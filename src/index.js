#!/usr/bin/env node
'use strict'
require('dotenv').config()

// CLI entry point
const cli = require('./cli/cli')
cli.parse()