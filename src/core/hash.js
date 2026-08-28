'use strict'

const sodium = require('sodium-native')

/**
 * Compute BLAKE2b-256 hash of a buffer.
 * @param {Buffer} buffer
 * @returns {string} 'blake2b:{hex digest}'
 */
function computeHash(buffer) {
  const out = Buffer.alloc(32)
  sodium.crypto_generichash(out, buffer)
  return `blake2b:${out.toString('hex')}`
}

/**
 * Derive Hyperdrive blob key for a paper.
 * @param {string} paperId - e.g. 'pharos:q-bio.GN/2026.08.28.001'
 * @param {number} version - version number (1-based)
 * @param {string} filename - e.g. 'fulltext.pdf'
 * @returns {string} Hyperdrive path
 */
function blobKey(paperId, version, filename) {
  // paperId format: pharos:{subject}/{date}/{seq}
  // e.g. pharos:q-bio.GN/2026.08.28.001 → q-bio.GN/2026.08.28.001
  const idPart = paperId.replace(/^pharos:/, '')
  return `/papers/${idPart}/v${version}/${filename}`
}

/**
 * Derive subject category from paper_id.
 * @param {string} paperId
 * @returns {string} subject category, e.g. 'q-bio.GN'
 */
function subjectFromPaperId(paperId) {
  const idPart = paperId.replace(/^pharos:/, '')
  return idPart.split('/')[0]
}

/**
 * Generate a new paper_id for direct publishing.
 * @param {string} subject - e.g. 'q-bio.GN'
 * @param {number} seq - daily sequence number
 * @returns {string} paper_id
 */
function makePaperId(subject, seq) {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '.')
  return `pharos:${subject}/${date}/${String(seq).padStart(3, '0')}`
}

module.exports = {
  computeHash,
  blobKey,
  subjectFromPaperId,
  makePaperId
}