'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')

const { initStore, close } = require('../src/core/store')
const { search, rebuildIndex } = require('../src/search/index')
const { publish } = require('../src/publish/publish')
const { orcidAuth } = require('../src/publish/orcid')

function makeTestPdf(title, body) {
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${body.length + 30} >> stream
BT /F1 12 Tf 100 700 Td (${title}) Tj 0 -20 Td (${body}) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
400
%%EOF`)
}

async function withTempStore(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-test-'))
  try {
    await initStore(tmpDir)
    await fn({ tmpDir })
  } finally {
    await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

test('search: FTS5 finds paper by title', async () => {
  await withTempStore(async ({ tmpDir }) => {
    const orcid = await orcidAuth()
    const pdfPath = path.join(tmpDir, 'p1.pdf')
    fs.writeFileSync(pdfPath, makeTestPdf('Bayesian inference for genomics', 'Some body text'))

    await publish(pdfPath, {
      title: 'Bayesian inference for genomics',
      authors: [{ name: 'Author' }],
      abstract: 'Bayesian methods for genomic data analysis',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })

    const results = search('bayesian')
    assert.ok(results.length > 0)
    assert.ok(results[0].title.includes('Bayesian'))
  })
})

test('search: FTS5 ranks relevant results higher', async () => {
  await withTempStore(async ({ tmpDir }) => {
    const orcid = await orcidAuth()

    const p1 = path.join(tmpDir, 'p1.pdf')
    fs.writeFileSync(p1, makeTestPdf('Single cell RNA-seq analysis', 'single cell methods'))
    await publish(p1, {
      title: 'Single cell RNA-seq analysis',
      authors: [{ name: 'A' }],
      abstract: 'single cell transcriptomics methods',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })

    const p2 = path.join(tmpDir, 'p2.pdf')
    fs.writeFileSync(p2, makeTestPdf('Plant ecology survey', 'ecology methods not related'))
    await publish(p2, {
      title: 'Plant ecology survey',
      authors: [{ name: 'B' }],
      abstract: 'Plant ecology and biodiversity',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })

    const results = search('single cell')
    assert.ok(results.length > 0)
    assert.strictEqual(results[0].title, 'Single cell RNA-seq analysis')
  })
})

test('search: no results returns empty array', async () => {
  await withTempStore(async () => {
    const results = search('nonexistentterm12345')
    assert.deepStrictEqual(results, [])
  })
})

test('rebuildIndex: rebuilds from Hyperbee', async () => {
  await withTempStore(async ({ tmpDir }) => {
    const orcid = await orcidAuth()

    const p1 = path.join(tmpDir, 'p1.pdf')
    fs.writeFileSync(p1, makeTestPdf('Protein folding dynamics', 'folding dynamics body'))
    await publish(p1, {
      title: 'Protein folding dynamics',
      authors: [{ name: 'A' }],
      abstract: 'Protein folding and dynamics simulation',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })

    // Search should work before rebuild
    let results = search('protein folding')
    assert.ok(results.length > 0)

    // Rebuild and verify still works
    const count = await rebuildIndex()
    assert.ok(count > 0)
    results = search('protein folding')
    assert.ok(results.length > 0)
  })
})