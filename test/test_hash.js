'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const { computeHash, blobKey, subjectFromPaperId, makePaperId } = require('../src/core/hash')

test('computeHash: deterministic for same input', () => {
  const buf = Buffer.from('hello world')
  const h1 = computeHash(buf)
  const h2 = computeHash(buf)
  assert.strictEqual(h1, h2)
  assert.match(h1, /^blake2b:[0-9a-f]{64}$/)
})

test('computeHash: different inputs produce different hashes', () => {
  const h1 = computeHash(Buffer.from('hello'))
  const h2 = computeHash(Buffer.from('world'))
  assert.notStrictEqual(h1, h2)
})

test('computeHash: known vector', () => {
  const h = computeHash(Buffer.from('hello world'))
  // BLAKE2b-256 of "hello world"
  assert.strictEqual(h, 'blake2b:256c83b297114d201b30179f3f0ef0cace9783622da5974326b436178aeef610')
})

test('blobKey: correct path format', () => {
  const key = blobKey('pharos:q-bio.GN/2026.08.28/001', 1, 'fulltext.pdf')
  assert.strictEqual(key, '/papers/q-bio.GN/2026.08.28/001/v1/fulltext.pdf')
})

test('blobKey: version increments', () => {
  const key = blobKey('pharos:q-bio.GN/2026.08.28/001', 2, 'metadata.json')
  assert.strictEqual(key, '/papers/q-bio.GN/2026.08.28/001/v2/metadata.json')
})

test('subjectFromPaperId: extracts subject', () => {
  assert.strictEqual(subjectFromPaperId('pharos:q-bio.GN/2026.08.28/001'), 'q-bio.GN')
  assert.strictEqual(subjectFromPaperId('pharos:cs.AI/2026.08.28/042'), 'cs.AI')
})

test('makePaperId: correct format with padding', () => {
  const id = makePaperId('q-bio.GN', 1)
  assert.match(id, /^pharos:q-bio\.GN\/\d{4}\.\d{2}\.\d{2}\/001$/)
})

test('makePaperId: 3-digit zero-padding', () => {
  const id = makePaperId('cs.AI', 42)
  assert.match(id, /\/042$/)
})