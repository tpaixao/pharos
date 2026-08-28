# Pharos: Implementation Plan

This document translates the SCOPING.md architecture into concrete engineering decisions: file structure, dependencies, data schemas, module APIs, and a build order that delivers a working vertical slice first.

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|----------|
| Runtime | Node.js 24 (already installed) | Hypercore ecosystem is Node-native; p2p-digest POC uses it |
| Blob storage | Hyperdrive v13 with Corestore | File system over Hypercore; content-addressed; v11 has internal Hyperbee version conflicts |
| Metadata index | Hyperbee | KV store over Hypercore; replicates to all peers; range queries for category browsing |
| Peer discovery | Hyperswarm v4 | Proven in p2p-digest POC; topic-based; no signaling server needed |
| Content hashing | BLAKE2b via `blake2b` npm pkg | Fast, deterministic, content-addressed dedup; native to Hypercore ecosystem |
| Local search | SQLite FTS5 via Node built-in `node:sqlite` | No native dependency needed; FTS5 built into SQLite; Node 22+ ships `node:sqlite` with FTS5 support |
| CLI | Commander.js | Standard, well-documented, subcommand support |
| Web UI | Vanilla JS SPA, no framework | Single-page app talking to local HTTP API; minimal build complexity; matches p2p-digest viewer pattern |
| ORCID OAuth | Local callback server (same pattern as gws_auth) | Headless Pi has no browser; manual paste of redirect URL; one-time bootstrap |
| HTTP server | Node `http` module (no Express) | Matches p2p-digest viewer; minimal dependencies; simple routing |
| PDF text extraction | `pdf-parse` | For FTS5 full-text indexing of PDFs after publish/replicate |

## Project Structure

```
projects/p2p-preprint-archive/
  package.json
  README.md
  SCOPING.md              # architecture and design decisions
  RESEARCH.md             # motivation and related work
  IMPLEMENTATION.md        # build plan and weekend-by-weekend progress
  
  src/
    index.js               # CLI entry point (loads dotenv, runs commander)
    lib.js                 # library exports (initStore, publish, search, etc.)
    
    core/
      store.js             # Hyperdrive + Hyperbee + SQLite init, disk usage, eviction
      hash.js              # BLAKE2b content hashing, blob key derivation
      schema.js            # metadata validation
      constants.js         # topic names, paths, key prefixes, valid subjects
    
    publish/
      publish.js           # direct publishing: PDF → hash → dedup → Hyperdrive → index
      orcid.js             # ORCID OAuth 2.0 flow (local callback server)
    
    replicate/
      swarm.js             # Hyperswarm topic management, connection handling
      replicate.js         # blob request/serve protocol over Hyperswarm
      health.js            # replication health: pin counts, at-risk papers
      protocol.js          # custom binary protocol for blob transfer
    
    search/
      index.js             # SQLite FTS5 index management (build, query, rebuild)
    
    cli/
      cli.js               # Commander.js command definitions (18 commands)
    
    web/
      server.js            # HTTP API + web UI server (single file, no static dir)
  
  test/                    # 9 test files, 74 tests
    test_hash.js           # BLAKE2b hashing
    test_schema.js         # metadata validation
    test_store.js           # Hyperdrive put/get, Hyperbee round-trip
    test_publish.js         # publish + retrieve round-trip, dedup, versions
    test_replicate.js       # two-node replication (in-process via Hyperswarm)
    test_search.js          # FTS5 indexing + query
    test_versions.js        # version history and revision links
    test_orcid.js           # ORCID OAuth mock flow
    test_web.js             # web server: routing, validation, security, upload
  
  data/                    # runtime data (gitignored)
    store/                 # Hyperdrive storage (Corestore)
    index/                 # Hyperbee storage
    pharos.db               # SQLite FTS5 database
    config.json            # node config (ORCID iD, keys, subscriptions)
```

## Data Schemas

### Paper metadata (stored in Hyperbee, indexed by paper_id)

```json
{
  "paper_id": "pharos:q-bio.GN/2026.08.28.001",
  "title": "Toward a unifying framework for evolutionary processes",
  "authors": [
    {"name": "Tiago Paixao", "orcid": "0000-0003-2361-3953"}
  ],
  "abstract": "...",
  "subject": "q-bio.GN",
  "doi": "10.1101/2026.08.28.001",
  "source": "pharos",
  "version": 1,
  "previous_version_hash": null,
  "content_hash": "blake2b:7f3a...e9c1",
  "blob_key": "/papers/q-bio.GN/2026.08.28.001/v1/fulltext.pdf",
  "hyperdrive_key": "hexstring...",
  "signed_by": "0000-0003-2361-3953",
  "published_at": "2026-08-28T10:30:00Z",
  "first_seen": "2026-08-28T10:30:00Z",
  "replicated_by": ["peerkey1", "peerkey2"]
}
```

### Blob entry (Hyperdrive file path convention)

```
/papers/{subject}/{paper_id}/v{N}/metadata.json
/papers/{subject}/{paper_id}/v{N}/fulltext.pdf
```

### Hyperbee key mappings

```
paper:{paper_id}          → paper metadata JSON (above)
hash:{content_hash}       → {paper_id, blob_key, type, size, replicated_by: [...]}
doi:{doi}                  → paper_id
category:{subject}:recent → sorted set (by timestamp) for recent papers listing
orcid:{orcid_id}          → discovery key for identity core (Phase 2; stub in MVP)
```

### ORCID config (~/.pharos/config.json)

```json
{
  "orcid_id": "0000-0003-2361-3953",
  "orcid_name": "Tiago Paixao",
  "orcid_verified_at": "2026-08-28T10:00:00Z",
  "orcid_client_id": "APP-XXXXXXXXXXXX",
  "orcid_client_secret": "secret",
  "node_key": "hexstring...",
  "subscriptions": ["q-bio.GN", "q-bio.QM", "cs.AI"],
  "pin_policy": "subscribed",
  "storage_limit_bytes": null,
  "web_port": 8093
}
```

### Paper ID format

```
pharos:{subject_category}/{date YYYY.MM.DD}/{daily_sequence:03d}
```
Example: `pharos:q-bio.GN/2026.08.28.001`

The daily sequence is a per-node counter reset each UTC midnight. Collisions across nodes are resolved by content hash dedup: two nodes publishing the same PDF get the same `content_hash`, and the metadata entry with the earlier `published_at` wins as canonical.

## Module Specifications

### core/store.js

Initializes and exports singleton Hyperdrive, Hyperbee, and SQLite instances.

```js
// Key functions:
async function initStore(dataDir)
  // Creates Hyperdrive at dataDir/store
  // Creates Hyperbee at dataDir/index
  // Opens SQLite at dataDir/search.db
  // Returns { drive, bee, db, close() }

async function closeStore()
  // Graceful shutdown of all three
```

### core/hash.js

```js
function computeHash(buffer)
  // Returns 'blake2b:{hex digest}' string

function blobKey(paperId, version, filename)
  // Returns Hyperdrive path: /papers/{subject}/{paperId}/v{N}/{filename}

function paperIdFromHash(hash, subject)
  // Derives a paper_id from content hash + subject (for dedup check)
```

### publish/publish.js

```js
async function publish(pdfPath, opts)
  // opts: { title, authors[], abstract, subject, orcidAuth, revises }
  // 1. If orcidAuth: run ORCID OAuth flow (orcid.js), get verified ORCID iD
  // 2. Read PDF file, compute hash
  // 3. Check Hyperbee for existing hash (dedup). If exists, return existing paper_id
  // 4. Generate paper_id (pharos:{subject}/{date}/{seq})
  // 5. Write PDF + metadata.json to Hyperdrive
  // 6. Insert into Hyperbee: paper:{id}, hash:{hash}, doi:{doi}, category:{subject}:recent
  // 7. If revises: set previous_version_hash, link in index
  // 8. Extract text via pdf-parse, insert into FTS5 index
  // 9. Announce on Hyperswarm topic
  // 10. Return { paper_id, content_hash, announced }
```

### publish/orcid.js

```js
async function orcidAuth()
  // 1. Start local HTTP server on port 8443 (or configurable)
  // 2. Open ORCID OAuth URL in browser (or print URL for manual paste on Pi)
  // 3. Receive callback at /callback?code=...
  // 4. Exchange code for ORCID iD via /oauth/token
  // 5. Save to config.json
  // 6. Return { orcid_id, name }

function getOrcidAuthUrl()
  // Constructs OAuth URL with /authenticate scope
  // redirect_uri = http://localhost:8443/callback

// Prerequisite: register client app at ORCID developer portal
// https://orcid.org/developer-tools
// Client ID + Client Secret stored in config.json (not committed)
```

### replicate/swarm.js

```js
async function startSwarm(topics, opts)
  // topics: array of topic strings (e.g. ["pharos-archive-v1", "pharos-qbio"])
  // opts: { server: true, client: true }
  // Joins each topic, handles connections
  // On connection: replicate Hyperdrive + Hyperbee
  // Returns swarm instance

async function stopSwarm(swarm)
  // Clean shutdown

function archiveTopic()
  // Returns hash("pharos-archive-v1")

function categoryTopic(subject)
  // Returns hash("pharos-" + subject.replace(".", "").toLowerCase())
```

### replicate/replicate.js

```js
async function requestBlob(contentHash, peerSocket)
  // Protocol: send {type: "request_blob", hash: contentHash}
  // Receive blob data, verify hash on receipt
  // Reject on mismatch

async function serveBlob(contentHash, peerSocket, store)
  // Look up hash in Hyperbee, get blob_key
  // Read from Hyperdrive, send to peer

async function announcePins(swarm, store)
  // Periodically broadcast what this node pins
  // Other nodes update replicated_by in their index
```

### search/index.js

```js
async function buildIndex(store)
  // Iterate all Hyperbee paper: entries
  // Extract text from each PDF (cached; only new papers)
  // Insert into FTS5: papers(rowid, paper_id, title, authors, abstract, fulltext)

async function search(query, opts)
  // opts: { category, limit, offset }
  // FTS5 MATCH query against title + abstract + fulltext
  // Returns [{paper_id, title, snippet, score}]

function addToIndex(paperId, metadata, pdfBuffer)
  // Extract text, insert single paper into FTS5
```

### web/server.js

HTTP API + static file server. Routes:

```
GET  /                          # Homepage (browse recent papers)
GET  /paper/:paper_id           # Paper detail page (HTML)
GET  /api/papers?subject=&limit= # list papers (optional filter)
GET  /api/paper/:paper_id       # paper metadata (JSON)
GET  /api/search?q=&limit=      # FTS5 full-text search
GET  /api/versions/:paper_id    # version history
GET  /api/stats                 # archive statistics
GET  /api/disk-usage            # storage breakdown
GET  /pdf/:paper_id             # serve PDF inline (magic byte verified)
POST /api/publish               # upload PDF (multipart, max 50MB)
```

Security: all responses include `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`. Only GET and POST methods allowed. Uploads validated for PDF magic bytes and subject whitelist.

## Build Order

The build order is designed to produce a working vertical slice (publish a PDF, store it, search it locally) by the end of weekend 1, then layer on replication, ORCID identity, and the web UI. With no external ingestion, the MVP is purely author-published content — the core thesis is proving a full publish-to-read cycle without a central server.

### Weekend 1: Vertical Slice (publish → store → search, single node)

**Goal:** Publish a local PDF to Pharos, store it in Hyperdrive, index in Hyperbee + FTS5, search and retrieve via CLI.

**Steps:**

1. `npm init`, install dependencies:
   ```
   hypercore hyperdrive hyperbee hyperswarm corestore sodium-native pdf-parse commander dotenv
   ```
   Note: SQLite FTS5 uses Node built-in `node:sqlite` (Node 22+), no native dependency needed.

2. Implement `core/hash.js` — BLAKE2b hashing, blob key derivation. Write `test/test_hash.js`.

3. Implement `core/store.js` — initStore/closeStore. Write `test/test_store.js` (put a file in Hyperdrive, read it back, put/get in Hyperbee).

4. Implement `core/schema.js` — validate metadata JSON before insertion. Reject malformed entries.

5. Implement `publish/publish.js` — full publish flow without ORCID (identity stubbed): read PDF → hash → dedup check → store in Hyperdrive → index in Hyperbee → index in FTS5.

6. Implement `search/index.js` — FTS5 build + query.

7. Implement minimal CLI: `pharos publish paper.pdf --title "..." --subject q-bio.GN` and `pharos search "single cell"` and `pharos fetch <paper_id>`.

**Deliverable:** Publish a PDF, search for it, retrieve it. Proves the storage + indexing + publishing stack works end-to-end on a single node.

### Weekend 2: Replication (Two-Node Test)

**Goal:** Pi publishes, laptop subscribes. Metadata index replicates. Blob request/serve works.

**Steps:**

1. Implement `replicate/swarm.js` — Hyperswarm topic management. Join global archive topic + per-category topics. On connection, replicate Hyperbee (metadata index) + Hyperdrive (blobs).

2. Implement `replicate/replicate.js` — blob request/serve protocol. Simple JSON message over the Hyperswarm socket: `{type: "request_blob", hash: "..."}` → response with blob data. Verify hash on receipt.

3. Test: Pi publishes 5 papers. Laptop connects via Hyperswarm. Laptop receives full metadata index (Hyperbee replication). Laptop requests a specific paper's PDF, receives it, hash verified.

4. Implement `replicate/health.js` — track replicated_by counts, flag papers with < 3 replicas.

5. Category-based auto-replication: laptop subscribes to `q-bio.GN`, automatically receives new papers in that category as they're published on the Pi.

6. Full CLI: `pharos browse <category> --recent`, `pharos pin <paper_id>`, `pharos status` (shows peers, pin count, storage).

**Deliverable:** Pi + laptop two-node system. Metadata replicates automatically. Blobs fetched on demand. This is the core P2P proof, extending p2p-digest from message-level to blob-level.

### Weekend 3: ORCID Identity + Versioning

**Goal:** Author publishes with ORCID-verified identity. Versioned updates work.

**Steps:**

1. Register ORCID client app at https://orcid.org/developer-tools (free for individuals). Get Client ID + Client Secret. **Do this early — ~1 day review time.**

2. Implement `publish/orcid.js` — OAuth flow with local callback server. On Pi: print URL for manual paste (same pattern as gws_auth). On desktop: open browser automatically.

3. Wire ORCID into `publish/publish.js` — `signed_by` field set to verified ORCID iD. Unverified publishes still work but show `signed_by: null`.

4. Versioning: `pharos publish paper_v2.pdf --revises pharos:q-bio.GN/2026.08.28.001` links versions via `previous_version_hash`. CLI and API return version history.

5. Test: publish a paper on the Pi with ORCID, see it appear on the laptop via replication with identity intact.

**Deliverable:** Full publish-to-read cycle with ORCID-verified authorship. Versioned updates linked.

### Weekend 4: Web UI

**Goal:** Browser-based interface for browsing, searching, reading, and publishing papers.

**Steps:**

1. Implement `web/server.js` — HTTP API with the routes listed above. Serve static files from `web/static/`.

2. Build `web/static/index.html` + `app.js` — dark-themed SPA (reuse p2p-digest viewer palette). Pages: home (recent papers by category), search, paper detail (metadata + abstract + PDF viewer), publish form.

3. PDF viewer: use `<embed>` or PDF.js for in-browser reading. Serve PDFs from Hyperdrive via `/api/paper/:id/pdf`.

4. Publish form: file upload (multipart), metadata fields, ORCID auth button.

5. `pharos serve` starts the daemon: web server + Hyperswarm replication.

**Deliverable:** Working web UI at `http://192.168.1.151:8093`. Browse, search, read PDFs, publish new papers. This is what makes it a product.

### Weekend 5: Polish + Hardening ✅

**Goal:** Production-quality for a two-node deployment.

**Completed:**

1. Graceful shutdown: idempotent `close()` with 5s force-timeout fallback; SIGTERM handler alongside SIGINT; no stale LOCK files.

2. Storage management: `getDiskUsage()` API endpoint and CLI command; `evictUnpinned(maxBytes)` CLI command evicts oldest papers with <2 replicas.

3. Security headers on all responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`.

4. Input validation: paper ID length limits (200 chars), search query max 500 chars, subject whitelist (`VALID_SUBJECTS`), required field checks on publish (title mandatory), upload size limit 50MB (early reject via Content-Length + streaming guard).

5. PDF magic byte verification on both upload (`%PDF-` check) and serve paths.

6. Method allowlist: only GET/POST allowed, returns 405 for everything else.

7. Error sanitization: generic "Internal server error" to clients instead of leaking `err.message`.

8. CLI: `pharos disk-usage`, `pharos evict <max_mb>` commands added.

9. README rewritten with full CLI reference, API endpoints table, valid subjects, and weekend progress.

10. 8 new tests (disk-usage, non-PDF rejection, missing title, invalid subject, valid web upload, 405 method, security headers, query length limit). Total: 74 tests.

**Deliverable:** Hardened two-node system with security headers, input validation, graceful shutdown, storage management, and full documentation.

## Testing Strategy

All tests use Node's built-in `node:test` runner (no Jest dependency).

**Unit tests** (run in seconds):
- `test_hash.js`: hash determinism, collision resistance (different inputs → different hashes)
- `test_schema.js`: valid/invalid metadata, missing fields, type checking
- `test_store.js`: Hyperdrive put/get round-trip, Hyperbee put/get, SQLite insert/query

**Integration tests** (run in <30s, use temp directories):
- `test_publish.js`: publish a local PDF, retrieve it by paper_id, verify hash, verify FTS5 index
- `test_search.js`: publish 10 papers, search for a term, verify results ranked correctly

**Replication test** (run in <60s, two in-process nodes):
- `test_replicate.js`: create two store instances in temp dirs, connect via Hyperswarm (localhost), verify metadata index replicates, verify blob transfer works

Run all: `node --test test/`

## Integration with Existing Code

### p2p-digest (direct reuse)
The Hyperswarm connection pattern, Hypercore replication, and the viewer.js HTTP server pattern are all directly reusable. The key difference: Pharos uses Hyperdrive (blobs) + Hyperbee (structured index) instead of a single Hypercore (messages). The swarm connection handler changes from `core.replicate(socket)` to replicating both the Hyperdrive and Hyperbee over the same socket.

### gws_auth (OAuth pattern reuse)
The ORCID OAuth flow in `publish/orcid.js` follows the same pattern as `projects/gws_auth/`: local HTTP callback server, manual URL paste for headless machines, token storage in config file.

## Key Implementation Decisions

### Why no external ingestion in the MVP
The core thesis from SCOPING.md is "a full publish-to-read cycle without a central server." Ingesting from arXiv/bioRxiv is a bootstrapping convenience, not the value proposition. Dropping it eliminates: OAI-PMH harvesters, rate-limit handling, PDF download cascading fallbacks, resumption tokens, and the entire `ingest/` module. The MVP is smaller, ships faster, and proves the actual thesis directly. External ingestion can be added post-MVP if bootstrapping from existing archives becomes useful.

### Why Hyperbee for the index (not just Hypercore)
Hyperbee provides ordered key-value storage with range queries. Browsing "recent papers in q-bio.GN" is a range query on `category:q-bio.GN:recent`. DOI lookup is a point query on `doi:{doi}`. A raw Hypercore would require scanning all entries to find by category or DOI. Hyperbee replicates to all peers (same as Hypercore), so every node has the full catalog.

### Why SQLite FTS5 for search (not Hyperbee)
Hyperbee is a KV store, not a full-text search engine. FTS5 provides tokenization, stemming, ranking, and snippet extraction out of the box. Each node maintains its own local FTS5 index over replicated content. No global search protocol needed for MVP. The FTS5 index is derived data, rebuilt from Hyperbee + Hyperdrive if lost.

### Why not Autobase for MVP
Autobase is the multiwriter solution for Hypercore, but the MVP uses single-writer Hyperbee per node. Each node writes to its own Hyperbee, and replication merges entries by content hash (dedup). Full multiwriter consensus (Autobase) is a Phase 2 concern for the citation graph and correction protocol.

### Why BLAKE2b (not SHA-256)
BLAKE2b is faster than SHA-256 on ARM (Pi), and it is the native hash function in the Hypercore/sodium ecosystem. Content addressing with BLAKE2b is consistent with how Hypercore internally handles integrity.

### Why content-hash dedup resolves paper_id collisions
Two nodes publishing the same PDF independently will compute the same BLAKE2b hash. The metadata entry with the earlier `published_at` timestamp becomes canonical. Both nodes' `replicated_by` lists merge. This is simpler than a global consensus protocol and sufficient for the MVP.

## Port Assignments

| Service | Port | Notes |
|---------|------|-------|
| Pharos web UI | 8093 | Verified available |
| ORCID OAuth callback | 8443 | Local-only, transient |

## Resolved Implementation Questions

1. **Hyperbee replication over Hyperswarm** ✅: Hyperbee + Hyperdrive share a single Corestore and replicate via `corestore.replicate(socket)`. Verified working in Weekend 2. Blob transfer uses a separate Hyperswarm topic because Hypercore's binary replication frames corrupt the custom length-prefixed JSON protocol on the same stream.

2. **PDF text extraction on the Pi**: `pdf-parse` works on ARM but is slow for large PDFs. Text extraction runs only on the publishing node; replicas receive pre-indexed FTS5 entries via Hyperbee.

3. **ORCID OAuth client registration** ✅: Client app registered (APP-YC0U2NG93W401578). Callback URL at https://tiagopaixao.com/orcid/callback.html (live on gh-pages). OAuth flow uses manual paste of redirect URL for headless Pi, same pattern as gws_auth.

4. **Storage growth with no ingestion**: MVP relies on direct publishing only. `pharos disk-usage` and `pharos evict` commands manage storage. Post-MVP ingestion can seed content.
