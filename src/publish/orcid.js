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
 * Full ORCID auth flow:
 * 1. Check for cached credentials
 * 2. If not cached, open browser to ORCID auth URL
 * 3. User pastes the auth code back into the CLI
 * 4. Exchange code for ORCID iD
 * 5. Cache locally
 *
 * @param {object} opts - { clientId, clientSecret, sandbox, force }
 * @returns {Promise<object>} { orcid_id, orcid_name, orcid_verified_at }
 */
async function orcidAuth(opts = {}) {
  const { clientId, clientSecret, sandbox = false, force = false } = opts

  // Check cache first
  if (!force) {
    const cached = loadCachedOrcid()
    if (cached) {
      console.log(`[orcid] Using cached ORCID iD: ${cached.orcid_id}`)
      return cached
    }
  }

  // If no client credentials, fall back to mock for dev
  if (!clientId || !clientSecret) {
    console.log('[orcid] No ORCID client credentials configured, using mock auth')
    return {
      orcid_id: '0000-0003-2361-3953',
      orcid_name: 'Tiago Paixao',
      orcid_verified_at: new Date().toISOString()
    }
  }

  const state = generateState()
  const authUrl = getOrcidAuthUrl(clientId, state, sandbox)

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

  // Read auth code from stdin (user pastes from callback page)
  const code = await new Promise((resolve) => {
    process.stdout.write('[orcid] Paste the authorization code from the callback page: ')
    process.stdin.resume()
    process.stdin.setEncoding('utf-8')
    process.stdin.once('data', (data) => {
      process.stdin.pause()
      resolve(data.trim())
    })
  })

  if (!code) {
    throw new Error('No authorization code provided')
  }

  console.log('[orcid] Exchanging code for ORCID iD...')
  const orcid = await exchangeCodeForOrcid(code, clientId, clientSecret, sandbox)

  console.log(`[orcid] Authenticated: ${orcid.orcid_id} (${orcid.orcid_name})`)

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

module.exports = { orcidAuth, getOrcidAuthUrl, hasOrcidConfig, loadCachedOrcid, saveOrcidConfig, generateState, exchangeCodeForOrcid }