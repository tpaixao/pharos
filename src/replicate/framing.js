'use strict'

/**
 * Shared length-prefixed JSON framing for Pharos side-channel protocols
 * (blob-transfer swarm, discovery swarm).
 *
 * Wire format: 4-byte big-endian length prefix + JSON payload.
 *
 * Extracted verbatim from replicate.js (GOSSIP_IMPL_PLAN.md, M1) so the
 * discovery protocol can reuse it; the blob protocol behavior is
 * unchanged, replicate.js re-exports these.
 *
 * New in the extraction: readMessages takes an optional maxBytes cap.
 * Without one, a malicious or buggy peer can send a huge length prefix
 * (up to 4 GiB) and make the reader buffer unbounded memory while
 * waiting for a message that never completes. On violation the stream
 * is destroyed -- the framing cannot resync anyway.
 *
 * The default cap is deliberately generous (256 MiB): blob-transfer
 * messages carry whole PDFs hex-encoded inside JSON (~2x the PDF size,
 * and uploads are capped at 50MB), so a tight cap would break blob
 * serving. Discovery messages are tiny and pass a strict 64 KiB cap.
 */

const HEADER_SIZE = 4

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

/**
 * Send a length-prefixed JSON message over a stream.
 * @param {Duplex} stream
 * @param {object} msg
 */
function sendMessage(stream, msg) {
  const json = Buffer.from(JSON.stringify(msg))
  const header = Buffer.alloc(HEADER_SIZE)
  header.writeUInt32BE(json.length, 0)
  stream.write(Buffer.concat([header, json]))
}

/**
 * Read messages from a stream. Calls onMessage for each parsed message.
 * Returns a cleanup function.
 *
 * @param {Duplex} stream
 * @param {function} onMessage - (msg) => void (may return a promise; it is
 *   the caller's job to catch rejections if it does)
 * @param {object} [opts] - { maxBytes = DEFAULT_MAX_BYTES } - messages whose
 *   declared length exceeds this are treated as a protocol violation and
 *   the stream is destroyed
 * @returns {function} cleanup - removes listener
 */
function readMessages(stream, onMessage, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES
  let buffer = Buffer.alloc(0)
  let destroyed = false

  const onData = (chunk) => {
    if (destroyed) return
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= HEADER_SIZE) {
      const msgLen = buffer.readUInt32BE(0)
      if (msgLen > maxBytes) {
        console.error(`[framing] Message length ${msgLen} exceeds cap ${maxBytes}, destroying connection`)
        destroyed = true
        stream.destroy()
        return
      }
      if (buffer.length < HEADER_SIZE + msgLen) break

      const json = buffer.slice(HEADER_SIZE, HEADER_SIZE + msgLen)
      buffer = buffer.slice(HEADER_SIZE + msgLen)

      let msg
      try {
        msg = JSON.parse(json.toString('utf-8'))
      } catch (err) {
        console.error('[framing] Failed to parse message:', err.message)
        continue
      }
      onMessage(msg)
    }
  }

  stream.on('data', onData)
  return () => stream.off('data', onData)
}

module.exports = { sendMessage, readMessages, HEADER_SIZE, DEFAULT_MAX_BYTES }