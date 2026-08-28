'use strict'

const { KEY_PREFIX } = require('../core/constants')
const { getStore } = require('../core/store')

/**
 * Track replication health: pin counts, at-risk papers.
 *
 * A paper is "at-risk" if replicated_by has < 3 entries.
 * A paper is "healthy" if replicated_by has >= 3 entries.
 */

const MIN_REPLICAS = 3

/**
 * Get the replication health status for all papers.
 * @returns {Promise<object>} { total, healthy, atRisk, papers: [{paper_id, replicas, status}] }
 */
async function healthReport() {
  const store = getStore()
  const { bee } = store

  const papers = []
  let healthy = 0
  let atRisk = 0

  for await (const { key, value } of bee.createReadStream({
    gt: KEY_PREFIX.PAPER,
    lt: KEY_PREFIX.PAPER + '\xff'
  })) {
    const replicas = value.replicated_by?.length || 0
    const status = replicas >= MIN_REPLICAS ? 'healthy' : 'at-risk'
    if (status === 'healthy') healthy++
    else atRisk++
    papers.push({ paper_id: value.paper_id, replicas, status })
  }

  return {
    total: papers.length,
    healthy,
    atRisk,
    minReplicas: MIN_REPLICAS,
    papers: papers.sort((a, b) => a.replicas - b.replicas)
  }
}

/**
 * Get at-risk papers (fewer than MIN_REPLICAS).
 * @returns {Promise<object[]>}
 */
async function atRiskPapers() {
  const report = await healthReport()
  return report.papers.filter(p => p.status === 'at-risk')
}

/**
 * Add a peer to the replicated_by list for a paper.
 * Called when a peer announces they pin a paper.
 *
 * @param {string} paperId
 * @param {string} peerKey - hex peer key
 */
async function addReplica(paperId, peerKey) {
  const store = getStore()
  const { bee } = store

  const entry = await bee.get(`${KEY_PREFIX.PAPER}${paperId}`)
  if (!entry) return

  const meta = entry.value
  if (!meta.replicated_by) meta.replicated_by = []
  if (!meta.replicated_by.includes(peerKey)) {
    meta.replicated_by.push(peerKey)
    await bee.put(`${KEY_PREFIX.PAPER}${paperId}`, meta)
  }

  // Also update the hash entry
  const hashEntry = await bee.get(`${KEY_PREFIX.HASH}${meta.content_hash}`)
  if (hashEntry) {
    const hashMeta = hashEntry.value
    if (!hashMeta.replicated_by) hashMeta.replicated_by = []
    if (!hashMeta.replicated_by.includes(peerKey)) {
      hashMeta.replicated_by.push(peerKey)
      await bee.put(`${KEY_PREFIX.HASH}${meta.content_hash}`, hashMeta)
    }
  }
}

/**
 * Pin a paper locally: fetch the blob and mark as pinned.
 * In the MVP, "pinning" means we have the blob in our local Hyperdrive.
 *
 * @param {string} paperId
 * @returns {Promise<object>} { paper_id, content_hash, pinned: true }
 */
async function pinPaper(paperId) {
  const store = getStore()
  const { bee, drive } = store

  const entry = await bee.get(`${KEY_PREFIX.PAPER}${paperId}`)
  if (!entry) {
    return { paper_id: paperId, pinned: false, error: 'not found' }
  }

  const meta = entry.value
  const blob = await drive.get(meta.blob_key)
  if (!blob) {
    return { paper_id: paperId, pinned: false, error: 'blob not available' }
  }

  // Verify hash
  const { computeHash } = require('../core/hash')
  const actualHash = computeHash(blob)
  if (actualHash !== meta.content_hash) {
    return { paper_id: paperId, pinned: false, error: 'hash mismatch' }
  }

  // Mark as pinned by this node
  const myKey = drive.key.toString('hex')
  if (!meta.replicated_by) meta.replicated_by = []
  if (!meta.replicated_by.includes(myKey)) {
    meta.replicated_by.push(myKey)
    await bee.put(`${KEY_PREFIX.PAPER}${paperId}`, meta)
  }

  return { paper_id: paperId, content_hash: meta.content_hash, pinned: true }
}

/**
 * Get all content hashes this node has (for pin announcements).
 * @returns {Promise<string[]>}
 */
async function getLocalPins() {
  const store = getStore()
  const { bee } = store
  const hashes = []

  for await (const { key, value } of bee.createReadStream({
    gt: KEY_PREFIX.HASH,
    lt: KEY_PREFIX.HASH + '\xff'
  })) {
    hashes.push(key.replace(KEY_PREFIX.HASH, ''))
  }

  return hashes
}

module.exports = {
  healthReport,
  atRiskPapers,
  addReplica,
  pinPaper,
  getLocalPins,
  MIN_REPLICAS
}