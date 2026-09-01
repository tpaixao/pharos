const TEST_ORCID = '0000-0003-2361-3953'
'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const path = require('path')
const os = require('os')
const fs = require('fs')

const pharos = require('../src/lib')

let testPort = 18193
let server = null
let tmpDir = null

async function startTestServer(opts = {}) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-web-api-test-'))
  server = await pharos.webServer.startServer({ port: testPort, dataDir: tmpDir, ...opts })
  return server
}

async function stopTestServer() {
  if (server) {
    await pharos.webServer.stopServer()
    server = null
  }
  await pharos.close()
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
}

function fetchUrl(reqPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${testPort}${reqPath}`, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    }).on('error', reject)
  })
}

function postJSON(reqPath, obj) {
  const body = JSON.stringify(obj || {})
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${testPort}${reqPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function postEmpty(reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${testPort}${reqPath}`, { method: 'POST' }, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end()
  })
}

function makeTestPdf(content = 'Test content') {
  const stream = `BT /F1 12 Tf 100 700 Td (${content}) Tj ET`
  const len = stream.length
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length ${len} >>\nstream\n${stream}\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000214 00000 n \n0000000268 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n330\n%%EOF`
  )
}

async function publishTestPaper(title, subject) {
  const pdfPath = path.join(tmpDir, `${title.replace(/\s+/g, '_')}.pdf`)
  fs.writeFileSync(pdfPath, makeTestPdf(title))
  return pharos.publish(pdfPath, {
    title,
    authors: [{ name: 'Test Author' }],
    abstract: 'Test abstract for ' + title,
    subject: subject || 'q-bio.GN',
    signedBy: TEST_ORCID
  })
}

// ---- ~/.pharos/config.json backup/restore (ORCID cache lives outside tmpDir) ----

const ORCID_CONFIG_PATH = path.join(os.homedir(), '.pharos', 'config.json')
let orcidBackup = undefined // undefined = not backed up, null = file didn't exist

function backupAndClearOrcidConfig() {
  try {
    orcidBackup = fs.readFileSync(ORCID_CONFIG_PATH, 'utf-8')
  } catch (_) {
    orcidBackup = null
  }
  try { fs.unlinkSync(ORCID_CONFIG_PATH) } catch (_) {}
}

function restoreOrcidConfig() {
  if (orcidBackup === undefined) return
  try {
    if (orcidBackup !== null) {
      fs.mkdirSync(path.dirname(ORCID_CONFIG_PATH), { recursive: true })
      fs.writeFileSync(ORCID_CONFIG_PATH, orcidBackup)
    } else {
      fs.unlinkSync(ORCID_CONFIG_PATH)
    }
  } catch (_) {}
  orcidBackup = undefined
}

// ---- Status / keys / health ----

test('web-api: GET /api/status returns node status shape', async () => {
  await startTestServer()
  try {
    const res = await fetchUrl('/api/status')
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.papers, 0)
    assert.match(data.drive_key, /^[0-9a-f]{64}$/)
    assert.match(data.bee_key, /^[0-9a-f]{64}$/)
    assert.ok(data.db_size_bytes >= 0)
    assert.strictEqual(data.is_replica, false)
  } finally {
    await stopTestServer()
  }
})

test('web-api: GET /api/keys returns hex keys matching /api/status', async () => {
  await startTestServer()
  try {
    const statusRes = await fetchUrl('/api/status')
    const status = JSON.parse(statusRes.body)
    const res = await fetchUrl('/api/keys')
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.drive_key, status.drive_key)
    assert.strictEqual(data.bee_key, status.bee_key)
  } finally {
    await stopTestServer()
  }
})

test('web-api: GET /api/health reflects published papers and replica counts', async () => {
  await startTestServer()
  try {
    const empty = JSON.parse((await fetchUrl('/api/health')).body)
    assert.strictEqual(empty.total, 0)
    assert.strictEqual(empty.minReplicas, 3)

    const result = await publishTestPaper('Health Paper')
    const report = JSON.parse((await fetchUrl('/api/health')).body)
    assert.strictEqual(report.total, 1)
    assert.strictEqual(report.atRisk, 1)
    assert.strictEqual(report.healthy, 0)
    assert.strictEqual(report.papers[0].paper_id, result.paper_id)
  } finally {
    await stopTestServer()
  }
})

// ---- Evict dry-run vs apply ----

test('web-api: POST /api/evict dry-run previews without deleting', async () => {
  await startTestServer()
  try {
    await publishTestPaper('Evict Preview Paper')
    const before = JSON.parse((await fetchUrl('/api/stats')).body)
    assert.strictEqual(before.total_papers, 1)

    const res = await postJSON('/api/evict', { max_mb: 0, dry_run: true })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.dry_run, true)
    assert.strictEqual(data.would_evict, 1)
    assert.ok(data.would_free_bytes > 0)
    assert.strictEqual(data.papers.length, 1)

    // Nothing was actually deleted
    const after = JSON.parse((await fetchUrl('/api/stats')).body)
    assert.strictEqual(after.total_papers, 1)
  } finally {
    await stopTestServer()
  }
})

test('web-api: POST /api/evict apply evicts unpinned papers', async () => {
  await startTestServer()
  try {
    await publishTestPaper('Evict Apply Paper')
    const res = await postJSON('/api/evict', { max_mb: 0, dry_run: false })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.evicted, 1)
    assert.ok(data.freed_bytes > 0)

    const after = JSON.parse((await fetchUrl('/api/stats')).body)
    assert.strictEqual(after.total_papers, 0)
  } finally {
    await stopTestServer()
  }
})

test('web-api: POST /api/evict exempts pinned (replicated) papers', async () => {
  await startTestServer()
  try {
    const result = await publishTestPaper('Pinned Paper')
    const { addReplica } = require('../src/replicate/health')
    await addReplica(result.paper_id, 'peer-a')
    await addReplica(result.paper_id, 'peer-b')

    const res = await postJSON('/api/evict', { max_mb: 0, dry_run: false })
    const data = JSON.parse(res.body)
    assert.strictEqual(data.evicted, 0)

    const after = JSON.parse((await fetchUrl('/api/stats')).body)
    assert.strictEqual(after.total_papers, 1)
  } finally {
    await stopTestServer()
  }
})

test('web-api: POST /api/evict rejects missing max_mb', async () => {
  await startTestServer()
  try {
    const res = await postJSON('/api/evict', { dry_run: true })
    assert.strictEqual(res.status, 400)
    const data = JSON.parse(res.body)
    assert.ok(data.error.includes('max_mb'))
  } finally {
    await stopTestServer()
  }
})

// ---- Rebuild index ----

test('web-api: POST /api/rebuild-index reindexes papers', async () => {
  await startTestServer()
  try {
    await publishTestPaper('Rebuild Index Paper')
    const res = await postEmpty('/api/rebuild-index')
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.indexed, 1)
  } finally {
    await stopTestServer()
  }
})

// ---- Download ----

test('web-api: GET /api/download/:id sets Content-Disposition attachment', async () => {
  await startTestServer()
  try {
    const result = await publishTestPaper('Download Paper')
    const res = await fetchUrl('/api/download/' + encodeURIComponent(result.paper_id))
    assert.strictEqual(res.status, 200)
    assert.ok(res.headers['content-type'].includes('application/pdf'))
    assert.ok(res.headers['content-disposition'].startsWith('attachment'))
    assert.ok(res.body.length > 0)
  } finally {
    await stopTestServer()
  }
})

test('web-api: GET /api/download/:id returns 404 for unknown paper', async () => {
  await startTestServer()
  try {
    const res = await fetchUrl('/api/download/nonexistent-id')
    assert.strictEqual(res.status, 404)
  } finally {
    await stopTestServer()
  }
})

// ---- Pin ----

test('web-api: POST /api/pin pins a paper whose blob is already local', async () => {
  await startTestServer()
  try {
    const result = await publishTestPaper('Pin Local Paper')
    const res = await postJSON('/api/pin', { paper_id: result.paper_id })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.pinned, true)
    assert.strictEqual(data.content_hash, result.content_hash)
  } finally {
    await stopTestServer()
  }
})

test('web-api: POST /api/pin returns error for missing paper', async () => {
  await startTestServer()
  try {
    const res = await postJSON('/api/pin', { paper_id: 'does-not-exist' })
    assert.strictEqual(res.status, 404)
    const data = JSON.parse(res.body)
    assert.ok(data.error)
  } finally {
    await stopTestServer()
  }
})

test('web-api: POST /api/pin rejects missing paper_id', async () => {
  await startTestServer()
  try {
    const res = await postJSON('/api/pin', {})
    assert.strictEqual(res.status, 400)
  } finally {
    await stopTestServer()
  }
})

// ---- ORCID ----

test('web-api: GET /api/orcid/status returns connected:false without cache', async () => {
  backupAndClearOrcidConfig()
  await startTestServer()
  try {
    const res = await fetchUrl('/api/orcid/status')
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.connected, false)
  } finally {
    await stopTestServer()
    restoreOrcidConfig()
  }
})

test('web-api: POST /api/orcid/callback verifies token and caches identity', async () => {
  backupAndClearOrcidConfig()
  const origFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ sub: '0000-0002-1694-233X', name: 'Web Test Author' })
  })
  await startTestServer()
  try {
    const res = await postJSON('/api/orcid/callback', { access_token: 'fake-token' })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.ok, true)
    assert.strictEqual(data.orcid_id, '0000-0002-1694-233X')
    assert.strictEqual(data.orcid_name, 'Web Test Author')

    const statusRes = await fetchUrl('/api/orcid/status')
    const status = JSON.parse(statusRes.body)
    assert.strictEqual(status.connected, true)
    assert.strictEqual(status.orcid_id, '0000-0002-1694-233X')
  } finally {
    await stopTestServer()
    global.fetch = origFetch
    restoreOrcidConfig()
  }
})

test('web-api: POST /api/orcid/callback rejects missing access_token', async () => {
  await startTestServer()
  try {
    const res = await postJSON('/api/orcid/callback', {})
    assert.strictEqual(res.status, 400)
  } finally {
    await stopTestServer()
  }
})

test('web-api: GET /api/orcid/authorize redirects to ORCID', async () => {
  await startTestServer()
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${testPort}/api/orcid/authorize`, (r) => resolve(r)).on('error', reject)
    })
    assert.strictEqual(res.statusCode, 302)
    assert.ok(res.headers.location.startsWith('https://orcid.org/oauth/authorize?'))
    assert.ok(res.headers.location.includes('response_type=token'))
  } finally {
    await stopTestServer()
  }
})

// ---- Serve status (Phase 5) ----

test('web-api: GET /api/serve-status returns serving:false by default', async () => {
  await startTestServer()
  try {
    const res = await fetchUrl('/api/serve-status')
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.serving, false)
  } finally {
    await stopTestServer()
  }
})

test('web-api: GET /api/serve-status reports embedded swarm state when serving', { timeout: 30000 }, async () => {
  await startTestServer({ serve: true, subscribe: ['q-bio.GN'] })
  try {
    const res = await fetchUrl('/api/serve-status')
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.serving, true)
    assert.ok(Number.isInteger(data.archive_peers))
    assert.ok(Number.isInteger(data.blob_connections))
    assert.ok(data.topics.includes('archive'))
    assert.ok(data.topics.includes('blob-transfer'))
    assert.ok(data.topics.includes('q-bio.GN'))
  } finally {
    await stopTestServer()
  }
})

// ---- Fetch-remote (Phase 2) ----

test('web-api: POST /api/fetch-remote writes remote.json and reopens store as replica', { timeout: 30000 }, async () => {
  await startTestServer()
  try {
    const fakeBeeKey = '11'.repeat(32)
    const res = await postJSON('/api/fetch-remote', { bee_key: fakeBeeKey })
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.ok, true)
    assert.strictEqual(typeof data.papers_synced, 'number')

    assert.ok(fs.existsSync(path.join(tmpDir, 'remote.json')))
    const remote = JSON.parse(fs.readFileSync(path.join(tmpDir, 'remote.json'), 'utf-8'))
    assert.strictEqual(remote.bee_key, fakeBeeKey)

    const status = JSON.parse((await fetchUrl('/api/status')).body)
    assert.strictEqual(status.is_replica, true)
    assert.strictEqual(status.bee_key, fakeBeeKey)
  } finally {
    await stopTestServer()
  }
})

test('web-api: POST /api/fetch-remote rejects invalid bee_key', async () => {
  await startTestServer()
  try {
    const res = await postJSON('/api/fetch-remote', { bee_key: 'not-hex' })
    assert.strictEqual(res.status, 400)
  } finally {
    await stopTestServer()
  }
})
