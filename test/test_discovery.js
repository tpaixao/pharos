'use strict'

/**
 * Gossip-based publisher discovery tests (GOSSIP_IMPL_PLAN.md, test plan).
 *
 * Pattern: the engine owns no sockets, so everything is testable against
 * in-memory Duplex stream pairs (same as test_replicate.js) and mock
 * stores -- the store.js singleton forbids multiple real stores per
 * process, so the engine contract (db + bee + drive + flags) is faked
 * directly.
 */

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Duplex } = require('node:stream')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { sendMessage, readMessages } = require('../src/replicate/framing')
const {
  createDiscoveryEngine,
  validateAnnounceBatch,
  entryKey,
  shouldUpsert,
  listKnownPublishers,
  DEFAULTS,
  PROTOCOL_VERSION
} = require('../src/replicate/discovery')
const { initDbTables, initReplicaStore, getStore, close } = require('../src/core/store')

// ---- helpers ----------------------------------------------------------

function hex64(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex')
}

/** Mock store matching the engine's contract (see createDiscoveryEngine). */
function mockStore({ id, papers = [], isReplica = false, hasPublisherDrive = true, dbPath = ':memory:' }) {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  initDbTables(db)
  return {
    db,
    bee: {
      core: { key: Buffer.from(hex64(id + ':bee'), 'hex') },
      createReadStream: async function* () {
        for (const p of papers) yield { key: `paper:${p.paper_id}`, value: p }
      }
    },
    drive: { key: Buffer.from(hex64(id + ':drive'), 'hex') },
    isReplica,
    hasPublisherDrive
  }
}

/** In-memory duplex stream pair (same shape as test_replicate.js). */
function createStreamPair() {
  class FakeSocket extends Duplex {
    constructor(other) {
      super()
      this._other = other
    }
    _read() {}
    _write(chunk, enc, cb) {
      this._other.push(chunk)
      cb()
    }
  }
  const a = new FakeSocket(null)
  const b = new FakeSocket(a)
  a._other = b
  return [a, b]
}

/** Wire two engines together as if a swarm connected them. */
function wire(engineA, engineB) {
  const [sockA, sockB] = createStreamPair()
  engineA.handleConnection(sockA, {})
  engineB.handleConnection(sockB, {})
  return () => {
    sockA.destroy()
    sockB.destroy()
  }
}

function entry(overrides = {}) {
  return {
    bee_key: hex64('pub:bee'),
    drive_key: hex64('pub:drive'),
    subjects: ['q-bio.GN'],
    announced_at: new Date().toISOString(),
    is_publisher: true,
    hops: 0,
    ...overrides
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- framing (M1) ------------------------------------------------------

test('discovery: framing round-trips announce and request over a stream pair', async () => {
  const [a, b] = createStreamPair()
  const received = []
  const cleanup = readMessages(b, (m) => received.push(m), { maxBytes: 64 * 1024 })

  sendMessage(a, { v: 1, type: 'request', subjects: ['q-bio.GN'] })
  sendMessage(a, { v: 1, type: 'announce', publishers: [entry()] })
  await wait(50)

  assert.equal(received.length, 2)
  assert.equal(received[0].type, 'request')
  assert.equal(received[1].publishers.length, 1)

  cleanup()
  a.destroy()
  b.destroy()
})

test('discovery: framing destroys the stream on an oversized message', async () => {
  const [a, b] = createStreamPair()
  readMessages(b, () => {}, { maxBytes: 1024 })

  // Hand-craft a frame declaring a length far above the cap
  const header = Buffer.alloc(4)
  header.writeUInt32BE(10 * 1024 * 1024, 0)
  a.write(Buffer.concat([header, Buffer.from('{')])
  )
  await wait(50)
  assert.ok(b.destroyed, 'stream should be destroyed on protocol violation')
  a.destroy()
})

test('discovery: blob framing default cap is generous enough for hex PDFs', () => {
  const { DEFAULT_MAX_BYTES } = require('../src/replicate/framing')
  // uploads are capped at 50MB; hex-encoding inside JSON doubles that
  assert.ok(DEFAULT_MAX_BYTES > 2 * 50 * 1024 * 1024)
})

// ---- validation -------------------------------------------------------

test('discovery: validateAnnounceBatch filters malformed entries', () => {
  const now = Date.now()
  const good = entry()
  const ctx = { now, opts: DEFAULTS }

  assert.deepEqual(validateAnnounceBatch(null, ctx), [])
  assert.deepEqual(validateAnnounceBatch({ type: 'announce', v: 2, publishers: [] }, ctx), [])
  assert.deepEqual(validateAnnounceBatch({ type: 'announce', v: 1 }, ctx), [])
  assert.deepEqual(validateAnnounceBatch({ type: 'announce', v: 1, publishers: 'nope' }, ctx), [])
  assert.deepEqual(validateAnnounceBatch({ type: 'announce', v: 1, publishers: [] }, ctx), [])
  assert.deepEqual(
    validateAnnounceBatch({ type: 'announce', v: 1, publishers: new Array(65).fill(good) }, ctx),
    []
  )

  const out = validateAnnounceBatch({
    type: 'announce', v: 1,
    publishers: [
      good,
      { ...good, bee_key: 'not-hex' },
      { ...good, bee_key: good.bee_key.toUpperCase() }, // valid hex, uppercase -> normalized
      { ...good, drive_key: 'zz' },
      { ...good, drive_key: null }, // drive-less entry is legal
      { ...good, subjects: ['nonsense.X'] },
      { ...good, subjects: ['q-bio.GN', 'invalid'] }, // mixed -> keeps valid
      { ...good, announced_at: 'yesterday' },
      { ...good, announced_at: new Date(now - 11 * 60 * 1000).toISOString() }, // beyond skew window
      { ...good, hops: 99 },
      { ...good, hops: -1 },
      { ...good, bee_key: hex64('own') } // self-echo when ownBeeKey given
    ]
  }, { now, ownBeeKey: hex64('own'), opts: DEFAULTS })

  // good, uppercase-normalized, drive-less, mixed-subjects
  assert.equal(out.length, 4)
  assert.equal(out[0].bee_key, good.bee_key)
  assert.equal(out[0].announced_at, new Date(good.announced_at).toISOString())
  assert.equal(out[1].bee_key, good.bee_key.toLowerCase(), 'uppercase keys normalized')
  assert.equal(out[2].drive_key, null)
  assert.deepEqual(out[3].subjects, ['q-bio.GN'])
  assert.equal(out[3].hops, 0)
})

test('discovery: entryKey is stable across relay hops and shouldUpsert demands newer', () => {
  const e = entry()
  assert.equal(entryKey(e), entryKey({ ...e, hops: 2 }))
  assert.equal(entryKey(e), `${e.bee_key}:${e.announced_at}`)

  const older = { announced_at: '2020-01-01T00:00:00.000Z' }
  const newer = { announced_at: '2030-01-01T00:00:00.000Z' }
  assert.equal(shouldUpsert(null, older), true)
  assert.equal(shouldUpsert(older, older), false, 'same announcement redelivered is not news')
  assert.equal(shouldUpsert(older, newer), true)
  assert.equal(shouldUpsert(newer, older), false, 'stale path must not overwrite fresher data')
})

// ---- engine: store, dedup, ordering, TTL -------------------------------

test('discovery: engine upserts announcements into the known_publishers table', async () => {
  const store = mockStore({ id: 'b' })
  const engine = createDiscoveryEngine({ store })
  const [sockA, sockB] = createStreamPair()
  engine.handleConnection(sockB, {})

  const e = entry()
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [e] })
  await wait(50)

  const rows = engine.listKnown()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].bee_key, e.bee_key)
  assert.equal(rows[0].drive_key, e.drive_key)
  assert.equal(rows[0].is_publisher, true)

  engine.stop()
  sockA.destroy()
  sockB.destroy()
})

test('discovery: duplicate and stale announcements are ignored (dedup + ordering)', async () => {
  const store = mockStore({ id: 'b' })
  const engine = createDiscoveryEngine({ store })
  const [sockA, sockB] = createStreamPair()
  engine.handleConnection(sockB, {})

  const t1 = entry({ announced_at: new Date(Date.now() - 60_000).toISOString() })
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [t1] })
  await wait(50)
  const afterFirst = engine.listKnown()[0]

  // Same announcement redelivered: seen-map hit, row untouched
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [t1] })
  await wait(50)
  assert.deepEqual(engine.listKnown()[0], afterFirst)

  // Older announcement for the same key: ignored
  sendMessage(sockA, {
    v: 1, type: 'announce',
    publishers: [entry({ announced_at: new Date(Date.now() - 120_000).toISOString() })]
  })
  await wait(50)
  assert.deepEqual(engine.listKnown()[0], afterFirst, 'stale must not overwrite')

  // Newer announcement: replaces
  const t2 = entry({ announced_at: new Date().toISOString() })
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [t2] })
  await wait(50)
  const afterNewer = engine.listKnown()[0]
  assert.equal(afterNewer.announced_at, t2.announced_at)

  engine.stop()
  sockA.destroy()
  sockB.destroy()
})

test('discovery: TTL prune drops entries the originator stopped refreshing', async () => {
  const store = mockStore({ id: 'b' })
  // Accept old timestamps (huge skew window) but expire anything > 1 day old
  const engine = createDiscoveryEngine({
    store,
    opts: { CLOCK_SKEW_TOLERANCE_MS: 10 * 24 * 60 * 60 * 1000, TTL_MS: 24 * 60 * 60 * 1000 }
  })
  const [sockA, sockB] = createStreamPair()
  engine.handleConnection(sockB, {})

  const stale = entry({ announced_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() })
  const fresh = entry({ bee_key: hex64('fresh:bee'), announced_at: new Date().toISOString() })
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [stale, fresh] })
  await wait(50)
  assert.equal(engine.listKnown().length, 2)

  const removed = engine.prune()
  assert.equal(removed, 1)
  const rows = engine.listKnown()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].bee_key, fresh.bee_key)

  engine.stop()
  sockA.destroy()
  sockB.destroy()
})

// ---- engine: self-announce semantics (D4) ------------------------------

test('discovery: publisher selfEntry announces own keys and real subjects', async () => {
  const store = mockStore({ id: 'pub', papers: [{ paper_id: 'p1', subject: 'q-bio.GN' }] })
  const engine = createDiscoveryEngine({ store })
  const self = await engine.selfEntry()

  assert.equal(self.bee_key, hex64('pub:bee'))
  assert.equal(self.drive_key, hex64('pub:drive'))
  assert.deepEqual(self.subjects, ['q-bio.GN'])
  assert.equal(self.is_publisher, true)
  assert.equal(self.hops, 0)
  engine.stop()
})

test('discovery: replica selfEntry announces publisher keys, null drive when local-only', async () => {
  // Replica WITH the publisher's drive key: announce both keys, is_publisher false
  const withDrive = createDiscoveryEngine({
    store: mockStore({
      id: 'replica', isReplica: true, hasPublisherDrive: true,
      papers: [{ paper_id: 'p1', subject: 'cs.LG' }]
    })
  })
  const e1 = await withDrive.selfEntry()
  assert.equal(e1.drive_key, hex64('replica:drive'))
  assert.equal(e1.is_publisher, false)
  withDrive.stop()

  // Replica WITHOUT a publisher drive key: fresh local drive is useless to
  // strangers -- must announce bee-only (drive_key null)
  const noDrive = createDiscoveryEngine({
    store: mockStore({
      id: 'replica2', isReplica: true, hasPublisherDrive: false,
      papers: [{ paper_id: 'p1', subject: 'cs.LG' }]
    })
  })
  const e2 = await noDrive.selfEntry()
  assert.equal(e2.drive_key, null)
  assert.equal(e2.is_publisher, false)
  noDrive.stop()

  // Node with no papers: nothing to announce
  const empty = createDiscoveryEngine({ store: mockStore({ id: 'empty' }) })
  assert.equal(await empty.selfEntry(), null)
  empty.stop()
})

test('discovery: initReplicaStore records hasPublisherDrive for real stores', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-disc-store-'))
  try {
    await initReplicaStore(tmpDir, hex64('some:bee'), hex64('some:drive'))
    assert.equal(getStore().isReplica, true)
    assert.equal(getStore().hasPublisherDrive, true)
    await close()

    await initReplicaStore(tmpDir, hex64('some:bee'))
    assert.equal(getStore().hasPublisherDrive, false)
  } finally {
    await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---- engine: gossip propagation (the actual epidemic property) --------

test('discovery: entries relay transitively through a middle node (A-B-C, no direct A-C)', async () => {
  const a = createDiscoveryEngine({
    store: mockStore({ id: 'a', papers: [{ paper_id: 'p1', subject: 'q-bio.GN' }] })
  })
  const b = createDiscoveryEngine({ store: mockStore({ id: 'b' }) })
  const c = createDiscoveryEngine({
    store: mockStore({ id: 'c' }),
    opts: { MSG_RATE_MAX: 1000 } // C receives B's forward + possibly greets; don't rate-limit in test
  })

  const unwireAB = wire(a, b)
  await wait(50)

  // B learned A directly from A's connect-time announce
  assert.equal(b.listKnown().length, 1)
  assert.equal(b.listKnown()[0].bee_key, hex64('a:bee'))

  // Now C connects to B: B's greet pushes what it knows, C learns A
  const unwireBC = wire(b, c)
  await wait(50)

  const knownToC = c.listKnown()
  assert.equal(knownToC.length, 1)
  assert.equal(knownToC[0].bee_key, hex64('a:bee'))
  assert.equal(knownToC[0].hops, 1, 'one relay hop from A to C via B')
  assert.equal(knownToC[0].is_publisher, true)

  unwireAB()
  unwireBC()
  a.stop(); b.stop(); c.stop()
})

test('discovery: entries learned later are forwarded to already-connected peers', async () => {
  const b = createDiscoveryEngine({ store: mockStore({ id: 'b' }) })
  const c = createDiscoveryEngine({
    store: mockStore({ id: 'c' }),
    opts: { MSG_RATE_MAX: 1000 }
  })
  const unwireBC = wire(b, c)
  await wait(50)

  // A fresh publisher connects to B AFTER B-C was wired; C must learn A
  // through B's forward, even though A and C share no connection.
  const a = createDiscoveryEngine({
    store: mockStore({ id: 'late-a', papers: [{ paper_id: 'p1', subject: 'q-bio.GN' }] })
  })
  const unwireAB = wire(a, b)
  await wait(50)

  assert.equal(c.listKnown().length, 1)
  assert.equal(c.listKnown()[0].bee_key, hex64('late-a:bee'))

  unwireAB()
  unwireBC()
  a.stop(); b.stop(); c.stop()
})

test('discovery: hop cap stops relayed entries beyond HOP_MAX', async () => {
  const b = createDiscoveryEngine({ store: mockStore({ id: 'b' }) })
  const c = createDiscoveryEngine({
    store: mockStore({ id: 'c' }),
    opts: { MSG_RATE_MAX: 1000 }
  })
  const unwireBC = wire(b, c)
  await wait(50)

  const atMaxHops = entry({ hops: DEFAULTS.HOP_MAX })
  const [sockA, sockB] = createStreamPair()
  b.handleConnection(sockB, {})
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [atMaxHops] })
  await wait(50)

  // B accepted it (hops == HOP_MAX is legal) but must not forward it
  assert.equal(b.listKnown().length, 1)
  assert.equal(b.listKnown()[0].hops, DEFAULTS.HOP_MAX)
  assert.equal(c.listKnown().length, 0, 'entries at hop cap must not propagate further')

  unwireBC()
  sockA.destroy(); sockB.destroy()
  b.stop(); c.stop()
})

test('discovery: self-echo is dropped -- an entry about yourself is never stored', async () => {
  const store = mockStore({ id: 'me', papers: [{ paper_id: 'p1', subject: 'q-bio.GN' }] })
  const engine = createDiscoveryEngine({ store })
  const [sockA, sockB] = createStreamPair()
  engine.handleConnection(sockB, {})

  const self = await engine.selfEntry()
  // A malicious/looping peer sends our own announcement back to us
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [{ ...self, hops: 3 }] })
  await wait(50)

  assert.equal(engine.listKnown().length, 0, 'own keys must never enter the table')
  engine.stop()
  sockA.destroy(); sockB.destroy()
})

// ---- engine: rate limiting + caps --------------------------------------

test('discovery: per-connection rate limit drops flood messages and keeps engine healthy', async () => {
  const store = mockStore({ id: 'b' })
  const engine = createDiscoveryEngine({ store })
  const [sockA, sockB] = createStreamPair()
  engine.handleConnection(sockB, {})

  const LIMIT = DEFAULTS.MSG_RATE_MAX
  for (let i = 0; i < LIMIT + 10; i++) {
    sendMessage(sockA, {
      v: 1, type: 'announce',
      publishers: [entry({ bee_key: hex64(`flood:${i}`) })]
    })
  }
  await wait(100)

  assert.equal(engine.listKnown().length, LIMIT, 'only the first MSG_RATE_MAX messages count')

  // The engine itself still answers requests fine after the flood
  const [sockC, sockD] = createStreamPair()
  const reply = readMessages(sockC, () => {}, { maxBytes: 64 * 1024 })
  sendMessage(sockD, { v: 1, type: 'request', subjects: [] })
  await wait(50)

  engine.stop()
  sockA.destroy(); sockB.destroy(); sockC.destroy(); sockD.destroy()
})

test('discovery: known-table LRU cap evicts oldest by last_seen', async () => {
  const store = mockStore({ id: 'b' })
  const engine = createDiscoveryEngine({ store, opts: { KNOWN_TABLE_MAX: 5, MSG_RATE_MAX: 1000 } })
  const [sockA, sockB] = createStreamPair()
  engine.handleConnection(sockB, {})

  for (let i = 0; i < 7; i++) {
    sendMessage(sockA, {
      v: 1, type: 'announce',
      publishers: [entry({ bee_key: hex64(`evict:${i}`) })]
    })
    await wait(20) // distinct last_seen timestamps
  }
  await wait(50)

  const rows = engine.listKnown()
  assert.equal(rows.length, 5)
  const keys = new Set(rows.map((r) => r.bee_key))
  assert.ok(!keys.has(hex64('evict:0')), 'oldest evicted')
  assert.ok(!keys.has(hex64('evict:1')), 'second-oldest evicted')
  assert.ok(keys.has(hex64(`evict:6`)), 'newest kept')

  engine.stop()
  sockA.destroy(); sockB.destroy()
})

// ---- engine: pull mode (request/reply) ---------------------------------

test('discovery: pullOnly engine sends request and receives subject-filtered replies', async () => {
  // Serving node B already knows two publishers
  const bStore = mockStore({ id: 'b' })
  const b = createDiscoveryEngine({ store: bStore, opts: { MSG_RATE_MAX: 1000 } })
  const seed = (beeKey, subjects) => bStore.db.prepare(
    `INSERT INTO known_publishers
       (bee_key, drive_key, subjects, is_publisher, hops, announced_at, first_seen, last_seen)
     VALUES (?, ?, ?, 1, 0, ?, ?, ?)`
  ).run(beeKey, null, JSON.stringify(subjects), new Date().toISOString(), new Date().toISOString(), new Date().toISOString())
  seed(hex64('gn:bee'), ['q-bio.GN'])
  seed(hex64('cs:bee'), ['cs.LG'])

  // Discoverer asks for q-bio.GN only, and caches only what it asked for:
  // B's connect-time greet pushes everything it knows, so the interest
  // filter (not the request) is what keeps cs.LG out of the discoverer's cache
  const discoverer = createDiscoveryEngine({
    store: mockStore({ id: 'd' }),
    opts: { pullOnly: true, requestSubjects: ['q-bio.GN'], interests: ['q-bio.GN'] }
  })
  const unwire = wire(discoverer, b)
  await wait(50)

  const known = discoverer.listKnown()
  assert.equal(known.length, 1)
  assert.equal(known[0].bee_key, hex64('gn:bee'))
  assert.equal(known[0].hops, 1, 'served entries are one hop from the responder')

  unwire()
  b.stop(); discoverer.stop()
})

test('discovery: request with no subjects returns everything the responder knows', async () => {
  const b = createDiscoveryEngine({ store: mockStore({ id: 'b' }) })
  const [sockA, sockB] = createStreamPair()
  b.handleConnection(sockB, {})

  const seen = []
  // B's engine writes replies to sockB, which arrive on sockA -- spy there.
  // (A spy on sockB would see our own outgoing requests instead.)
  const spy = readMessages(sockA, (m) => seen.push(m), { maxBytes: 64 * 1024 })
  sendMessage(sockA, { v: 1, type: 'request', subjects: [] })
  await wait(50)
  // B has an empty table: no reply should be sent at all
  assert.equal(seen.length, 0)

  // Now teach B one entry, then request again (past the rate window is not
  // needed: MSG_RATE_MAX=10 covers two requests)
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [entry()] })
  await wait(30)
  sendMessage(sockA, { v: 1, type: 'request', subjects: [] })
  await wait(50)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].type, 'announce')
  assert.equal(seen[0].publishers.length, 1)

  spy()
  b.stop()
  sockA.destroy(); sockB.destroy()
})

test('discovery: entries outside a node\'s interests are neither stored nor relayed', async () => {
  const relay = createDiscoveryEngine({
    store: mockStore({ id: 'relay' }),
    opts: { interests: ['cs.LG'], MSG_RATE_MAX: 1000 }
  })
  const downstream = createDiscoveryEngine({
    store: mockStore({ id: 'down' }),
    opts: { MSG_RATE_MAX: 1000 }
  })
  const unwire = wire(relay, downstream)
  await wait(50)

  // A q-bio.GN announcement reaches the relay: within its interests? No.
  const [sockA, sockRelay] = createStreamPair()
  relay.handleConnection(sockRelay, {})
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [entry({ subjects: ['q-bio.GN'] })] })
  await wait(50)
  assert.equal(relay.listKnown().length, 0, 'out-of-interest entry not stored')
  assert.equal(downstream.listKnown().length, 0, '...and not relayed')

  // A cs.LG announcement: within interests -> stored and relayed
  sendMessage(sockA, { v: 1, type: 'announce', publishers: [entry({ bee_key: hex64('cs:pub'), subjects: ['cs.LG'] })] })
  await wait(50)
  assert.equal(relay.listKnown().length, 1)
  assert.equal(downstream.listKnown().length, 1)

  unwire()
  sockA.destroy(); sockRelay.destroy()
  relay.stop(); downstream.stop()
})

// ---- persistence -------------------------------------------------------

test('discovery: known publishers survive engine restarts via SQLite', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-disc-persist-'))
  const dbPath = path.join(tmpDir, 'discovery.db')
  try {
    const store1 = mockStore({ id: 'b', dbPath })
    const engine1 = createDiscoveryEngine({ store: store1 })
    const [sockA, sockB] = createStreamPair()
    engine1.handleConnection(sockB, {})
    sendMessage(sockA, { v: 1, type: 'announce', publishers: [entry()] })
    await wait(50)
    assert.equal(engine1.listKnown().length, 1)
    engine1.stop()
    store1.db.close()

    // Fresh engine, same backing file: entries persist (like a restart)
    const store2 = mockStore({ id: 'b2', dbPath })
    const engine2 = createDiscoveryEngine({ store: store2 })
    const rows = engine2.listKnown()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].bee_key, entry().bee_key)
    engine2.stop()
    store2.db.close()

    // Standalone reader path (web API / CLI use this)
    const store3 = mockStore({ id: 'b3', dbPath })
    assert.equal(listKnownPublishers(store3, null).length, 1)
    assert.equal(listKnownPublishers(store3, 'q-bio.GN').length, 1)
    assert.equal(listKnownPublishers(store3, 'cs.LG').length, 0)
    store3.db.close()
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})