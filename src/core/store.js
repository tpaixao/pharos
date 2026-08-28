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
 * Initialize the Pharos storage layer: Hyperdrive (blobs), Hyperbee (metadata index),
 * and SQLite FTS5 (full-text search).
 *
 * @param {string} dataDir - absolute or relative path to data directory
 * @returns {Promise<object>} { drive, bee, db, close }
 */
async function initStore(dataDir) {
  if (storeInstance) return storeInstance

  // Ensure data directories exist
  const storePath = path.join(dataDir, STORE_DIR)
  const indexPath = path.join(dataDir, INDEX_DIR)
  fs.mkdirSync(storePath, { recursive: true })
  fs.mkdirSync(indexPath, { recursive: true })

  // Corestore manages multiple hypercores for Hyperdrive
  const corestore = new Corestore(storePath)

  // Hyperdrive for blob storage (PDFs, metadata JSON)
  const drive = new Hyperdrive(corestore, { name: 'pharos-drive' })

  // Hyperbee for structured metadata index (uses its own Hypercore)
  const indexCore = new Hypercore(path.join(indexPath, 'bee-core'))
  const bee = new Hyperbee(indexCore, {
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
 * Close all storage resources gracefully.
 */
async function close() {
  if (!storeInstance) return

  const { drive, bee, db, corestore } = storeInstance

  try { db.close() } catch (_) {}
  try { await bee.close() } catch (_) {}
  try { await drive.close() } catch (_) {}
  try { await corestore.close() } catch (_) {}

  storeInstance = null
}

/**
 * Get the current store instance (must call initStore first).
 * @returns {object}
 */
function getStore() {
  if (!storeInstance) throw new Error('Store not initialized. Call initStore() first.')
  return storeInstance
}

module.exports = { initStore, getStore, close }