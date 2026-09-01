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

const { startArchiveSwarm, startBlobSwarm, stopAll } = require('./swarm')
const { serveBlobs, sendMessage } = require('./replicate')
const { getLocalPins, addReplica, pinPaper } = require('./health')

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

  return { archiveSwarm, blobSwarm, topics: ['archive', 'blob-transfer', ...subscribe] }
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

module.exports = { startServing, waitForArchiveSync, pinWithSwarmFallback }
