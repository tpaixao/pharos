'use strict'

const { computeHash } = require('../core/hash')
const { KEY_PREFIX } = require('../core/constants')

/**
 * Pin announcement protocol over a replicated stream.
 *
 * This is a lightweight side-channel on top of Hypercore's native replication.
 * Messages are length-prefixed JSON, but we use a magic prefix byte (0x50 = 'P')
 * to distinguish our messages from Hypercore replication noise.
 *
 * Wire format: [0x50 magic] [4-byte big-endian length] [JSON payload]
 *
 * Message types:
 *   { type: "pin_announce", hashes: ["blake2b:..."] }
 *   { type: "pin_request", paper_ids: ["pharos:..."] }
 */

const MAGIC_BYTE = 0x50
const HEADER_SIZE = 5 // 1 magic + 4 length

function isOurMessage(chunk) {
  return chunk.length >= HEADER_SIZE && chunk[0] === MAGIC_BYTE
}

/**
 * Send a length-prefixed JSON message with magic byte prefix.
 * @param {Duplex} stream
 * @param {object} msg
 */
function sendMessage(stream, msg) {
  const json = Buffer.from(JSON.stringify(msg))
  const header = Buffer.alloc(HEADER_SIZE)
  header[0] = MAGIC_BYTE
  header.writeUInt32BE(json.length, 1)
  stream.write(Buffer.concat([header, json]))
}

/**
 * Read messages from a stream, filtering out non-magic chunks.
 * @param {Duplex} stream
 * @param {function} onMessage
 * @returns {function} cleanup
 */
function readMessages(stream, onMessage) {
  let buffer = Buffer.alloc(0)

  const onData = (chunk) => {
    // Skip chunks that don't start with our magic byte
    if (chunk.length > 0 && chunk[0] !== MAGIC_BYTE) {
      // This is likely Hypercore replication data, ignore it
      return
    }

    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= HEADER_SIZE) {
      if (buffer[0] !== MAGIC_BYTE) {
        // Discard leading bytes until we find magic
        buffer = buffer.slice(1)
        continue
      }
      const msgLen = buffer.readUInt32BE(1)
      if (buffer.length < HEADER_SIZE + msgLen) break

      const json = buffer.slice(HEADER_SIZE, HEADER_SIZE + msgLen)
      buffer = buffer.slice(HEADER_SIZE + msgLen)

      let msg
      try {
        msg = JSON.parse(json.toString('utf-8'))
      } catch (err) {
        // Not our data, skip
        continue
      }
      onMessage(msg)
    }
  }

  stream.on('data', onData)
  return () => stream.off('data', onData)
}

/**
 * Announce pins on a connection.
 * @param {Duplex} stream
 * @param {string[]} hashes - content hashes this node pins
 */
function announcePins(stream, hashes) {
  sendMessage(stream, { type: 'pin_announce', hashes })
}

module.exports = {
  sendMessage,
  readMessages,
  announcePins,
  MAGIC_BYTE
}