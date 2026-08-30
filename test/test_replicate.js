const TEST_ORCID = '0000-0003-2361-3953'
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { sendMessage, readMessages, serveBlobs, requestBlob } = require('../src/replicate/replicate')
const { computeHash } = require('../src/core/hash')
const { initStore, close, getStore } = require('../src/core/store')
const { publish } = require('../src/publish/publish')
const path = require('path')
const fs = require('fs')
const os = require('os')

// Helper: create a minimal valid PDF
function makeTestPdf(content = 'Test content') {
  const stream = `BT /F1 12 Tf 100 700 Td (${content}) Tj ET`
  const len = stream.length
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length ${len} >>\nstream\n${stream}\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000214 00000 n \n0000000268 00000 n \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n330\n%%EOF`
  )
}

// Helper: in-memory duplex stream pair
const { Duplex } = require('node:stream')

function createStreamPair() {
  class FakeSocket extends Duplex {
    constructor(other) {
      super()
      this._other = other
    }
    _read() {}
    _write(chunk, enc, cb) {
      this._other.push(chunk)
      cb()
    }
  }
  
  const a = new FakeSocket(null)
  const b = new FakeSocket(a)
  a._other = b
  
  return [a, b]
}

// Ensure store is closed before each test
async function freshStore(tmpDir) {
  await close()
  await initStore(tmpDir)
  return getStore()
}

test('replicate: sendMessage/readMessages round-trip', async () => {
  const [client, server] = createStreamPair()
  
  const received = []
  const cleanup = readMessages(server, (msg) => received.push(msg))
  
  sendMessage(client, { type: 'request_blob', hash: 'blake2b:abc123' })
  sendMessage(client, { type: 'pin_announce', hashes: ['blake2b:abc', 'blake2b:def'] })
  
  await new Promise(r => setTimeout(r, 100))
  
  assert.equal(received.length, 2)
  assert.equal(received[0].type, 'request_blob')
  assert.equal(received[0].hash, 'blake2b:abc123')
  assert.equal(received[1].type, 'pin_announce')
  assert.equal(received[1].hashes.length, 2)
  
  cleanup()
  client.destroy()
  server.destroy()
})

test('replicate: serveBlobs serves a published blob on request', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-repl-test-'))
  try {
    await freshStore(tmpDir)
    
    const pdfPath = path.join(tmpDir, 'test.pdf')
    fs.writeFileSync(pdfPath, makeTestPdf('Replicate Test'))
    
        
    const result = await publish(pdfPath, {
      title: 'Replication Test Paper',
      authors: [{ name: 'Test Author', orcid: null }],
      abstract: 'Testing blob serving for replication',
      subject: 'q-bio.GN',
      signedBy: TEST_ORCID
    })
    
    assert.ok(result.paper_id)
    assert.ok(result.content_hash)
    
    const [client, serverSock] = createStreamPair()
    const store = getStore()
    
    serveBlobs(serverSock, store)
    
    const blob = await requestBlob(client, result.content_hash, 5000)
    
    assert.ok(blob)
    assert.equal(blob.length, makeTestPdf('Replicate Test').length)
    
    const actualHash = computeHash(blob)
    assert.equal(actualHash, result.content_hash)
    
    client.destroy()
    serverSock.destroy()
  } finally {
    await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('replicate: requestBlob returns null for nonexistent hash', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-repl-test-'))
  try {
    await freshStore(tmpDir)
    const store = getStore()
    
    const [client, serverSock] = createStreamPair()
    serveBlobs(serverSock, store)
    
    const blob = await requestBlob(client, 'blake2b:nonexistent', 3000)
    
    assert.equal(blob, null)
    
    client.destroy()
    serverSock.destroy()
  } finally {
    await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('replicate: health report tracks at-risk papers', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-repl-test-'))
  try {
    await freshStore(tmpDir)
    
    const pdfPath = path.join(tmpDir, 'test.pdf')
    fs.writeFileSync(pdfPath, makeTestPdf('Health Test'))
    
        
    const pubResult = await publish(pdfPath, {
      title: 'Health Test Paper',
      authors: [{ name: 'Test', orcid: null }],
      abstract: 'Testing health reports',
      subject: 'q-bio.QM',
      signedBy: TEST_ORCID
    })
    
    const paperId = pubResult.paper_id
    const { healthReport, atRiskPapers, addReplica } = require('../src/replicate/health')
    
    // Initially at-risk (1 replica: self/publisher)
    const report1 = await healthReport()
    assert.equal(report1.total, 1)
    assert.equal(report1.atRisk, 1)
    assert.equal(report1.healthy, 0)
    
    // Add a replica peer
    await addReplica(paperId, 'peer-abc')
    const report2 = await healthReport()
    assert.equal(report2.atRisk, 1)
    assert.equal(report2.healthy, 0)
    assert.equal(report2.papers[0].replicas, 2)
    
    // Add 1 more replica -> 3 total = healthy
    await addReplica(paperId, 'peer-def')
    const report3 = await healthReport()
    assert.equal(report3.healthy, 1)
    assert.equal(report3.atRisk, 0)
    
    // atRiskPapers returns empty now
    const atRisk = await atRiskPapers()
    assert.equal(atRisk.length, 0)
  } finally {
    await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('replicate: pin_announce records replica in publisher index', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-repl-test-'))
  try {
    await freshStore(tmpDir)

    const pdfPath = path.join(tmpDir, 'test.pdf')
    fs.writeFileSync(pdfPath, makeTestPdf('Pin Announce Test'))

        const result = await publish(pdfPath, {
      title: 'Pin Announce Test Paper',
      authors: [{ name: 'Test Author', orcid: null }],
      abstract: 'Testing pin announcements',
      subject: 'q-bio.GN',
      signedBy: TEST_ORCID
    })

    const { addReplica } = require('../src/replicate/health')

    // Simulate a peer announcing its pins (as the serve daemon now does)
    const [client, serverSock] = createStreamPair()
    const store = getStore()

    const recorded = []
    serveBlobs(serverSock, store, {
      onPinAnnounce: async (paperId, peerKey) => {
        recorded.push(paperId)
        await addReplica(paperId, peerKey)
      }
    })

    sendMessage(client, {
      type: 'pin_announce',
      hashes: [result.content_hash, 'blake2b:unknown-hash'],
      peer_key: 'peer-1234'
    })

    await new Promise(r => setTimeout(r, 200))

    // The known hash should be recorded as a replica
    assert.deepEqual(recorded, [result.paper_id])

    const meta = await store.bee.get(`paper:${result.paper_id}`)
    assert.ok(meta.value.replicated_by.includes('peer-1234'))

    client.destroy()
    serverSock.destroy()
  } finally {
    await close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
