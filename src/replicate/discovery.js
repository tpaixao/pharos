'use strict'

const { sendMessage, readMessages } = require('./framing')
const { VALID_SUBJECTS, KEY_PREFIX } = require('../core/constants')
const { initDbTables } = require('../core/store')

/**
 * Gossip-based publisher discovery (GOSSIP_IMPL_PLAN.md).
 *
 * Closes the "no cross-publisher discovery" gap: two nodes on the same
 * discovery topic can learn each other's {bee_key, drive_key, subjects}
 * without any out-of-band key exchange, and relay what they learn so a
 * publisher you have never connected to still reaches you transitively.
 *
 * This engine owns NO sockets. Connections are injected (swarm.js's
 * discovery swarm calls engine.handleConnection(conn, info)), which keeps
 * the whole module testable against fake Duplex pairs -- same pattern as
 * the blob-transfer protocol in replicate.js.
 *
 * Announcement semantics (plan decision D4): an entry means "here are keys
 * I can serve". Because replica stores open the publisher's cores by key
 * (initReplicaStore), this one rule covers publishers (announce own cores)
 * and replicas (announce their publisher's cores) with no extra bookkeeping.
 * A replica opened without a publisher drive key has a fresh local drive
 * whose key is useless to strangers -- it announces bee_key only.
 *
 * Propagation (plan decision D5):
 *   - push: on connect, send self + most recently seen known entries
 *   - pull: stateless discoverers send `request`, responders answer from
 *     their local table (this is what `pharos discover` uses)
 *   - epidemic relay: entries new to us are upserted and forwarded to all
 *     other connected discovery peers
 *
 * Loop/flood prevention: dedup on `${bee_key}:${announced_at}` (FIFO-capped
 * seen-map; relays never mutate announced_at, so the key is stable across
 * every path a given announcement takes), hop cap, per-connection message
 * rate limit, batch caps, table LRU cap, and frame size cap.
 *
 * Interest scoping (plan decision D2): senders cannot know what a receiver
 * cares about (Hyperswarm gives no connection->topic mapping server-side),
 * so greeting pushes everything the sender knows and the RECEIVER filters:
 * engines created with `interests` upsert and relay only entries whose
 * subjects intersect those interests. Empty interests = accept everything
 * (hub behavior). Information therefore flows along the interest graph,
 * never requiring a global flood.
 *
 * Trust model (plan decision D6): entries are UNVERIFIED HINTS. A gossiped
 * key still has to resolve to a real Hyperbee whose records still have to
 * pass the existing Ed25519 metadata-signature gate; a bogus key simply
 * makes fetch-remote fail. Nothing here writes to the replicated Hyperbee.
 */

const PROTOCOL_VERSION = 1

const DEFAULTS = {
  /** entries per announce message */
  ANNOUNCE_BATCH_MAX: 64,
  /** entries pushed to a peer on connect (self + recently seen) */
  FORWARD_BATCH_MAX: 32,
  /** SQLite rows kept; LRU-evicted by last_seen */
  KNOWN_TABLE_MAX: 1000,
  /** dedup map size; FIFO-evicted */
  SEEN_SET_MAX: 4096,
  /** relay depth cap */
  HOP_MAX: 3,
  /** entry expiry; originators re-announce every REANNOUNCE_INTERVAL_MS */
  TTL_MS: 7 * 24 * 60 * 60 * 1000,
  REANNOUNCE_INTERVAL_MS: 10 * 60 * 1000,
  PRUNE_INTERVAL_MS: 60 * 60 * 1000,
  /** strict frame cap for discovery messages (they are tiny) */
  MAX_MSG_BYTES: 64 * 1024,
  /** flood control per connection */
  MSG_RATE_MAX: 10,
  MSG_RATE_WINDOW_MS: 5000,
  /** sanity window for announced_at timestamps */
  CLOCK_SKEW_TOLERANCE_MS: 10 * 60 * 1000
}

const HEX64 = /^[0-9a-f]{64}$/i

/**
 * Dedup key for an announcement. announced_at comes from the ORIGINATOR and
 * is never modified by relays -- that is what makes this key identical on
 * every path a given announcement travels, so the seen-map kills loops.
 */
function entryKey(entry) {
  return `${entry.bee_key}:${entry.announced_at}`
}

/**
 * An incoming entry only replaces a stored one if strictly newer.
 * (Equal = same announcement redelivered; older = stale path.)
 */
function shouldUpsert(existing, incoming) {
  if (!existing) return true
  return Date.parse(incoming.announced_at) > Date.parse(existing.announced_at)
}

/**
 * Validate and normalize an announce message. Returns the acceptable entries
 * (possibly fewer than sent). Pure: no engine state is touched. Peer input
 * can never throw out of here.
 *
 * @param {object} msg - raw parsed wire message
 * @param {object} [ctx] - { ownBeeKey, now, opts }
 * @returns {object[]} normalized entries
 */
function validateAnnounceBatch(msg, ctx = {}) {
  const { ownBeeKey = null, now = Date.now(), opts = DEFAULTS } = ctx
  if (!msg || msg.type !== 'announce' || msg.v !== PROTOCOL_VERSION) return []
  if (!Array.isArray(msg.publishers)) return []
  if (msg.publishers.length === 0 || msg.publishers.length > opts.ANNOUNCE_BATCH_MAX) return []

  const out = []
  for (const e of msg.publishers) {
    if (!e || typeof e !== 'object') continue
    if (typeof e.bee_key !== 'string' || !HEX64.test(e.bee_key)) continue
    const beeKey = e.bee_key.toLowerCase()
    if (ownBeeKey && beeKey === ownBeeKey) continue // self-echo

    let driveKey = null
    if (e.drive_key !== null && e.drive_key !== undefined) {
      if (typeof e.drive_key !== 'string' || !HEX64.test(e.drive_key)) continue
      driveKey = e.drive_key.toLowerCase()
    }

    if (!Array.isArray(e.subjects) || e.subjects.length === 0) continue
    const subjects = [...new Set(e.subjects)]
      .filter((s) => typeof s === 'string' && VALID_SUBJECTS.includes(s))
    if (subjects.length === 0) continue
    subjects.sort()

    const ts = Date.parse(e.announced_at)
    if (!Number.isFinite(ts)) continue
    if (Math.abs(now - ts) > opts.CLOCK_SKEW_TOLERANCE_MS) continue

    const hops = typeof e.hops === 'number' && Number.isInteger(e.hops) ? e.hops : 0
    if (hops < 0 || hops > opts.HOP_MAX) continue

    out.push({
      bee_key: beeKey,
      drive_key: driveKey,
      subjects,
      is_publisher: Boolean(e.is_publisher),
      hops,
      // Normalize so string comparison in prune() and dedup is consistent
      announced_at: new Date(ts).toISOString()
    })
  }
  return out
}

/** Map raw SQLite rows to entry objects, optionally filtered by subject. */
function rowsToEntries(rows, wantedSubjects) {
  const wanted = wantedSubjects && wantedSubjects.length ? new Set(wantedSubjects) : null
  const out = []
  for (const r of rows) {
    let subjects
    try {
      subjects = JSON.parse(r.subjects)
    } catch (_) {
      continue
    }
    if (!Array.isArray(subjects)) continue
    if (wanted && !subjects.some((s) => wanted.has(s))) continue
    out.push({
      bee_key: r.bee_key,
      drive_key: r.drive_key,
      subjects,
      is_publisher: Boolean(r.is_publisher),
      hops: r.hops,
      announced_at: r.announced_at,
      first_seen: r.first_seen,
      last_seen: r.last_seen
    })
  }
  return out
}

/**
 * List cached known publishers straight from a store's SQLite table,
 * without constructing an engine (used by the web API / CLI list paths).
 *
 * @param {object} store - store instance (needs .db)
 * @param {string|null} [subject] - optional subject filter
 * @param {number} [limit]
 * @returns {object[]}
 */
function listKnownPublishers(store, subject = null, limit = 100) {
  const db = store.db
  let rows
  try {
    rows = db.prepare('SELECT * FROM known_publishers ORDER BY last_seen DESC LIMIT ?').all(limit)
  } catch (_) {
    return []
  }
  return rowsToEntries(rows, subject ? [subject] : null)
}

/**
 * Create a gossip engine.
 *
 * @param {object} params
 * @param {object} params.store - store instance (publisher or replica);
 *   needs .db, .bee, .drive, .isReplica, .hasPublisherDrive
 * @param {object} [params.opts] - overrides of DEFAULTS, plus:
 *   pullOnly: don't push-announce on connect; send `request` instead
 *   (used by the one-shot discover flow)
 *   requestSubjects: subjects to ask for when pullOnly
 *   interests: subjects this node accepts and relays entries for
 *   (empty/omitted = accept everything)
 * @returns {object} engine
 */
function createDiscoveryEngine({ store, opts = {} }) {
  const o = { ...DEFAULTS, ...opts }
  const db = store.db
  initDbTables(db) // defensive: mock/test stores may skip store.js init

  const ownBeeKey = store.bee.core.key.toString('hex')

  const connections = new Set()
  const rate = new WeakMap() // conn -> { count, windowStart }
  const seen = new Map() // `${bee_key}:${announced_at}` -> true, FIFO-capped
  const interests = new Set(opts.interests || [])
  let reannounceTimer = null
  let pruneTimer = null
  let selfCache = null // { at, value } -- subjects scan is ~1/minute max

  /** D2: out-of-interest entries are neither stored nor relayed. */
  function interested(entry) {
    if (interests.size === 0) return true
    return entry.subjects.some((s) => interests.has(s))
  }

  /** True when this node's drive key is useful to strangers (D4). */
  function announceDrive() {
    if (!store.isReplica) return true
    return Boolean(store.hasPublisherDrive)
  }

  /**
   * Compose this node's own announcement from the subjects it can actually
   * serve (papers present in its bee -- own papers for a publisher, the
   * publisher's papers for a replica). Interests (--subscribe) are a
   * swarm-join concern, NOT part of the self-announce.
   */
  async function selfEntry() {
    const now = Date.now()
    if (selfCache && now - selfCache.at < 60_000) {
      return selfCache.value ? { ...selfCache.value } : null
    }

    const subjects = new Set()
    try {
      for await (const { value } of store.bee.createReadStream({
        gt: KEY_PREFIX.PAPER,
        lt: KEY_PREFIX.PAPER + '\xff'
      })) {
        if (value?.subject && VALID_SUBJECTS.includes(value.subject)) subjects.add(value.subject)
      }
    } catch (_) {}

    if (subjects.size === 0) {
      selfCache = { at: now, value: null }
      return null
    }

    const entry = {
      bee_key: ownBeeKey,
      drive_key: announceDrive() ? store.drive.key.toString('hex') : null,
      subjects: [...subjects].sort(),
      announced_at: new Date().toISOString(),
      is_publisher: !store.isReplica,
      hops: 0
    }
    selfCache = { at: now, value: entry }
    return { ...entry }
  }

  function markSeen(key) {
    seen.set(key, true)
    if (seen.size > o.SEEN_SET_MAX) {
      // Map preserves insertion order -> FIFO eviction
      seen.delete(seen.keys().next().value)
    }
  }

  function evictOverCap() {
    const count = db.prepare('SELECT COUNT(*) AS n FROM known_publishers').get().n
    if (count <= o.KNOWN_TABLE_MAX) return
    db.prepare(
      `DELETE FROM known_publishers WHERE bee_key IN (
         SELECT bee_key FROM known_publishers ORDER BY last_seen ASC LIMIT ?
       )`
    ).run(count - o.KNOWN_TABLE_MAX)
  }

  /**
   * Store an accepted entry if it is news to us.
   * @returns {boolean} true when the table was updated (caller forwards)
   */
  function upsertEntry(entry) {
    const key = entryKey(entry)
    if (seen.has(key)) return false
    markSeen(key)

    const existing = db.prepare('SELECT announced_at FROM known_publishers WHERE bee_key = ?').get(entry.bee_key)
    if (!shouldUpsert(existing, entry)) return false

    const nowIso = new Date().toISOString()
    db.prepare(
      `INSERT INTO known_publishers
         (bee_key, drive_key, subjects, is_publisher, hops, announced_at, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bee_key) DO UPDATE SET
         drive_key = excluded.drive_key,
         subjects = excluded.subjects,
         is_publisher = excluded.is_publisher,
         hops = excluded.hops,
         announced_at = excluded.announced_at,
         last_seen = excluded.last_seen`
    ).run(
      entry.bee_key,
      entry.drive_key,
      JSON.stringify(entry.subjects),
      entry.is_publisher ? 1 : 0,
      entry.hops,
      entry.announced_at,
      nowIso,
      nowIso
    )
    evictOverCap()
    return true
  }

  /** Per-connection flood control. */
  function allowMessage(conn) {
    const now = Date.now()
    let r = rate.get(conn)
    if (!r || now - r.windowStart > o.MSG_RATE_WINDOW_MS) {
      r = { count: 0, windowStart: now }
      rate.set(conn, r)
    }
    r.count++
    if (r.count > o.MSG_RATE_MAX) {
      if (r.count === o.MSG_RATE_MAX + 1) {
        console.warn('[discovery] Rate limit exceeded on a connection, dropping extra messages this window')
      }
      return false
    }
    return true
  }

  /** Relay freshly learned entries to every other discovery peer. */
  function forwardToOthers(fromConn, entries) {
    const batch = []
    for (const e of entries) {
      const fwd = { ...e, hops: e.hops + 1 }
      if (fwd.hops > o.HOP_MAX) continue
      batch.push(fwd)
    }
    if (batch.length === 0) return

    for (const conn of connections) {
      if (conn === fromConn) continue
      if (conn.destroyed) continue
      for (let i = 0; i < batch.length; i += o.ANNOUNCE_BATCH_MAX) {
        sendMessage(conn, {
          v: PROTOCOL_VERSION,
          type: 'announce',
          publishers: batch.slice(i, i + o.ANNOUNCE_BATCH_MAX)
        })
      }
    }
  }

  async function handleMessage(conn, msg) {
    if (!allowMessage(conn)) return
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'request' && msg.v === PROTOCOL_VERSION) {
      const wanted = Array.isArray(msg.subjects)
        ? [...new Set(msg.subjects.filter((s) => typeof s === 'string' && VALID_SUBJECTS.includes(s)))]
        : []
      const rows = db.prepare('SELECT * FROM known_publishers ORDER BY last_seen DESC LIMIT ?')
        .all(o.ANNOUNCE_BATCH_MAX)
      const publishers = rowsToEntries(rows, wanted)
        .map((r) => ({ ...stripLocalFields(r), hops: (r.hops || 0) + 1 }))
      if (publishers.length > 0) {
        sendMessage(conn, { v: PROTOCOL_VERSION, type: 'announce', publishers })
      }
      return
    }

    if (msg.type !== 'announce' || msg.v !== PROTOCOL_VERSION) return

    const entries = validateAnnounceBatch(msg, { ownBeeKey, opts: o }).filter(interested)
    const fresh = []
    for (const e of entries) {
      if (upsertEntry(e)) fresh.push(e)
    }
    if (fresh.length > 0) forwardToOthers(conn, fresh)
  }

  /** Push self + recently seen entries to one peer. */
  async function greet(conn) {
    if (o.pullOnly) {
      sendMessage(conn, { v: PROTOCOL_VERSION, type: 'request', subjects: o.requestSubjects || [] })
      return
    }
    const batch = []
    const self = await selfEntry()
    if (self) {
      markSeen(entryKey(self))
      batch.push(self)
    }
    const rows = db.prepare('SELECT * FROM known_publishers ORDER BY last_seen DESC LIMIT ?')
      .all(Math.max(0, o.FORWARD_BATCH_MAX - batch.length))
    for (const r of rowsToEntries(rows, null)) {
      const fwd = { ...stripLocalFields(r), hops: (r.hops || 0) + 1 }
      if (fwd.hops > o.HOP_MAX) continue
      markSeen(entryKey(fwd))
      batch.push(fwd)
    }
    if (batch.length > 0) {
      sendMessage(conn, { v: PROTOCOL_VERSION, type: 'announce', publishers: batch })
    }
  }

  /**
   * Wire a discovery-swarm connection into the engine. Safe to call for
   * client- and server-side connections alike: the messages carry subjects,
   * so no connection->topic mapping is needed (Hyperswarm doesn't provide
   * one server-side anyway).
   */
  function handleConnection(conn, _info) {
    connections.add(conn)
    const cleanup = readMessages(
      conn,
      (msg) => {
        Promise.resolve(handleMessage(conn, msg)).catch((err) => {
          console.error('[discovery] Message handling failed:', err.message)
        })
      },
      { maxBytes: o.MAX_MSG_BYTES }
    )

    const onClose = () => {
      connections.delete(conn)
      cleanup()
    }
    conn.on('close', onClose)
    conn.on('error', (err) => {
      console.log(`[discovery] Connection error: ${err.message}`)
    })

    greet(conn).catch((err) => {
      console.error('[discovery] Greet failed:', err.message)
    })
  }

  /** List cached entries, newest first, optionally filtered by subject. */
  function listKnown(subject = null, limit = 100) {
    const rows = db.prepare('SELECT * FROM known_publishers ORDER BY last_seen DESC LIMIT ?').all(limit)
    return rowsToEntries(rows, subject ? [subject] : null)
  }

  /** Drop entries older than TTL (originator stopped re-announcing). */
  function prune() {
    const cutoff = new Date(Date.now() - o.TTL_MS).toISOString()
    const r = db.prepare('DELETE FROM known_publishers WHERE announced_at < ?').run(cutoff)
    return r.changes
  }

  /**
   * Periodically re-announce to connected peers with a fresh announced_at.
   * The fresh timestamp is what refreshes liveness in peers' tables (and
   * their dedup maps treat it as a new announcement, so it propagates).
   */
  function startReannounceLoop() {
    if (reannounceTimer) return
    reannounceTimer = setInterval(() => {
      Promise.resolve(selfEntry())
        .then((self) => {
          if (!self) return
          self.announced_at = new Date().toISOString()
          const msg = { v: PROTOCOL_VERSION, type: 'announce', publishers: [self] }
          for (const conn of connections) {
            if (!conn.destroyed) sendMessage(conn, msg)
          }
        })
        .catch(() => {})
    }, o.REANNOUNCE_INTERVAL_MS)
    reannounceTimer.unref()
  }

  function startPruneLoop() {
    if (pruneTimer) return
    pruneTimer = setInterval(() => {
      try { prune() } catch (_) {}
    }, o.PRUNE_INTERVAL_MS)
    pruneTimer.unref()
  }

  function stop() {
    if (reannounceTimer) clearInterval(reannounceTimer)
    if (pruneTimer) clearInterval(pruneTimer)
    reannounceTimer = null
    pruneTimer = null
  }

  startPruneLoop()
  prune() // drop stale entries from previous runs on startup

  return {
    handleConnection,
    selfEntry,
    listKnown,
    prune,
    startReannounceLoop,
    stop,
    get connections() { return connections.size }
  }
}

function stripLocalFields(entry) {
  const { first_seen, last_seen, ...rest } = entry
  return rest
}

module.exports = {
  createDiscoveryEngine,
  listKnownPublishers,
  validateAnnounceBatch,
  entryKey,
  shouldUpsert,
  PROTOCOL_VERSION,
  DEFAULTS
}