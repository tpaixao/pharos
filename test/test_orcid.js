'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const os = require('os')

const { orcidAuth, getOrcidImplicitUrl, hasOrcidConfig, loadCachedOrcid, saveOrcidConfig, generateState, generateNonce, verifyAccessToken } = require('../src/publish/orcid')

test('orcid: generateNonce produces deterministic 64-char hex', () => {
  const r = generateNonce('abc123', 'feedkey')
  assert.strictEqual(r.nonce.length, 64)
  assert.match(r.nonce, /^[0-9a-f]{64}$/)
  assert.ok(r.generated_at)
})

test('orcid: generateNonce binds content+feedKey (+timestamp)', () => {
  const a = generateNonce('content-a', 'feedkey-1')
  const b = generateNonce('content-b', 'feedkey-1')
  const c = generateNonce('content-a', 'feedkey-2')
  assert.notStrictEqual(a.nonce, b.nonce, 'different content must give different nonce')
  assert.notStrictEqual(a.nonce, c.nonce, 'different feed key must give different nonce')
})

test('orcid: getOrcidImplicitUrl builds implicit OpenID URL with nonce', () => {
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
  const url = getOrcidImplicitUrl('APP-TEST456', undefined, undefined, true)
  assert.ok(url.startsWith('https://sandbox.orcid.org/oauth/authorize?'))
  assert.ok(url.includes('response_type=token'))
  assert.ok(url.includes('client_id=APP-TEST456'))
})

test('orcid: verifyAccessToken throws on userinfo failure', async () => {
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
  const origFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ sub: '0000-0002-1694-233X', name: 'Test Author' })
  })
  try {
    const claims = await verifyAccessToken('tok', { expectedNonce: 'n1' })
    assert.strictEqual(claims.orcid_id, '0000-0002-1694-233X')
    assert.strictEqual(claims.name, 'Test Author')
    assert.strictEqual(claims.nonce, 'n1')
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

test('orcid: hasOrcidConfig detects valid config', () => {
  assert.strictEqual(hasOrcidConfig({ orcid_id: '0000-0003-2361-3953' }), true)
  assert.strictEqual(hasOrcidConfig({}), false)
  assert.strictEqual(hasOrcidConfig(null), false)
  assert.strictEqual(hasOrcidConfig({ orcid_id: null }), false)
})

test('orcid: hasOrcidConfig is a presence check, not a validator', () => {
  assert.strictEqual(hasOrcidConfig({ orcid_id: 'bad-format' }), true)
})