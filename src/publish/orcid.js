'use strict'

/**
 * Mock ORCID auth for MVP development.
 *
 * Real ORCID OAuth flow would:
 * 1. Start local HTTP server on port 8443
 * 2. Redirect user to orcid.org/oauth/authorize
 * 3. Receive callback with auth code
 * 4. Exchange code for ORCID iD via /oauth/token
 *
 * Mock version: returns a hardcoded ORCID iD + name without any network calls.
 * This lets us develop and test the publish flow before registering a real
 * ORCID client app.
 */

const MOCK_ORCID = {
  orcid_id: '0000-0003-2361-3953',
  orcid_name: 'Tiago Paixao',
  orcid_verified_at: new Date().toISOString()
}

/**
 * Mock ORCID auth. Returns immediately with a hardcoded identity.
 * @returns {Promise<object>} { orcid_id, orcid_name, orcid_verified_at }
 */
async function orcidAuth() {
  console.log('[mock-orcid] Using mock ORCID auth (no real OAuth flow)')
  console.log(`[mock-orcid] ORCID iD: ${MOCK_ORCID.orcid_id}`)
  console.log(`[mock-orcid] Name: ${MOCK_ORCID.orcid_name}`)
  return { ...MOCK_ORCID }
}

/**
 * Get the mock auth URL (for display purposes only).
 * In the real flow, this would redirect to orcid.org/oauth/authorize.
 */
function getOrcidAuthUrl() {
  return 'mock://orcid-oauth (would redirect to orcid.org/oauth/authorize in production)'
}

/**
 * Check if a config has valid (mock or real) ORCID credentials.
 * @param {object} config
 * @returns {boolean}
 */
function hasOrcidConfig(config) {
  return !!(config && config.orcid_id)
}

module.exports = { orcidAuth, getOrcidAuthUrl, hasOrcidConfig, MOCK_ORCID }