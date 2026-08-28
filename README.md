# Pharos

A peer-to-peer preprint archive built on Hypercore/Hyperdrive/Hyperswarm. Content-addressed with BLAKE2b, designed to replace centralized preprint servers like arXiv/bioRxiv rather than just mirror them.

## Why?

Centralized preprint servers are fragile. arXiv ran a \$297K deficit in 2025 and is transitioning to a nonprofit model after 25 years at Cornell. bioRxiv sits behind Cloudflare, which had 4 major outages in 2025. 8,000+ federal pages and 3,000 datasets were purged since January 2025. A decentralized archive eliminates single points of failure and single points of control.

## Architecture

Pharos has five layers:

1. **Ingestion** — Author-direct publishing via CLI (`pharos publish`). No external ingestion from arXiv/bioRxiv in MVP.
2. **Storage** — Hyperdrive for blob storage (PDFs, metadata JSON), content-addressed by BLAKE2b-256 hash.
3. **Index** — Hyperbee for structured metadata (paper records, hash dedup, DOI lookup, category browsing). SQLite FTS5 for full-text search.
4. **Replication** — Hyperswarm topic-based peer discovery. Each node pins content for its categories. *(planned)*
5. **Verification** — BLAKE2b content hashing + Ed25519 signatures. Paper IDs encode subject, date, and sequence: `pharos:{subject}/{date}/{seq}`.

### Identity

ORCID-only identity. MVP uses mock ORCID auth (hardcoded). Real ORCID OAuth 2.0 with `/authenticate` scope is planned for a later weekend. Identity is separate from affiliation; institutions pin content but do not own identity.

### Paper ID Format

```
pharos:q-bio.GN/2026.08.28/001
└──┬──┘ └──┬──┘ └───┬────┘ └┬┘
  prefix  subject    date   seq (3-digit, zero-padded)
```

## Install

```bash
npm install
```

Dependencies: `hyperdrive`, `hyperbee`, `hypercore`, `corestore`, `sodium-native`, `commander`, `pdf-parse`. Node >= 22 (uses built-in `node:sqlite`).

## Usage

```bash
# Initialize store (auto-creates data/ directory)
node src/index.js status

# Publish a paper (mock ORCID auth)
node src/index.js publish paper.pdf \
  --title "A Novel Approach to Single-Cell Analysis" \
  --subject q-bio.GN \
  --author "Tiago Paixao" \
  --abstract "We propose..."

# Search
node src/index.js search "single cell bayesian"

# Fetch a paper
node src/index.js fetch pharos:q-bio.GN/2026.08.28/001 --output paper.pdf

# Show metadata
node src/index.js info pharos:q-bio.GN/2026.08.28/001

# Browse category
node src/index.js browse q-bio.GN

# Rebuild search index
node src/index.js rebuild-index
```

## Tests

```bash
node --test test/
```

All 30 tests passing: BLAKE2b hashing, metadata validation, Hyperdrive/Hyperbee round-trips, SQLite FTS5 search, publish+dedup, PDF retrieval, mock ORCID auth, index rebuild.

## Project Structure

```
pharos/
├── src/
│   ├── cli/cli.js          # Commander-based CLI
│   ├── core/
│   │   ├── constants.js     # Topic names, paths, key prefixes
│   │   ├── hash.js          # BLAKE2b hashing, blob key derivation
│   │   ├── schema.js        # Metadata validation
│   │   └── store.js         # Hyperdrive + Hyperbee + SQLite init
│   ├── publish/
│   │   ├── orcid.js         # Mock ORCID auth
│   │   └── publish.js       # Full publish flow (dedup, versioning, FTS5)
│   ├── search/index.js     # FTS5 search + index rebuild
│   ├── index.js             # CLI entry point
│   └── lib.js               # Library exports
├── test/                    # node:test suite (5 files, 30 tests)
├── SCOPING.md               # Design decisions and scope
├── IMPLEMENTATION.md        # Weekend-by-weekend build plan
└── RESEARCH.md              # Motivation and related work
```

## Status

**MVP Weekend 1 complete.** Storage layer, publish flow, search, and CLI are functional with full test coverage. Single-node only (no replication yet).

### Roadmap

- **Weekend 2**: Hyperswarm replication, category-based auto-pinning
- **Weekend 3**: Real ORCID OAuth, Ed25519 signatures
- **Weekend 4**: Web UI (browse/search/read PDF)
- **Weekend 5**: Versioning UI, CLI polish, documentation
- **Post-MVP**: External ingestion (arXiv/bioRxiv), tiered key management, institutional pinning, citation graph

## License

MIT