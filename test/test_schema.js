'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { validateMetadata } = require('../src/core/schema')

test('validateMetadata: valid metadata passes', () => {
  const meta = {
    paper_id: 'pharos:q-bio.GN/2026.08.28/001',
    title: 'Test Paper',
    authors: [{ name: 'Tiago Paixao', orcid: '0000-0003-2361-3953' }],
    subject: 'q-bio.GN',
    content_hash: 'blake2b:256c83b297114d201b30179f3f0ef0cace9783622da5974326b436178aeef610',
    blob_key: '/papers/q-bio.GN/2026.08.28/001/v1/fulltext.pdf',
    source: 'pharos',
    version: 1,
    signed_by: '0000-0003-2361-3953'
  }
  const { valid, errors } = validateMetadata(meta)
  assert.strictEqual(valid, true)
  assert.deepStrictEqual(errors, [])
})

test('validateMetadata: missing required field fails', () => {
  const meta = { paper_id: 'pharos:q-bio.GN/2026.08.28/001' }
  const { valid, errors } = validateMetadata(meta)
  assert.strictEqual(valid, false)
  assert.ok(errors.some(e => e.includes('title')))
  assert.ok(errors.some(e => e.includes('authors')))
})

test('validateMetadata: invalid paper_id format', () => {
  const meta = {
    paper_id: 'bad-format',
    title: 'Test',
    authors: [{ name: 'Author' }],
    subject: 'q-bio.GN',
    content_hash: 'blake2b:' + 'a'.repeat(64),
    blob_key: '/path',
    source: 'pharos',
    version: 1
  }
  const { valid, errors } = validateMetadata(meta)
  assert.strictEqual(valid, false)
  assert.ok(errors.some(e => e.includes('paper_id format')))
})

test('validateMetadata: invalid ORCID format', () => {
  const meta = {
    paper_id: 'pharos:q-bio.GN/2026.08.28/001',
    title: 'Test',
    authors: [{ name: 'Author', orcid: 'bad-orcid' }],
    subject: 'q-bio.GN',
    content_hash: 'blake2b:' + 'a'.repeat(64),
    blob_key: '/path',
    source: 'pharos',
    version: 1
  }
  const { valid, errors } = validateMetadata(meta)
  assert.strictEqual(valid, false)
  assert.ok(errors.some(e => e.includes('orcid format invalid')))
})

test('validateMetadata: invalid version', () => {
  const meta = {
    paper_id: 'pharos:q-bio.GN/2026.08.28/001',
    title: 'Test',
    authors: [{ name: 'Author' }],
    subject: 'q-bio.GN',
    content_hash: 'blake2b:' + 'a'.repeat(64),
    blob_key: '/path',
    source: 'pharos',
    version: 0
  }
  const { valid, errors } = validateMetadata(meta)
  assert.strictEqual(valid, false)
  assert.ok(errors.some(e => e.includes('version')))
})

test('validateMetadata: signed_by null is valid', () => {
  const meta = {
    paper_id: 'pharos:q-bio.GN/2026.08.28/001',
    title: 'Test',
    authors: [{ name: 'Author' }],
    subject: 'q-bio.GN',
    content_hash: 'blake2b:' + 'a'.repeat(64),
    blob_key: '/path',
    source: 'pharos',
    version: 1,
    signed_by: null
  }
  const { valid } = validateMetadata(meta)
  assert.strictEqual(valid, true)
})

test('validateMetadata: null input fails', () => {
  const { valid } = validateMetadata(null)
  assert.strictEqual(valid, false)
})