'use strict'

const crypto = require('crypto')
const { ARCHIVE_TOPIC, BLOB_TRANSFER_TOPIC } = require('../core/constants')

let archiveSwarmInstance = null
let blobSwarmInstance = null
let connectedPeers = new Set()
let blobConnections = []

/**
 * Derive a Hyperswarm topic buffer from a string.
 * @param {string} name - topic name
 * @returns {Buffer} 32-byte topic key
 */
function topicFromName(name) {
  return crypto.createHash('sha256').update(name).digest()
}

/**
 * Get the global archive topic (for metadata replication).
 * @returns {Buffer}
 */
function archiveTopic() {
  return topicFromName(ARCHIVE_TOPIC)
}

/**
 * Get the blob transfer topic (for blob request/serve).
 * @returns {Buffer}
 */
function blobTransferTopic() {
  return topicFromName(BLOB_TRANSFER_TOPIC)
}

/**
 * Get a per-category topic.
 * @param {string} subject - e.g. 'q-bio.GN'
 * @returns {Buffer}
 */
function categoryTopic(subject) {
  return topicFromName(`pharos-category-${subject.replace(/\./g, '').toLowerCase()}`)
}

/**
 * Start the archive swarm for metadata replication (Hyperbee/Hyperdrive).
 * This swarm handles corestore.replicate() for syncing the index and blobs.
 *
 * @param {object} store - store instance from initStore/initReplicaStore
 * @param {object} opts - { server: true, client: true, topics: ['q-bio.GN', ...] }
 * @returns {Promise<object>} { swarm, peers, peerKeys, stop }
 */
async function startArchiveSwarm(store, opts = {}) {
  const Hyperswarm = require('hyperswarm')
  const { server = true, client = true, topics = [] } = opts

  const swarm = new Hyperswarm()
  const { corestore } = store

  swarm.on('connection', (conn, info) => {
    const peerKey = info.publicKey?.toString('hex') || 'unknown'
    connectedPeers.add(peerKey)
    console.log(`[archive-swarm] Peer connected: ${peerKey.slice(0, 12)}...`)

    conn.on('error', (err) => {
      console.log(`[archive-swarm] Connection error: ${err.message}`)
      connectedPeers.delete(peerKey)
    })

    conn.on('close', () => {
      connectedPeers.delete(peerKey)
      console.log(`[archive-swarm] Peer disconnected: ${peerKey.slice(0, 12)}...`)
    })

    // Replicate all cores in the corestore over this connection
    corestore.replicate(conn)
  })

  const archTopic = archiveTopic()
  swarm.join(archTopic, { server, client })
  console.log(`[archive-swarm] Joined archive topic: ${ARCHIVE_TOPIC}`)

  for (const subject of topics) {
    const catTopic = categoryTopic(subject)
    swarm.join(catTopic, { server, client })
    console.log(`[archive-swarm] Joined category topic: ${subject}`)
  }

  await swarm.flush()

  archiveSwarmInstance = {
    swarm,
    get peers() { return connectedPeers.size },
    peerKeys: connectedPeers,
    connections: () => Array.from(swarm.connections),
    stop: async () => {
      connectedPeers.clear()
      await swarm.destroy()
      archiveSwarmInstance = null
    }
  }
  return archiveSwarmInstance
}

/**
 * Start the blob transfer swarm (dedicated channel for blob request/serve).
 * Connections on this swarm are NOT used for corestore replication.
 * They are clean streams where we own the protocol entirely.
 *
 * @param {function} onConnection - callback(conn, info) for each new connection
 * @param {object} opts - { server: true, client: true }
 * @returns {Promise<object>} { swarm, connections, stop }
 */
async function startBlobSwarm(onConnection, opts = {}) {
  const Hyperswarm = require('hyperswarm')
  const { server = true, client = true } = opts

  const swarm = new Hyperswarm()

  swarm.on('connection', (conn, info) => {
    const peerKey = info.publicKey?.toString('hex') || 'unknown'
    console.log(`[blob-swarm] Peer connected: ${peerKey.slice(0, 12)}...`)

    conn.on('error', (err) => {
      console.log(`[blob-swarm] Connection error: ${err.message}`)
    })

    conn.on('close', () => {
      console.log(`[blob-swarm] Peer disconnected: ${peerKey.slice(0, 12)}...`)
      blobConnections = blobConnections.filter(c => c !== conn)
    })

    blobConnections.push(conn)

    if (onConnection) onConnection(conn, info)
  })

  const bTopic = blobTransferTopic()
  swarm.join(bTopic, { server, client })
  console.log(`[blob-swarm] Joined blob transfer topic: ${BLOB_TRANSFER_TOPIC}`)

  await swarm.flush()

  blobSwarmInstance = {
    swarm,
    get connections() { return blobConnections },
    stop: async () => {
      blobConnections = []
      await swarm.destroy()
      blobSwarmInstance = null
    }
  }
  return blobSwarmInstance
}

/**
 * Stop all swarms.
 */
async function stopAll() {
  if (archiveSwarmInstance) await archiveSwarmInstance.stop()
  if (blobSwarmInstance) await blobSwarmInstance.stop()
}

/**
 * Get active peer count (archive swarm).
 * @returns {number}
 */
function peerCount() {
  return connectedPeers.size
}

module.exports = {
  startArchiveSwarm,
  startBlobSwarm,
  stopAll,
  archiveTopic,
  blobTransferTopic,
  categoryTopic,
  topicFromName,
  peerCount
}