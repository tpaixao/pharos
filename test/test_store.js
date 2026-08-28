'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')

const { initStore, close } = require('../src/core/store')
const { computeHash } = require('../src/core/hash')

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