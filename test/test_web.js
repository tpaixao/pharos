'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const path = require('path')
const os = require('os')
const fs = require('fs')

const pharos = require('../src/lib')

let testPort = 18093
let server = null
let tmpDir = null

async function startTestServer() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-web-test-'))
  await pharos.initStore(tmpDir)
  server = await pharos.webServer.startServer({ port: testPort, dataDir: tmpDir })
  return server
}

async function stopTestServer() {
  if (server) {
    await pharos.webServer.stopServer()
    server = null
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
  await pharos.close()
}

function fetchUrl(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${testPort}${path}`, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    }).on('error', reject)
  })
}

function postUrl(path, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${testPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': body.length }
    }, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function requestMethod(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${testPort}${path}`, { method }, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end()
  })
}

function buildMultipart(fields, files) {
  const boundary = 'testboundary' + Math.random().toString(36).slice(2)
  const parts = []

  for (const [key, val] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}`)
  }

  for (const [key, file] of Object.entries(files || {})) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${file.filename}"\r\nContent-Type: application/pdf\r\n\r\n`)
  }

  let buffer = Buffer.concat([
    Buffer.from(parts[0], 'utf-8'),
    ...(parts.length > 1 ? parts.slice(1).map((p, i) => {
      if (files && Object.keys(files)[i] && p.includes('filename=')) {
        return Buffer.concat([Buffer.from(p, 'utf-8'), files[Object.keys(files)[i]].data])
      }
      return Buffer.from(p, 'utf-8')
    }) : [])
  ])

  // Simpler approach: build manually
  const chunks = []
  for (const [key, val] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`))
  }
  for (const [key, file] of Object.entries(files || {})) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${file.filename}"\r\nContent-Type: application/pdf\r\n\r\n`))
    chunks.push(file.data)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))

  return {
    buffer: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  }
}

function makeTestPdf(title) {
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
xref
0 4
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
trailer << /Size 4 /Root 1 0 R >>
startxref
190
%%EOF`)
}

async function publishTestPaper(title, subject) {
  const orcid = await pharos.orcidAuth()
  const pdfPath = path.join(tmpDir, 'test.pdf')
  fs.writeFileSync(pdfPath, makeTestPdf(title))
  const result = await pharos.publish(pdfPath, {
    title,
    authors: [{ name: 'Test Author' }],
    abstract: 'Test abstract for ' + title,
    subject: subject || 'q-bio.GN',
    signedBy: orcid.orcid_id
  })
  return result
}

// ---- Tests ----

test('web: GET / returns homepage HTML', async () => {
  await startTestServer()
  try {
    const res = await fetchUrl('/')
    assert.strictEqual(res.status, 200)
    assert.ok(res.headers['content-type'].includes('text/html'))
    assert.ok(res.body.includes('Pharos'))
    assert.ok(res.body.includes('P2P Preprint Archive'))
    assert.ok(res.body.includes('Browse'))
    assert.ok(res.body.includes('Search'))
  } finally {
    await stopTestServer()
  }
})

test('web: GET /api/stats returns JSON with total_papers', async () => {
  await startTestServer()
  try {
    const res = await fetchUrl('/api/stats')
    assert.strictEqual(res.status, 200)
    assert.ok(res.headers['content-type'].includes('application/json'))
    const data = JSON.parse(res.body)
    assert.strictEqual(data.total_papers, 0)
    assert.ok(data.subjects)
  } finally {
    await stopTestServer()
  }
})

test('web: GET /api/papers returns empty list initially', async () => {
  await startTestServer()
  try {
    const res = await fetchUrl('/api/papers')
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.papers.length, 0)
  } finally {
    await stopTestServer()
  }
})

test('web: after publishing, /api/papers returns the paper', async () => {
  await startTestServer()
  try {
    await publishTestPaper('Test Paper for Web', 'q-bio.GN')
    const res = await fetchUrl('/api/papers')
    const data = JSON.parse(res.body)
    assert.strictEqual(data.papers.length, 1)
    assert.strictEqual(data.papers[0].title, 'Test Paper for Web')
  } finally {
    await stopTestServer()
  }
})

test('web: /api/stats shows correct count after publish', async () => {
  await startTestServer()
  try {
    await publishTestPaper('Stats Paper', 'q-bio.QM')
    const res = await fetchUrl('/api/stats')
    const data = JSON.parse(res.body)
    assert.strictEqual(data.total_papers, 1)
    assert.strictEqual(data.subjects['q-bio.QM'], 1)
  } finally {
    await stopTestServer()
  }
})

test('web: GET /api/paper/:id returns metadata', async () => {
  await startTestServer()
  try {
    const result = await publishTestPaper('Detail Paper', 'q-bio.GN')
    const res = await fetchUrl('/api/paper/' + encodeURIComponent(result.paper_id))
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data.title, 'Detail Paper')
    assert.strictEqual(data.subject, 'q-bio.GN')
    assert.ok(data.content_hash)
  } finally {
    await stopTestServer()
  }
})

test('web: GET /api/search returns FTS results', async () => {
  await startTestServer()
  try {
    await publishTestPaper('Single Cell RNA-seq Analysis', 'q-bio.GN')
    const res = await fetchUrl('/api/search?q=' + encodeURIComponent('single cell'))
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.ok(data.length > 0)
    assert.ok(data[0].paper_id)
    assert.ok(data[0].title)
  } finally {
    await stopTestServer()
  }
})

test('web: GET /api/versions/:id returns version list', async () => {
  await startTestServer()
  try {
    const r1 = await publishTestPaper('Versioned Paper', 'q-bio.GN')
    const res = await fetchUrl('/api/versions/' + encodeURIComponent(r1.paper_id))
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.ok(Array.isArray(data))
    assert.strictEqual(data.length, 1)
    assert.strictEqual(data[0].version, 1)
  } finally {
    await stopTestServer()
  }
})

test('web: GET /pdf/:id serves PDF content', async () => {
  await startTestServer()
  try {
    const result = await publishTestPaper('PDF Paper', 'q-bio.GN')
    const res = await fetchUrl('/pdf/' + encodeURIComponent(result.paper_id))
    assert.strictEqual(res.status, 200)
    assert.ok(res.headers['content-type'].includes('application/pdf'))
    assert.ok(res.body.length > 0)
  } finally {
    await stopTestServer()
  }
})

test('web: GET /paper/:id returns HTML detail page', async () => {
  await startTestServer()
  try {
    const result = await publishTestPaper('Detail Page Test', 'q-bio.GN')
    const res = await fetchUrl('/paper/' + encodeURIComponent(result.paper_id))
    assert.strictEqual(res.status, 200)
    assert.ok(res.headers['content-type'].includes('text/html'))
    assert.ok(res.body.includes('Pharos'))
    assert.ok(res.body.includes('load()'))
  } finally {
    await stopTestServer()
  }
})

test('web: GET /api/papers?subject= filters by subject', async () => {
  await startTestServer()
  try {
    await publishTestPaper('Paper A', 'q-bio.GN')
    await publishTestPaper('Paper B', 'q-bio.QM')
    const res = await fetchUrl('/api/papers?subject=q-bio.GN')
    const data = JSON.parse(res.body)
    assert.strictEqual(data.subject, 'q-bio.GN')
    assert.strictEqual(data.papers.length, 1)
    assert.strictEqual(data.papers[0].title, 'Paper A')
  } finally {
    await stopTestServer()
  }
})

test('web: unknown route returns 404 JSON', async () => {
  await startTestServer()
  try {
    const res = await fetchUrl('/nonexistent')
    assert.strictEqual(res.status, 404)
    const data = JSON.parse(res.body)
    assert.ok(data.error)
  } finally {
    await stopTestServer()
  }
})

test('web: GET /api/paper/nonexistent returns null', async () => {
  await startTestServer()
  try {
    const res = await fetchUrl('/api/paper/nonexistent-id')
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.strictEqual(data, null)
  } finally {
    await stopTestServer()
  }
})
test('web: GET /api/disk-usage returns storage stats', async () => {
  await startTestServer()
  try {
    await publishTestPaper('Disk Usage Paper', 'q-bio.GN')
    const res = await fetchUrl('/api/disk-usage')
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.ok(data.total_bytes >= 0)
    assert.ok(data.store_bytes >= 0)
  } finally {
    await stopTestServer()
  }
})

test('web: POST /api/publish rejects non-PDF files', async () => {
  await startTestServer()
  try {
    const body = buildMultipart({
      title: 'Fake Paper',
      subject: 'q-bio.GN',
      authors: 'Test Author'
    }, { pdf: { filename: 'fake.pdf', data: Buffer.from('not a pdf') } })
    const res = await postUrl('/api/publish', body.buffer, body.contentType)
    assert.strictEqual(res.status, 400)
    const data = JSON.parse(res.body)
    assert.ok(data.error.includes('not a valid PDF'))
  } finally {
    await stopTestServer()
  }
})

test('web: POST /api/publish rejects missing title', async () => {
  await startTestServer()
  try {
    const body = buildMultipart({
      subject: 'q-bio.GN',
      authors: 'Test Author'
    }, { pdf: { filename: 'test.pdf', data: makeTestPdf('test') } })
    const res = await postUrl('/api/publish', body.buffer, body.contentType)
    assert.strictEqual(res.status, 400)
    const data = JSON.parse(res.body)
    assert.ok(data.error.includes('Title is required'))
  } finally {
    await stopTestServer()
  }
})

test('web: POST /api/publish rejects invalid subject', async () => {
  await startTestServer()
  try {
    const body = buildMultipart({
      title: 'Bad Subject Paper',
      subject: 'invalid.subject',
      authors: 'Test Author'
    }, { pdf: { filename: 'test.pdf', data: makeTestPdf('test') } })
    const res = await postUrl('/api/publish', body.buffer, body.contentType)
    assert.strictEqual(res.status, 400)
    const data = JSON.parse(res.body)
    assert.ok(data.error.includes('Invalid subject'))
  } finally {
    await stopTestServer()
  }
})

test('web: POST /api/publish accepts valid paper via web upload', async () => {
  await startTestServer()
  try {
    const body = buildMultipart({
      title: 'Web Upload Paper',
      subject: 'q-bio.GN',
      authors: 'Author One, Author Two',
      abstract: 'An abstract for the web upload test paper.',
      orcid: '0000-0002-1825-0097'
    }, { pdf: { filename: 'test.pdf', data: makeTestPdf('test') } })
    const res = await postUrl('/api/publish', body.buffer, body.contentType)
    assert.strictEqual(res.status, 200)
    const data = JSON.parse(res.body)
    assert.ok(data.success)
    assert.ok(data.paper_id)
  } finally {
    await stopTestServer()
  }
})

test('web: PUT method returns 405', async () => {
  await startTestServer()
  try {
    const res = await requestMethod('PUT', '/api/papers')
    assert.strictEqual(res.status, 405)
  } finally {
    await stopTestServer()
  }
})

test('web: response headers include security headers', async () => {
  await startTestServer()
  try {
    const res = await fetchUrl('/')
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff')
    assert.strictEqual(res.headers['x-frame-options'], 'SAMEORIGIN')
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer')
  } finally {
    await stopTestServer()
  }
})

test('web: search query over 500 chars returns 400', async () => {
  await startTestServer()
  try {
    const longQuery = 'a'.repeat(501)
    const res = await fetchUrl('/api/search?q=' + encodeURIComponent(longQuery))
    assert.strictEqual(res.status, 400)
    const data = JSON.parse(res.body)
    assert.ok(data.error.includes('too long'))
  } finally {
    await stopTestServer()
  }
})
