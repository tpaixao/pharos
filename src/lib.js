'use strict'

const { initStore, initReplicaStore, getStore, close, getDiskUsage, evictUnpinned } = require('./core/store')
const { publish, fetchPdf, getPaper, browseCategory, getVersions } = require('./publish/publish')
const { orcidAuth } = require('./publish/orcid')
const { search, rebuildIndex } = require('./search/index')
const webServer = require('./web/server')
const { computeHash, makePaperId, blobKey, subjectFromPaperId } = require('./core/hash')
const { validateMetadata } = require('./core/schema')

module.exports = {
  initStore,
  initReplicaStore,
  getStore,
  close,
  publish,
  fetchPdf,
  getPaper,
  browseCategory,
  getVersions,
  orcidAuth,
  search,
  rebuildIndex,
  computeHash,
  makePaperId,
  blobKey,
  subjectFromPaperId,
  validateMetadata,
  webServer,
  getDiskUsage,
  evictUnpinned
}