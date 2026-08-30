#!/usr/bin/env node
'use strict'
// No dotenv: the only remaining env-ish value (ORCID client ID) is public and baked in.
// Note: dotenv/config left intentionally absent; add it back if a true secret ever appears.

// CLI entry point
const cli = require('./cli/cli')
cli.parse()