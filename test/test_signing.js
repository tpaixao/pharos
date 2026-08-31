'use strict'

const test = require('node:test')
const assert = require('node:assert')
const crypto = require('hypercore-crypto')

const {
  signMetadata,
  verifyMetadata,
  canonicalMetadata,
  metadataSignable,
  METADATA_SIGNING_TAG,
  SIGNED_FIELDS
} = require('../src/core/signing')
const { validateMetadata } = require('../src/core/schema')

function makeMeta(overrides = {}) {
  return {
    paper_id: 'pharos:q-bio.GN/2026.08.31/001',
    title: 'A Test Paper',
    authors: [{ name: 'A. Author', orcid: '0000-0003-2361-3953' }],
    abstract: 'Testing metadata signatures.',
    subject: 'q-bio.GN',
    doi: null,
    source: 'pharos',
    version: 1,
    previous_version_hash: null,
    content_hash: 'blake2b:' + 'ab'.repeat(32),
    blob_key: 'blob/2026/08/pharos_q-bio.GN_2026.08.31_001.pdf',
    hyperdrive_key: 'f'.repeat(64),
    signed_by: '0000-0003-2361-3953',
    identity: {
      orcid_auth_flow: 'implicit-openid',
      orcid_verified_at: '2026-08-31T22:00:00Z',
      orcid_nonce: 'deadbeef'
    },
    published_at: '2026-08-31T22:00:00Z',
    first_seen: '2026-08-31T22:00:00Z',
    replicated_by: ['f'.repeat(64)],
    ...overrides
  }
}

test('signing: round trip sign/verify', () => {
  const kp = crypto.keyPair()
  const meta = makeMeta()
  const { signature, signer_pubkey } = signMetadata(meta, kp.secretKey)
  assert.match(signature, /^[0-9a-f]{128}$/)
  assert.match(signer_pubkey, /^[0-9a-f]{64}$/)
  // signer_pubkey must be the public key matching the secret key
  assert.strictEqual(signer_pubkey, kp.publicKey.toString('hex'))
  const result = verifyMetadata({ ...meta, signature, signer_pubkey })
  assert.ok(result.valid, result.reason)
})

test('signing: tampered title fails verification', () => {
  const kp = crypto.keyPair()
  const meta = makeMeta()
  const { signature, signer_pubkey } = signMetadata(meta, kp.secretKey)
  const result = verifyMetadata({ ...meta, title: 'Not The Original Title', signature, signer_pubkey })
  assert.ok(!result.valid)
})

test('signing: tampered identity claim (orcid_auth_flow) fails', () => {
  const kp = crypto.keyPair()
  const meta = makeMeta()
  const { signature, signer_pubkey } = signMetadata(meta, kp.secretKey)
  const tampered = {
    ...meta,
    identity: { ...meta.identity, orcid_auth_flow: 'implicit-openid', orcid_verified_at: '2999-01-01T00:00:00Z' }
  }
  const result = verifyMetadata({ ...tampered, signature, signer_pubkey })
  assert.ok(!result.valid)
})

test('signing: tampered signed_by (impersonation) fails', () => {
  const kp = crypto.keyPair()
  const meta = makeMeta()
  const { signature, signer_pubkey } = signMetadata(meta, kp.secretKey)
  const result = verifyMetadata({ ...meta, signed_by: '0000-0002-1694-233X', signature, signer_pubkey })
  assert.ok(!result.valid)
})

test('signing: tampered content_hash fails', () => {
  const kp = crypto.keyPair()
  const meta = makeMeta()
  const { signature, signer_pubkey } = signMetadata(meta, kp.secretKey)
  const result = verifyMetadata({
    ...meta,
    content_hash: 'blake2b:' + 'cd'.repeat(32),
    signature,
    signer_pubkey
  })
  assert.ok(!result.valid)
})

test('signing: mutable bookkeeping fields are excluded from the signature', () => {
  const kp = crypto.keyPair()
  const meta = makeMeta()
  const { signature, signer_pubkey } = signMetadata(meta, kp.secretKey)
  // replicated_by / first_seen / published_at legitimately change after publish
  const result = verifyMetadata({
    ...meta,
    replicated_by: ['f'.repeat(64), 'e'.repeat(64)],
    first_seen: '2026-09-01T10:00:00Z'
  , signature, signer_pubkey })
  assert.ok(result.valid, result.reason)
})

test('signing: unsigned record fails verification with reason', () => {
  const result = verifyMetadata(makeMeta())
  assert.ok(!result.valid)
  assert.match(result.reason, /unsigned/)
})

test('signing: malformed signer_pubkey rejected', () => {
  const kp = crypto.keyPair()
  const meta = makeMeta()
  const { signature } = signMetadata(meta, kp.secretKey)
  const result = verifyMetadata({ ...meta, signature, signer_pubkey: 'nothex' })
  assert.ok(!result.valid)
  assert.match(result.reason, /signer_pubkey/)
})

test('signing: expectedPubkey anchoring works both ways', () => {
  const kp = crypto.keyPair()
  const other = crypto.keyPair()
  const meta = makeMeta()
  const { signature, signer_pubkey } = signMetadata(meta, kp.secretKey)
  const signed = { ...meta, signature, signer_pubkey }
  assert.ok(verifyMetadata(signed, { expectedPubkeyHex: kp.publicKey.toString('hex') }).valid)
  const mismatch = verifyMetadata(signed, { expectedPubkeyHex: other.publicKey.toString('hex') })
  assert.ok(!mismatch.valid)
  assert.match(mismatch.reason, /expected/)
})

test('signing: canonical form is key-order independent', () => {
  const a = makeMeta()
  const b = {}
  for (const k of Object.keys(a).reverse()) b[k] = a[k]
  assert.ok(canonicalMetadata(a).equals(canonicalMetadata(b)))
})

test('signing: signable is domain-tagged (never equals raw canonical)', () => {
  const meta = makeMeta()
  const signable = metadataSignable(meta)
  const canonical = canonicalMetadata(meta)
  assert.ok(signable.length > canonical.length)
  assert.ok(signable.subarray(0, METADATA_SIGNING_TAG.length).equals(METADATA_SIGNING_TAG))
})

test('schema: implicit-openid without signature is rejected', () => {
  const meta = makeMeta()
  const { errors } = validateMetadata(meta)
  assert.ok(errors.some(e => e.includes('requires a metadata signature')))
})

test('schema: implicit-openid with forged signature is rejected', () => {
  const forged = makeMeta({ signature: 'f'.repeat(128), signer_pubkey: crypto.keyPair().publicKey.toString('hex') })
  const { errors } = validateMetadata(forged)
  assert.ok(errors.some(e => e.includes('metadata signature invalid')))
})

test('schema: implicit-openid with valid signature passes identity checks', () => {
  const kp = crypto.keyPair()
  const meta = makeMeta()
  const { signature, signer_pubkey } = signMetadata(meta, kp.secretKey)
  const { errors } = validateMetadata({ ...meta, signature, signer_pubkey })
  assert.deepStrictEqual(errors, [])
})

test('schema: self-asserted records may stay unsigned', () => {
  const kp = crypto.keyPair()
  const meta = makeMeta({
    signed_by: '0000-0003-2361-3953',
    identity: { orcid_auth_flow: 'self-asserted', orcid_verified_at: null, orcid_nonce: null }
  })
  const { errors } = validateMetadata(meta)
  assert.deepStrictEqual(errors, [])
  // but if they DO carry a signature, it must be valid
  const { signature, signer_pubkey } = signMetadata(meta, kp.secretKey)
  assert.deepStrictEqual(validateMetadata({ ...meta, signature, signer_pubkey }).errors, [])
})