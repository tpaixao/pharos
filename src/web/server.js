'use strict'

/**
 * Pharos Web UI server.
 *
 * Routes:
 *   GET  /                        - Homepage (browse + search + node dashboard)
 *   GET  /paper/:paperId          - Paper detail page
 *   GET  /api/papers              - List papers (?subject=q-bio.GN&limit=20)
 *   GET  /api/paper/:paperId      - Paper metadata JSON
 *   GET  /api/search?q=...        - FTS5 search
 *   GET  /api/versions/:paperId   - Version history
 *   GET  /api/stats               - Archive statistics
 *   GET  /api/disk-usage          - Disk usage breakdown
 *   GET  /pdf/:paperId            - Serve PDF inline
 *   GET  /api/download/:paperId   - Serve PDF as attachment
 *   POST /api/publish             - Upload + publish (multipart)
 *   GET  /api/status              - Node status (papers, keys, db size, is_replica)
 *   GET  /api/keys                - This node's public keys
 *   GET  /api/health               - Replication health report
 *   POST /api/fetch-remote        - Open a replicated store against a publisher
 *   POST /api/pin                 - Pin a paper locally (swarm-assisted fallback)
 *   POST /api/evict               - Evict unpinned papers (dry_run preview or apply)
 *   POST /api/rebuild-index       - Rebuild the FTS5 search index
 *   GET  /api/orcid/status        - Cached ORCID identity, if any
 *   GET  /api/orcid/authorize     - Redirect to ORCID implicit-OpenID authorize URL
 *   POST /api/orcid/callback      - Verify a pasted ORCID access token, cache identity
 *   GET  /api/serve-status        - Embedded replication swarm status
 */

const http = require('http')
const { URL } = require('url')
const fs = require('fs')
const path = require('path')

// Import directly from core modules to avoid circular dependency with lib.js
const { initStore, initReplicaStore, getStore, close, getDiskUsage, evictUnpinned } = require('../core/store')
const { publish, fetchPdf, getPaper, browseCategory, getVersions } = require('../publish/publish')
const {
  orcidAuth, loadCachedOrcid, generateState, getOrcidImplicitUrl,
  verifyAccessToken, saveOrcidConfig
} = require('../publish/orcid')
const { search, rebuildIndex } = require('../search/index')
const { healthReport, pinPaper, getLocalPins, addReplica } = require('../replicate/health')
const { KEY_PREFIX, VALID_SUBJECTS } = require('../core/constants')

let serverInstance = null

// Absolute data directory for the currently running server (set in startServer)
let currentDataDir = null

// Embedded replication swarm state (Phase 5). null when not serving.
let embeddedSwarms = null
let serveEnabled = false
let serveTopics = []

// In-memory ORCID CSRF state map: state -> expiry timestamp (ms)
const ORCID_STATE_TTL_MS = 5 * 60 * 1000
const pendingOrcidStates = new Map()

// Public ORCID client ID (implicit OpenID flow; no client secret involved).
// Mirrors the default baked into src/publish/orcid.js.
const ORCID_PROD_CLIENT_ID = 'APP-YC0U2NG93W401578'

// Max upload size: 50MB
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * Start the Pharos web server.
 * @param {object} opts - { port, dataDir, serve, subscribe }
 * @returns {Promise<http.Server>}
 */
async function startServer(opts = {}) {
  const port = opts.port || 8093
  const dataDir = opts.dataDir || 'data'
  currentDataDir = path.resolve(dataDir)

  // A replica node remembers its publisher keys after `fetch-remote`
  // (dataDir/remote.json). If present, open the replicated store instead
  // of a fresh local one, otherwise browse/pin/health would see nothing.
  const remoteFile = path.join(currentDataDir, 'remote.json')
  if (fs.existsSync(remoteFile)) {
    const remote = JSON.parse(fs.readFileSync(remoteFile, 'utf8'))
    await initReplicaStore(currentDataDir, remote.bee_key, remote.drive_key)
  } else {
    await initStore(currentDataDir)
  }

  // Embedded replication is opt-in at the startServer() API level (keeps
  // library callers and tests network-free by default). The CLI's `web`
  // command opts in explicitly by default via --no-serve semantics.
  serveEnabled = opts.serve === true
  serveTopics = opts.subscribe || []
  if (serveEnabled) {
    try {
      await startEmbeddedSwarms()
    } catch (err) {
      console.error('[web] Failed to start embedded replication:', err.message)
    }
  }

  const server = http.createServer(handleRequest)
  serverInstance = server

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      resolve(server)
    })
  })
}

/**
 * Start the archive + blob swarms for embedded replication (Phase 5).
 * Joins the archive topic (server+client), any subscribed category topics,
 * and the blob-transfer topic to serve blobs and record pin announcements.
 */
async function startEmbeddedSwarms() {
  const { startArchiveSwarm, startBlobSwarm } = require('../replicate/swarm')
  const { serveBlobs, sendMessage } = require('../replicate/replicate')
  const store = getStore()

  const archiveSwarm = await startArchiveSwarm(store, {
    server: true,
    client: true,
    topics: serveTopics
  })

  const blobSwarm = await startBlobSwarm((conn, info) => {
    serveBlobs(conn, store, {
      onPinAnnounce: async (paperId, pk) => {
        try { await addReplica(paperId, pk) } catch (_) {}
      }
    })
    getLocalPins().then((pins) => {
      if (pins.length) {
        sendMessage(conn, { type: 'pin_announce', hashes: pins, peer_key: store.drive.key.toString('hex') })
      }
    }).catch(() => {})
  }, { server: true, client: true })

  embeddedSwarms = { archiveSwarm, blobSwarm, topics: ['archive', 'blob-transfer', ...serveTopics] }
}

/** Stop embedded swarms, if running. Idempotent. */
async function stopEmbeddedSwarms() {
  if (!embeddedSwarms) return
  const { stopAll } = require('../replicate/swarm')
  try { await stopAll() } catch (_) {}
  embeddedSwarms = null
}

async function handleRequest(req, res) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('Referrer-Policy', 'no-referrer')

  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname
  const method = req.method

  // Only allow GET and POST
  if (method !== 'GET' && method !== 'POST') {
    return sendJSON(res, { error: 'Method not allowed' }, 405)
  }

  try {
    // ---- Static pages ----
    if (method === 'GET' && pathname === '/') {
      return sendHTML(res, renderHomepage())
    }

    // Paper detail page: /paper/pharos:q-bio.GN/2026.08.28/001
    if (method === 'GET' && pathname.startsWith('/paper/')) {
      const paperId = decodeURIComponent(pathname.slice('/paper/'.length))
      if (!paperId || paperId.length > 200) {
        return sendHTML(res, renderErrorPage('Invalid paper ID'))
      }
      return sendHTML(res, renderPaperPage(paperId))
    }

    // ---- API routes ----
    if (method === 'GET' && pathname === '/api/papers') {
      const subject = url.searchParams.get('subject') || ''
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50'), 1), 200)
      return sendJSON(res, await listPapers(subject, limit))
    }

    if (method === 'GET' && pathname.startsWith('/api/paper/')) {
      const paperId = decodeURIComponent(pathname.slice('/api/paper/'.length))
      if (!paperId || paperId.length > 200) {
        return sendJSON(res, { error: 'Invalid paper ID' }, 400)
      }
      return sendJSON(res, await getPaper(paperId))
    }

    if (method === 'GET' && pathname === '/api/search') {
      const q = url.searchParams.get('q') || ''
      if (q.length > 500) {
        return sendJSON(res, { error: 'Query too long' }, 400)
      }
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20'), 1), 100)
      return sendJSON(res, search(q, { limit }))
    }

    if (method === 'GET' && pathname.startsWith('/api/versions/')) {
      const paperId = decodeURIComponent(pathname.slice('/api/versions/'.length))
      return sendJSON(res, await getVersions(paperId))
    }

    if (method === 'GET' && pathname === '/api/stats') {
      return sendJSON(res, await getStats())
    }

    if (method === 'GET' && pathname === '/api/disk-usage') {
      return sendJSON(res, await getDiskUsage())
    }

    // ---- Node dashboard (Phase 1) ----
    if (method === 'GET' && pathname === '/api/status') {
      return sendJSON(res, await getNodeStatus())
    }

    if (method === 'GET' && pathname === '/api/keys') {
      return sendJSON(res, getNodeKeys())
    }

    if (method === 'GET' && pathname === '/api/health') {
      return sendJSON(res, await healthReport())
    }

    // ---- Replica support (Phase 2) ----
    if (method === 'POST' && pathname === '/api/fetch-remote') {
      return handleFetchRemote(req, res)
    }

    if (method === 'POST' && pathname === '/api/pin') {
      return handlePin(req, res)
    }

    // ---- Storage management (Phase 3) ----
    if (method === 'POST' && pathname === '/api/evict') {
      return handleEvict(req, res)
    }

    if (method === 'POST' && pathname === '/api/rebuild-index') {
      const count = await rebuildIndex()
      return sendJSON(res, { indexed: count })
    }

    if (method === 'GET' && pathname.startsWith('/api/download/')) {
      const paperId = decodeURIComponent(pathname.slice('/api/download/'.length))
      if (!paperId || paperId.length > 200) {
        return sendJSON(res, { error: 'Invalid paper ID' }, 400)
      }
      return serveDownload(res, paperId)
    }

    // ---- ORCID auth in browser (Phase 4) ----
    if (method === 'GET' && pathname === '/api/orcid/status') {
      return sendJSON(res, getOrcidStatus())
    }

    if (method === 'GET' && pathname === '/api/orcid/authorize') {
      return handleOrcidAuthorize(res, url)
    }

    if (method === 'POST' && pathname === '/api/orcid/callback') {
      return handleOrcidCallback(req, res)
    }

    // ---- Embedded replication (Phase 5) ----
    if (method === 'GET' && pathname === '/api/serve-status') {
      return sendJSON(res, getServeStatus())
    }

    // ---- PDF serving ----
    if (method === 'GET' && pathname.startsWith('/pdf/')) {
      const paperId = decodeURIComponent(pathname.slice('/pdf/'.length))
      if (!paperId || paperId.length > 200) {
        return sendJSON(res, { error: 'Invalid paper ID' }, 400)
      }
      return servePdf(res, paperId)
    }

    // ---- Publish (multipart upload) ----
    if (method === 'POST' && pathname === '/api/publish') {
      // Check content-length to reject oversized uploads early
      const contentLength = parseInt(req.headers['content-length'] || '0')
      if (contentLength > MAX_UPLOAD_BYTES) {
        return sendJSON(res, { error: 'Upload too large (max 50MB)' }, 413)
      }
      return handlePublish(req, res)
    }

    // ---- 404 ----
    return sendJSON(res, { error: 'Not found' }, 404)
  } catch (err) {
    console.error('[web] Error:', err.message)
    return sendJSON(res, { error: 'Internal server error' }, 500)
  }
}

// ---- API handlers ----

async function listPapers(subject, limit) {
  const store = getStore()

  const papers = []
  if (subject) {
    // Browse by subject category
    const results = await browseCategory(subject, limit)
    return { papers: results, subject }
  }

  // List all papers (scan Hyperbee)
  for await (const { key, value } of store.bee.createReadStream()) {
    if (!key.startsWith(KEY_PREFIX.PAPER)) continue
    papers.push(value)
    if (papers.length >= limit) break
  }

  // Sort newest first
  papers.sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
  return { papers, subject: null }
}

async function getStats() {
  const store = getStore()

  let total = 0
  let subjects = {}
  for await (const { key, value } of store.bee.createReadStream()) {
    if (!key.startsWith(KEY_PREFIX.PAPER)) continue
    total++
    const subj = value.subject || 'unknown'
    subjects[subj] = (subjects[subj] || 0) + 1
  }

  return { total_papers: total, subjects }
}

/** Phase 1: GET /api/status */
async function getNodeStatus() {
  const store = getStore()

  let total = 0
  for await (const { key } of store.bee.createReadStream({ gt: KEY_PREFIX.PAPER, lt: KEY_PREFIX.PAPER + '\xff' })) {
    total++
  }

  let dbSizeBytes = 0
  try {
    dbSizeBytes = fs.statSync(path.join(currentDataDir, 'search.db')).size
  } catch (_) {}

  return {
    papers: total,
    drive_key: store.drive.key.toString('hex'),
    bee_key: store.bee.core.key.toString('hex'),
    db_size_bytes: dbSizeBytes,
    is_replica: Boolean(store.isReplica)
  }
}

/** Phase 1: GET /api/keys */
function getNodeKeys() {
  const store = getStore()
  return {
    drive_key: store.drive.key.toString('hex'),
    bee_key: store.bee.core.key.toString('hex')
  }
}

/** Phase 2: POST /api/fetch-remote */
async function handleFetchRemote(req, res) {
  const body = await readJsonBody(req)
  if (!body || !body.bee_key) {
    return sendJSON(res, { error: 'bee_key is required' }, 400)
  }
  const beeKey = String(body.bee_key).trim()
  const driveKey = body.drive_key ? String(body.drive_key).trim() : null

  if (!/^[0-9a-f]{64}$/i.test(beeKey)) {
    return sendJSON(res, { error: 'Invalid bee_key (expected 64 hex chars)' }, 400)
  }
  if (driveKey && !/^[0-9a-f]{64}$/i.test(driveKey)) {
    return sendJSON(res, { error: 'Invalid drive_key (expected 64 hex chars)' }, 400)
  }

  // Re-initializing the store means the current singleton must be closed
  // first, including any embedded swarms bound to its corestore.
  const wasServing = serveEnabled
  await stopEmbeddedSwarms()
  await close()

  try {
    await initReplicaStore(currentDataDir, beeKey, driveKey)
  } catch (err) {
    return sendJSON(res, { error: `Failed to open replicated store: ${err.message}` }, 500)
  }

  fs.writeFileSync(path.join(currentDataDir, 'remote.json'), JSON.stringify({
    bee_key: beeKey,
    drive_key: driveKey,
    saved_at: new Date().toISOString()
  }, null, 2))

  // Briefly join the archive swarm to let the Hyperbee/Hyperdrive replicate.
  const { startArchiveSwarm, stopAll } = require('../replicate/swarm')
  const store = getStore()
  let peers = 0
  try {
    const archiveSwarm = await startArchiveSwarm(store, { server: false, client: true })
    const deadline = Date.now() + 15000
    while (archiveSwarm.peers === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
    }
    peers = archiveSwarm.peers
    if (peers > 0) {
      // Give the Hyperbee a moment to sync after the connection opens.
      await new Promise((r) => setTimeout(r, 3000))
    }
  } finally {
    await stopAll().catch(() => {})
  }

  let papersSynced = 0
  for await (const { key } of store.bee.createReadStream({ gt: KEY_PREFIX.PAPER, lt: KEY_PREFIX.PAPER + '\xff' })) {
    papersSynced++
  }

  // Resume embedded serving on the new (replica) store if it was enabled.
  if (wasServing) {
    try { await startEmbeddedSwarms() } catch (err) {
      console.error('[web] Failed to resume embedded replication:', err.message)
    }
  }

  return sendJSON(res, { ok: true, papers_synced: papersSynced, peers })
}

/** Phase 2: POST /api/pin */
async function handlePin(req, res) {
  const body = await readJsonBody(req)
  if (!body || !body.paper_id) {
    return sendJSON(res, { error: 'paper_id is required' }, 400)
  }
  const paperId = String(body.paper_id)

  let result = await pinPaper(paperId)

  // Replica node: the blob lives on the publisher's Hyperdrive. Join the
  // archive swarm so corestore.replicate can fetch the block on demand,
  // then retry until it arrives or we time out. If we're already serving
  // (embedded swarms active), reuse that connection instead of starting a
  // second archive swarm, which would orphan the first.
  if (!result.pinned && result.error === 'blob not available') {
    const startedTransient = !embeddedSwarms
    const { startArchiveSwarm, stopAll } = require('../replicate/swarm')
    if (startedTransient) {
      await startArchiveSwarm(getStore(), { server: true, client: true })
    }
    const deadline = Date.now() + 30000
    while (!result.pinned && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      result = await pinPaper(paperId)
    }
    if (startedTransient) await stopAll().catch(() => {})
  }

  if (result.pinned) {
    return sendJSON(res, result)
  }
  return sendJSON(res, { error: result.error || 'pin failed', paper_id: paperId }, 404)
}

/** Phase 3: POST /api/evict */
async function handleEvict(req, res) {
  const body = await readJsonBody(req)
  if (!body || typeof body.max_mb === 'undefined') {
    return sendJSON(res, { error: 'max_mb is required' }, 400)
  }
  const maxMb = parseFloat(body.max_mb)
  if (!Number.isFinite(maxMb) || maxMb < 0) {
    return sendJSON(res, { error: 'Invalid max_mb' }, 400)
  }
  const maxBytes = maxMb * 1024 * 1024

  if (body.dry_run) {
    return sendJSON(res, await previewEviction(maxBytes))
  }

  const result = await evictUnpinned(maxBytes)
  return sendJSON(res, result)
}

/** Preview what evictUnpinned(maxBytes) would remove, without deleting anything. */
async function previewEviction(maxBytes) {
  const store = getStore()
  const { bee, drive } = store

  const allPapers = []
  for await (const { key, value } of bee.createReadStream({ gt: KEY_PREFIX.PAPER, lt: KEY_PREFIX.PAPER + '\xff' })) {
    const replicas = value.replicated_by?.length || 0
    allPapers.push({ value, replicas })
  }
  allPapers.sort((a, b) => (a.value.published_at || '').localeCompare(b.value.published_at || ''))

  const usage = await getDiskUsage()
  let projected = usage.total_bytes
  const candidates = []

  for (const { value, replicas } of allPapers) {
    if (projected <= maxBytes) break
    if (replicas >= 2) continue // pinned papers (>=2 replicas) are exempt

    const size = await getBlobSizePreview(drive, value.blob_key)
    candidates.push({
      paper_id: value.paper_id,
      title: value.title,
      published_at: value.published_at,
      size_bytes: size
    })
    projected -= size
  }

  return {
    dry_run: true,
    current_total_bytes: usage.total_bytes,
    would_evict: candidates.length,
    would_free_bytes: candidates.reduce((sum, c) => sum + c.size_bytes, 0),
    papers: candidates
  }
}

async function getBlobSizePreview(drive, blobKey) {
  try {
    const entry = await drive.entry(blobKey)
    if (entry && entry.value && entry.value.blob) return entry.value.blob.byteLength
  } catch (_) {}
  return 0
}

/** Phase 3: GET /api/download/:paperId */
async function serveDownload(res, paperId) {
  const pdf = await fetchPdf(paperId)
  if (!pdf) {
    return sendJSON(res, { error: 'PDF not found' }, 404)
  }
  if (!pdf.slice(0, 5).toString('ascii').startsWith('%PDF-')) {
    console.error('[web] PDF magic bytes mismatch for', paperId)
    return sendJSON(res, { error: 'Invalid PDF content' }, 500)
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': pdf.length,
    'Content-Disposition': `attachment; filename="${paperId.replace(/[:/]/g, '_')}.pdf"`,
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(pdf)
}

/** Phase 4: GET /api/orcid/status */
function getOrcidStatus() {
  const cached = loadCachedOrcid()
  if (!cached || !cached.orcid_id) {
    return { connected: false }
  }
  return {
    connected: true,
    orcid_id: cached.orcid_id,
    orcid_name: cached.orcid_name,
    orcid_verified_at: cached.orcid_verified_at || null
  }
}

/** Phase 4: GET /api/orcid/authorize */
function handleOrcidAuthorize(res, url) {
  purgeExpiredOrcidStates()
  const clientId = url.searchParams.get('client_id') || ORCID_PROD_CLIENT_ID
  const sandbox = url.searchParams.get('sandbox') === '1'

  const state = generateState()
  pendingOrcidStates.set(state, Date.now() + ORCID_STATE_TTL_MS)

  const authUrl = getOrcidImplicitUrl(clientId, state, null, sandbox)
  res.writeHead(302, { Location: authUrl })
  res.end()
}

/** Phase 4: POST /api/orcid/callback */
async function handleOrcidCallback(req, res) {
  const body = await readJsonBody(req)
  if (!body || !body.access_token) {
    return sendJSON(res, { error: 'access_token is required' }, 400)
  }

  // Best-effort CSRF check. ORCID's implicit flow redirects to a fixed,
  // externally hosted callback page (src/publish/orcid.js CALLBACK_URL)
  // that only displays the token for the user to copy-paste back here --
  // it cannot relay `state` through that manual step. When a state IS
  // supplied we validate it; its absence is tolerated, same trust
  // boundary as the CLI's paste-token flow (which never checks state).
  if (body.state) {
    purgeExpiredOrcidStates()
    const expiry = pendingOrcidStates.get(body.state)
    pendingOrcidStates.delete(body.state)
    if (!expiry) {
      return sendJSON(res, { error: 'Invalid or expired state' }, 400)
    }
  }

  try {
    const claims = await verifyAccessToken(body.access_token, { sandbox: Boolean(body.sandbox) })
    const orcid = {
      orcid_id: claims.orcid_id,
      orcid_name: claims.name || 'Unknown',
      orcid_verified_at: claims.verified_at,
      orcid_nonce: null
    }
    saveOrcidConfig(orcid)
    return sendJSON(res, { ok: true, orcid_id: orcid.orcid_id, orcid_name: orcid.orcid_name })
  } catch (err) {
    return sendJSON(res, { error: `ORCID verification failed: ${err.message}` }, 400)
  }
}

function purgeExpiredOrcidStates() {
  const now = Date.now()
  for (const [state, expiry] of pendingOrcidStates) {
    if (expiry < now) pendingOrcidStates.delete(state)
  }
}

/** Phase 5: GET /api/serve-status */
function getServeStatus() {
  if (!embeddedSwarms) {
    return { serving: false }
  }
  return {
    serving: true,
    archive_peers: embeddedSwarms.archiveSwarm.peers,
    blob_connections: embeddedSwarms.blobSwarm.connections.length,
    topics: embeddedSwarms.topics
  }
}

async function servePdf(res, paperId) {
  const pdf = await fetchPdf(paperId)
  if (!pdf) {
    return sendJSON(res, { error: 'PDF not found' }, 404)
  }
  // Verify the blob starts with %PDF to prevent serving non-PDF content
  if (!pdf.slice(0, 5).toString('ascii').startsWith('%PDF-')) {
    console.error('[web] PDF magic bytes mismatch for', paperId)
    return sendJSON(res, { error: 'Invalid PDF content' }, 500)
  }
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': pdf.length,
    'Content-Disposition': `inline; filename="${paperId.replace(/[:/]/g, '_')}.pdf"`,
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(pdf)
}

async function handlePublish(req, res) {
  // Parse multipart form data
  const contentType = req.headers['content-type'] || ''
  if (!contentType.includes('multipart/form-data')) {
    return sendJSON(res, { error: 'Expected multipart/form-data' }, 400)
  }

  const boundary = contentType.split('boundary=')[1]
  if (!boundary) {
    return sendJSON(res, { error: 'No boundary in content-type' }, 400)
  }

  const body = await readBody(req, MAX_UPLOAD_BYTES)
  if (!body) {
    return sendJSON(res, { error: 'Upload too large (max 50MB)' }, 413)
  }

  const fields = parseMultipart(body, boundary)

  const pdfFile = fields._files && fields._files.pdf
  if (!pdfFile) {
    return sendJSON(res, { error: 'No PDF file uploaded' }, 400)
  }

  // Validate file type by magic bytes
  if (!pdfFile.data.slice(0, 5).toString('ascii').startsWith('%PDF-')) {
    return sendJSON(res, { error: 'File is not a valid PDF' }, 400)
  }

  // Validate required fields
  if (!fields.title || !fields.title.trim()) {
    return sendJSON(res, { error: 'Title is required' }, 400)
  }

  // Validate subject
  if (fields.subject && !VALID_SUBJECTS.includes(fields.subject)) {
    return sendJSON(res, { error: 'Invalid subject category' }, 400)
  }

  // Write PDF to temp file for publish()
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const tmpPath = path.join(os.tmpdir(), `pharos-upload-${Date.now()}.pdf`)
  fs.writeFileSync(tmpPath, pdfFile.data)

  try {
    // Parse authors
    let authors = []
    if (fields.authors) {
      authors = fields.authors.split(',').map(a => ({ name: a.trim() })).filter(a => a.name)
    }

    // ORCID auth: cached identity or explicit field; refuse unsigned/na mock
    let orcid = loadCachedOrcid()
    if (!orcid && fields.orcid && /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(fields.orcid.trim())) {
      orcid = { orcid_id: fields.orcid.trim(), orcid_name: (fields.authors && fields.authors.split(',')[0].trim()) || 'Unknown', orcid_verified_at: null }
    }
    if (!orcid) {
      return sendJSON(res, { error: 'No ORCID identity available. Authenticate once with `pharos publish` (CLI OAuth) or the "Connect ORCID" button, then retry, or pass a verified orcid field.' }, 401)
    }

    // Identity provenance: cached identity came from a CLI ORCID session;
    // a self-pasted orcid field is unverified (flagged, not rejected --
    // consistent with the CLI's --orcid escape hatch).
    const identity = orcid.orcid_verified_at
      ? { orcid_auth_flow: 'implicit-openid', orcid_verified_at: orcid.orcid_verified_at, orcid_nonce: orcid.orcid_nonce || null }
      : { orcid_auth_flow: 'self-asserted', orcid_verified_at: orcid.orcid_verified_at || null, orcid_nonce: null }

    const result = await publish(tmpPath, {
      title: fields.title || 'Untitled',
      authors,
      abstract: fields.abstract || '',
      subject: fields.subject || 'q-bio.GN',
      doi: fields.doi || null,
      revises: fields.revises || null,
      signedBy: orcid.orcid_id,
      identity
    })

    return sendJSON(res, {
      success: true,
      paper_id: result.paper_id,
      content_hash: result.content_hash,
      version: result.version,
      duplicate: result.duplicate
    })
  } finally {
    try { fs.unlinkSync(tmpPath) } catch (_) {}
  }
}

// ---- Multipart parsing (simple, no deps) ----

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let aborted = false

    req.on('data', (c) => {
      if (aborted) return
      total += c.length
      if (total > maxBytes) {
        aborted = true
        resolve(null) // signal oversized
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks))
    })
    req.on('error', () => resolve(null))
  })
}

/** Read and parse a JSON request body. Resolves null on oversized/malformed input. */
function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let aborted = false

    req.on('data', (c) => {
      if (aborted) return
      total += c.length
      if (total > maxBytes) {
        aborted = true
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      const raw = Buffer.concat(chunks).toString('utf-8').trim()
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (_) {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function parseMultipart(body, boundary) {
  const fields = { _files: {} }
  const delim = Buffer.from(`--${boundary}`)
  const parts = []

  // Split by boundary
  let start = 0
  while (true) {
    const idx = body.indexOf(delim, start)
    if (idx === -1) break
    if (start > 0) parts.push(body.slice(start, idx))
    start = idx + delim.length
    // Skip CRLF after boundary
    if (body[start] === 0x0d) start += 2
  }
  // Last part before closing boundary
  const closeDelim = Buffer.from(`--${boundary}--`)
  const closeIdx = body.indexOf(closeDelim, start)
  if (closeIdx > -1) parts.push(body.slice(start, closeIdx))

  for (const part of parts) {
    if (part.length === 0) continue
    // Find header/body separator (CRLF CRLF)
    const sepIdx = part.indexOf(Buffer.from([0x0d, 0x0a, 0x0d, 0x0a]))
    if (sepIdx === -1) continue

    const headerStr = part.slice(0, sepIdx).toString('utf-8')
    const data = part.slice(sepIdx + 4) // skip CRLFCRLF

    // Parse Content-Disposition
    const nameMatch = headerStr.match(/name="([^"]+)"/)
    const filenameMatch = headerStr.match(/filename="([^"]*)"/)

    if (filenameMatch) {
      // File upload
      const name = nameMatch ? nameMatch[1] : 'file'
      fields._files[name] = {
        filename: filenameMatch[1],
        data: data.slice(0, data.length - 2) // strip trailing CRLF
      }
    } else if (nameMatch) {
      fields[nameMatch[1]] = data.toString('utf-8').trim()
    }
  }

  return fields
}

// ---- HTTP helpers ----

function sendJSON(res, obj, status = 200) {
  const json = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*'
  })
  res.end(json)
}

function sendHTML(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(html)
}

function renderErrorPage(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pharos - Error</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 40px; text-align: center; }
    a { color: #58a6ff; }
  </style>
</head>
<body>
  <h2>Error</h2>
  <p>${message}</p>
  <p><a href="/">Back to Pharos</a></p>
</body>
</html>`
}

// ---- HTML rendering ----

function renderHomepage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pharos - P2P Preprint Archive</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --muted: #8b949e;
      --accent: #58a6ff;
      --accent-hover: #79c0ff;
      --green: #3fb950;
      --orange: #d29922;
      --red: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 20px;
      max-width: 1000px;
      margin: 0 auto;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { color: var(--accent-hover); }

    header { margin-bottom: 24px; }
    .logo { font-size: 1.6em; font-weight: 700; color: var(--text); }
    .logo span { color: var(--accent); }
    .tagline { color: var(--muted); font-size: 0.9em; margin-top: 4px; }

    .nav { display: flex; gap: 16px; margin: 16px 0; }
    .nav a { padding: 6px 12px; border-radius: 6px; font-size: 0.9em; }
    .nav a.active { background: var(--accent); color: var(--bg); }

    .search-bar {
      display: flex; gap: 8px; margin: 16px 0;
    }
    .search-bar input {
      flex: 1; padding: 10px 14px;
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
      color: var(--text); font-size: 0.95em;
    }
    .search-bar input:focus { outline: none; border-color: var(--accent); }
    .search-bar button {
      padding: 10px 20px;
      background: var(--accent); color: var(--bg); border: none; border-radius: 8px;
      font-weight: 600; cursor: pointer; font-size: 0.95em;
    }
    .search-bar button:hover { background: var(--accent-hover); }

    .stats { display: flex; gap: 20px; margin: 16px 0; flex-wrap: wrap; }
    .stat-card {
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
      padding: 12px 16px; min-width: 100px;
    }
    .stat-num { font-size: 1.4em; font-weight: 700; }
    .stat-label { color: var(--muted); font-size: 0.8em; }

    .subject-filter { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
    .subject-chip {
      padding: 4px 12px; border-radius: 16px; font-size: 0.85em; cursor: pointer;
      background: var(--card); border: 1px solid var(--border); color: var(--muted);
    }
    .subject-chip.active { border-color: var(--accent); color: var(--accent); }
    .subject-chip:hover { border-color: var(--accent); }

    .papers { display: flex; flex-direction: column; gap: 12px; }
    .paper-card {
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
      padding: 16px 20px; cursor: pointer; transition: border-color 0.2s;
    }
    .paper-card:hover { border-color: var(--accent); }
    .paper-header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .paper-id {
      background: var(--accent); color: var(--bg); padding: 2px 8px;
      border-radius: 4px; font-size: 0.72em; font-weight: 700; white-space: nowrap;
    }
    .paper-version {
      background: var(--border); color: var(--text); padding: 2px 8px;
      border-radius: 4px; font-size: 0.72em; font-weight: 600;
    }
    .paper-title { font-weight: 600; flex: 1; }
    .paper-authors { color: var(--muted); font-size: 0.85em; margin-top: 4px; }
    .paper-meta { display: flex; gap: 16px; color: var(--muted); font-size: 0.8em; margin-top: 6px; }
    .paper-meta .subject { color: var(--green); }
    .paper-meta .date { margin-left: auto; }
    .paper-abstract {
      margin-top: 8px; color: var(--text); font-size: 0.9em;
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .signed-badge { color: var(--orange); font-size: 0.8em; }

    .empty { color: var(--muted); padding: 40px; text-align: center; font-size: 1.1em; }

    .publish-btn {
      display: inline-block; padding: 8px 16px;
      background: var(--green); color: var(--bg); border-radius: 6px;
      font-weight: 600; font-size: 0.9em; cursor: pointer; margin-bottom: 16px;
    }

    #publish-form, #node-panel { display: none; }
    #publish-form.show, #node-panel.show { display: block; }
    .form-section {
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
      padding: 20px; margin: 16px 0;
    }
    .form-section h3 { margin-bottom: 4px; }
    .form-section label { display: block; margin-top: 12px; margin-bottom: 4px; font-size: 0.85em; color: var(--muted); }
    .form-section input[type="text"],
    .form-section textarea,
    .form-section select {
      width: 100%; padding: 8px 10px;
      background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
      color: var(--text); font-size: 0.95em;
    }
    .form-section input[type="text"]:focus,
    .form-section textarea:focus,
    .form-section select:focus { outline: none; border-color: var(--accent); }
    .form-section textarea { min-height: 80px; resize: vertical; }
    .form-section input[type="file"] { color: var(--muted); }
    .form-submit {
      margin-top: 16px; padding: 10px 24px;
      background: var(--green); color: var(--bg); border: none; border-radius: 8px;
      font-weight: 600; cursor: pointer; font-size: 0.95em;
    }
    .form-submit:hover { opacity: 0.9; }
    .btn-sm {
      display: inline-block; padding: 6px 14px; border-radius: 6px;
      font-weight: 600; font-size: 0.85em; cursor: pointer; border: none;
      background: var(--card); color: var(--text); border: 1px solid var(--border);
    }
    .btn-sm:hover { border-color: var(--accent); }
    .btn-sm.primary { background: var(--accent); color: var(--bg); border: none; }
    .btn-sm.danger { background: var(--red); color: #fff; border: none; }
    .form-msg { margin-top: 12px; font-size: 0.9em; }
    .form-msg.ok { color: var(--green); }
    .form-msg.err { color: var(--red); }

    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .kv-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 0.85em; }
    .kv-label { color: var(--muted); min-width: 80px; }
    .kv-value {
      font-family: monospace; background: var(--bg); border: 1px solid var(--border);
      border-radius: 4px; padding: 4px 8px; word-break: break-all; flex: 1;
    }
    .copy-btn { flex-shrink: 0; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 0.78em; font-weight: 600; }
    .badge.green { background: rgba(63,185,80,0.15); color: var(--green); }
    .badge.orange { background: rgba(210,153,34,0.15); color: var(--orange); }
    .badge.red { background: rgba(248,81,73,0.15); color: var(--red); }
    .badge.muted { background: rgba(139,148,158,0.15); color: var(--muted); }
    .disk-bar { display: flex; height: 10px; border-radius: 6px; overflow: hidden; margin: 8px 0; background: var(--bg); border: 1px solid var(--border); }
    .disk-bar span { display: block; height: 100%; }
    .disk-legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 0.8em; color: var(--muted); }
    .disk-legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
    .health-list { margin-top: 8px; max-height: 240px; overflow-y: auto; }
    .health-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 0.85em; }
    .health-row:last-child { border-bottom: none; }
    .details-toggle { cursor: pointer; color: var(--accent); font-size: 0.85em; margin-top: 8px; display: inline-block; }
    .node-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 700px) { .node-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="logo">Pha<span>ros</span></div>
    <div class="tagline">P2P Preprint Archive - Content-addressed, ORCID-signed, Hypercore-powered</div>
  </header>

  <div class="nav">
    <a href="#" class="active" onclick="showBrowse(event)">Browse</a>
    <a href="#" onclick="togglePublish(event)">Publish</a>
    <a href="#" onclick="toggleNode(event)">Node</a>
  </div>

  <div id="publish-form">
    <div class="form-section">
      <h3>Publish a Paper</h3>
      <div id="orcid-banner" style="margin-top:8px;font-size:0.85em;color:var(--muted)"></div>
      <form id="pub-form" enctype="multipart/form-data" method="POST" action="/api/publish">
        <label for="pdf">PDF File</label>
        <input type="file" id="pdf" name="pdf" accept="application/pdf" required>

        <label for="title">Title</label>
        <input type="text" id="title" name="title" placeholder="Paper title" required>

        <label for="authors">Authors (comma-separated)</label>
        <input type="text" id="authors" name="authors" placeholder="Author One, Author Two">

        <label for="abstract">Abstract</label>
        <textarea id="abstract" name="abstract" placeholder="Paper abstract"></textarea>

        <label for="subject">Subject Category</label>
        <select id="subject" name="subject">
          <option value="q-bio.GN">q-bio.GN - Genomics</option>
          <option value="q-bio.QM">q-bio.QM - Quantitative Methods</option>
          <option value="q-bio.BM">q-bio.BM - Biomolecules</option>
          <option value="q-bio.CB">q-bio.CB - Cell Behavior</option>
          <option value="q-bio.MN">q-bio.MN - Molecular Networks</option>
          <option value="q-bio.PE">q-bio.PE - Populations and Evolution</option>
          <option value="q-bio.TO">q-bio.TO - Tissues and Organs</option>
          <option value="cs.LG">cs.LG - Machine Learning</option>
          <option value="cs.AI">cs.AI - Artificial Intelligence</option>
          <option value="stat.ML">stat.ML - Statistics: Machine Learning</option>
          <option value="stat.AP">stat.AP - Statistics: Applications</option>
          <option value="stat.ME">stat.ME - Statistics: Methodology</option>
        </select>

        <label for="doi">DOI (optional)</label>
        <input type="text" id="doi" name="doi" placeholder="10.xxxx/xxxxx">

        <label for="revises">Revises (paper ID, optional)</label>
        <input type="text" id="revises" name="revises" placeholder="pharos:q-bio.GN/2026.08.28/001">

        <label for="orcid">ORCID iD (optional, self-asserted escape hatch)</label>
        <input type="text" id="orcid" name="orcid" placeholder="0000-0000-0000-0000">

        <button type="submit" class="form-submit">Publish</button>
      </form>
      <div id="publish-msg" class="form-msg"></div>
    </div>
  </div>

  <div id="node-panel">
    <div class="node-grid">
      <div class="form-section">
        <h3>Keys</h3>
        <div id="node-status">Loading...</div>
      </div>
      <div class="form-section">
        <h3>Replication</h3>
        <div id="serve-status">Loading...</div>
      </div>
      <div class="form-section">
        <h3>Disk Usage</h3>
        <div id="disk-usage">Loading...</div>
      </div>
      <div class="form-section">
        <h3>Health</h3>
        <div id="health-report">Loading...</div>
      </div>
    </div>

    <div class="form-section">
      <h3>ORCID Identity</h3>
      <div id="orcid-status">Loading...</div>
    </div>

    <div class="form-section">
      <h3>Connect to Publisher</h3>
      <p style="color:var(--muted);font-size:0.85em">Open a replicated store against a remote publisher's Hyperbee/Hyperdrive keys.</p>
      <label for="fr-bee-key">Publisher Bee Key</label>
      <input type="text" id="fr-bee-key" placeholder="64 hex chars">
      <label for="fr-drive-key">Publisher Drive Key (optional)</label>
      <input type="text" id="fr-drive-key" placeholder="64 hex chars">
      <button class="btn-sm primary" style="margin-top:12px" onclick="doFetchRemote()">Fetch Remote</button>
      <div id="fetch-remote-msg" class="form-msg"></div>
    </div>

    <div class="form-section">
      <h3>Storage Management</h3>
      <label for="evict-mb">Target Max Size (MB)</label>
      <input type="text" id="evict-mb" placeholder="e.g. 500">
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-sm" onclick="doEvict(true)">Preview Eviction</button>
        <button class="btn-sm danger" onclick="doEvict(false)">Apply Eviction</button>
        <button class="btn-sm" onclick="doRebuildIndex()">Rebuild Search Index</button>
      </div>
      <p style="color:var(--muted);font-size:0.8em;margin-top:8px">Pinned papers (2+ replicas) are exempt from eviction. Evicted unpinned blobs are gone unless the publisher is online.</p>
      <div id="evict-result"></div>
    </div>
  </div>

  <div id="browse-section">
    <div class="search-bar">
      <input type="text" id="search-input" placeholder="Search papers..." onkeydown="if(event.key==='Enter')doSearch()">
      <button onclick="doSearch()">Search</button>
      <button onclick="clearSearch()" style="background:var(--card);color:var(--text);border:1px solid var(--border)">Clear</button>
    </div>

    <div class="stats" id="stats"></div>

    <div class="subject-filter" id="subject-filter"></div>

    <div class="papers" id="papers-list">
      <div class="empty"><span class="spinner"></span> Loading...</div>
    </div>
  </div>

  <script>
    let currentSubject = '';
    let isSearch = false;

    async function loadStats() {
      try {
        const resp = await fetch('/api/stats');
        const data = await resp.json();
        let html = '<div class="stat-card"><div class="stat-num">' + data.total_papers + '</div><div class="stat-label">Papers</div></div>';
        const subjects = Object.entries(data.subjects || {}).sort((a,b) => b[1]-a[1]);
        for (const [subj, count] of subjects.slice(0, 5)) {
          html += '<div class="stat-card"><div class="stat-num">' + count + '</div><div class="stat-label">' + subj + '</div></div>';
        }
        document.getElementById('stats').innerHTML = html;

        // Build subject filter chips
        let chipHtml = '<span class="subject-chip active" onclick="filterSubject(\\'\\')">All</span>';
        for (const [subj, count] of subjects) {
          chipHtml += '<span class="subject-chip" onclick="filterSubject(\\'' + subj + '\\')">' + subj + ' (' + count + ')</span>';
        }
        document.getElementById('subject-filter').innerHTML = chipHtml;
      } catch (e) {
        console.error('Stats error:', e);
      }
    }

    async function loadPapers(subject) {
      isSearch = false;
      currentSubject = subject || '';
      const list = document.getElementById('papers-list');
      list.innerHTML = '<div class="empty"><span class="spinner"></span> Loading...</div>';

      const url = '/api/papers' + (currentSubject ? '?subject=' + encodeURIComponent(currentSubject) : '');
      const resp = await fetch(url);
      const data = await resp.json();

      renderPapers(data.papers || [], list);
      updateSubjectChips();
    }

    async function doSearch() {
      const q = document.getElementById('search-input').value.trim();
      if (!q) return;
      isSearch = true;
      const list = document.getElementById('papers-list');
      list.innerHTML = '<div class="empty"><span class="spinner"></span> Searching...</div>';

      const resp = await fetch('/api/search?q=' + encodeURIComponent(q));
      const data = await resp.json();

      if (!data || data.length === 0) {
        list.innerHTML = '<div class="empty">No results for "' + escapeHtml(q) + '"</div>';
        return;
      }

      // Fetch full metadata for each search result
      const papers = [];
      for (const r of data) {
        const metaResp = await fetch('/api/paper/' + encodeURIComponent(r.paper_id));
        const meta = await metaResp.json();
        if (meta) {
          meta._snippet = r.snippet;
          papers.push(meta);
        }
      }
      renderPapers(papers, list);
    }

    function clearSearch() {
      document.getElementById('search-input').value = '';
      loadPapers(currentSubject);
    }

    function filterSubject(subject) {
      loadPapers(subject);
    }

    function updateSubjectChips() {
      const chips = document.querySelectorAll('.subject-chip');
      chips.forEach(c => c.classList.remove('active'));
      chips.forEach(c => {
        const onclick = c.getAttribute('onclick') || '';
        if (onclick.includes("'" + currentSubject + "'") || (currentSubject === '' && onclick.includes("'"))) {
          c.classList.add('active');
        }
      });
    }

    function renderPapers(papers, container) {
      if (papers.length === 0) {
        container.innerHTML = '<div class="empty">No papers yet. Be the first to publish!</div>';
        return;
      }
      let html = '';
      for (const p of papers) {
        const pid = p.paper_id;
        const date = new Date(p.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        const authors = (p.authors || []).map(a => a.name).join(', ');
        const signed = p.signed_by ? ' <span class="signed-badge">&#9745; ' + escapeHtml(p.signed_by) + '</span>' : '';
        const verBadge = p.version > 1 ? '<span class="paper-version">v' + p.version + '</span>' : '';
        const snippet = p._snippet ? '<div class="paper-abstract">' + escapeHtml(p._snippet) + '</div>' : '';
        html += '<div class="paper-card" onclick="window.location.href=\\'/paper/' + encodeURIComponent(pid) + '\\'">' +
          '<div class="paper-header">' +
            '<span class="paper-id">' + escapeHtml(pid) + '</span>' +
            verBadge +
            '<span class="paper-title">' + escapeHtml(p.title) + '</span>' +
          '</div>' +
          '<div class="paper-authors">' + escapeHtml(authors) + signed + '</div>' +
          '<div class="paper-meta">' +
            '<span class="subject">' + escapeHtml(p.subject || '') + '</span>' +
            '<span class="date">' + date + '</span>' +
          '</div>' +
          snippet +
        '</div>';
      }
      container.innerHTML = html;
    }

    function showBrowse(e) {
      e.preventDefault();
      document.getElementById('browse-section').style.display = 'block';
      document.getElementById('publish-form').classList.remove('show');
      document.getElementById('node-panel').classList.remove('show');
      document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
      e.target.classList.add('active');
    }

    function togglePublish(e) {
      e.preventDefault();
      const form = document.getElementById('publish-form');
      form.classList.add('show');
      document.getElementById('node-panel').classList.remove('show');
      document.getElementById('browse-section').style.display = 'none';
      document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
      e.target.classList.add('active');
      loadOrcidBanner();
    }

    function toggleNode(e) {
      e.preventDefault();
      document.getElementById('node-panel').classList.add('show');
      document.getElementById('publish-form').classList.remove('show');
      document.getElementById('browse-section').style.display = 'none';
      document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
      e.target.classList.add('active');
      loadNodePanel();
      if (!window._nodeInterval) {
        window._nodeInterval = setInterval(loadServeStatus, 10000);
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function formatBytes(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(1024));
      return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }

    function copyToClipboard(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        const old = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = old; }, 1500);
      }).catch(() => {});
    }

    // ---- Node panel ----

    async function loadNodePanel() {
      loadNodeStatus();
      loadServeStatus();
      loadDiskUsage();
      loadHealthReport();
      loadOrcidStatus();
    }

    async function loadNodeStatus() {
      const el = document.getElementById('node-status');
      try {
        const resp = await fetch('/api/status');
        const s = await resp.json();
        const replicaBadge = s.is_replica ? '<span class="badge orange">replica</span>' : '<span class="badge green">publisher</span>';
        el.innerHTML =
          '<div class="kv-row"><span class="kv-label">Papers</span><span class="kv-value">' + s.papers + '</span></div>' +
          '<div class="kv-row"><span class="kv-label">Role</span>' + replicaBadge + '</div>' +
          '<div class="kv-row"><span class="kv-label">DB size</span><span class="kv-value">' + formatBytes(s.db_size_bytes) + '</span></div>' +
          '<div class="kv-row"><span class="kv-label">Drive key</span><span class="kv-value" id="drive-key">' + escapeHtml(s.drive_key) + '</span><button class="btn-sm copy-btn" onclick="copyToClipboard(\\'' + s.drive_key + '\\', this)">Copy</button></div>' +
          '<div class="kv-row"><span class="kv-label">Bee key</span><span class="kv-value" id="bee-key">' + escapeHtml(s.bee_key) + '</span><button class="btn-sm copy-btn" onclick="copyToClipboard(\\'' + s.bee_key + '\\', this)">Copy</button></div>';
      } catch (e) {
        el.innerHTML = '<span style="color:var(--red)">Failed to load status</span>';
      }
    }

    async function loadServeStatus() {
      const el = document.getElementById('serve-status');
      if (!el) return;
      try {
        const resp = await fetch('/api/serve-status');
        const s = await resp.json();
        if (!s.serving) {
          el.innerHTML = '<span class="badge muted">not serving</span>';
          return;
        }
        el.innerHTML =
          '<div class="kv-row"><span class="badge green">serving</span></div>' +
          '<div class="kv-row"><span class="kv-label">Archive peers</span><span class="kv-value">' + s.archive_peers + '</span></div>' +
          '<div class="kv-row"><span class="kv-label">Blob conns</span><span class="kv-value">' + s.blob_connections + '</span></div>' +
          '<div class="kv-row"><span class="kv-label">Topics</span><span class="kv-value">' + escapeHtml((s.topics || []).join(', ')) + '</span></div>';
      } catch (e) {
        el.innerHTML = '<span style="color:var(--red)">Failed to load</span>';
      }
    }

    async function loadDiskUsage() {
      const el = document.getElementById('disk-usage');
      try {
        const resp = await fetch('/api/disk-usage');
        const u = await resp.json();
        const total = u.total_bytes || 1;
        const storePct = (u.store_bytes / total * 100).toFixed(1);
        const indexPct = (u.index_bytes / total * 100).toFixed(1);
        const dbPct = (u.db_bytes / total * 100).toFixed(1);
        el.innerHTML =
          '<div class="disk-bar">' +
            '<span style="width:' + storePct + '%;background:var(--accent)"></span>' +
            '<span style="width:' + indexPct + '%;background:var(--green)"></span>' +
            '<span style="width:' + dbPct + '%;background:var(--orange)"></span>' +
          '</div>' +
          '<div class="disk-legend">' +
            '<span><span class="swatch" style="background:var(--accent)"></span>Blobs: ' + formatBytes(u.store_bytes) + '</span>' +
            '<span><span class="swatch" style="background:var(--green)"></span>Index: ' + formatBytes(u.index_bytes) + '</span>' +
            '<span><span class="swatch" style="background:var(--orange)"></span>DB: ' + formatBytes(u.db_bytes) + '</span>' +
          '</div>' +
          '<div class="kv-row"><span class="kv-label">Total</span><span class="kv-value">' + formatBytes(u.total_bytes) + '</span></div>';
      } catch (e) {
        el.innerHTML = '<span style="color:var(--red)">Failed to load</span>';
      }
    }

    async function loadHealthReport() {
      const el = document.getElementById('health-report');
      try {
        const resp = await fetch('/api/health');
        const h = await resp.json();
        let html =
          '<div class="kv-row"><span class="kv-label">Total</span><span class="kv-value">' + h.total + '</span></div>' +
          '<div class="kv-row"><span class="kv-label">Healthy</span><span class="badge green">' + h.healthy + '</span></div>' +
          '<div class="kv-row"><span class="kv-label">At-risk</span><span class="badge orange">' + h.atRisk + '</span></div>';
        if (h.papers && h.papers.length) {
          html += '<a class="details-toggle" onclick="document.getElementById(\\'health-list\\').style.display = document.getElementById(\\'health-list\\').style.display === \\'block\\' ? \\'none\\' : \\'block\\'; return false;" href="#">Show per-paper detail</a>';
          html += '<div class="health-list" id="health-list" style="display:none">';
          for (const p of h.papers) {
            const badge = p.status === 'healthy' ? 'green' : 'orange';
            html += '<div class="health-row"><span>' + escapeHtml(p.paper_id) + '</span><span class="badge ' + badge + '">' + p.replicas + ' replica(s)</span></div>';
          }
          html += '</div>';
        }
        el.innerHTML = html;
      } catch (e) {
        el.innerHTML = '<span style="color:var(--red)">Failed to load</span>';
      }
    }

    async function loadOrcidStatus() {
      const el = document.getElementById('orcid-status');
      try {
        const resp = await fetch('/api/orcid/status');
        const o = await resp.json();
        if (o.connected) {
          el.innerHTML = '<span class="badge green">Connected as ' + escapeHtml(o.orcid_name) + ' (' + escapeHtml(o.orcid_id) + ')</span>';
        } else {
          el.innerHTML = '<a class="btn-sm primary" href="/api/orcid/authorize">Connect ORCID</a>' +
            '<div style="margin-top:12px">' +
            '<label for="orcid-token-input" style="display:block;font-size:0.85em;color:var(--muted);margin-bottom:4px">Paste access token from the ORCID callback page</label>' +
            '<input type="text" id="orcid-token-input" placeholder="access token">' +
            '<button class="btn-sm" style="margin-top:8px" onclick="submitOrcidToken()">Submit Token</button>' +
            '<div id="orcid-token-msg" class="form-msg"></div>' +
            '</div>';
        }
      } catch (e) {
        el.innerHTML = '<span style="color:var(--red)">Failed to load</span>';
      }
    }

    async function submitOrcidToken() {
      const token = document.getElementById('orcid-token-input').value.trim();
      const msg = document.getElementById('orcid-token-msg');
      if (!token) return;
      msg.className = 'form-msg';
      msg.innerHTML = '<span class="spinner"></span> Verifying...';
      try {
        const resp = await fetch('/api/orcid/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: token })
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        msg.className = 'form-msg ok';
        msg.textContent = 'Connected as ' + data.orcid_name + ' (' + data.orcid_id + ')';
        loadOrcidStatus();
      } catch (err) {
        msg.className = 'form-msg err';
        msg.textContent = 'Error: ' + err.message;
      }
    }

    async function loadOrcidBanner() {
      const el = document.getElementById('orcid-banner');
      try {
        const resp = await fetch('/api/orcid/status');
        const o = await resp.json();
        if (o.connected) {
          el.innerHTML = '<span class="badge green">Connected as ' + escapeHtml(o.orcid_name) + '</span>';
        } else {
          el.innerHTML = '<span class="badge muted">Not connected &mdash; <a href="#" onclick="toggleNode(event)">connect ORCID</a> first, or use the self-asserted field below</span>';
        }
      } catch (e) {}
    }

    async function doFetchRemote() {
      const beeKey = document.getElementById('fr-bee-key').value.trim();
      const driveKey = document.getElementById('fr-drive-key').value.trim();
      const msg = document.getElementById('fetch-remote-msg');
      if (!beeKey) { msg.className = 'form-msg err'; msg.textContent = 'Bee key is required.'; return; }
      msg.className = 'form-msg';
      msg.innerHTML = '<span class="spinner"></span> Connecting to publisher (this can take up to 15s)...';
      try {
        const resp = await fetch('/api/fetch-remote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bee_key: beeKey, drive_key: driveKey || undefined })
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        msg.className = 'form-msg ok';
        msg.textContent = 'Connected. Synced ' + data.papers_synced + ' paper(s) from ' + data.peers + ' peer(s).';
        loadNodePanel();
        loadStats();
        loadPapers('');
      } catch (err) {
        msg.className = 'form-msg err';
        msg.textContent = 'Error: ' + err.message;
      }
    }

    async function doEvict(dryRun) {
      const mb = parseFloat(document.getElementById('evict-mb').value);
      const result = document.getElementById('evict-result');
      if (!Number.isFinite(mb) || mb < 0) { result.innerHTML = '<div class="form-msg err">Enter a valid target size in MB.</div>'; return; }
      result.innerHTML = '<div class="form-msg"><span class="spinner"></span> ' + (dryRun ? 'Previewing' : 'Evicting') + '...</div>';
      try {
        const resp = await fetch('/api/evict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ max_mb: mb, dry_run: dryRun })
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        if (dryRun) {
          let html = '<div class="form-msg ok">Would evict ' + data.would_evict + ' paper(s), freeing ' + formatBytes(data.would_free_bytes) + '.</div>';
          if (data.papers && data.papers.length) {
            html += '<div class="health-list" style="display:block">';
            for (const p of data.papers) {
              html += '<div class="health-row"><span>' + escapeHtml(p.title) + '</span><span class="badge muted">' + formatBytes(p.size_bytes) + '</span></div>';
            }
            html += '</div>';
          }
          result.innerHTML = html;
        } else {
          result.innerHTML = '<div class="form-msg ok">Evicted ' + data.evicted + ' paper(s), freed ' + formatBytes(data.freed_bytes) + '.</div>';
          loadDiskUsage();
          loadStats();
          loadPapers(currentSubject);
        }
      } catch (err) {
        result.innerHTML = '<div class="form-msg err">Error: ' + err.message + '</div>';
      }
    }

    async function doRebuildIndex() {
      const result = document.getElementById('evict-result');
      result.innerHTML = '<div class="form-msg"><span class="spinner"></span> Rebuilding index...</div>';
      try {
        const resp = await fetch('/api/rebuild-index', { method: 'POST' });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        result.innerHTML = '<div class="form-msg ok">Indexed ' + data.indexed + ' paper(s).</div>';
      } catch (err) {
        result.innerHTML = '<div class="form-msg err">Error: ' + err.message + '</div>';
      }
    }

    document.getElementById('pub-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('publish-msg');
      msg.className = 'form-msg';
      msg.innerHTML = '<span class="spinner"></span> Publishing...';

      const formData = new FormData(e.target);
      try {
        const resp = await fetch('/api/publish', { method: 'POST', body: formData });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        msg.className = 'form-msg ok';
        msg.innerHTML = 'Published: <a href="/paper/' + encodeURIComponent(data.paper_id) + '">' + escapeHtml(data.paper_id) + '</a>' +
          (data.duplicate ? ' (duplicate)' : ' (v' + data.version + ')');
        e.target.reset();
        loadStats();
        loadPapers(currentSubject);
      } catch (err) {
        msg.className = 'form-msg err';
        msg.textContent = 'Error: ' + err.message;
      }
    });

    // Prefill fetch-remote form from shareable link query params
    (function prefillFromQuery() {
      const params = new URLSearchParams(window.location.search);
      const beeKey = params.get('bee_key');
      const driveKey = params.get('drive_key');
      if (beeKey) {
        document.addEventListener('DOMContentLoaded', () => {
          const beeInput = document.getElementById('fr-bee-key');
          const driveInput = document.getElementById('fr-drive-key');
          if (beeInput) beeInput.value = beeKey;
          if (driveInput && driveKey) driveInput.value = driveKey;
        });
      }
    })();

    // Init
    loadStats();
    loadPapers('');
  </script>
</body>
</html>`
}

function renderPaperPage(paperId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pharos - Paper</title>
  <style>
    :root {
      --bg: #0d1117;
      --card: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --muted: #8b949e;
      --accent: #58a6ff;
      --accent-hover: #79c0ff;
      --green: #3fb950;
      --orange: #d29922;
      --red: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 20px;
      max-width: 900px;
      margin: 0 auto;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { color: var(--accent-hover); }
    .back { display: inline-block; margin-bottom: 16px; font-size: 0.9em; }
    .paper-id { color: var(--muted); font-size: 0.85em; font-family: monospace; }
    h1 { margin: 8px 0; }
    .authors { color: var(--muted); margin-bottom: 12px; }
    .meta-row { display: flex; gap: 20px; flex-wrap: wrap; margin: 12px 0; font-size: 0.9em; }
    .meta-item { color: var(--muted); }
    .meta-item .label { font-weight: 600; color: var(--text); }
    .meta-item .value { color: var(--muted); }
    .subject-badge { color: var(--green); font-weight: 600; }
    .version-badge { background: var(--border); padding: 2px 8px; border-radius: 4px; font-size: 0.85em; }
    .signed { color: var(--orange); }
    .actions { margin: 16px 0; display: flex; gap: 12px; flex-wrap: wrap; }
    .btn {
      display: inline-block; padding: 8px 16px; border-radius: 6px;
      font-weight: 600; font-size: 0.9em; cursor: pointer; text-decoration: none; border: none;
    }
    .btn-pdf { background: var(--accent); color: var(--bg); }
    .btn-pdf:hover { background: var(--accent-hover); }
    .btn-version { background: var(--card); color: var(--text); border: 1px solid var(--border); }
    .btn-pin { background: var(--green); color: var(--bg); }
    .btn-download { background: var(--card); color: var(--text); border: 1px solid var(--border); }
    .abstract {
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
      padding: 16px 20px; margin: 16px 0;
    }
    .abstract h3 { font-size: 0.9em; color: var(--muted); margin-bottom: 8px; text-transform: uppercase; }
    .versions { margin: 16px 0; }
    .version-entry {
      display: flex; gap: 12px; align-items: baseline;
      padding: 10px 0; border-bottom: 1px solid var(--border);
    }
    .version-entry:last-child { border-bottom: none; }
    .version-num { font-weight: 700; color: var(--accent); min-width: 40px; }
    .version-info { flex: 1; }
    .version-hash { color: var(--muted); font-family: monospace; font-size: 0.85em; }
    .version-date { color: var(--muted); font-size: 0.85em; }
    .version-link { color: var(--accent); }
    .hash-display {
      font-family: monospace; font-size: 0.85em; color: var(--muted);
      word-break: break-all; padding: 8px 12px; background: var(--card);
      border: 1px solid var(--border); border-radius: 6px; margin: 8px 0;
    }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .pdf-frame {
      width: 100%; height: 600px; border: 1px solid var(--border); border-radius: 8px; margin: 16px 0;
    }
    .pin-msg { margin-top: 8px; font-size: 0.85em; }
    .pin-msg.ok { color: var(--green); }
    .pin-msg.err { color: var(--red); }
  </style>
</head>
<body>
  <a class="back" href="/">&larr; Back to browse</a>
  <div id="content"><span class="spinner"></span> Loading...</div>

  <script>
    const paperId = window.location.pathname.replace('/paper/', '');

    async function load() {
      const resp = await fetch('/api/paper/' + encodeURIComponent(paperId));
      const meta = await resp.json();
      if (!meta || meta.error) {
        document.getElementById('content').innerHTML = '<p>Paper not found: ' + escapeHtml(paperId) + '</p>';
        return;
      }

      const date = new Date(meta.published_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      const authors = (meta.authors || []).map(a => a.name).join(', ');
      const verBadge = meta.version > 1 ? '<span class="version-badge">v' + meta.version + '</span>' : '<span class="version-badge">v1</span>';
      const signed = meta.signed_by ? '<span class="signed">&#9745; Signed by ' + escapeHtml(meta.signed_by) + '</span>' : '';
      const revises = meta.previous_version_hash ? '<div class="meta-item"><span class="label">Revises:</span> <span class="value">' + escapeHtml(meta.previous_version_hash.slice(0, 24)) + '...</span></div>' : '';

      let html = '<div class="paper-id">' + escapeHtml(meta.paper_id) + '</div>';
      html += '<h1>' + escapeHtml(meta.title) + '</h1>';
      html += '<div class="authors">' + escapeHtml(authors) + ' ' + signed + '</div>';
      html += '<div class="meta-row">';
      html += '<div class="meta-item"><span class="label">Subject:</span> <span class="subject-badge">' + escapeHtml(meta.subject) + '</span></div>';
      html += '<div class="meta-item"><span class="label">Version:</span> ' + verBadge + '</div>';
      html += '<div class="meta-item"><span class="label">Published:</span> <span class="value">' + date + '</span></div>';
      if (meta.doi) html += '<div class="meta-item"><span class="label">DOI:</span> <a href="https://doi.org/' + escapeHtml(meta.doi) + '">' + escapeHtml(meta.doi) + '</a></div>';
      html += '</div>';
      html += revises;
      html += '<div class="hash-display">' + escapeHtml(meta.content_hash) + '</div>';

      html += '<div class="actions">';
      html += '<a class="btn btn-pdf" href="/pdf/' + encodeURIComponent(paperId) + '" target="_blank">View PDF</a>';
      html += '<a class="btn btn-download" href="/api/download/' + encodeURIComponent(paperId) + '">Download</a>';
      html += '<button class="btn btn-pin" onclick="doPin(event)">Pin this paper</button>';
      html += '<a class="btn btn-version" href="#" onclick="loadVersions(event)">Version History</a>';
      html += '</div>';
      html += '<div id="pin-msg" class="pin-msg"></div>';

      if (meta.abstract) {
        html += '<div class="abstract"><h3>Abstract</h3>' + escapeHtml(meta.abstract) + '</div>';
      }

      html += '<div id="versions-section"></div>';
      html += '<iframe id="pdf-frame" class="pdf-frame" style="display:none" src="/pdf/' + encodeURIComponent(paperId) + '"></iframe>';

      document.getElementById('content').innerHTML = html;
    }

    async function doPin(e) {
      e.preventDefault();
      const btn = e.target;
      const msg = document.getElementById('pin-msg');
      btn.disabled = true;
      msg.className = 'pin-msg';
      msg.innerHTML = '<span class="spinner"></span> Pinning (may take up to 30s if fetching from swarm)...';
      try {
        const resp = await fetch('/api/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paper_id: paperId })
        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        msg.className = 'pin-msg ok';
        msg.textContent = 'Pinned. Hash: ' + data.content_hash;
      } catch (err) {
        msg.className = 'pin-msg err';
        msg.textContent = 'Error: ' + err.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function loadVersions(e) {
      e.preventDefault();
      const section = document.getElementById('versions-section');
      section.innerHTML = '<span class="spinner"></span> Loading versions...';

      const resp = await fetch('/api/versions/' + encodeURIComponent(paperId));
      const versions = await resp.json();

      if (!versions || versions.length === 0) {
        section.innerHTML = '<p>No version history.</p>';
        return;
      }

      let html = '<h3 style="margin: 16px 0 8px;">Version History (' + versions.length + ')</h3><div class="versions">';
      for (const v of versions) {
        const isCurrent = v.paper_id === paperId;
        const date = new Date(v.published_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        const prev = v.previous_version_hash ? '<div class="version-hash">revises: ' + escapeHtml(v.previous_version_hash.slice(0, 24)) + '...</div>' : '';
        const link = isCurrent ? '<span class="version-link">v' + v.version + ' (current)</span>' : '<a class="version-link" href="/paper/' + encodeURIComponent(v.paper_id) + '">v' + v.version + '</a>';
        html += '<div class="version-entry">' +
          '<span class="version-num">' + link + '</span>' +
          '<div class="version-info">' +
            '<div class="version-date">' + date + ' - ' + escapeHtml(v.title) + '</div>' +
            prev +
          '</div>' +
        '</div>';
      }
      html += '</div>';
      section.innerHTML = html;
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    load();
  </script>
</body>
</html>`
}

async function stopServer() {
  await stopEmbeddedSwarms()
  serveEnabled = false
  serveTopics = []
  pendingOrcidStates.clear()
  if (serverInstance) {
    return new Promise((resolve) => serverInstance.close(() => {
      serverInstance = null
      resolve()
    }))
  }
}

module.exports = { startServer, stopServer, getServer: () => serverInstance }
