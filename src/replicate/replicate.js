'use strict'

const { computeHash } = require('../core/hash')
const { KEY_PREFIX } = require('../core/constants')

/**
 * Blob request/serve protocol over a raw stream.
 *
 * Message format (length-prefixed JSON):
 *   Request:  { type: "request_blob", hash: "blake2b:..." }
 *   Response: { type: "blob", hash: "blake2b:...", size: N, data: "<hex>" }
 *   Error:    { type: "error", hash: "blake2b:...", message: "..." }
 *
 * Wire format: 4-byte big-endian length prefix + JSON payload
 */

const HEADER_SIZE = 4

/**
 * Send a length-prefixed JSON message over a stream.
 * @param {Duplex} stream
 * @param {object} msg
 */
function sendMessage(stream, msg) {
  const json = Buffer.from(JSON.stringify(msg))
  const header = Buffer.allocUnsafe(HEADER_SIZE)
  header.writeUInt32BE(json.length, 0)
  stream.write(Buffer.concat([header, json]))
}

/**
 * Read messages from a stream. Calls onMessage for each parsed message.
 * Returns a cleanup function.
 * @param {Duplex} stream
 * @param {function} onMessage - async (msg) => void
 * @returns {function} cleanup - removes listener
 */
function readMessages(stream, onMessage) {
  let buffer = Buffer.alloc(0)

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= HEADER_SIZE) {
      const msgLen = buffer.readUInt32BE(0)
      if (buffer.length < HEADER_SIZE + msgLen) break

      const json = buffer.slice(HEADER_SIZE, HEADER_SIZE + msgLen)
      buffer = buffer.slice(HEADER_SIZE + msgLen)

      let msg
      try {
        msg = JSON.parse(json.toString('utf-8'))
      } catch (err) {
        console.error('[replicate] Failed to parse message:', err.message)
        continue
      }
      onMessage(msg)
    }
  }

  stream.on('data', onData)
  return () => stream.off('data', onData)
}

/**
 * Handle incoming blob requests as a server.
 * When a peer requests a blob by hash, look it up and serve it.
 *
 * @param {Duplex} stream - the replication connection
 * @param {object} store - store instance
 */
function serveBlobs(stream, store) {
  const { bee, drive } = store

  readMessages(stream, async (msg) => {
    if (msg.type !== 'request_blob') return

    const { hash } = msg
    console.log(`[replicate] Blob request: ${hash.slice(0, 20)}...`)

    try {
      // Look up hash in Hyperbee
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

      // Verify hash before sending
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
      console.log(`[replicate] Served blob: ${hash.slice(0, 20)}... (${blob.length} bytes)`)
    } catch (err) {
      sendMessage(stream, { type: 'error', hash, message: err.message })
    }
  })
}

/**
 * Request a blob from a peer by content hash.
 *
 * @param {Duplex} stream - the replication connection
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
        // Verify hash
        const actualHash = computeHash(blob)
        if (actualHash !== contentHash) {
          console.error('[replicate] Hash mismatch on received blob!')
          resolve(null)
          return
        }
        console.log(`[replicate] Received blob: ${contentHash.slice(0, 20)}... (${blob.length} bytes)`)
        resolve(blob)
      } else if (msg.type === 'error') {
        console.log(`[replicate] Peer error: ${msg.message}`)
        resolve(null)
      }
    })

    // Send request
    sendMessage(stream, { type: 'request_blob', hash: contentHash })
  })
}

/**
 * Announce pins on a swarm connection.
 * Notifies peers what blobs this node has available.
 *
 * @param {Duplex} stream
 * @param {string[]} hashes - content hashes this node pins
 */
function announcePins(stream, hashes) {
  sendMessage(stream, { type: 'pin_announce', hashes })
}

module.exports = {
  sendMessage,
  readMessages,
  serveBlobs,
  requestBlob,
  announcePins
}