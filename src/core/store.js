'use strict'

const Hyperdrive = require('hyperdrive')
const Hyperbee = require('hyperbee')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const { DatabaseSync } = require('node:sqlite')
const path = require('path')
const fs = require('fs')

const { SQLITE_DB_NAME, STORE_DIR, INDEX_DIR } = require('./constants')

let storeInstance = null

/**
 * Initialize the Pharos storage layer: Corestore (manages all hypercores),
 * Hyperdrive (blobs), Hyperbee (metadata index), and SQLite FTS5 (full-text search).
 *
 * @param {string} dataDir - absolute or relative path to data directory
 * @returns {Promise<object>} { drive, bee, db, corestore, dataDir, close }
 */
async function initStore(dataDir) {
  if (storeInstance) return storeInstance

  // Ensure data directories exist
  const storePath = path.join(dataDir, STORE_DIR)
  const indexPath = path.join(dataDir, INDEX_DIR)
  fs.mkdirSync(storePath, { recursive: true })
  fs.mkdirSync(indexPath, { recursive: true })

  // Single Corestore manages all hypercores for both Hyperdrive and Hyperbee
  const corestore = new Corestore(storePath)

  // Hyperdrive for blob storage (PDFs, metadata JSON)
  const drive = new Hyperdrive(corestore, { name: 'pharos-drive' })

  // Hyperbee for structured metadata index (uses a core from the same Corestore)
  const beeCore = corestore.get({ name: 'pharos-bee' })
  const bee = new Hyperbee(beeCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })

  // SQLite FTS5 for full-text search
  const dbPath = path.join(dataDir, SQLITE_DB_NAME)
  const db = new DatabaseSync(dbPath)

  // Create FTS5 table if not exists
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
      paper_id UNINDEXED,
      title,
      authors,
      abstract,
      fulltext,
      tokenize = 'porter unicode61'
    );
  `)

  // Wait for Hyperdrive and Hyperbee to be ready
  await drive.ready()
  await bee.ready()

  storeInstance = { drive, bee, db, corestore, dataDir, close }
  return storeInstance
}

/**
 * Initialize a subscriber store that replicates from a publisher.
 * Creates a Corestore with read-only replicas of the publisher's Hyperbee and Hyperdrive.
 *
 * @param {string} dataDir - local data directory for the subscriber
 * @param {string} publisherBeeKey - hex key of publisher's Hyperbee core
 * @param {string} [publisherDriveKey] - hex key of publisher's Hyperdrive (optional, can be learned from metadata)
 * @returns {Promise<object>} { drive, bee, db, corestore, dataDir, close }
 */
async function initReplicaStore(dataDir, publisherBeeKey, publisherDriveKey) {
  if (storeInstance) return storeInstance

  const storePath = path.join(dataDir, STORE_DIR)
  const indexPath = path.join(dataDir, INDEX_DIR)
  fs.mkdirSync(storePath, { recursive: true })
  fs.mkdirSync(indexPath, { recursive: true })

  const corestore = new Corestore(storePath)

  // Read-only replica of publisher's Hyperbee
  const beeCore = corestore.get({ key: Buffer.from(publisherBeeKey, 'hex') })
  const bee = new Hyperbee(beeCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })

  // Read-only replica of publisher's Hyperdrive (if key provided)
  let drive = null
  if (publisherDriveKey) {
    drive = new Hyperdrive(corestore, { key: Buffer.from(publisherDriveKey, 'hex') })
  } else {
    // Create a local drive for storing fetched blobs
    drive = new Hyperdrive(corestore, { name: 'pharos-drive-local' })
  }

  // SQLite for local search
  const dbPath = path.join(dataDir, SQLITE_DB_NAME)
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS papers_fts USING fts5(
      paper_id UNINDEXED,
      title,
      authors,
      abstract,
      fulltext,
      tokenize = 'porter unicode61'
    );
  `)

  await drive.ready()
  await bee.ready()

  storeInstance = { drive, bee, db, corestore, dataDir, isReplica: true, close }
  return storeInstance
}

/**
 * Close all storage resources gracefully.
 * Idempotent: safe to call multiple times.
 * Uses a timeout fallback to force-destroy if clean close hangs.
 */
let closing = false
async function close() {
  if (!storeInstance || closing) return
  closing = true

  const { db, bee, drive, corestore } = storeInstance

  const forceClose = setTimeout(() => {
    console.error('[store] Close timed out, forcing exit')
    storeInstance = null
  }, 5000)
  forceClose.unref()

  try { db.close() } catch (_) {}
  try { await bee.close() } catch (_) {}
  try { await drive.close() } catch (_) {}
  try { await corestore.close() } catch (_) {}

  clearTimeout(forceClose)
  storeInstance = null
  closing = false
}

/**
 * Get the current store instance (must call initStore first).
 * @returns {object}
 */
function getStore() {
  if (!storeInstance) throw new Error('Store not initialized. Call initStore() first.')
  return storeInstance
}

/**
 * Get total disk usage of the data directory.
 * @returns {Promise<object>} { store_bytes, index_bytes, total_bytes }
 */
async function getDiskUsage() {
  if (!storeInstance) throw new Error('Store not initialized')
  const { dataDir } = storeInstance
  const { STORE_DIR, INDEX_DIR, SQLITE_DB_NAME } = require('./constants')

  const storeBytes = await dirSize(path.join(dataDir, STORE_DIR))
  const indexBytes = await dirSize(path.join(dataDir, INDEX_DIR))
  let dbBytes = 0
  try { dbBytes = fs.statSync(path.join(dataDir, SQLITE_DB_NAME)).size } catch (_) {}

  return {
    store_bytes: storeBytes,
    index_bytes: indexBytes,
    db_bytes: dbBytes,
    total_bytes: storeBytes + indexBytes + dbBytes
  }
}

function dirSize(dirPath) {
  return new Promise((resolve) => {
    let total = 0
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          total += fs.statSync(full).size
          try {
            const sub = fs.readdirSync(full, { withFileTypes: true })
            for (const s of sub) {
              try { total += fs.statSync(path.join(full, s.name)).size } catch (_) {}
            }
          } catch (_) {}
        } else {
          try { total += fs.statSync(full).size } catch (_) {}
        }
      }
    } catch (_) {}
    resolve(total)
  })
}

/**
 * Evict oldest unpinned papers to free disk space.
 * A paper is "pinned" if replicated_by has >= 2 entries (at least one other peer has it).
 * Removes the PDF blob from Hyperdrive and deletes Hyperbee entries.
 *
 * @param {number} maxBytes - target maximum total bytes; evict until under threshold
 * @returns {Promise<object>} { evicted: number, freed_bytes: number }
 */
async function evictUnpinned(maxBytes) {
  if (!storeInstance) throw new Error('Store not initialized')
  const { bee, drive, db } = storeInstance

  const allPapers = []
  for await (const { key, value } of bee.createReadStream({
    gt: KEY_PREFIX.PAPER,
    lt: KEY_PREFIX.PAPER + '\xff'
  })) {
    const replicas = value.replicated_by?.length || 0
    allPapers.push({ key, value, replicas })
  }
  allPapers.sort((a, b) => (a.value.published_at || '').localeCompare(b.value.published_at || ''))

  let usage = await getDiskUsage()
  let evicted = 0
  let freedBytes = 0

  for (const { key, value, replicas } of allPapers) {
    if (usage.total_bytes <= maxBytes) break
    if (replicas >= 2) continue

    const paperSize = await getBlobSize(drive, value.blob_key)

    try { await drive.del(value.blob_key) } catch (_) {}
    const metaKey = value.blob_key.replace('fulltext.pdf', 'metadata.json')
    try { await drive.del(metaKey) } catch (_) {}

    try { await bee.del(key) } catch (_) {}
    try { await bee.del(`${KEY_PREFIX.HASH}${value.content_hash}`) } catch (_) {}
    try { await bee.del(`${KEY_PREFIX.CATEGORY}${value.subject}:recent:${value.paper_id}`) } catch (_) {}
    if (value.doi) {
      try { await bee.del(`${KEY_PREFIX.DOI}${value.doi}`) } catch (_) {}
    }

    try {
      db.prepare('DELETE FROM papers_fts WHERE paper_id = ?').run(value.paper_id)
    } catch (_) {}

    evicted++
    freedBytes += paperSize
    usage = await getDiskUsage()
  }

  return { evicted, freed_bytes: freedBytes }
}

async function getBlobSize(drive, blobKey) {
  try {
    const entry = await drive.entry(blobKey)
    if (entry && entry.blob) return entry.blob.byteLength
    if (entry && entry.value) return entry.value.length
  } catch (_) {}
  return 0
}

module.exports = { initStore, initReplicaStore, getStore, close, getDiskUsage, evictUnpinned }
