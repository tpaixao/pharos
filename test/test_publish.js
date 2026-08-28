'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')

const { initStore, close, getStore } = require('../src/core/store')
const { publish, fetchPdf, getPaper } = require('../src/publish/publish')
const { orcidAuth } = require('../src/publish/orcid')

// Create a minimal valid PDF for testing
function makeTestPdf(title) {
  // Minimal PDF structure (not a real PDF, but pdf-parse may fail gracefully)
  return Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 12 Tf 100 700 Td (${title}) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000266 00000 n 
0000000360 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
434
%%EOF`)
}

async function withTempStore(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-test-'))
  const pdfPath = path.join(tmpDir, 'test.pdf')
  fs.writeFileSync(pdfPath, makeTestPdf('Test Paper Title'))
  try {
    await initStore(tmpDir)
    await fn({ tmpDir, pdfPath })
  } finally {
    await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

test('publish: publishes a PDF and returns paper_id', async () => {
  await withTempStore(async ({ pdfPath }) => {
    const orcid = await orcidAuth()
    const result = await publish(pdfPath, {
      title: 'Test Paper',
      authors: [{ name: 'Test Author', orcid: orcid.orcid_id }],
      abstract: 'Test abstract about Bayesian inference',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })
    assert.ok(result.paper_id)
    assert.match(result.paper_id, /^pharos:q-bio\.GN\//)
    assert.strictEqual(result.duplicate, false)
    assert.strictEqual(result.version, 1)
    assert.ok(result.content_hash.startsWith('blake2b:'))
  })
})

test('publish: dedup returns same paper_id', async () => {
  await withTempStore(async ({ pdfPath }) => {
    const orcid = await orcidAuth()
    const r1 = await publish(pdfPath, {
      title: 'Test Paper',
      authors: [{ name: 'Test Author' }],
      abstract: 'Abstract',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })
    const r2 = await publish(pdfPath, {
      title: 'Test Paper',
      authors: [{ name: 'Test Author' }],
      abstract: 'Abstract',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })
    assert.strictEqual(r1.paper_id, r2.paper_id)
    assert.strictEqual(r2.duplicate, true)
  })
})

test('publish: metadata is retrievable via getPaper', async () => {
  await withTempStore(async ({ pdfPath }) => {
    const orcid = await orcidAuth()
    const result = await publish(pdfPath, {
      title: 'Retrievable Paper',
      authors: [{ name: 'Tiago Paixao', orcid: '0000-0003-2361-3953' }],
      abstract: 'Abstract about retrieval',
      subject: 'q-bio.GN',
      signedBy: '0000-0003-2361-3953'
    })
    const meta = await getPaper(result.paper_id)
    assert.ok(meta)
    assert.strictEqual(meta.title, 'Retrievable Paper')
    assert.strictEqual(meta.subject, 'q-bio.GN')
    assert.strictEqual(meta.signed_by, '0000-0003-2361-3953')
    assert.strictEqual(meta.source, 'pharos')
  })
})

test('publish: PDF is retrievable via fetchPdf', async () => {
  await withTempStore(async ({ pdfPath }) => {
    const orcid = await orcidAuth()
    const result = await publish(pdfPath, {
      title: 'Fetchable Paper',
      authors: [{ name: 'Author' }],
      abstract: 'Abstract',
      subject: 'q-bio.QM',
      signedBy: orcid.orcid_id
    })
    const pdf = await fetchPdf(result.paper_id)
    assert.ok(pdf)
    assert.ok(pdf.length > 0)
    assert.ok(pdf.toString().includes('%PDF'))
  })
})

test('publish: getPaper returns null for nonexistent paper', async () => {
  await withTempStore(async () => {
    const meta = await getPaper('pharos:q-bio.GN/1999.01.01/999')
    assert.strictEqual(meta, null)
  })
})

test('orcid: mock auth returns Tiago ORCID', async () => {
  const orcid = await orcidAuth()
  assert.strictEqual(orcid.orcid_id, '0000-0003-2361-3953')
  assert.strictEqual(orcid.orcid_name, 'Tiago Paixao')
  assert.ok(orcid.orcid_verified_at)
})