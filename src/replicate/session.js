'use strict'

/**
 * High-level replication orchestration, composed from the lower-level
 * swarm/replicate/health primitives (src/replicate/swarm.js,
 * src/replicate/replicate.js, src/replicate/health.js).
 *
 * Both the CLI (`serve`, `fetch-remote`, `pin` commands) and the web UI
 * need the same three sequences -- serve to peers, sync a freshly-opened
 * replica store, and pin-with-swarm-fallback -- so they're implemented
 * once here instead of duplicated (and drifting) in each surface.
 */

const { startArchiveSwarm, startBlobSwarm, startDiscoverySwarm, stopAll } = require('./swarm')
const { serveBlobs, sendMessage } = require('./replicate')
const { getLocalPins, addReplica, pinPaper } = require('./health')
const { createDiscoveryEngine } = require('./discovery')
const { KEY_PREFIX, VALID_SUBJECTS } = require('../core/constants')

/**
 * Start serving: archive swarm (metadata replication via corestore) +
 * blob swarm (blob request/serve + pin announcements), wired to record
 * incoming pin announcements as replicas and announce this node's own
 * pins to newly connected peers.
 *
 * @param {object} store - store instance from initStore/initReplicaStore
 * @param {object} [opts] - { subscribe: string[], server = true, client = true }
 * @returns {Promise<{archiveSwarm, blobSwarm, topics: string[]}>}
 */
async function startServing(store, opts = {}) {
  const subscribe = opts.subscribe || []
  const server = opts.server !== false
  const client = opts.client !== false

  const archiveSwarm = await startArchiveSwarm(store, { server, client, topics: subscribe })

  const blobSwarm = await startBlobSwarm((conn, info) => {
    serveBlobs(conn, store, {
      onPinAnnounce: async (paperId, pk) => {
        try { await addReplica(paperId, pk) } catch (_) {}
      }
    })
    getLocalPins().then((pins) => {
      if (pins.length) {
        sendMessage(conn, { type: 'pin_announce', hashes: pins, peer_key: store.drive.key.toString('hex') })
      }
    }).catch(() => {})
  }, { server, client })

  // Discovery gossip (GOSSIP_IMPL_PLAN.md M5). Opt out with discovery: false;
  // a failed discovery swarm must never take down serving itself.
  let discovery = null
  if (opts.discovery !== false) {
    try {
      discovery = await startDiscovery(store, { subscribe, server, client })
    } catch (err) {
      console.error('[serve] Discovery gossip failed to start:', err.message)
    }
  }

  const topics = ['archive', 'blob-transfer', ...subscribe]
  if (discovery) {
    for (const s of discovery.subjects) topics.push(`discovery:${s}`)
  }
  return { archiveSwarm, blobSwarm, discovery, topics }
}

/**
 * Join the archive swarm client-only and wait for it to connect to at
 * least one peer, giving the Hyperbee a moment to replicate. The caller
 * owns the swarm's lifetime from here -- stop it with swarm.js's
 * stopAll() once done (this intentionally does not stop it itself, so a
 * caller that also needs the blob swarm up, like the CLI's
 * `fetch-remote` command, can keep both alive across the wait).
 *
 * @param {object} store
 * @param {object} [opts] - { connectTimeoutMs = 15000, syncGraceMs = 3000 }
 * @returns {Promise<object>} the archive swarm handle ({ peers, ... })
 */
async function waitForArchiveSync(store, opts = {}) {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15000
  const syncGraceMs = opts.syncGraceMs ?? 3000

  const archiveSwarm = await startArchiveSwarm(store, { server: false, client: true })

  const deadline = Date.now() + connectTimeoutMs
  while (archiveSwarm.peers === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
  }
  if (archiveSwarm.peers > 0) {
    await new Promise((r) => setTimeout(r, syncGraceMs))
  }
  return archiveSwarm
}

/**
 * Subjects this node should be discoverable under: the subjects of papers
 * it can actually serve (own papers for a publisher, the publisher's papers
 * for a replica) unioned with explicitly subscribed interests. Discovery
 * topics are joined for this set; the self-announce itself only ever claims
 * the serving capabilities (discovery.js selfEntry).
 */
async function resolveDiscoverySubjects(store, subscribe = []) {
  const subjects = new Set()
  for (const s of subscribe) {
    if (VALID_SUBJECTS.includes(s)) subjects.add(s)
    else console.warn(`[discovery] Ignoring invalid subscribed subject: ${s}`)
  }
  try {
    for await (const { value } of store.bee.createReadStream({
      gt: KEY_PREFIX.PAPER,
      lt: KEY_PREFIX.PAPER + '\uffff'
    })) {
      if (value?.subject && VALID_SUBJECTS.includes(value.subject)) subjects.add(value.subject)
    }
  } catch (_) {}
  return [...subjects]
}

/**
 * Start long-lived discovery gossip for a serving node: joins one
 * discovery topic per subject, announces this node's servable keys, and
 * relays what it learns (GOSSIP_IMPL_PLAN.md M5). Returns null when the
 * node has nothing to gossip about (no papers, no subscriptions).
 *
 * @param {object} store
 * @param {object} [opts] - { subscribe = [], server = true, client = true }
 * @returns {Promise<object|null>} { engine, subjects, stop }
 */
async function startDiscovery(store, opts = {}) {
  const subscribe = opts.subscribe || []
  const server = opts.server !== false
  const client = opts.client !== false

  const subjects = await resolveDiscoverySubjects(store, subscribe)
  if (subjects.length === 0) {
    console.log('[discovery] No subjects to gossip about (no local papers, no subscriptions)')
    return null
  }

  const engine = createDiscoveryEngine({ store, opts: { interests: subjects } })
  const swarm = await startDiscoverySwarm(
    (conn, info) => engine.handleConnection(conn, info),
    { subjects, server, client }
  )
  engine.startReannounceLoop()

  return {
    engine,
    subjects,
    stop: async () => {
      engine.stop()
      await swarm.stop()
    }
  }
}

/**
 * One-shot discovery: join one subject's discovery topic client-only,
 * pull announcements for `timeoutMs`, and return the publishers learned
 * (also persisted to the local known_publishers cache). Same lifetime
 * conventions as waitForArchiveSync -- callers stop swarms via stopAll()
 * or the returned handle.
 *
 * @param {string} subject - e.g. 'q-bio.GN'
 * @param {object} [opts] - { timeoutMs = 10000, store }
 * @returns {Promise<object[]>} discovered publisher entries
 */
async function discoverPublishers(subject, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000
  if (!VALID_SUBJECTS.includes(subject)) {
    throw new Error(`Invalid subject: ${subject}`)
  }
  const store = opts.store || require('../core/store').getStore()

  const engine = createDiscoveryEngine({
    store,
    opts: { pullOnly: true, requestSubjects: [subject], interests: [subject] }
  })
  const swarm = await startDiscoverySwarm(
    (conn, info) => engine.handleConnection(conn, info),
    { subjects: [subject], server: false, client: true }
  )

  await new Promise((r) => setTimeout(r, timeoutMs))

  const publishers = engine.listKnown(subject)
  engine.stop()
  await swarm.stop()
  return publishers
}

/**
 * Pin a paper, joining the archive swarm to fetch its blob on demand if
 * it isn't available locally yet, retrying until it arrives or the
 * timeout elapses.
 *
 * @param {string} paperId
 * @param {object} [opts] - { timeoutMs = 30000, pollMs = 2000, reuseSwarm = false }
 *   reuseSwarm: pass true when an archive swarm is already running (e.g.
 *   an embedded `serve` session) so this doesn't start a second one --
 *   swarm.js keeps a single module-level archive swarm instance, and
 *   starting another would silently orphan the first without stopping it.
 * @returns {Promise<object>} pinPaper() result
 */
async function pinWithSwarmFallback(paperId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000
  const pollMs = opts.pollMs ?? 2000

  let result = await pinPaper(paperId)
  if (result.pinned || result.error !== 'blob not available') return result

  const startedTransient = !opts.reuseSwarm
  if (startedTransient) {
    const { getStore } = require('../core/store')
    await startArchiveSwarm(getStore(), { server: true, client: true })
  }

  const deadline = Date.now() + timeoutMs
  while (!result.pinned && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    result = await pinPaper(paperId)
  }

  if (startedTransient) await stopAll().catch(() => {})
  return result
}

module.exports = { startServing, waitForArchiveSync, pinWithSwarmFallback, startDiscovery, discoverPublishers }
