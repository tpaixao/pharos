'use strict'

const { Command } = require('commander')
const path = require('path')
const fs = require('fs')

const pharos = require('../lib')

const program = new Command()

program
  .name('pharos')
  .description('Pharos: P2P preprint archive')
  .version('0.1.0')
  .option('--data-dir <path>', 'data directory', 'data')

// Helper to init store before commands
async function withStore(fn) {
  const opts = program.opts()
  const dataDir = path.resolve(opts.dataDir)
  await pharos.initStore(dataDir)
  try {
    await fn()
  } finally {
    await pharos.close()
  }
}

// pharos publish <pdf> --title --subject --abstract --author
program
  .command('publish')
  .description('Publish a PDF to Pharos')
  .argument('<pdf>', 'path to PDF file')
  .requiredOption('--title <title>', 'paper title')
  .requiredOption('--subject <subject>', 'subject category (e.g. q-bio.GN)')
  .option('--abstract <abstract>', 'paper abstract')
  .option('--author <name>', 'author name (repeat for multiple authors)', (v, p) => [...p, v], [])
  .option('--orcid <orcid>', 'ORCID iD (overrides OAuth flow)')
  .option('--orcid-client-id <id>', 'ORCID client ID for OAuth')
  .option('--orcid-client-secret <secret>', 'ORCID client secret for OAuth')
  .option('--orcid-sandbox', 'use ORCID sandbox instead of production')
  .option('--orcid-force', 'force re-authentication (ignore cached credentials)')
  .option('--doi <doi>', 'DOI if already assigned')
  .option('--revises <paper_id>', 'paper_id this is a revision of')
  .action(async (pdf, opts) => {
    await withStore(async () => {
      // ORCID auth: explicit iD, real OAuth, or mock fallback
      let signedBy = null
      let orcidName = null
      if (opts.orcid) {
        signedBy = opts.orcid
      } else {
        const clientId = opts.orcidClientId || process.env.PHAROS_ORCID_CLIENT_ID
        const clientSecret = opts.orcidClientSecret || process.env.PHAROS_ORCID_CLIENT_SECRET
        const orcid = await pharos.orcidAuth({
          clientId,
          clientSecret,
          sandbox: opts.orcidSandbox || false,
          force: opts.orcidForce || false
        })
        signedBy = orcid.orcid_id
        orcidName = orcid.orcid_name
      }

      const authors = opts.author.length > 0
        ? opts.author.map(name => ({ name, orcid: name === orcidName ? signedBy : null }))
        : [{ name: orcidName || 'Unknown', orcid: signedBy }]

      const result = await pharos.publish(pdf, {
        title: opts.title,
        authors,
        abstract: opts.abstract || '',
        subject: opts.subject,
        signedBy,
        doi: opts.doi,
        revises: opts.revises
      })

      if (result.duplicate) {
        console.log(`Already published: ${result.paper_id}`)
      } else {
        console.log(`Published: ${result.paper_id}`)
        console.log(`  Version: ${result.version}`)
        console.log(`  Hash: ${result.content_hash}`)
        console.log(`  Blob: ${result.blob_key}`)
      }
    })
  })

// pharos search <query>
program
  .command('search')
  .description('Search papers by full-text query')
  .argument('<query>', 'search query')
  .option('--limit <n>', 'max results', '20')
  .action(async (query, opts) => {
    await withStore(async () => {
      const results = pharos.search(query, { limit: parseInt(opts.limit) })
      if (results.length === 0) {
        console.log('No results found.')
        return
      }
      console.log(`Found ${results.length} result(s):\n`)
      results.forEach((r, i) => {
        console.log(`${i + 1}. [${r.paper_id}] ${r.title}`)
        if (r.snippet) console.log(`   ${r.snippet}`)
        console.log()
      })
    })
  })

// pharos fetch <paper_id>
program
  .command('fetch')
  .description('Fetch a paper PDF by paper_id')
  .argument('<paper_id>', 'paper ID')
  .option('--output <path>', 'output file path')
  .action(async (paperId, opts) => {
    await withStore(async () => {
      const meta = await pharos.getPaper(paperId)
      if (!meta) {
        console.log(`Paper not found: ${paperId}`)
        process.exit(1)
      }
      console.log(`Title: ${meta.title}`)
      console.log(`Authors: ${meta.authors.map(a => a.name).join(', ')}`)
      console.log(`Version: ${meta.version}`)
      console.log(`Hash: ${meta.content_hash}`)

      const pdf = await pharos.fetchPdf(paperId)
      if (pdf) {
        const outPath = opts.output || `${paperId.replace(/[:/]/g, '_')}.pdf`
        fs.writeFileSync(outPath, pdf)
        console.log(`PDF saved to: ${outPath} (${pdf.length} bytes)`)
      } else {
        console.log('PDF not available.')
      }
    })
  })

// pharos info <paper_id>
program
  .command('info')
  .description('Show paper metadata')
  .argument('<paper_id>', 'paper ID')
  .action(async (paperId) => {
    await withStore(async () => {
      const meta = await pharos.getPaper(paperId)
      if (!meta) {
        console.log(`Paper not found: ${paperId}`)
        process.exit(1)
      }
      console.log(JSON.stringify(meta, null, 2))
    })
  })

// pharos versions <paper_id>
program
  .command('versions')
  .description('Show version history for a paper')
  .argument('<paper_id>', 'paper ID (any version)')
  .action(async (paperId) => {
    await withStore(async () => {
      const versions = await pharos.getVersions(paperId)
      if (versions.length === 0) {
        console.log(`No versions found for: ${paperId}`)
        process.exit(1)
      }
      console.log(`Version history (${versions.length} version(s)):\n`)
      for (const v of versions) {
        const signed = v.signed_by ? ` [signed: ${v.signed_by}]` : ''
        const revises = v.previous_version_hash ? ` revises ${v.previous_version_hash.slice(0, 16)}...` : ''
        console.log(`  v${v.version}  ${v.paper_id}${signed}${revises}`)
        console.log(`        Title: ${v.title}`)
        console.log(`        Hash: ${v.content_hash}`)
        console.log(`        Published: ${v.published_at}`)
        console.log()
      }
    })
  })

// pharos browse <category>
program
  .command('browse')
  .description('Browse recent papers in a category')
  .argument('<category>', 'subject category (e.g. q-bio.GN)')
  .option('--limit <n>', 'max results', '20')
  .action(async (category, opts) => {
    await withStore(async () => {
      // Since we don't have the category:recent sorted set populated yet,
      // scan paper: keys and filter by subject
      const { getStore } = require('../core/store')
      const { KEY_PREFIX } = require('../core/constants')
      const store = getStore()
      const results = []
      for await (const { key, value } of store.bee.createReadStream({ gt: KEY_PREFIX.PAPER, lt: KEY_PREFIX.PAPER + '\xff' })) {
        if (value.subject === category) {
          results.push(value)
        }
      }
      // Sort by published_at desc
      results.sort((a, b) => b.published_at.localeCompare(a.published_at))
      const limit = parseInt(opts.limit)
      const limited = results.slice(0, limit)
      if (limited.length === 0) {
        console.log('No papers in this category.')
        return
      }
      console.log(`Papers in ${category} (${limited.length}):\n`)
      limited.forEach((p, i) => {
        console.log(`${i + 1}. [${p.paper_id}] ${p.title}`)
        console.log(`   Authors: ${p.authors.map(a => a.name).join(', ')}`)
        console.log(`   Published: ${p.published_at}`)
        console.log()
      })
    })
  })

// pharos status
program
  .command('status')
  .description('Show node status')
  .action(async () => {
    await withStore(async () => {
      const { getStore } = require('../core/store')
      const { KEY_PREFIX } = require('../core/constants')
      const store = getStore()

      let paperCount = 0
      for await (const { key } of store.bee.createReadStream({ gt: KEY_PREFIX.PAPER, lt: KEY_PREFIX.PAPER + '\xff' })) {
        paperCount++
      }

      const dbSize = fs.statSync(path.join(program.opts().dataDir, 'search.db')).size

      console.log('Pharos Node Status')
      console.log('==================')
      console.log(`  Papers: ${paperCount}`)
      console.log(`  Hyperdrive key: ${store.drive.key.toString('hex')}`)
      console.log(`  Hyperbee key: ${store.bee.core.key.toString('hex')}`)
      console.log(`  SQLite DB size: ${(dbSize / 1024).toFixed(1)} KB`)
    })
  })

// pharos orcid
program
  .command('orcid')
  .description('Run ORCID OAuth authentication')
  .option('--orcid-client-id <id>', 'ORCID client ID')
  .option('--orcid-client-secret <secret>', 'ORCID client secret')
  .option('--orcid-sandbox', 'use ORCID sandbox')
  .option('--orcid-force', 'force re-authentication')
  .action(async (opts) => {
    const clientId = opts.orcidClientId || process.env.PHAROS_ORCID_CLIENT_ID
    const clientSecret = opts.orcidClientSecret || process.env.PHAROS_ORCID_CLIENT_SECRET
    const orcid = await pharos.orcidAuth({
      clientId,
      clientSecret,
      sandbox: opts.orcidSandbox || false,
      force: opts.orcidForce || false
    })
    console.log(`ORCID iD: ${orcid.orcid_id}`)
    console.log(`Name: ${orcid.orcid_name}`)
    console.log(`Verified at: ${orcid.orcid_verified_at}`)
  })

// pharos rebuild-index
program
  .command('rebuild-index')
  .description('Rebuild FTS5 search index from stored papers')
  .action(async () => {
    await withStore(async () => {
      console.log('Rebuilding FTS5 index...')
      const count = await pharos.rebuildIndex()
      console.log(`Indexed ${count} papers.`)
    })
  })

// pharos serve
program
  .command('serve')
  .description('Start daemon: join Hyperswarm and serve blobs to peers')
  .option('--no-client', 'do not connect to peers (server only)')
  .option('--no-server', 'do not serve to peers (client only)')
  .option('--subscribe <subjects...>', 'subject categories to subscribe to (space-separated)', [])
  .action(async (opts) => {
    const dataDir = path.resolve(program.opts().dataDir)
    await pharos.initStore(dataDir)
    const store = pharos.getStore()

    const { startArchiveSwarm, startBlobSwarm, stopAll } = require('../replicate/swarm')
    const { serveBlobs, sendMessage } = require('../replicate/replicate')

    // Archive swarm: metadata replication (Hyperbee/Hyperdrive via corestore.replicate)
    const archiveSwarm = await startArchiveSwarm(store, {
      server: opts.server !== false,
      client: opts.client !== false,
      topics: opts.subscribe || []
    })

    // Blob swarm: dedicated channel for blob request/serve + pin announcements
    // (no corestore replication on this channel; length-prefixed JSON only)
    const { getLocalPins, addReplica } = require('../replicate/health')
    const blobSwarm = await startBlobSwarm((conn, info) => {
      const peerKey = info.publicKey?.toString('hex') || 'unknown'
      serveBlobs(conn, store, {
        onPinAnnounce: async (paperId, pk) => {
          try {
            await addReplica(paperId, pk)
          } catch (err) {
            console.log(`[blob-transfer] Could not record replica (read-only index?): ${err.message}`)
          }
        }
      })
      // Announce our own pins to the newly connected peer
      getLocalPins().then((pins) => {
        if (pins.length) {
          sendMessage(conn, { type: 'pin_announce', hashes: pins, peer_key: store.drive.key.toString('hex') })
          console.log(`[blob-transfer] Announced ${pins.length} pin(s) to ${peerKey.slice(0, 12)}...`)
        }
      }).catch((err) => {
        console.log(`[blob-transfer] Pin announce failed: ${err.message}`)
      })
    }, {
      server: opts.server !== false,
      client: opts.client !== false
    })

    console.log(`\nPharos daemon running.`)
    console.log(`  Drive key:       ${store.drive.key.toString('hex')}`)
    console.log(`  Bee key:         ${store.bee.core.key.toString('hex')}`)
    console.log(`  Archive peers:   ${archiveSwarm.peers}`)
    console.log(`  Blob transfers: ${blobSwarm.connections.length}`)
    console.log(`  Topics:          ${['archive', 'blob-transfer', ...opts.subscribe || []].join(', ')}`)
    console.log(`\n  Press Ctrl+C to stop.`)

    let shuttingDown = false
    const shutdown = async (signal) => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`\n${signal} received, shutting down...`)
      try { await stopAll() } catch (_) {}
      try { await pharos.close() } catch (_) {}
      process.exit(0)
    }
    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
  })

// pharos pin <paper_id>
program
  .command('pin')
  .description('Pin a paper locally (ensure blob is available)')
  .argument('<paper_id>', 'paper ID to pin')
  .action(async (paperId) => {
    await withStore(async () => {
      const { pinPaper } = require('../replicate/health')
      const result = await pinPaper(paperId)
      if (result.pinned) {
        console.log(`Pinned: ${result.paper_id}`)
        console.log(`  Hash: ${result.content_hash}`)
      } else {
        console.log(`Failed to pin: ${result.error}`)
      }
    })
  })

// pharos health
program
  .command('health')
  .description('Show replication health report')
  .action(async () => {
    await withStore(async () => {
      const { healthReport } = require('../replicate/health')
      const report = await healthReport()
      console.log('Replication Health')
      console.log('==================')
      console.log(`  Total papers: ${report.total}`)
      console.log(`  Healthy (>= ${report.minReplicas} replicas): ${report.healthy}`)
      console.log(`  At-risk (< ${report.minReplicas} replicas): ${report.atRisk}`)
      if (report.atRisk > 0) {
        console.log('\n  At-risk papers:')
        report.papers.filter(p => p.status === 'at-risk').forEach(p => {
          console.log(`    ${p.paper_id} (${p.replicas} replicas)`)
        })
      }
    })
  })

// pharos keys
program
  .command('keys')
  .description('Show this node\'s public keys for connecting peers')
  .action(async () => {
    await withStore(async () => {
      const { getStore } = require('../core/store')
      const store = getStore()
      console.log(`Drive key: ${store.drive.key.toString('hex')}`)
      console.log(`Bee key:   ${store.bee.core.key.toString('hex')}`)
    })
  })

// pharos fetch-remote <paper_id> --bee-key <hex> --drive-key <hex>
program
  .command('fetch-remote')
  .description('Fetch a paper from a remote peer via Hyperswarm')
  .argument('<paper_id>', 'paper ID to fetch')
  .requiredOption('--bee-key <hex>', 'publisher Hyperbee public key (hex)')
  .option('--drive-key <hex>', 'publisher Hyperdrive public key (hex)')
  .option('--output <path>', 'output file path')
  .action(async (paperId, opts) => {
    const dataDir = path.resolve(program.opts().dataDir)
    await pharos.initReplicaStore(dataDir, opts.beeKey, opts.driveKey)
    try {
      const { getStore } = require('../core/store')
      const { startArchiveSwarm, startBlobSwarm, stopAll } = require('../replicate/swarm')
      const { requestBlob } = require('../replicate/replicate')

      const store = getStore()

      // Archive swarm: replicate metadata (Hyperbee/Hyperdrive)
      const archiveSwarm = await startArchiveSwarm(store, { server: false, client: true })

      // Blob swarm: connect to peer for blob transfer
      let blobConn = null
      const blobSwarm = await startBlobSwarm((conn, info) => {
        blobConn = conn
      }, { server: false, client: true })

      console.log('Waiting for peer connection...')
      await new Promise(resolve => setTimeout(resolve, 15000))

      if (archiveSwarm.peers === 0) {
        console.log('No peers found. Is the publisher running `pharos serve`?')
        await stopAll()
        return
      }

      console.log(`Connected to ${archiveSwarm.peers} archive peer(s).`)

      // Wait for bee replication to sync
      console.log('Syncing metadata index...')
      await new Promise(resolve => setTimeout(resolve, 5000))

      const meta = await pharos.getPaper(paperId)
      if (!meta) {
        console.log(`Paper not found in replicated index: ${paperId}`)
        await stopAll()
        return
      }

      console.log(`Title: ${meta.title}`)
      console.log(`Hash: ${meta.content_hash}`)

      // Wait for blob swarm connection
      if (!blobConn) {
        console.log('Waiting for blob transfer connection...')
        await new Promise(resolve => setTimeout(resolve, 5000))
      }

      if (!blobConn) {
        console.log('No blob transfer connection available.')
        await stopAll()
        return
      }

      const pdf = await requestBlob(blobConn, meta.content_hash, 15000)
      if (pdf) {
        const outPath = opts.output || `${paperId.replace(/[:/]/g, '_')}.pdf`
        fs.writeFileSync(outPath, pdf)
        console.log(`PDF saved to: ${outPath} (${pdf.length} bytes)`)
      } else {
        console.log('Failed to fetch blob from peer.')
      }

      await stopAll()
    } finally {
      await pharos.close()
    }
  })

// pharos web
program
  .command('web')
  .description('Start the Pharos web UI server')
  .option('--port <n>', 'port number', '8093')
  .action(async (opts) => {
    const dataDir = path.resolve(program.opts().dataDir)
    await pharos.initStore(dataDir)
    const port = parseInt(opts.port)
    const server = await pharos.webServer.startServer({ port, dataDir })

    const store = pharos.getStore()
    console.log(`\nPharos Web UI`)
    console.log(`==============`)
    console.log(`  URL:          http://0.0.0.0:${port}`)
    console.log(`  Drive key:    ${store.drive.key.toString('hex')}`)
    console.log(`  Bee key:      ${store.bee.core.key.toString('hex')}`)
    console.log(`  Data dir:     ${dataDir}`)

    // Graceful shutdown
    let shuttingDown = false
    const shutdown = async (signal) => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`\n${signal} received, shutting down...`)
      try {
        await pharos.webServer.stopServer()
      } catch (_) {}
      try {
        await pharos.close()
      } catch (_) {}
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    console.log(`\n  Press Ctrl+C to stop.`)
  })

// pharos disk-usage
program
  .command('disk-usage')
  .description('Show disk usage of the data directory')
  .action(async () => {
    await withStore(async () => {
      const { getDiskUsage } = require('../core/store')
      const usage = await getDiskUsage()
      console.log('Disk Usage')
      console.log('==========')
      console.log(`  Hyperdrive:  ${formatBytes(usage.store_bytes)}`)
      console.log(`  Hyperbee:    ${formatBytes(usage.index_bytes)}`)
      console.log(`  SQLite DB:   ${formatBytes(usage.db_bytes)}`)
      console.log(`  Total:       ${formatBytes(usage.total_bytes)}`)
    })
  })

// pharos evict <max-mb>
program
  .command('evict')
  .description('Evict oldest unpinned papers to free disk space')
  .argument('<max_mb>', 'target maximum total storage in MB')
  .action(async (maxMb) => {
    await withStore(async () => {
      const { evictUnpinned } = require('../core/store')
      const maxBytes = parseInt(maxMb) * 1024 * 1024
      console.log(`Evicting papers until total storage is under ${formatBytes(maxBytes)}...`)
      const result = await evictUnpinned(maxBytes)
      console.log(`  Evicted: ${result.evicted} paper(s)`)
      console.log(`  Freed:   ${formatBytes(result.freed_bytes)}`)
    })
  })

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`
}

module.exports = program
