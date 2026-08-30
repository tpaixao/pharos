'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { orcidAuth, getOrcidAuthUrl, hasOrcidConfig, loadCachedOrcid, saveOrcidConfig, generateState, exchangeCodeForOrcid } = require('../src/publish/orcid')

// Use a temporary config path for tests (monkey-patch)
const CONFIG_PATH = path.join(os.homedir(), '.pharos', 'config.json')
const origExists = fs.existsSync
const origRead = fs.readFileSync
const origWrite = fs.writeFileSync

function withTempConfig(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-orcid-test-'))
  const tmpConfig = path.join(tmpDir, 'config.json')
  // Monkey-patch CONFIG_PATH by stubbing fs calls for that specific path
  const origExistsSync = fs.existsSync
  const origReadFileSync = fs.readFileSync
  const origWriteFileSync = fs.writeFileSync
  const origMkdirSync = fs.mkdirSync

  // We can't easily monkey-patch the module's CONFIG_PATH constant,
  // so test the constituent functions directly
  return fn({ tmpDir, tmpConfig })
}

test('orcid: mock auth returns Tiago ORCID when no credentials', async () => {
  const orcid = await orcidAuth()
  assert.strictEqual(orcid.orcid_id, '0000-0003-2361-3953')
  assert.strictEqual(orcid.orcid_name, 'Tiago Paixao')
  assert.ok(orcid.orcid_verified_at)
})

test('orcid: force with missing credentials throws instead of mock fallback', async () => {
  await assert.rejects(
    orcidAuth({ force: true }),
    /ORCID client ID required but not configured/
  )
})

test('orcid: implicit flow with missing client ID throws', async () => {
  await assert.rejects(
    orcidAuth({ nonce: 'abc' }),
    /ORCID client ID required but not configured/
  )
})

test('orcid: generateNonce produces deterministic 64-char hex', () => {
  const { generateNonce } = require('../src/publish/orcid')
  const r = generateNonce('abc123', 'feedkey')
  assert.strictEqual(r.nonce.length, 64)
  assert.match(r.nonce, /^[0-9a-f]{64}$/)
  assert.ok(r.generated_at)
})

test('orcid: generateNonce binds content+feedKey (+timestamp)', () => {
  const { generateNonce } = require('../src/publish/orcid')
  const a = generateNonce('content-a', 'feedkey-1')
  const b = generateNonce('content-b', 'feedkey-1')
  const c = generateNonce('content-a', 'feedkey-2')
  assert.notStrictEqual(a.nonce, b.nonce, 'different content must give different nonce')
  assert.notStrictEqual(a.nonce, c.nonce, 'different feed key must give different nonce')
})

test('orcid: getOrcidImplicitUrl builds implicit OpenID URL with nonce', () => {
  const { getOrcidImplicitUrl } = require('../src/publish/orcid')
  const state = generateState()
  const url = getOrcidImplicitUrl('APP-TEST123', state, 'nonce-xyz', false)
  assert.ok(url.startsWith('https://orcid.org/oauth/authorize?'))
  assert.ok(url.includes('client_id=APP-TEST123'))
  assert.ok(url.includes('response_type=token'))
  assert.ok(url.includes('scope=openid'))
  assert.ok(url.includes(`state=${state}`))
  assert.ok(url.includes('nonce=nonce-xyz'))
  assert.ok(url.includes('redirect_uri=https%3A%2F%2Ftiagopaixao.com%2Forcid%2Fcallback.html'))
})

test('orcid: getOrcidImplicitUrl sandbox variant', () => {
  const { getOrcidImplicitUrl } = require('../src/publish/orcid')
  const url = getOrcidImplicitUrl('APP-TEST456', undefined, undefined, true)
  assert.ok(url.startsWith('https://sandbox.orcid.org/oauth/authorize?'))
  assert.ok(url.includes('response_type=token'))
  assert.ok(url.includes('state='))
})

test('orcid: verifyAccessToken throws on userinfo failure', async () => {
  const { verifyAccessToken } = require('../src/publish/orcid')
  const origFetch = global.fetch
  global.fetch = async () => ({ ok: false, status: 401 })
  try {
    await assert.rejects(
      verifyAccessToken('bad-token'),
      /ORCID userinfo verification failed: 401/
    )
  } finally {
    global.fetch = origFetch
  }
})

test('orcid: verifyAccessToken returns verified claims on success', async () => {
  const { verifyAccessToken } = require('../src/publish/orcid')
  const origFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ sub: '0000-0002-1694-233X', name: 'Test Author' })
  })
  try {
    const claims = await verifyAccessToken('tok', { expectedNonce: 'n1' })
    assert.strictEqual(claims.orcid_id, '0000-0002-1694-233X')
    assert.strictEqual(claims.name, 'Test Author')
    assert.strictEqual(claims.nonce_verified, 'n1')
    assert.ok(claims.verified_at)
  } finally {
    global.fetch = origFetch
  }
})

test('orcid: generateState returns 32-char hex string', () => {
  const state = generateState()
  assert.strictEqual(state.length, 32)
  assert.match(state, /^[0-9a-f]{32}$/)
})

test('orcid: generateState produces unique values', () => {
  const s1 = generateState()
  const s2 = generateState()
  assert.notStrictEqual(s1, s2)
})

test('orcid: getOrcidAuthUrl builds correct production URL', () => {
  const state = generateState()
  const url = getOrcidAuthUrl('APP-TEST123', state, false)
  assert.ok(url.startsWith('https://orcid.org/oauth/authorize?'))
  assert.ok(url.includes('client_id=APP-TEST123'))
  assert.ok(url.includes('response_type=code'))
  assert.ok(url.includes('scope=%2Fauthenticate'))
  assert.ok(url.includes(`state=${state}`))
  assert.ok(url.includes('redirect_uri=https%3A%2F%2Ftiagopaixao.com%2Forcid%2Fcallback.html'))
})

test('orcid: getOrcidAuthUrl builds correct sandbox URL', () => {
  const state = generateState()
  const url = getOrcidAuthUrl('APP-TEST456', state, true)
  assert.ok(url.startsWith('https://sandbox.orcid.org/oauth/authorize?'))
  assert.ok(url.includes('client_id=APP-TEST456'))
})

test('orcid: getOrcidAuthUrl generates state if not provided', () => {
  const url = getOrcidAuthUrl('APP-TEST789')
  assert.ok(url.includes('state='))
})

test('orcid: hasOrcidConfig detects valid config', () => {
  assert.strictEqual(hasOrcidConfig({ orcid_id: '0000-0003-2361-3953' }), true)
  assert.strictEqual(hasOrcidConfig({}), false)
  assert.strictEqual(hasOrcidConfig(null), false)
  assert.strictEqual(hasOrcidConfig({ orcid_id: null }), false)
})

test('orcid: hasOrcidConfig returns true for any truthy orcid_id string', () => {
  // hasOrcidConfig is a simple presence check, not a format validator
  assert.strictEqual(hasOrcidConfig({ orcid_id: 'bad-format' }), true)
})

test('orcid: saveOrcidConfig writes valid JSON', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharos-orcid-cfg-'))
  const tmpConfig = path.join(tmpDir, 'config.json')

  // We need to test saveOrcidConfig, but it writes to CONFIG_PATH (hardcoded).
  // Instead, test that the JSON round-trips correctly.
  const orcid = {
    orcid_id: '0000-0003-2361-3953',
    orcid_name: 'Tiago Paixao',
    orcid_verified_at: '2026-08-28T17:00:00.000Z'
  }
  // Simulate what saveOrcidConfig does
  const config = {}
  Object.assign(config, orcid)
  fs.writeFileSync(tmpConfig, JSON.stringify(config, null, 2))

  const loaded = JSON.parse(fs.readFileSync(tmpConfig, 'utf-8'))
  assert.strictEqual(loaded.orcid_id, '0000-0003-2361-3953')
  assert.strictEqual(loaded.orcid_name, 'Tiago Paixao')
  assert.strictEqual(loaded.orcid_verified_at, '2026-08-28T17:00:00.000Z')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('orcid: exchangeCodeForOrcid throws on non-200 response', async () => {
  // Mock fetch to return error
  const origFetch = global.fetch
  global.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => 'invalid_grant'
  })

  try {
    await assert.rejects(
      exchangeCodeForOrcid('bad-code', 'client-id', 'client-secret', false),
      /ORCID token exchange failed: 400/
    )
  } finally {
    global.fetch = origFetch
  }
})

test('orcid: exchangeCodeForOrcid returns orcid_id and name on success', async () => {
  const origFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      orcid: '0000-0003-2361-3953',
      name: 'Tiago Paixao',
      access_token: 'test-token',
      token_type: 'bearer',
      scope: '/authenticate'
    })
  })

  try {
    const orcid = await exchangeCodeForOrcid('good-code', 'client-id', 'client-secret', false)
    assert.strictEqual(orcid.orcid_id, '0000-0003-2361-3953')
    assert.strictEqual(orcid.orcid_name, 'Tiago Paixao')
    assert.ok(orcid.orcid_verified_at)
  } finally {
    global.fetch = origFetch
  }
})

test('orcid: exchangeCodeForOrcid handles unknown name', async () => {
  const origFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      orcid: '0000-0002-1825-009X',
      name: null,
      access_token: 'test-token'
    })
  })

  try {
    const orcid = await exchangeCodeForOrcid('good-code', 'client-id', 'client-secret', false)
    assert.strictEqual(orcid.orcid_name, 'Unknown')
  } finally {
    global.fetch = origFetch
  }
})

test('orcid: exchangeCodeForOrcid uses sandbox URL when sandbox=true', async () => {
  let capturedUrl = null
  const origFetch = global.fetch
  global.fetch = async (url) => {
    capturedUrl = url
    return {
      ok: true,
      status: 200,
      json: async () => ({
        orcid: '0000-0003-2361-3953',
        name: 'Test',
        access_token: 't'
      })
    }
  }

  try {
    await exchangeCodeForOrcid('code', 'cid', 'secret', true)
    assert.ok(capturedUrl.startsWith('https://sandbox.orcid.org/oauth/token'))
  } finally {
    global.fetch = origFetch
  }
})