'use strict'

const { Command } = require('commander')
const path = require('path')
const fs = require('fs')

const pharos = require('../index')

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
  .option('--orcid <orcid>', 'ORCID iD (overrides mock auth)')
  .option('--doi <doi>', 'DOI if already assigned')
  .option('--revises <paper_id>', 'paper_id this is a revision of')
  .action(async (pdf, opts) => {
    await withStore(async () => {
      // ORCID auth (mock or real)
      let signedBy = null
      if (opts.orcid) {
        signedBy = opts.orcid
      } else {
        const orcid = await pharos.orcidAuth()
        signedBy = orcid.orcid_id
      }

      const authors = opts.author.length > 0
        ? opts.author.map(name => ({ name, orcid: name === 'Tiago Paixao' ? signedBy : null }))
        : [{ name: 'Unknown', orcid: null }]

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
  .description('Run ORCID auth (mock in MVP)')
  .action(async () => {
    const orcid = await pharos.orcidAuth()
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

module.exports = program