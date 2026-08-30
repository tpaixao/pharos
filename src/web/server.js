'use strict'

/**
 * Pharos Web UI server.
 *
 * Routes:
 *   GET  /                        - Homepage (browse + search)
 *   GET  /paper/:paperId          - Paper detail page
 *   GET  /api/papers              - List papers (?subject=q-bio.GN&limit=20)
 *   GET  /api/paper/:paperId      - Paper metadata JSON
 *   GET  /api/search?q=...        - FTS5 search
 *   GET  /api/versions/:paperId   - Version history
 *   GET  /api/stats               - Archive statistics
 *   GET  /pdf/:paperId            - Serve PDF inline
 *   POST /api/publish             - Upload + publish (multipart)
 */

const http = require('http')
const { URL } = require('url')

// Import directly from core modules to avoid circular dependency with lib.js
const { initStore, getStore, close, getDiskUsage, evictUnpinned } = require('../core/store')
const { publish, fetchPdf, getPaper, browseCategory, getVersions } = require('../publish/publish')
const { orcidAuth, loadCachedOrcid } = require('../publish/orcid')
const { search } = require('../search/index')
const { KEY_PREFIX, VALID_SUBJECTS } = require('../core/constants')

let serverInstance = null

// Max upload size: 50MB
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

/**
 * Start the Pharos web server.
 * @param {object} opts - { port, dataDir }
 * @returns {Promise<http.Server>}
 */
async function startServer(opts = {}) {
  const port = opts.port || 8093
  const dataDir = opts.dataDir || 'data'

  // Initialize store if not already initialized
  await initStore(dataDir)

  const server = http.createServer(handleRequest)
  serverInstance = server

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      resolve(server)
    })
  })
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
      return sendJSON(res, { error: 'No ORCID identity available. Authenticate once with `pharos publish` (CLI OAuth), then retry, or pass a verified orcid field.' }, 401)
    }

    const result = await publish(tmpPath, {
      title: fields.title || 'Untitled',
      authors,
      abstract: fields.abstract || '',
      subject: fields.subject || 'q-bio.GN',
      doi: fields.doi || null,
      revises: fields.revises || null,
      signedBy: orcid.orcid_id
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

    #publish-form { display: none; }
    #publish-form.show { display: block; }
    .form-section {
      background: var(--card); border: 1px solid var(--border); border-radius: 8px;
      padding: 20px; margin: 16px 0;
    }
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
    .form-msg { margin-top: 12px; font-size: 0.9em; }
    .form-msg.ok { color: var(--green); }
    .form-msg.err { color: var(--red); }

    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
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
  </div>

  <div id="publish-form">
    <div class="form-section">
      <h3>Publish a Paper</h3>
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

        <button type="submit" class="form-submit">Publish</button>
      </form>
      <div id="publish-msg" class="form-msg"></div>
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
        if (onclick.includes("'" + currentSubject + "'") || (currentSubject === '' && onclick.includes("''))) {
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
      document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
      e.target.classList.add('active');
    }

    function togglePublish(e) {
      e.preventDefault();
      const form = document.getElementById('publish-form');
      form.classList.toggle('show');
      document.getElementById('browse-section').style.display = form.classList.contains('show') ? 'none' : 'block';
      document.querySelectorAll('.nav a').forEach(a => a.classList.remove('active'));
      e.target.classList.add('active');
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

    function escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

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
    .actions { margin: 16px 0; display: flex; gap: 12px; }
    .btn {
      display: inline-block; padding: 8px 16px; border-radius: 6px;
      font-weight: 600; font-size: 0.9em; cursor: pointer; text-decoration: none;
    }
    .btn-pdf { background: var(--accent); color: var(--bg); }
    .btn-pdf:hover { background: var(--accent-hover); }
    .btn-version { background: var(--card); color: var(--text); border: 1px solid var(--border); }
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
      html += '<a class="btn btn-version" href="#" onclick="loadVersions(event)">Version History</a>';
      html += '</div>';

      if (meta.abstract) {
        html += '<div class="abstract"><h3>Abstract</h3>' + escapeHtml(meta.abstract) + '</div>';
      }

      html += '<div id="versions-section"></div>';
      html += '<iframe id="pdf-frame" class="pdf-frame" style="display:none" src="/pdf/' + encodeURIComponent(paperId) + '"></iframe>';

      document.getElementById('content').innerHTML = html;
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
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    load();
  </script>
</body>
</html>`
}

async function stopServer() {
  if (serverInstance) {
    return new Promise((resolve) => serverInstance.close(() => {
      serverInstance = null
      resolve()
    }))
  }
}

module.exports = { startServer, stopServer, getServer: () => serverInstance }
