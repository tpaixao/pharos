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

## Separate Hyperswarms per wire protocol, deliberately not one

This was a real design decision documented in `replicate.js`'s header
comment: mixing Hypercore's binary replication stream with a custom JSON
protocol on the same connection corrupts the JSON framing. Each channel
gets its own swarm, joined by topic hash (`swarm.js`):

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
3. **Discovery swarm** (`pharos-discovery-<subject>-pharos-v1` topics) — the
   publisher-gossip channel (see the last section of this document).

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

## Publisher discovery: the gossip channel (as built)

The original "no cross-publisher discovery" limitation is closed. Two
publishers joining the same category topic used to connect over the DHT and
do nothing useful, because neither's corestore referenced the other's keys —
Hyperswarm topics are rendezvous points only, and `corestore.replicate()`
syncs nothing without an exact public key on both sides. Keys entered the
system only out-of-band (CLI flags, web form, `data/remote.json`).

The gap is closed by a **third swarm** — the discovery swarm — carrying
publisher gossip. Full design and rationale in `GOSSIP_IMPL_PLAN.md`; the
shape as built:

- **Topics**: `pharos-discovery-<subject>-pharos-v1`, one per subject the
  node can serve (papers in its bee) or subscribes to. A node with nothing
  to gossip about joins no discovery topic.
- **Protocol**: same length-prefixed JSON framing as the blob channel
  (extracted to `src/replicate/framing.js`, now with a frame-size cap);
  messages are `announce` (batched `{bee_key, drive_key, subjects,
  announced_at, is_publisher, hops}` entries) and `request` (stateless
  pull, used by `pharos discover`). Connections here are never passed to
  `corestore.replicate()` — that was the documented failure mode of the old
  `protocol.js` magic-byte idea, which is why that module was dead code and
  has been deleted.
- **Announcement semantics**: an entry means "keys I can serve". Because
  replica stores open the publisher's cores *by key*, this one rule covers
  publishers (announce own cores) and replicas (announce their publisher's
  cores, keeping discovery alive when the publisher is offline). A replica
  without a publisher drive key announces bee-only — its fresh local drive
  key is useless to strangers.
- **Propagation**: on connect, push self + recently-seen entries; on
  receiving entries new to us, upsert locally and forward to all other
  discovery peers — epidemic relay. Stateless discoverers send `request`
  and get a subject-filtered reply. Senders can't know what a receiver
  cares about (server-side connections carry no topic info in Hyperswarm
  v4), so receivers filter: engines created with interests upsert/relay
  only entries intersecting them. Information flows along the interest
  graph instead of flooding globally.
- **Loop/flood control**: dedup on `(bee_key, announced_at)` — stable across
  every path because relays never mutate the originator's timestamp — plus
  a hop cap (3), per-connection rate limits, batch caps, a 1000-row LRU
  table cap, and 7-day TTL refreshed by 10-minute re-announces.
- **Local storage**: a `known_publishers` SQLite table in the existing
  local-only `search.db` — deliberately not a Hyperbee table, so it can
  never replicate; same category of state as `remote.json`.
- **Surfaces**: `pharos discover <subject>` (one-shot listen + print),
  `pharos publishers` (cache listing), `serve` gossips by default
  (`--no-discovery` to opt out), web `GET /api/discover` /
  `GET /api/publishers` and a Node panel "Discovered Publishers" section
  whose "Use" button prefills the fetch-remote form.

### Trust posture

Gossip is *unauthenticated by construction* — nothing stops a peer
announcing bogus keys, and relayed announcements aren't re-signed. This
doesn't threaten paper-level integrity: a gossiped key still has to resolve
to a real Hyperbee whose records still have to pass the Ed25519
metadata-signature gate, and a bogus key simply makes `fetch-remote` fail.
It is a spam/DoS surface on the discovery *UX*, bounded by the rate/batch/
size caps above. Discovered entries are rendered as **unverified** in the
CLI and web UI until a fetch-remote against them actually succeeds.

### Two swarms become three

The architecture now runs three deliberately separate channels, each with
one job and one wire protocol owner:

1. **Archive swarm** — Hypercore replication (`corestore.replicate()`),
   metadata + blob blocks, global + per-category topics.
2. **Blob-transfer swarm** — request/serve individual blobs by content
   hash, pin announcements.
3. **Discovery swarm** — publisher gossip; the only channel that carries
   *who exists* information.
