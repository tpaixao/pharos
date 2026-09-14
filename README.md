# Pharos

A peer-to-peer preprint archive built on Hypercore/Hyperdrive/Hyperswarm. Content-addressed with BLAKE2b, designed to replace centralized preprint servers like arXiv/bioRxiv rather than just mirror them.

## Why?

Centralized preprint servers are fragile. arXiv ran a $297K deficit in 2025 and is transitioning to a nonprofit model after 25 years at Cornell. bioRxiv sits behind Cloudflare, which had 4 major outages in 2025. 8,000+ federal pages and 3,000 datasets were purged since January 2025. A decentralized archive eliminates single points of failure and single points of control.

## Architecture

Pharos has five layers:

1. **Ingestion** — Author-direct publishing via CLI (`pharos publish`) or web UI upload. No external ingestion from arXiv/bioRxiv in MVP.
2. **Storage** — Hyperdrive v13 with Corestore for blob storage (PDFs, metadata JSON), content-addressed by BLAKE2b-256 hash.
3. **Index** — Hyperbee for structured metadata (paper records, hash dedup, DOI lookup, category browsing, version tracking). SQLite FTS5 via Node built-in `node:sqlite` for full-text search.
4. **Replication** — Hyperswarm topic-based peer discovery. Separate topics for metadata replication and blob transfer. Category-based auto-pinning. Health tracking with at-risk paper detection.
5. **Verification** — BLAKE2b content hashing + Ed25519 via sodium-native. Paper IDs encode subject, date, and sequence: `pharos:{subject}/{date}/{seq}`. Versioning via `previous_version_hash` links.

### Identity

ORCID-only identity. ORCID OAuth 2.0 with `/authenticate` scope (returns ORCID iD + name only, no ongoing API access). ORCID client app registered (APP-YC0U2NG93W401578, callback at https://tiagopaixao.com/orcid/callback.html). Identity is separate from affiliation; institutions pin content but do not own identity. ORCID iD cached in `~/.pharos/config.json`.

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

Dependencies: `hyperdrive`, `hyperbee`, `hypercore`, `corestore`, `hyperswarm`, `sodium-native`, `commander`, `pdf-parse`, `dotenv`. Node >= 22 (uses built-in `node:sqlite` with FTS5 support).

## Usage

### Publishing

```bash
# Publish a paper (requires ORCID auth)
node src/index.js publish paper.pdf \
  --title "A Novel Approach to Single-Cell Analysis" \
  --subject q-bio.GN \
  --author "Tiago Paixao" \
  --abstract "We propose..."

# Publish a revision (links to previous version)
node src/index.js publish paper_v2.pdf \
  --title "A Novel Approach to Single-Cell Analysis (v2)" \
  --subject q-bio.GN \
  --author "Tiago Paixao" \
  --revises pharos:q-bio.GN/2026.08.28/001
```

### Reading

```bash
# Search papers by full-text query
node src/index.js search "single cell bayesian"

# Fetch a paper PDF
node src/index.js fetch pharos:q-bio.GN/2026.08.28/001 --output paper.pdf

# Show paper metadata
node src/index.js info pharos:q-bio.GN/2026.08.28/001

# Browse recent papers in a category
node src/index.js browse q-bio.GN

# View version history
node src/index.js versions pharos:q-bio.GN/2026.08.28/001
```

### P2P Replication

```bash
# Start daemon: join Hyperswarm, serve blobs to peers, gossip your keys
node src/index.js serve
# ...or without the discovery gossip channel
node src/index.js serve --no-discovery

# Show this node's public keys for connecting peers
node src/index.js keys

# Discover publishers of a subject via gossip -- no key exchange needed
node src/index.js discover q-bio.GN --timeout 10000

# List publishers learned from gossip so far (local cache)
node src/index.js publishers q-bio.GN

# Fetch a paper from a remote peer via Hyperswarm (keys from `discover`)
node src/index.js fetch-remote pharos:q-bio.GN/2026.08.28/001 \
  --bee-key <hex> --drive-key <hex>

# Pin a paper locally (ensure blob is available)
node src/index.js pin pharos:q-bio.GN/2026.08.28/001

# Show replication health report
node src/index.js health
```

A third Hyperswarm channel — the **discovery swarm** — carries publisher gossip:
length-prefixed JSON announcements of `{bee_key, drive_key, subjects}` on
per-subject topics (`pharos-discovery-<subject>-pharos-v1`). Nodes announce the
keys they can serve (publishers announce their own; replicas automatically
announce their publisher's), relay what they learn, and dedup on
`(bee_key, announced_at)` with a hop cap, rate limits, and TTLs. Discovered
keys are *unverified hints* until `fetch-remote` succeeds and the replicated
records pass the Ed25519 metadata-signature gate. See `GOSSIP_IMPL_PLAN.md`
for the full design.

### Web UI

```bash
# Start the web server (default port 8093)
node src/index.js web
# Or specify a custom port
node src/index.js web --port 9000
```

Browse to `http://0.0.0.0:8093` to:
- View recent papers and browse by category
- Read paper detail pages with metadata and abstracts
- Search full-text across all papers
- Download PDFs inline
- View version history for papers
- Upload new papers via web form (multipart upload with validation)
- Discover publishers via gossip (Node panel) and fetch from them with one click

### Storage Management

```bash
# Show disk usage breakdown
node src/index.js disk-usage

# Evict oldest unpinned papers to free space
node src/index.js evict 500  # target max 500MB
```

### ORCID Authentication

```bash
# Run ORCID implicit OpenID flow (no client secret needed)
node src/index.js orcid

# With sandbox for testing
node src/index.js orcid --sandbox
```

### Status and Maintenance

```bash
# Show node status (keys, paper count, storage)
node src/index.js status

# Rebuild FTS5 search index from stored papers
node src/index.js rebuild-index
```

## Tests

```bash
node --test test/
```

135 tests passing across 12 test files: BLAKE2b hashing, metadata validation, Hyperdrive/Hyperbee round-trips, SQLite FTS5 search, publish + dedup, versioning, PDF retrieval, ORCID OAuth mock, P2P replication (two-node in-process), web server (routing, validation, security headers, upload, disk-usage), and gossip discovery (framing, validation, dedup/TTL, transitive relay, rate limits, interest scoping, persistence).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Homepage (browse recent papers) |
| GET | `/paper/{paper_id}` | Paper detail page |
| GET | `/api/papers` | List papers (optional `?subject=` and `?limit=`) |
| GET | `/api/paper/{paper_id}` | Get paper metadata as JSON |
| GET | `/api/search?q={query}` | Full-text search (max 500 chars, `?limit=` up to 100) |
| GET | `/api/versions/{paper_id}` | Version history for a paper |
| GET | `/api/stats` | Archive statistics (paper count, categories) |
| GET | `/api/disk-usage` | Disk usage breakdown (store, index, db, total) |
| GET | `/api/status` | Node status (keys, paper count, role) |
| GET | `/api/serve-status` | Embedded replication swarm status |
| GET | `/api/discover?subject=` | One-shot gossip discovery of publishers for a subject (`timeout_ms` 1s–30s) |
| GET | `/api/publishers` | Local discovered-publishers cache (optional `?subject=`) |
| GET | `/pdf/{paper_id}` | Serve PDF inline (magic byte verified) |
| POST | `/api/publish` | Upload a new paper (multipart, max 50MB, PDF magic bytes checked) |
| POST | `/api/fetch-remote` | Open a replicated store against a publisher's keys |
| POST | `/api/pin` | Pin a paper locally (swarm-assisted fallback) |

All responses include security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`. Only GET and POST methods are allowed.

## Valid Subject Categories

```
q-bio.GN  (Genomics)
q-bio.QM  (Quantitative Methods)
q-bio.BM  (Biomolecules)
q-bio.CB  (Cell Behavior)
q-bio.MN  (Molecular Networks)
q-bio.PE  (Populations and Evolution)
q-bio.TO  (Tissues and Organs)
cs.LG     (Machine Learning)
cs.AI     (Artificial Intelligence)
stat.ML   (Machine Learning Stats)
stat.AP   (Applications)
stat.ME   (Methodology)
```

## Project Structure

```
pharos/
├── src/
│   ├── cli/cli.js              # Commander-based CLI (18 commands)
│   ├── core/
│   │   ├── constants.js         # Topic names, paths, key prefixes, valid subjects
│   │   ├── hash.js              # BLAKE2b hashing, blob key derivation
│   │   ├── schema.js            # Metadata validation
│   │   └── store.js            # Hyperdrive + Hyperbee + SQLite init, disk usage, eviction
│   ├── publish/
│   │   ├── orcid.js             # ORCID OAuth 2.0 flow
│   │   └── publish.js           # Full publish flow (dedup, versioning, FTS5, browse)
│   ├── replicate/
│   │   ├── swarm.js             # Hyperswarm topic management, connection handling
│   │   ├── framing.js           # Shared length-prefixed JSON framing (with size cap)
│   │   ├── replicate.js         # Blob request/serve protocol over Hyperswarm
│   │   ├── discovery.js         # Gossip engine: publisher announcements, dedup, relay
│   │   ├── session.js           # Shared orchestration: serve/sync/pin/discover sequences
│   │   └── health.js            # Replication health: pin counts, at-risk papers
│   ├── search/index.js          # SQLite FTS5 search + index rebuild
│   ├── web/server.js            # HTTP API + web UI server
│   ├── index.js                 # CLI entry point
│   └── lib.js                   # Library exports
├── test/                        # 12 test files, 135 tests
├── SCOPING.md                   # Architecture and design decisions
├── IMPLEMENTATION.md           # Build plan and weekend-by-weekend progress
├── GOSSIP_IMPL_PLAN.md          # Publisher-discovery gossip design (implemented)
└── RESEARCH.md                  # Motivation and related work
```

## Status

**MVP complete.** All 6 weekends delivered: storage layer, publish flow, search, P2P replication, ORCID identity, versioning, web UI, and hardening. **Post-MVP: gossip-based publisher discovery implemented** (`GOSSIP_IMPL_PLAN.md`) — nodes now learn each other's keys over the discovery swarm with no out-of-band exchange. 135 tests passing.

### Weekend Progress

| Weekend | Scope | Status |
|---------|-------|--------|
| 1 | Single-node vertical slice (publish, search, fetch, info, browse, status, dedup, revisions) | Done |
| 2 | P2P replication (Hyperswarm, blob serve, health tracking) | Done |
| 3 | ORCID identity integration + versioning | Done |
| 4 | Web UI (browse, search, read PDF, upload, version history) | Done |
| 5 | Polish and hardening (security headers, input validation, graceful shutdown, storage management) | Done |
| 6 | Gossip-based publisher discovery (discovery swarm, gossip engine, `discover`/`publishers` CLI, web Node panel) | Done |

### Post-MVP Roadmap

- External ingestion (arXiv/bioRxiv) as bootstrapping mechanism
- Tiered key management (institutional attestation, passkeys, sovereign keys)
- Institutional pinning as first-class replication mode
- Bidirectional ORCID linking (write back to ORCID profile)
- Citation graph extraction and content-addressed linking
- Distributed gossip-based search across peers
- Formal correction/erratum protocol with UI
- Reputation layer: endorsements from verified researchers

## License

MIT