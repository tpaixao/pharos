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

## Known limitation: no cross-publisher discovery

Joining a category topic (`--subscribe q-bio.GN`) does **not** let you
discover papers from publishers whose keys you don't already know. This was
checked directly against the code, not assumed:

- Hyperswarm topics (`categoryTopic()`, `swarm.js:41`) are a DHT rendezvous
  point only — joining one gets you raw `connection` events with other peers
  on that topic, nothing more.
- The connection handler calls `corestore.replicate(conn)` unconditionally.
  That call only syncs a core that **both sides already reference by its
  exact public key** — it does not enumerate or announce "here are all the
  cores I have" to a stranger. There is no discovery step in Corestore's
  replication protocol itself.
- `initReplicaStore(dataDir, beeKey, driveKey)` (`store.js:77`) is the only
  place a node's corestore learns a specific publisher's keys, and those
  keys must be passed in explicitly — there's nothing that fills them in
  automatically.
- A `src/replicate/protocol.js` module exists with a `pin_announce`-shaped
  message format that looks like it could be a discovery mechanism, but it
  is **dead code** — not `require()`'d anywhere. The pin-announce protocol
  that actually runs (`replicate.js`) only broadcasts content hashes you
  already pin, to peers you're already connected to; it carries no publisher
  keys and no "who else exists" information.

Net effect: two different publishers joining the exact same category topic
today will connect to each other over the DHT and do nothing useful with the
connection, because neither one's corestore references the other's keys.
The only way to learn a publisher's keys right now is out-of-band — they run
`pharos keys` (or you read them off the web UI's Node panel) and hand you
the `bee_key`/`drive_key` directly, or share a `fetch-remote` link with
those as query params.

## Sketch: a gossip extension for publisher discovery

A minimal, buildable design for closing that gap, following the same
patterns already used elsewhere in `src/replicate/`.

### Goal

Join `pharos-category-qbiogn` and, without knowing any keys in advance, end
up with a list of `{bee_key, drive_key, subjects}` for every publisher
(and gossiping replica) currently reachable on that topic — feeding
straight into the existing `fetch-remote` flow to actually sync one.

### Wire protocol

A third side-channel, same shape as `replicate.js`'s blob-transfer protocol
(length-prefixed JSON) or `protocol.js`'s magic-byte-prefixed variant so it
can share a connection with the archive swarm's category topic without
colliding with Hypercore replication noise:

```
Message types:
  { type: "publisher_announce",
    bee_key: "<hex>", drive_key: "<hex>",
    subjects: ["q-bio.GN"], announced_at: "<ISO8601>" }
  { type: "publisher_request", subject: "q-bio.GN" }   // optional pull mode
```

### Propagation (the "gossip" part)

Direct announce alone only tells you about peers you're *directly*
connected to — with a small swarm that's most of the value already, but the
epidemic/gossip property comes from **re-announcing what you've learned**,
not just what you own:

1. On connecting to a peer on a category topic, send a `publisher_announce`
   for yourself (if you're a publisher for that subject) **and** for every
   other publisher you've already learned about for that subject (if you're
   a replica or a relay).
2. On receiving a `publisher_announce`, upsert it into a local "known
   publishers" table (see below) and, the next time you connect to a *new*
   peer on that topic, forward it along. This is the same shape as the
   existing pin-announce fan-out, just one hop further — publishers you've
   never talked to propagate transitively through peers who have.
3. **Loop/flood prevention**: track `(bee_key, announced_at)` already seen
   and skip re-forwarding duplicates; cap how many announcements you forward
   per new connection (e.g. most-recently-seen N); apply a TTL so a stale
   announcement (publisher long offline) eventually stops propagating.

### Local storage

A small Hyperbee table (or even a flat JSON file, given the low write
volume) keyed `known_publisher:<bee_key>` → `{drive_key, subjects,
last_seen}`. Not part of the *replicated* Hyperbee — this is local-only
discovery-cache state, same category as `remote.json` today.

### Wiring it in

- New module `src/replicate/discovery.js`, parallel to `session.js`:
  `announceSelf(conn, knownPublishers)`, `handleDiscoveryMessage(msg,
  knownPublishers)`, `listKnownPublishers(subject)`.
- Attach it to the *category*-topic connections specifically inside
  `startArchiveSwarm`'s connection handler (`swarm.js`) — it should only run
  for category topics, not the global archive topic, or every node on the
  network would gossip about every subject.
- New CLI command: `pharos discover <subject> [--timeout 10000]` — joins
  the category topic, listens for `publisher_announce`s until the timeout,
  prints the resulting list (ready to paste into `fetch-remote`).
- New web endpoint: `GET /api/discover?subject=q-bio.GN` (same join-and-
  collect-with-timeout shape as `waitForArchiveSync` in `session.js`) +
  a "Discover publishers" button in the Node panel that lists results with
  a one-click "Fetch Remote" action per row.

### Trust considerations

Gossip is *unauthenticated by construction* — nothing stops a peer from
announcing a bogus `bee_key`, and forwarded announcements aren't re-signed
by whoever relays them. This doesn't threaten paper-level integrity (a
gossiped key still has to resolve to a real Hyperbee whose records still
have to pass the existing Ed25519 metadata-signature check to be trusted —
see Trust model above), but it is a spam/DoS surface on the *discovery* UX
itself: a malicious peer could flood fake announcements to bury real ones.
Worth treating discovered publishers as explicitly **unverified** in the UI
until a `fetch-remote` against them actually succeeds and yields
signature-valid records, and worth rate-limiting how many announcements a
single connection is allowed to send before being ignored.
