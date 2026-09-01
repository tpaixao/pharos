'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')

const { initStore, close, evictUnpinned } = require('../src/core/store')
const { computeHash } = require('../src/core/hash')
const { publish } = require('../src/publish/publish')

const TEST_ORCID = '0000-0003-2361-3953'

function makeTestPdf(content = 'Test content') {
  const stream = `BT /F1 12 Tf 100 700 Td (${content}) Tj ET`
  const len = stream.length
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length ${len} >>\nstream\n${stream}\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000214 00000 n \n0000000268 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n330\n%%EOF`
  )
}

async function withTempStore(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-test-'))
  try {
    await initStore(tmpDir)
    const { getStore } = require('../src/core/store')
    const { drive, bee, db } = getStore()
    await fn({ drive, bee, db, tmpDir })
  } finally {
    await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

test('store: Hyperdrive put/get round-trip', async () => {
  await withTempStore(async ({ drive }) => {
    const data = Buffer.from('hello pharos')
    await drive.put('/test/file.txt', data)
    const retrieved = await drive.get('/test/file.txt')
    assert.ok(retrieved)
    assert.strictEqual(retrieved.toString(), 'hello pharos')
  })
})

test('store: Hyperbee put/get round-trip', async () => {
  await withTempStore(async ({ bee }) => {
    await bee.put('key1', { name: 'test', value: 42 })
    const entry = await bee.get('key1')
    assert.ok(entry)
    assert.strictEqual(entry.value.name, 'test')
    assert.strictEqual(entry.value.value, 42)
  })
})

test('store: SQLite FTS5 insert and query', async () => {
  await withTempStore(async ({ db }) => {
    db.prepare('INSERT INTO papers_fts (paper_id, title, authors, abstract, fulltext) VALUES (?, ?, ?, ?, ?)')
      .run('pharos:q-bio.GN/2026.08.28/001', 'Single Cell Analysis', 'Author One', 'Abstract about cells', 'The full text about single cell analysis methods')

    const results = db.prepare('SELECT paper_id, title FROM papers_fts WHERE papers_fts MATCH ?').all('single cell')
    assert.ok(results.length > 0)
    assert.strictEqual(results[0].paper_id, 'pharos:q-bio.GN/2026.08.28/001')
  })
})

test('store: SQLite FTS5 snippet extraction', async () => {
  await withTempStore(async ({ db }) => {
    db.prepare('INSERT INTO papers_fts (paper_id, title, authors, abstract, fulltext) VALUES (?, ?, ?, ?, ?)')
      .run('pharos:test/2026.01.01/001', 'Bayesian Inference', 'Author', 'Abstract', 'This paper discusses bayesian inference methods for posterior estimation in complex models')

    const results = db.prepare(`SELECT snippet(papers_fts, 4, '...', '...', 10, 2) as snip FROM papers_fts WHERE papers_fts MATCH ?`).all('bayesian')
    assert.ok(results.length > 0)
    assert.ok(results[0].snip.includes('bayesian'))
  })
})

test('store: computeHash integration with drive blob', async () => {
  await withTempStore(async ({ drive }) => {
    const pdfContent = Buffer.from('%PDF-1.4 fake pdf content for testing')
    const hash = computeHash(pdfContent)
    await drive.put('/papers/test/v1/fulltext.pdf', pdfContent)
    const retrieved = await drive.get('/papers/test/v1/fulltext.pdf')
    assert.strictEqual(computeHash(retrieved), hash)
  })
})

test('store: evictUnpinned dry-run lists candidates without deleting', async () => {
  await withTempStore(async ({ tmpDir }) => {
    const pdfPath = path.join(tmpDir, 'evict-dry.pdf')
    fs.writeFileSync(pdfPath, makeTestPdf('Evict Dry Run'))
    const result = await publish(pdfPath, {
      title: 'Evict Dry Run Paper',
      authors: [{ name: 'Test Author' }],
      abstract: 'Testing dry-run eviction',
      subject: 'q-bio.GN',
      signedBy: TEST_ORCID
    })

    const preview = await evictUnpinned(0, { dryRun: true })
    assert.strictEqual(preview.dry_run, true)
    assert.strictEqual(preview.would_evict, 1)
    assert.ok(preview.would_free_bytes > 0)
    assert.strictEqual(preview.papers[0].paper_id, result.paper_id)

    // Dry run must not have deleted anything
    const { getStore } = require('../src/core/store')
    const { bee } = getStore()
    const entry = await bee.get(`paper:${result.paper_id}`)
    assert.ok(entry, 'paper should still exist after a dry run')
  })
})

test('store: evictUnpinned dry-run exempts pinned (>=2 replica) papers', async () => {
  await withTempStore(async ({ tmpDir }) => {
    const pdfPath = path.join(tmpDir, 'evict-pinned.pdf')
    fs.writeFileSync(pdfPath, makeTestPdf('Evict Pinned'))
    const result = await publish(pdfPath, {
      title: 'Evict Pinned Paper',
      authors: [{ name: 'Test Author' }],
      abstract: 'Testing pinned exemption',
      subject: 'q-bio.GN',
      signedBy: TEST_ORCID
    })

    const { addReplica } = require('../src/replicate/health')
    await addReplica(result.paper_id, 'peer-a')
    await addReplica(result.paper_id, 'peer-b')

    const preview = await evictUnpinned(0, { dryRun: true })
    assert.strictEqual(preview.would_evict, 0)
    assert.strictEqual(preview.papers.length, 0)
  })
})

test('store: evictUnpinned apply actually deletes candidates', async () => {
  await withTempStore(async ({ tmpDir }) => {
    const pdfPath = path.join(tmpDir, 'evict-apply.pdf')
    fs.writeFileSync(pdfPath, makeTestPdf('Evict Apply'))
    const result = await publish(pdfPath, {
      title: 'Evict Apply Paper',
      authors: [{ name: 'Test Author' }],
      abstract: 'Testing apply eviction',
      subject: 'q-bio.GN',
      signedBy: TEST_ORCID
    })

    const applied = await evictUnpinned(0)
    assert.strictEqual(applied.evicted, 1)
    assert.ok(applied.freed_bytes > 0)
    assert.strictEqual(applied.dry_run, undefined)

    const { getStore } = require('../src/core/store')
    const { bee } = getStore()
    const entry = await bee.get(`paper:${result.paper_id}`)
    assert.strictEqual(entry, null)
  })
})