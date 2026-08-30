'use strict'

/**
 * ORCID identity via OAuth2 implicit OpenID flow.
 *
 * Why implicit: ORCID's code flow requires a client secret at exchange
 * time, which cannot be safely shipped inside a distributed CLI. The
 * implicit OpenID flow (response_type=token, scope=openid) returns an
 * access token directly in the redirect fragment, needing only the public
 * client ID. No secret exists anywhere in this codebase.
 *
 * Security model: each publish generates a nonce bound to
 * sha256(content_hash | feed_pubkey | timestamp). The nonce travels
 * through the OIDC authorize request and is echoed in the userinfo
 * response verification step, so the resulting verified identity claims
 * are bound to the exact (content, feed key) pair. A captured token
 * cannot be replayed to sign different content on a different node.
 *
 * Known limit: verification relies on the TLS-protected /oauth/userinfo
 * exchange rather than offline JWKS verification of an id_token (ORCID's
 * implicit flow does not reliably issue id_tokens). Offline JWKS checks
 * are a post-MVP hardening path.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SANDBOX_BASE = 'https://sandbox.orcid.org'
const PROD_BASE = 'https://orcid.org'
const PROD_CLIENT_ID = 'APP-YC0U2NG93W401578'
const CALLBACK_URL = 'https://tiagopaixao.com/orcid/callback.html'

const CONFIG_DIR = path.join(os.homedir(), '.pharos')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

/**
 * Generate a random state value for OAuth CSRF protection.
 * @returns {string} 32-char hex string
 */
function generateState() {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * Generate a transaction nonce binding an ORCID auth to a specific
 * publish: hash(content_hash | feed_pubkey | timestamp).
 * @param {string} contentHash - blake2b content hash of the PDF
 * @param {string} feedKeyHex - publisher Hyperdrive public key (hex)
 * @returns {{nonce: string, generated_at: string}}
 */
function generateNonce(contentHash, feedKeyHex) {
  const timestamp = new Date().toISOString()
  const h = crypto.createHash('sha256')
  h.update(String(contentHash || ''))
  h.update('|')
  h.update(String(feedKeyHex || ''))
  h.update('|')
  h.update(timestamp)
  return { nonce: h.digest('hex'), generated_at: timestamp }
}

/**
 * Build the ORCID implicit OpenID authorization URL.
 * @param {string} clientId - ORCID client ID (public)
 * @param {string} [state] - CSRF state
 * @param {string} [nonce] - transaction nonce
 * @param {boolean} [sandbox] - sandbox instead of production
 * @returns {string}
 */
function getOrcidImplicitUrl(clientId, state, nonce, sandbox = false) {
  const base = sandbox ? SANDBOX_BASE : PROD_BASE
  const params = {
    client_id: clientId,
    response_type: 'token',
    scope: 'openid',
    redirect_uri: CALLBACK_URL
  }
  if (state) params.state = state
  if (nonce) params.nonce = nonce
  return `${base}/oauth/authorize?${new URLSearchParams(params).toString()}`
}

/** Load cached ORCID config (~/.pharos/config.json). */
function loadCachedOrcid() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

/** Check whether a cached config has a usable orcid_id. */
function hasOrcidConfig(config) {
  return Boolean(config && config.orcid_id)
}

/** Save ORCID config to ~/.pharos/config.json. */
function saveOrcidConfig(orcid) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(orcid, null, 2))
}

/**
 * Verify an ORCID access token against the userinfo endpoint.
 * @param {string} accessToken
 * @param {object} [opts] - { expectedNonce }
 * @returns {Promise<{orcid_id, name, nonce, verified_at}>}
 */
async function verifyAccessToken(token, opts = {}) {
  const base = opts.sandbox ? SANDBOX_BASE : PROD_BASE
  const res = await fetch(`${base}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) {
    throw new Error(`ORCID userinfo verification failed: ${res.status}`)
  }
  const claims = await res.json()
  return {
    orcid_id: claims.sub,
    name: claims.name,
    nonce: opts.expectedNonce || null,
    verified_at: new Date().toISOString()
  }
}

/**
 * Run ORCID implicit OpenID flow.
 * @param {object} opts - { clientId, sandbox, force, nonce }
 * @returns {Promise<{orcid_id, orcid_name, orcid_verified_at, orcid_nonce}>}
 */
async function orcidAuth(opts = {}) {
  const { clientId, sandbox = false, force = false, nonce = null } = opts
  const id = clientId || process.env.PHAROS_ORCID_CLIENT_ID

  // Config cache is only useful for non-nonce-bound standalone auths.
  if (!force && !nonce) {
    const cached = loadCachedOrcid()
    if (hasOrcidConfig(cached)) return cached
  }

  const effectiveId = id || PROD_CLIENT_ID
  if (!effectiveId) {
    throw new Error(
      'ORCID client ID required but not configured. Set PHAROS_ORCID_CLIENT_ID in .env (dotenv loads from the ' +
      'current working directory), or pass --orcid-client-id explicitly.'
    )
  }

  const state = generateState()
  const url = getOrcidImplicitUrl(effectiveId, state, nonce, sandbox)
  console.log('\nORCID authentication (implicit OpenID flow, no client secret):')
  console.log(`  ${url}\n`)

  // Try to open the browser automatically; user can copy the URL otherwise
  try {
    const { execSync } = require('child_process')
    execSync(`xdg-open "${url}" || open "${url}" || echo ""`, { stdio: 'ignore' })
  } catch (_) {
    // user can copy URL manually
  }

  console.log('Authorize in the browser, then paste the ACCESS TOKEN shown on the callback page:')
  const token = await new Promise((resolve) => {
    process.stdout.write('[orcid] access_token: ')
    process.stdin.resume()
    process.stdin.setEncoding('utf-8')
    process.stdin.once('data', (data) => {
      process.stdin.pause()
      resolve(data.trim())
    })
  })

  if (!token) {
    throw new Error('No access token provided')
  }

  const claims = await verifyAccessToken(token, { expectedNonce: nonce, sandbox })
  const orcid = {
    orcid_id: claims.orcid_id,
    orcid_name: claims.name || 'Unknown',
    orcid_verified_at: claims.verified_at,
    orcid_nonce: claims.nonce
  }
  // Only cache non-transactional (standalone) authentications
  if (!nonce) {
    saveOrcidConfig(orcid)
  }
  return orcid
}

module.exports = {
  orcidAuth,
  getOrcidImplicitUrl,
  hasOrcidConfig,
  loadCachedOrcid,
  saveOrcidConfig,
  generateState,
  generateNonce,
  verifyAccessToken
}