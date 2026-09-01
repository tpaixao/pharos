# Pharos P2P Architecture

A walkthrough of how the P2P layer actually works, grounded in the code.

## Storage layer: three data stores, one per concern

Every node (`src/core/store.js`) runs a single **Corestore** (`store.js:32`) —
a container that manages all Hypercores for this data dir — and builds two
structures on top of it:

- **Hyperdrive** (`pharos-drive` core) — content-addressed blob storage. Holds
  the actual PDF bytes and a `metadata.json` sidecar per paper, at paths like
  `/papers/q-bio.GN/2026.08.31/001/v1/fulltext.pdf`.
- **Hyperbee** (`pharos-bee` core) — a sorted key-value index over the
  Hyperdrive contents: `paper:<id>`, `hash:<blake2b>`,
  `category:<subject>:recent:<id>`, `doi:<doi>`. This is the metadata layer
  everything queries.

Both are **append-only, single-writer Hypercores** signed by the publisher's
Ed25519 keypair — that's the actual unit of P2P replication in this stack
(via Hypercore's own wire protocol), not something Pharos invented.

A third store, **SQLite + FTS5**, sits *outside* the P2P layer entirely — it's
a local-only full-text index (`src/search/index.js`), rebuilt from Hyperdrive
content (`rebuildIndex()` re-parses every PDF). It never replicates; each
node builds its own.

## Two roles, one store shape

- **Publisher**: `initStore()` creates a *fresh, writable* Hyperdrive+Hyperbee
  — this node owns the keypair.
- **Replica**: `initReplicaStore(dataDir, beeKey, driveKey)` (`store.js:77`)
  opens the *same two cores by public key*, read-only, plus a small local
  Hyperdrive for anything it fetches. It's the identical data shape, just
  pointed at someone else's cores instead of creating its own.

A node remembers which role it is via `data/remote.json` (written by
`fetch-remote`) — that's the file both the CLI's `withStore()` and the web
server's `startServer()` D2 fix check on startup to decide which kind to
open.

## Two separate Hyperswarms, deliberately not one

This was a real design decision documented in `replicate.js`'s header
comment: mixing Hypercore's binary replication stream with a custom JSON
protocol on the same connection corrupts the JSON framing. So there are two
independent swarms, joined by topic hash (`swarm.js`):

1. **Archive swarm** (`pharos-archive-pharos-v1` topic) — pure
   `corestore.replicate(conn)`. This is what actually syncs Hyperbee/
   Hyperdrive blocks between nodes; Hypercore's own protocol does the work.
   Publishers also join per-category topics here so replicas can subscribe
   selectively.
2. **Blob-transfer swarm** (`pharos-blob-transfer-pharos-v1` topic) — a
   hand-rolled length-prefixed JSON protocol (`replicate.js`):
   `request_blob`/`blob`/`error`/`pin_announce` messages. This exists for
   **on-demand blob fetch** (a replica that only has metadata pulling one
   specific PDF) and for **pin announcements** (see below) — things outside
   what plain Hypercore replication gives you for free.

## Publish → replicate → pin lifecycle

1. **Publish** (`publish.js`): hash the PDF (blake2b via `hash.js`), dedupe by
   hash, assign a `paper_id` (`pharos:<subject>/<date>/<seq>`), write the
   blob to Hyperdrive, build the metadata record, **sign it** (Ed25519 over a
   canonical, domain-tagged serialization — `signing.js`, binding
   `signed_by`/`identity`/`content_hash` to the publisher's actual drive
   keypair so a hand-crafted record can't forge identity), then index into
   Hyperbee + SQLite. The record starts with
   `replicated_by: [own_drive_key]`.
2. **Serve** (CLI `serve`, or web's embedded replication): join both swarms.
   Archive swarm passively syncs cores to anyone connected; blob swarm
   answers `request_blob` and records `pin_announce`s from peers into
   `replicated_by` via `addReplica()`.
3. **Discover/sync** (`fetch-remote`): a replica opens `initReplicaStore`
   against the publisher's keys, joins the archive swarm client-only, and
   waits — Hypercore's protocol fills in the Hyperbee/Hyperdrive locally.
   This gets you metadata for *everything*, but blobs replicate lazily.
4. **Pin** (`health.js pinPaper` + swarm fallback): "pinning" = actually
   pulling a specific blob into your local Hyperdrive and recording your key
   in that paper's `replicated_by`. If the blob isn't local yet, join the
   archive swarm to fetch it on demand, retry until it lands.
5. **Health** (`health.js healthReport`): a paper is "healthy" once
   `replicated_by.length >= 3` (`MIN_REPLICAS`). This is the whole redundancy
   model — no DHT-wide replication guarantee, just an explicit pin-count you
   can see and act on.
6. **Eviction** (`store.js evictUnpinned`): reclaim disk by deleting the
   oldest papers with `replicated_by.length < 2` — "pinned" here just means
   someone else besides you already has it, so deleting your copy doesn't
   lose the paper.

## Trust model

Two independent layers, worth keeping distinct:

- **Content integrity**: blake2b hash is checked on every blob
  fetch/pin/serve (`computeHash(blob) === content_hash`) — this is what a
  Hypercore append-only log already gives you for free at the block level,
  re-verified at the application level too.
- **Identity**: ORCID auth (implicit OpenID flow, `orcid.js`) proves who
  signed, with a nonce binding a specific auth session to a specific
  `(content_hash, publisher_key)` pair so a captured token can't be replayed
  onto different content. The **metadata signature** (`signing.js`) is
  separate again — it's the publisher's own Ed25519 key vouching that *this*
  Hyperbee record's identity claim hasn't been tampered with in
  transit/replication, independent of ORCID.

## Where the web UI sits

Everything above lives in `src/core`, `src/publish`, `src/replicate`,
`src/search` — the web server (`src/web/server.js`) is a thin HTTP layer over
it, and the swarm-orchestration *sequences* (serve, sync-wait, pin-fallback)
are shared with the CLI via `src/replicate/session.js` rather than
reimplemented. The web server can itself run as either role (publisher or
replica, same D2 auto-detection) and optionally embed its own archive+blob
swarm participation (`--no-serve` to disable).
