'use strict'

const { getStore } = require('../core/store')
const { KEY_PREFIX } = require('../core/constants')

/**
 * Search papers using FTS5.
 * @param {string} query - search query
 * @param {object} opts - { limit, offset }
 * @returns {Array} search results [{ paper_id, title, snippet, score }]
 */
function search(query, opts = {}) {
  const store = getStore()
  const { db } = store
  const limit = opts.limit || 20
  const offset = opts.offset || 0

  const results = db.prepare(`
    SELECT
      paper_id,
      title,
      snippet(papers_fts, 4, '...', '...', 20, 2) as snippet,
      rank
    FROM papers_fts
    WHERE papers_fts MATCH ?
    ORDER BY rank
    LIMIT ? OFFSET ?
  `).all(query, limit, offset)

  return results.map(r => ({
    paper_id: r.paper_id,
    title: r.title,
    snippet: r.snippet,
    score: r.rank
  }))
}

/**
 * Rebuild the FTS5 index from all papers in Hyperbee.
 * Useful if the index is corrupted or lost.
 * @returns {Promise<number>} number of papers indexed
 */
async function rebuildIndex() {
  const store = getStore()
  const { bee, db } = store

  // Clear existing index
  db.exec('DELETE FROM papers_fts')

  let count = 0
  const pdfParse = require('pdf-parse')

  for await (const { key, value } of bee.createReadStream()) {
    if (!key.startsWith(KEY_PREFIX.PAPER)) continue

    const meta = value
    let fulltext = ''
    try {
      const pdfBuf = await store.drive.get(meta.blob_key)
      if (pdfBuf) {
        const parsed = await pdfParse(pdfBuf)
        fulltext = parsed.text || ''
      }
    } catch (_) {}

    const authorsStr = meta.authors.map(a => a.name).join(', ')
    db.prepare(`
      INSERT INTO papers_fts (paper_id, title, authors, abstract, fulltext)
      VALUES (?, ?, ?, ?, ?)
    `).run(meta.paper_id, meta.title, authorsStr, meta.abstract || '', fulltext)
    count++
  }

  return count
}

module.exports = { search, rebuildIndex }
