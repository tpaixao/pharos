'use strict'

/**
 * Validate paper metadata before insertion into Hyperbee.
 * @param {object} meta - metadata object
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateMetadata(meta) {
  const errors = []

  if (!meta || typeof meta !== 'object') {
    return { valid: false, errors: ['metadata must be an object'] }
  }

  // Required fields
  const required = ['paper_id', 'title', 'authors', 'subject', 'content_hash', 'blob_key', 'source', 'version']
  for (const field of required) {
    if (meta[field] === undefined || meta[field] === null || meta[field] === '') {
      errors.push(`missing required field: ${field}`)
    }
  }

  // paper_id format: pharos:{subject}/{date}/{seq}
  // subject can contain letters, digits, hyphens, dots (e.g. q-bio.GN, cs.AI)
  if (meta.paper_id && !/^pharos:[a-zA-Z0-9.-]+\/\d{4}\.\d{2}\.\d{2}\/\d{3}$/.test(meta.paper_id)) {
    errors.push(`paper_id format invalid: ${meta.paper_id} (expected pharos:{subject}/{date}/{seq})`)
  }

  // authors must be an array of {name, orcid?}
  if (meta.authors) {
    if (!Array.isArray(meta.authors)) {
      errors.push('authors must be an array')
    } else {
      meta.authors.forEach((author, i) => {
        if (!author.name || typeof author.name !== 'string') {
          errors.push(`authors[${i}].name must be a string`)
        }
        if (author.orcid && !/^\d{4}-\d{4}-\d{4}-\d{4}$/.test(author.orcid)) {
          errors.push(`authors[${i}].orcid format invalid: ${author.orcid}`)
        }
      })
    }
  }

  // version must be a positive integer
  if (meta.version !== undefined && (!Number.isInteger(meta.version) || meta.version < 1)) {
    errors.push('version must be a positive integer')
  }

  // content_hash format: blake2b:{hex}
  if (meta.content_hash && !/^blake2b:[0-9a-f]{64}$/.test(meta.content_hash)) {
    errors.push(`content_hash format invalid: ${meta.content_hash}`)
  }

  // source must be one of the known values
  if (meta.source && !['pharos', 'arxiv', 'biorxiv'].includes(meta.source)) {
    errors.push(`source must be 'pharos', 'arxiv', or 'biorxiv', got: ${meta.source}`)
  }

  // signed_by: if present, must be a valid ORCID format
  if (meta.signed_by !== null && meta.signed_by !== undefined) {
    if (!/^\d{4}-\d{4}-\d{4}-\d{4}$/.test(meta.signed_by)) {
      errors.push(`signed_by format invalid: ${meta.signed_by}`)
    }
  }

  return { valid: errors.length === 0, errors }
}

module.exports = { validateMetadata }