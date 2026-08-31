'use strict'

/**
 * Ed25519 metadata signing for Pharos paper records.
 *
 * Binds the identity claim (signed_by ORCID + identity provenance block) and
 * the content_hash to the publisher's Hyperdrive signing keypair. Without
 * this, `signed_by` / `identity` are plain claims that any hand-crafted
 * record can assert.
 *
 * Design:
 *  - Signature covers a canonical serialization of the stable,
 *    identity-bearing metadata fields (see SIGNED_FIELDS). Mutable
 *    bookkeeping fields (published_at, first_seen, replicated_by, signature,
 *    signer_pubkey itself) are excluded.
 *  - Domain separation: the signable is prefixed with a fixed tag so a
 *    metadata signature can never be replayed as a Hypercore block signature
 *    or vice versa.
 *  - The signer public key is stored in the record (signer_pubkey). It is NOT
 *    the same as drive.key (a namespace-derived discovery key); the raw
 *    Ed25519 public key is drive.core.keyPair.publicKey, also exposed as
 *    core.manifest.signers[0].publicKey on fully-replicated nodes.
 *  - Verification has two levels: (1) cryptographic: signature valid for the
 *    canonical payload under signer_pubkey; (2) anchoring (optional):
 *    signer_pubkey matches a trusted/expected key supplied by the caller
 *    (e.g. the local drive's manifest signer, or a known publisher key).
 */

const crypto = require('hypercore-crypto')
const b4a = require('b4a')

// Fixed domain-separation tag. Never reuse a Hypercore caps namespace here:
// metadata signatures are a distinct protocol.
const METADATA_SIGNING_TAG = b4a.from('pharos/metadata-signing/v1')

// Fields covered by the signature. Order is irrelevant (canonical form sorts).
const SIGNED_FIELDS = [
  'paper_id',
  'title',
  'authors',
  'abstract',
  'subject',
  'doi',
  'source',
  'version',
  'previous_version_hash',
  'content_hash',
  'blob_key',
  'hyperdrive_key',
  'signed_by',
  'identity'
]

/**
 * Deterministic serialization of a metadata object: recursive key sort,
 * no whitespace. Unicode is preserved (JSON.stringify handles escaping).
 * @param {object} meta
 * @returns {Buffer}
 */
function canonicalMetadata(meta) {
  const sorted = (obj) => {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj
    const out = {}
    for (const k of Object.keys(obj).sort()) out[k] = sorted(obj[k])
    return out
  }
  const payload = {}
  for (const f of SIGNED_FIELDS) payload[f] = meta[f] === undefined ? null : meta[f]
  return Buffer.from(JSON.stringify(sorted(payload)), 'utf-8')
}

/**
 * Build the signable buffer: tag || canonical payload.
 * @param {object} meta
 * @returns {Buffer}
 */
function metadataSignable(meta) {
  return b4a.concat([METADATA_SIGNING_TAG, canonicalMetadata(meta)])
}

/**
 * Sign paper metadata with the publisher's Ed25519 secret key.
 * @param {object} meta - metadata (signature/signer_pubkey fields ignored)
 * @param {Buffer} secretKey - 64-byte Ed25519 secret key (drive.core.keyPair.secretKey)
 * @returns {{signature: string, signer_pubkey: string}} hex-encoded
 */
function signMetadata(meta, secretKey) {
  if (!secretKey || secretKey.length !== 64) {
    throw new Error('signMetadata: secretKey must be a 64-byte Ed25519 secret key')
  }
  const signature = crypto.sign(metadataSignable(meta), secretKey)
  // Derive the matching public key from the secret key (sodium sk_to_pk)
  const sodium = require('sodium-universal')
  const pk = b4a.allocUnsafe(32)
  sodium.crypto_sign_ed25519_sk_to_pk(pk, secretKey)
  return {
    signature: signature.toString('hex'),
    signer_pubkey: pk.toString('hex')
  }
}

/**
 * Verify a paper record's metadata signature.
 *
 * @param {object} meta - full metadata record (needs signature, signer_pubkey,
 *   and all SIGNED_FIELDS)
 * @param {object} [opts]
 * @param {string} [opts.expectedPubkeyHex] - if given, signer_pubkey must
 *   match this key (anchor to a known publisher / local manifest signer)
 * @returns {{valid: boolean, reason: string|null}}
 */
function verifyMetadata(meta, opts = {}) {
  if (!meta || typeof meta !== 'object') {
    return { valid: false, reason: 'metadata must be an object' }
  }
  if (!meta.signature) {
    return { valid: false, reason: 'record is unsigned (no signature field)' }
  }
  if (!meta.signer_pubkey) {
    return { valid: false, reason: 'record has a signature but no signer_pubkey' }
  }
  if (!/^[0-9a-f]{64}$/.test(meta.signer_pubkey)) {
    return { valid: false, reason: `signer_pubkey format invalid: ${meta.signer_pubkey}` }
  }
  if (!/^[0-9a-f]{128}$/.test(meta.signature)) {
    return { valid: false, reason: `signature format invalid (expected 128 hex chars)` }
  }
  if (opts.expectedPubkeyHex && meta.signer_pubkey !== opts.expectedPubkeyHex) {
    return { valid: false, reason: `signer_pubkey does not match expected publisher key` }
  }
  try {
    const ok = crypto.verify(
      metadataSignable(meta),
      b4a.from(meta.signature, 'hex'),
      b4a.from(meta.signer_pubkey, 'hex')
    )
    return ok
      ? { valid: true, reason: null }
      : { valid: false, reason: 'signature does not verify against canonical metadata' }
  } catch (err) {
    return { valid: false, reason: `verification error: ${err.message}` }
  }
}

module.exports = {
  METADATA_SIGNING_TAG,
  SIGNED_FIELDS,
  canonicalMetadata,
  metadataSignable,
  signMetadata,
  verifyMetadata
}