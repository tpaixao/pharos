'use strict'

const { computeHash } = require('../core/hash')
const { KEY_PREFIX } = require('../core/constants')

/**
 * Blob request/serve protocol over a dedicated Hyperswarm connection.
 *
 * Problem: We tried multiplexing our JSON blob protocol on the same stream
 * as Hypercore replication, but Hypercore's replication stream sends binary
 * data that corrupts our length-prefixed JSON parsing.
 *
 * Solution: Use a SEPARATE connection (separate swarm topic) for the blob
 * request/serve protocol. The metadata replication (Hyperbee/Hyperdrive)
 * happens on the archive topic via corestore.replicate(). Blob requests
 * happen on a dedicated "blob-transfer" topic where we own the stream entirely.
 *
 * Wire format: 4-byte big-endian length prefix + JSON payload
 * (framing shared with the discovery protocol via ./framing.js)
 *
 * Message types:
 *   Request:  { type: "request_blob", hash: "blake2b:..." }
 *   Response: { type: "blob", hash: "blake2b:...", size: N, data: "<hex>" }
 *   Error:    { type: "error", hash: "blake2b:...", message: "..." }
 */

const { sendMessage, readMessages } = require('./framing')

/**
 * Handle incoming blob requests as a server.
 *
 * @param {Duplex} stream - dedicated blob transfer connection (NOT a corestore replication stream)
 * @param {object} store - store instance
 * @param {object} [opts] - { onPinAnnounce: async (paperId, peerKey) => void }
 */
function serveBlobs(stream, store, opts = {}) {
  const { bee, drive } = store

  readMessages(stream, async (msg) => {
    if (msg.type === 'pin_announce') {
      // Map announced content hashes to paper IDs and record the replica.
      const peerKey = msg.peer_key || 'unknown'
      for (const hash of msg.hashes || []) {
        try {
          const entry = await bee.get(`${KEY_PREFIX.HASH}${hash}`)
          if (!entry || !entry.value.paper_id) continue
          if (opts.onPinAnnounce) {
            await opts.onPinAnnounce(entry.value.paper_id, peerKey)
          }
          console.log(`[blob-transfer] Pin announced by ${peerKey.slice(0, 12)}...: ${entry.value.paper_id}`)
        } catch (err) {
          console.error(`[blob-transfer] Pin announcement handling failed: ${err.message}`)
        }
      }
      return
    }

    if (msg.type !== 'request_blob') return

    const { hash } = msg
    console.log(`[blob-transfer] Blob request: ${hash.slice(0, 20)}...`)

    try {
      const entry = await bee.get(`${KEY_PREFIX.HASH}${hash}`)
      if (!entry) {
        sendMessage(stream, { type: 'error', hash, message: 'not found' })
        return
      }

      const blobKey = entry.value.blob_key
      const blob = await drive.get(blobKey)
      if (!blob) {
        sendMessage(stream, { type: 'error', hash, message: 'blob missing' })
        return
      }

      const actualHash = computeHash(blob)
      if (actualHash !== hash) {
        sendMessage(stream, { type: 'error', hash, message: 'hash mismatch' })
        return
      }

      sendMessage(stream, {
        type: 'blob',
        hash,
        size: blob.length,
        data: blob.toString('hex')
      })
      console.log(`[blob-transfer] Served blob: ${hash.slice(0, 20)}... (${blob.length} bytes)`)
    } catch (err) {
      sendMessage(stream, { type: 'error', hash, message: err.message })
    }
  })
}

/**
 * Request a blob from a peer by content hash.
 *
 * @param {Duplex} stream - dedicated blob transfer connection
 * @param {string} contentHash - blake2b:... hash
 * @param {number} [timeoutMs=10000] - response timeout
 * @returns {Promise<Buffer|null>} blob buffer, verified by hash, or null on failure
 */
function requestBlob(stream, contentHash, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let cleanup = null
    let settled = false

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        if (cleanup) cleanup()
        resolve(null)
      }
    }, timeoutMs)

    cleanup = readMessages(stream, (msg) => {
      if (msg.hash !== contentHash) return
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (cleanup) cleanup()

      if (msg.type === 'blob') {
        const blob = Buffer.from(msg.data, 'hex')
        const actualHash = computeHash(blob)
        if (actualHash !== contentHash) {
          console.error('[blob-transfer] Hash mismatch on received blob!')
          resolve(null)
          return
        }
        console.log(`[blob-transfer] Received blob: ${contentHash.slice(0, 20)}... (${blob.length} bytes)`)
        resolve(blob)
      } else if (msg.type === 'error') {
        console.log(`[blob-transfer] Peer error: ${msg.message}`)
        resolve(null)
      }
    })

    sendMessage(stream, { type: 'request_blob', hash: contentHash })
  })
}

module.exports = {
  sendMessage,
  readMessages,
  serveBlobs,
  requestBlob
}
