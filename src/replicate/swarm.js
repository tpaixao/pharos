'use strict'

const crypto = require('crypto')
const { ARCHIVE_TOPIC } = require('../core/constants')

let swarmInstance = null
let connectedPeers = new Set()

/**
 * Derive a Hyperswarm topic buffer from a string.
 * @param {string} name - topic name
 * @returns {Buffer} 32-byte topic key
 */
function topicFromName(name) {
  return crypto.createHash('sha256').update(name).digest()
}

/**
 * Get the global archive topic.
 * @returns {Buffer}
 */
function archiveTopic() {
  return topicFromName(ARCHIVE_TOPIC)
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
 * Start a Hyperswarm node that replicates the store's cores.
 *
 * @param {object} store - store instance from initStore/initReplicaStore
 * @param {object} opts - { server: true, client: true, topics: ['q-bio.GN', ...] }
 * @returns {Promise<object>} { swarm, peers, stop }
 */
async function startSwarm(store, opts = {}) {
  const Hyperswarm = require('hyperswarm')
  const { server = true, client = true, topics = [] } = opts

  const swarm = new Hyperswarm()
  const { corestore, bee, drive } = store

  // Track peer connections
  swarm.on('connection', (conn, info) => {
    const peerKey = info.publicKey?.toString('hex') || 'unknown'
    connectedPeers.add(peerKey)
    console.log(`[swarm] Peer connected: ${peerKey.slice(0, 12)}...`)

    // Replicate all cores in the corestore over this connection
    conn.on('error', (err) => {
      console.log(`[swarm] Connection error: ${err.message}`)
      connectedPeers.delete(peerKey)
    })

    conn.on('close', () => {
      connectedPeers.delete(peerKey)
      console.log(`[swarm] Peer disconnected: ${peerKey.slice(0, 12)}...`)
    })

    // Pipe the corestore replication stream
    corestore.replicate(conn)
  })

  // Join the global archive topic
  const archTopic = archiveTopic()
  swarm.join(archTopic, { server, client })
  console.log(`[swarm] Joined archive topic: ${ARCHIVE_TOPIC}`)

  // Join per-category topics
  for (const subject of topics) {
    const catTopic = categoryTopic(subject)
    swarm.join(catTopic, { server, client })
    console.log(`[swarm] Joined category topic: ${subject}`)
  }

  // Wait for swarm ready
  await swarm.flush()

  swarmInstance = {
    swarm,
    get peers() { return connectedPeers.size },
    peerKeys: connectedPeers,
    stop
  }
  return swarmInstance

  async function stop() {
    for (const peerKey of connectedPeers) {
      // connections auto-close
    }
    connectedPeers.clear()
    await swarm.destroy()
    swarmInstance = null
  }
}

/**
 * Stop the active swarm if running.
 */
async function stopSwarm() {
  if (swarmInstance) {
    await swarmInstance.stop()
  }
}

/**
 * Get active peer count.
 * @returns {number}
 */
function peerCount() {
  return connectedPeers.size
}

module.exports = {
  startSwarm,
  stopSwarm,
  archiveTopic,
  categoryTopic,
  topicFromName,
  peerCount
}