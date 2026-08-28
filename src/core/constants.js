'use strict'

// Pharos constants: topic names, version strings, default paths

const PHAROS_VERSION = 'pharos-v1'
const ARCHIVE_TOPIC = `pharos-archive-${PHAROS_VERSION}`
const BLOB_TRANSFER_TOPIC = `pharos-blob-transfer-${PHAROS_VERSION}`

// Default data directory (relative to project root)
const DEFAULT_DATA_DIR = 'data'

// SQLite database filename within data dir
const SQLITE_DB_NAME = 'search.db'

// Hyperdrive subdirectory within data dir
const STORE_DIR = 'store'

// Hyperbee subdirectory within data dir
const INDEX_DIR = 'index'

// Web UI port
const DEFAULT_WEB_PORT = 8093

// ORCID OAuth callback port (mock in MVP)
const ORCID_CALLBACK_PORT = 8443

// Hyperbee key prefixes
const KEY_PREFIX = {
  PAPER: 'paper:',
  HASH: 'hash:',
  DOI: 'doi:',
  CATEGORY: 'category:',
  ORCID: 'orcid:'
}

module.exports = {
  PHAROS_VERSION,
  ARCHIVE_TOPIC,
  BLOB_TRANSFER_TOPIC,
  DEFAULT_DATA_DIR,
  SQLITE_DB_NAME,
  STORE_DIR,
  INDEX_DIR,
  DEFAULT_WEB_PORT,
  ORCID_CALLBACK_PORT,
  KEY_PREFIX
}