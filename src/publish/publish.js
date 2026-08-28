'use strict'

const { getStore } = require('../core/store')
const { computeHash, blobKey, makePaperId, subjectFromPaperId } = require('../core/hash')
const { validateMetadata } = require('../core/schema')
const { KEY_PREFIX } = require('../core/constants')

/**
 * Publish a PDF to Pharos.
 *
 * @param {string} pdfPath - path to the PDF file
 * @param {object} opts - { title, authors[], abstract, subject, signedBy, revises }
 * @returns {Promise<object>} { paper_id, content_hash, blob_key, version }
 */
async function publish(pdfPath, opts) {
  const store = getStore()
  const { drive, bee, db } = store

  // 1. Read PDF and compute hash
  const fs = require('fs')
  const pdfBuffer = fs.readFileSync(pdfPath)
  const contentHash = computeHash(pdfBuffer)

  // 2. Dedup check: if hash already exists, return existing paper_id
  const existingHash = await bee.get(`${KEY_PREFIX.HASH}${contentHash}`)
  if (existingHash) {
    const existingMeta = existingHash.value
    return {
      paper_id: existingMeta.paper_id,
      content_hash: contentHash,
      blob_key: existingMeta.blob_key,
      version: existingMeta.version,
      duplicate: true
    }
  }

  // 3. Determine version and previous_version_hash (if revising)
  let version = 1
  let previousVersionHash = null

  if (opts.revises) {
    const existingPaper = await bee.get(`${KEY_PREFIX.PAPER}${opts.revises}`)
    if (existingPaper) {
      version = existingPaper.value.version + 1
      previousVersionHash = existingPaper.value.content_hash
    }
  }

  // 4. Generate paper_id
  const seq = await getNextSequence()
  const paperId = opts.revises
    ? `${opts.revises.split('/').slice(0, -1).join('/')}/${String(seq).padStart(3, '0')}`
    : makePaperId(opts.subject, seq)

  // 5. Write PDF to Hyperdrive
  const pdfBlobKey = blobKey(paperId, version, 'fulltext.pdf')
  await drive.put(pdfBlobKey, pdfBuffer)

  // 6. Build metadata
  const now = new Date().toISOString()
  const metadata = {
    paper_id: paperId,
    title: opts.title,
    authors: opts.authors || [],
    abstract: opts.abstract || '',
    subject: opts.subject,
    doi: opts.doi || null,
    source: 'pharos',
    version,
    previous_version_hash: previousVersionHash,
    content_hash: contentHash,
    blob_key: pdfBlobKey,
    hyperdrive_key: drive.key.toString('hex'),
    signed_by: opts.signedBy || null,
    published_at: now,
    first_seen: now,
    replicated_by: [drive.key.toString('hex')]
  }

  // 7. Validate metadata
  const { valid, errors } = validateMetadata(metadata)
  if (!valid) {
    throw new Error(`Metadata validation failed: ${errors.join(', ')}`)
  }

  // 8. Write metadata.json to Hyperdrive
  const metaBlobKey = blobKey(paperId, version, 'metadata.json')
  await drive.put(metaBlobKey, Buffer.from(JSON.stringify(metadata, null, 2)))

  // 9. Insert into Hyperbee
  await bee.put(`${KEY_PREFIX.PAPER}${paperId}`, metadata)
  await bee.put(`${KEY_PREFIX.HASH}${contentHash}`, {
    paper_id: paperId,
    blob_key: pdfBlobKey,
    type: 'pdf',
    size: pdfBuffer.length,
    replicated_by: metadata.replicated_by
  })
  if (opts.doi) {
    await bee.put(`${KEY_PREFIX.DOI}${opts.doi}`, { paper_id: paperId })
  }

  // 10. Index in FTS5
  await addToIndex(db, paperId, metadata, pdfBuffer)

  return {
    paper_id: paperId,
    content_hash: contentHash,
    blob_key: pdfBlobKey,
    version,
    duplicate: false
  }
}

/**
 * Retrieve a paper's PDF buffer from Hyperdrive.
 * @param {string} paperId
 * @returns {Promise<Buffer|null>}
 */
async function fetchPdf(paperId) {
  const store = getStore()
  const { bee, drive } = store

  const entry = await bee.get(`${KEY_PREFIX.PAPER}${paperId}`)
  if (!entry) return null

  const buf = await drive.get(entry.value.blob_key)
  return buf
}

/**
 * Get paper metadata by paper_id.
 * @param {string} paperId
 * @returns {Promise<object|null>}
 */
async function getPaper(paperId) {
  const store = getStore()
  const entry = await store.bee.get(`${KEY_PREFIX.PAPER}${paperId}`)
  return entry ? entry.value : null
}

/**
 * Browse recent papers in a category.
 * @param {string} subject - e.g. 'q-bio.GN'
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function browseCategory(subject, limit = 20) {
  const store = getStore()
  const prefix = `${KEY_PREFIX.CATEGORY}${subject}:recent`
  const results = []
  for await (const { value } of store.bee.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
    results.push(value)
    if (results.length >= limit) break
  }
  return results
}

/**
 * Get the next sequence number for paper_id generation.
 * Uses a simple counter in Hyperbee.
 * @returns {Promise<number>}
 */
async function getNextSequence() {
  const store = getStore()
  const seqKey = '_meta:next_seq'
  const existing = await store.bee.get(seqKey)
  const next = existing ? existing.value + 1 : 1
  await store.bee.put(seqKey, next)
  return next
}

// --- FTS5 helpers ---

async function addToIndex(db, paperId, metadata, pdfBuffer) {
  let fulltext = ''
  try {
    const pdfParse = require('pdf-parse')
    const parsed = await pdfParse(pdfBuffer)
    fulltext = parsed.text || ''
  } catch (_) {
    // PDF parsing failed; index with empty fulltext
  }

  const authorsStr = metadata.authors.map(a => a.name).join(', ')

  db.prepare(`
    INSERT INTO papers_fts (paper_id, title, authors, abstract, fulltext)
    VALUES (?, ?, ?, ?, ?)
  `).run(paperId, metadata.title, authorsStr, metadata.abstract || '', fulltext)
}

/**
 * Get version history for a paper by traversing previous_version_hash chain.
 * Searches by base paper_id (without sequence suffix) to find all versions.
 * @param {string} paperId - any version's paper_id
 * @returns {Promise<object[]>} array of metadata objects, oldest first
 */
async function getVersions(paperId) {
  const store = getStore()
  const { bee } = store

  // Extract base: pharos:q-bio.GN/2026.08.28/001 -> pharos:q-bio.GN/2026.08.28
  const parts = paperId.split('/')
  const base = parts.slice(0, -1).join('/')

  // Scan all paper: entries with this base prefix
  const prefix = `${KEY_PREFIX.PAPER}${base}/`
  const versions = []
  for await (const { value } of bee.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
    versions.push(value)
  }

  // Sort by version number ascending
  versions.sort((a, b) => a.version - b.version)
  return versions
}

module.exports = { publish, fetchPdf, getPaper, browseCategory, getVersions }
