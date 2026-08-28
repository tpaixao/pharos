'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')

const { initStore, close, getStore } = require('../src/core/store')
const { publish, getVersions } = require('../src/publish/publish')
const { orcidAuth } = require('../src/publish/orcid')

// Minimal valid PDF for testing
function makeTestPdf(title) {
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-ver-test-'))
  const pdfPath = path.join(tmpDir, 'test.pdf')
  const pdf2Path = path.join(tmpDir, 'test_v2.pdf')
  fs.writeFileSync(pdfPath, makeTestPdf('Version Test V1'))
  fs.writeFileSync(pdf2Path, makeTestPdf('Version Test V2'))
  try {
    await initStore(tmpDir)
    await fn({ tmpDir, pdfPath, pdf2Path })
  } finally {
    await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

test('versions: v1 has no previous_version_hash', async () => {
  await withTempStore(async ({ pdfPath }) => {
    const orcid = await orcidAuth()
    const result = await publish(pdfPath, {
      title: 'Version Test',
      authors: [{ name: 'Author' }],
      abstract: 'Abstract',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })
    assert.strictEqual(result.version, 1)
    assert.strictEqual(result.duplicate, false)

    const { getPaper } = require('../src/publish/publish')
    const meta = await getPaper(result.paper_id)
    assert.strictEqual(meta.previous_version_hash, null)
  })
})

test('versions: revises creates v2 with correct previous_version_hash', async () => {
  await withTempStore(async ({ pdfPath, pdf2Path }) => {
    const orcid = await orcidAuth()

    // Publish v1
    const r1 = await publish(pdfPath, {
      title: 'Version Test',
      authors: [{ name: 'Author' }],
      abstract: 'V1 abstract',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })
    assert.strictEqual(r1.version, 1)

    // Publish v2 as revision of v1
    const r2 = await publish(pdf2Path, {
      title: 'Version Test',
      authors: [{ name: 'Author' }],
      abstract: 'V2 abstract with changes',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id,
      revises: r1.paper_id
    })
    assert.strictEqual(r2.version, 2)
    assert.strictEqual(r2.duplicate, false)

    // v2 should have different paper_id (same base, different seq)
    assert.notStrictEqual(r1.paper_id, r2.paper_id)
    // Same base prefix (date part should match)
    const base1 = r1.paper_id.split('/').slice(0, -1).join('/')
    const base2 = r2.paper_id.split('/').slice(0, -1).join('/')
    assert.strictEqual(base1, base2)

    // v2 metadata should reference v1 hash
    const { getPaper } = require('../src/publish/publish')
    const meta2 = await getPaper(r2.paper_id)
    assert.strictEqual(meta2.version, 2)
    assert.strictEqual(meta2.previous_version_hash, r1.content_hash)
  })
})

test('versions: getVersions returns all versions oldest first', async () => {
  await withTempStore(async ({ pdfPath, pdf2Path }) => {
    const orcid = await orcidAuth()
    const tmpDir = path.join(os.tmpdir(), 'pharos-ver3-test-' + Date.now())
    fs.mkdirSync(tmpDir, { recursive: true })
    const pdf3Path = path.join(tmpDir, 'test_v3.pdf')
    fs.writeFileSync(pdf3Path, makeTestPdf('Version Test V3'))

    try {
      // Publish v1, v2, v3
      const r1 = await publish(pdfPath, {
        title: 'Multi Version Paper',
        authors: [{ name: 'Author' }],
        abstract: 'V1',
        subject: 'q-bio.QM',
        signedBy: orcid.orcid_id
      })
      const r2 = await publish(pdf2Path, {
        title: 'Multi Version Paper',
        authors: [{ name: 'Author' }],
        abstract: 'V2',
        subject: 'q-bio.QM',
        signedBy: orcid.orcid_id,
        revises: r1.paper_id
      })
      const r3 = await publish(pdf3Path, {
        title: 'Multi Version Paper',
        authors: [{ name: 'Author' }],
        abstract: 'V3',
        subject: 'q-bio.QM',
        signedBy: orcid.orcid_id,
        revises: r2.paper_id
      })

      // getVersions from any version's paper_id
      const versions = await getVersions(r1.paper_id)
      assert.strictEqual(versions.length, 3)
      assert.strictEqual(versions[0].version, 1)
      assert.strictEqual(versions[1].version, 2)
      assert.strictEqual(versions[2].version, 3)

      // Verify chain: v2.previous = v1.hash, v3.previous = v2.hash
      assert.strictEqual(versions[1].previous_version_hash, versions[0].content_hash)
      assert.strictEqual(versions[2].previous_version_hash, versions[1].content_hash)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

test('versions: getVersions returns empty for nonexistent paper', async () => {
  await withTempStore(async () => {
    const versions = await getVersions('pharos:q-bio.GN/1999.01.01/999')
    assert.strictEqual(versions.length, 0)
  })
})

test('versions: getVersions works when called from v2 paper_id', async () => {
  await withTempStore(async ({ pdfPath, pdf2Path }) => {
    const orcid = await orcidAuth()

    const r1 = await publish(pdfPath, {
      title: 'Chain Test',
      authors: [{ name: 'Author' }],
      abstract: 'V1',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id
    })
    const r2 = await publish(pdf2Path, {
      title: 'Chain Test',
      authors: [{ name: 'Author' }],
      abstract: 'V2',
      subject: 'q-bio.GN',
      signedBy: orcid.orcid_id,
      revises: r1.paper_id
    })

    // Query from v2's paper_id should still find both versions
    const versions = await getVersions(r2.paper_id)
    assert.strictEqual(versions.length, 2)
    assert.strictEqual(versions[0].version, 1)
    assert.strictEqual(versions[1].version, 2)
  })
})