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
 */
async function close() {
  if (!storeInstance) return

  const { db, bee, drive, corestore } = storeInstance

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

module.exports = { initStore, initReplicaStore, getStore, close }