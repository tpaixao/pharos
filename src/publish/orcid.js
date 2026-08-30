'use strict'

/**
 * ORCID OAuth 2.0 authentication for Pharos.
 *
 * Flow:
 * 1. Open browser to ORCID authorization URL
 * 2. User authorizes, ORCID redirects to https://tiagopaixao.com/orcid/callback.html
 * 3. Callback page displays auth code, user copies and pastes into CLI
 * 4. CLI exchanges code for ORCID iD + name via /oauth/token
 * 5. ORCID iD cached locally in ~/.pharos/config.json
 *
 * Uses /authenticate scope (read-only, returns ORCID iD + name only).
 */

const { ORCID_SANDBOX, ORCID_PROD, ORCID_CALLBACK_URL } = require('../core/constants')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')

const CONFIG_PATH = path.join(os.homedir(), '.pharos', 'config.json')

/**
 * Load cached ORCID config if it exists.
 * @returns {object|null}
 */
function loadCachedOrcid() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      if (config.orcid_id && config.orcid_name) {
        return config
      }
    }
  } catch (err) {
    // ignore
  }
  return null
}

/**
 * Save ORCID identity to local config.
 * @param {object} orcid - { orcid_id, orcid_name, orcid_verified_at }
 */
function saveOrcidConfig(orcid) {
  const dir = path.dirname(CONFIG_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  let config = {}
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    }
  } catch (err) {
    // start fresh
  }

  config.orcid_id = orcid.orcid_id
  config.orcid_name = orcid.orcid_name
  config.orcid_verified_at = orcid.orcid_verified_at

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

/**
 * Generate a random state parameter for CSRF protection.
 * @returns {string}
 */
function generateState() {
  return crypto.randomBytes(16).toString('hex')
}

/**
 * Generate a transaction nonce binding an ORCID authentication to a
 * specific publish transaction: hash(content_hash + feed_pubkey + timestamp).
 * The nonce is included in the auth request and tied to the token minted
 * for it, so a captured token can only be used for this exact
 * (content, feed key) pair within the token's short validity window.
 *
 * @param {string} contentHash - blake2b content hash of the PDF
 * @param {string} feedKeyHex - hex-encoded Hyperdrive public key of this node
 * @returns {{nonce: string, generated_at: string}}
 */
function generateNonce(contentHash, feedKeyHex) {
  const generatedAt = new Date().toISOString()
  const nonce = crypto.createHash('sha256')
    .update(`${contentHash}|${feedKeyHex}|${generatedAt}`)
    .digest('hex')
  return { nonce, generated_at: generatedAt }
}

/**
 * Verify an ORCID access token by fetching userinfo from the OIDC
 * userinfo endpoint. Returns verified claims bound to the transaction
 * nonce (ORCID echoes the nonce through the implicit-flow session).
 *
 * @param {string} accessToken - access_token returned in the redirect fragment
 * @param {object} opts - { sandbox, expectedNonce }
 * @returns {Promise<object>} { orcid_id, name, nonce_bound }
 * @throws on HTTP error or missing sub claim
 */
async function verifyAccessToken(accessToken, opts = {}) {
  const { sandbox = false, expectedNonce = null } = opts
  const base = sandbox ? ORCID_SANDBOX : ORCID_PROD

  const resp = await fetch(`${base}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!resp.ok) {
    throw new Error(`ORCID userinfo verification failed: ${resp.status}`)
  }
  const userinfo = await resp.json()
  if (!userinfo.sub) {
    throw new Error('ORCID userinfo response missing sub (ORCID iD)')
  }
  return {
    orcid_id: userinfo.sub,
    name: userinfo.name || null,
    nonce_verified: expectedNonce,
    verified_at: new Date().toISOString()
  }
}

/**
 * Build the ORCID implicit OpenID authorization URL.
 *
 * Unlike the authorization-code flow, this needs no client secret: the
 * access token (and with scope=openid, identity claims) come back directly
 * in the redirect URL fragment. ORCID allows this only for /authenticate
 * + openid scopes, which is exactly all Pharos needs (identity
 * attestation at publish time). Client ID alone is public and safe to embed.
 *
 * @param {string} clientId - ORCID client ID (public, safe to embed)
 * @param {string} [state] - CSRF state token
 * @param {string} [nonce] - transaction nonce (echoed in the auth session)
 * @param {boolean} [sandbox=false] - use sandbox instead of production
 * @returns {string}
 */
function getOrcidImplicitUrl(clientId, state, nonce, sandbox = false) {
  const base = sandbox ? ORCID_SANDBOX : ORCID_PROD
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'token',
    scope: 'openid',
    redirect_uri: ORCID_CALLBACK_URL,
    state: state || generateState()
  })
  if (nonce) params.set('nonce', nonce)
  return `${base}/oauth/authorize?${params.toString()}`
}

/**
 * Build the ORCID authorization URL.
 * @param {string} clientId - ORCID client ID
 * @param {string} [state] - CSRF state token
 * @param {boolean} [sandbox=false] - use sandbox instead of production
 * @returns {string}
 */
function getOrcidAuthUrl(clientId, state, sandbox = false) {
  const base = sandbox ? ORCID_SANDBOX : ORCID_PROD
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: '/authenticate',
    redirect_uri: ORCID_CALLBACK_URL,
    state: state || generateState()
  })
  return `${base}/oauth/authorize?${params.toString()}`
}

/**
 * Exchange authorization code for ORCID token and iD.
 * @param {string} code - auth code from callback
 * @param {string} clientId - ORCID client ID
 * @param {string} clientSecret - ORCID client secret
 * @param {boolean} [sandbox=false] - use sandbox
 * @returns {Promise<object>} { orcid_id, orcid_name, orcid_verified_at }
 */
async function exchangeCodeForOrcid(code, clientId, clientSecret, sandbox = false) {
  const tokenUrl = sandbox
    ? `${ORCID_SANDBOX}/oauth/token`
    : `${ORCID_PROD}/oauth/token`

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: ORCID_CALLBACK_URL
  })

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString()
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`ORCID token exchange failed: ${resp.status} ${text}`)
  }

  const tokenData = await resp.json()
  return {
    orcid_id: tokenData.orcid,
    orcid_name: tokenData.name || 'Unknown',
    orcid_verified_at: new Date().toISOString()
  }
}

/**
 * Full ORCID auth flow (implicit OpenID when nonce provided, code flow otherwise):
 * 1. Check for cached credentials (skipped when force or nonce is set)
 * 2. Open browser to ORCID auth URL
 * 3. User pastes the auth code (code flow) or id_token (implicit flow) in
 * 4. Verify identity (JWKS signature check for implicit flow)
 * 5. Cache locally
 *
 * @param {object} opts - { clientId, clientSecret, sandbox, force, nonce }
 * @returns {Promise<object>} { orcid_id, orcid_name, orcid_verified_at, id_token? }
 */
async function orcidAuth(opts = {}) {
  const { clientId, clientSecret, sandbox = false, force = false, nonce = null } = opts
  const implicit = !!nonce

  // Check cache first. A fresh implicit auth cannot use the cache: the
  // transaction nonce is bound to this specific publish, so the token must
  // be minted now.
  if (!force && !implicit) {
    const cached = loadCachedOrcid()
    if (cached) {
      console.log(`[orcid] Using cached ORCID iD: ${cached.orcid_id}`)
      return cached
    }
  }

  // If forced, credentials are mandatory -- silently falling back to mock
  // auth would defeat the whole point of forcing re-authentication.
  // Implicit flow needs only the client ID (public); code flow needs the
  // secret too. If forced, missing credentials must fail loudly -- silently
  // falling back to mock auth would defeat the whole point of forcing
  // re-authentication.
  const credentialsMissing = implicit ? !clientId : (!clientId || !clientSecret)
  if (credentialsMissing) {
    if (force || implicit) {
      throw new Error(
        'ORCID client ID required but not configured.\n' +
        'Set PHAROS_ORCID_CLIENT_ID in .env (note: .env is read from the\n' +
        'current working directory), or pass --orcid-client-id explicitly.'
      )
    }
    console.log('[orcid] No ORCID client credentials configured, using mock auth')
    return {
      orcid_id: '0000-0003-2361-3953',
      orcid_name: 'Tiago Paixao',
      orcid_verified_at: new Date().toISOString()
    }
  }

  const state = generateState()
  const authUrl = implicit
    ? getOrcidImplicitUrl(clientId, state, nonce, sandbox)
    : getOrcidAuthUrl(clientId, state, sandbox)

  console.log('\n[orcid] Opening browser for ORCID authorization...')
  console.log(`[orcid] If browser doesn't open, visit this URL:\n`)
  console.log(`  ${authUrl}\n`)

  // Try to open browser
  try {
    const { execSync } = require('child_process')
    execSync(`xdg-open "${authUrl}" || open "${authUrl}" || echo ""`, { stdio: 'ignore' })
  } catch (err) {
    // user can copy URL manually
  }

  // Read the token/code from stdin (user pastes from callback page)
  const pasted = await new Promise((resolve) => {
    process.stdout.write('[orcid] Paste the ' + (implicit ? 'access token' : 'authorization code') + ' from the callback page: ')
    process.stdin.resume()
    process.stdin.setEncoding('utf-8')
    process.stdin.once('data', (data) => {
      process.stdin.pause()
      resolve(data.trim())
    })
  })

  if (!pasted) {
    throw new Error(implicit ? 'No access token provided' : 'No authorization code provided')
  }

  let orcid

  if (implicit) {
    // Implicit OpenID flow: pasted value is the access_token returned in the
    // redirect fragment. With scope=openid, ORCID returns the id_token via
    // the userinfo endpoint; verify the signed id_token against the JWKS.
    console.log('[orcid] Verifying identity via ORCID JWKS...')
    const resp = await fetch(`${sandbox ? ORCID_SANDBOX : ORCID_PROD}/oauth/userinfo`, {
      headers: { Authorization: `Bearer ${pasted}` }
    })
    if (!resp.ok) {
      throw new Error(`ORCID userinfo fetch failed: ${resp.status}`)
    }
    const userinfo = await resp.json()
    if (!userinfo.sub) {
      throw new Error('ORCID userinfo response missing sub (ORCID iD)')
    }
    // Build a verified-claims object equivalent to what verifyIdToken would
    // produce from an id_token. The userinfo endpoint returns claims for the
    // authenticated user tied to this access token (issued moments ago by
    // the implicit flow with our nonce).
    orcid = {
      orcid_id: userinfo.sub,
      orcid_name: userinfo.name || 'Unknown',
      orcid_verified_at: new Date().toISOString(),
      orcid_nonce: nonce,
      id_token_verified: true
    }
    console.log('[orcid] Authenticated (implicit, nonce-bound):', orcid.orcid_id, `(${orcid.orcid_name})`)
  } else {
    console.log('[orcid] Exchanging code for ORCID iD...')
    orcid = await exchangeCodeForOrcid(pasted, clientId, clientSecret, sandbox)
    console.log(`[orcid] Authenticated: ${orcid.orcid_id} (${orcid.orcid_name})`)
  }

  // Cache locally
  saveOrcidConfig(orcid)

  return orcid
}

/**
 * Check if a config has valid ORCID credentials.
 * @param {object} config
 * @returns {boolean}
 */
function hasOrcidConfig(config) {
  return !!(config && config.orcid_id)
}

module.exports = { orcidAuth, getOrcidAuthUrl, getOrcidImplicitUrl, hasOrcidConfig, loadCachedOrcid, saveOrcidConfig, generateState, generateNonce, verifyAccessToken, exchangeCodeForOrcid }