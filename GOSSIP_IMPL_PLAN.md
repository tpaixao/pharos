# Pharos: Gossip-based Publisher Discovery — Implementation Plan

Status: **implemented** (see "As-built deviations" §10 for where the
build diverged from this plan, and why).

Goal: close the "no cross-publisher discovery" gap documented in
ARCHITECTURE.md — let any node learn `{bee_key, drive_key, subjects}` for
publishers it has never heard of, without out-of-band key exchange, and
feed those keys straight into the existing `fetch-remote` flow.

This plan supersedes the "Sketch: a gossip extension for publisher
discovery" section that used to live at the bottom of ARCHITECTURE.md
(that section is now an as-built description). The sketch's *goal,
wire-message shape, and trust posture* are kept; three of its mechanical
choices were corrected here (D1–D3) based on how the code and
Hyperswarm v4 actually behave.

---

## 1. Investigation summary (what exists today)

Verified against the code, not assumed:

- **Two deliberately separate swarms** (`src/replicate/swarm.js`):
  1. *Archive swarm* — topic `pharos-archive-pharos-v1` (+ per-category
     topics via `categoryTopic()`); every connection is handed to
     `corestore.replicate(conn)` unconditionally.
  2. *Blob-transfer swarm* — topic `pharos-blob-transfer-pharos-v1`;
     connections are clean streams we own, running the length-prefixed
     JSON protocol in `src/replicate/replicate.js`
     (`request_blob` / `blob` / `error` / `pin_announce`).
  The separation exists because multiplexing JSON on a Hypercore
  replication stream corrupts the JSON framing (documented in the header
  of `replicate.js` — this was tried and failed).
- **`src/replicate/protocol.js` is dead code** — nothing in `src/` or
  `test/` requires it. It sketches a magic-byte (0x50) side channel that
  could share a connection with Hypercore replication. It was never
  wired up (see D1 for why it must stay dead).
- **No discovery step anywhere**: `corestore.replicate()` only syncs
  cores both sides already reference by exact public key;
  `initReplicaStore(dataDir, beeKey, driveKey)` (`src/core/store.js`) is
  the only place keys enter the system, and they must be passed in
  explicitly (CLI flags, web form, or `data/remote.json`).
- **Replica stores inherit publisher keys** (`initReplicaStore`): a
  replica opens `corestore.get({ key: publisherBeeKey })`, so
  `store.bee.core.key` IS the publisher's bee key and (when provided)
  `store.drive.key` is the publisher's drive key. The store is marked
  `isReplica: true`.
- **Orchestration is shared** (`src/replicate/session.js`):
  `startServing`, `waitForArchiveSync`, `pinWithSwarmFallback` are used
  by both CLI and web; `swarm.js` keeps module-level swarm singletons.
- **Local-only state precedent**: `data/remote.json` (written by
  `fetch-remote` and the web fetch-remote handler) is a local cache of
  a remote publisher's keys.
- **SQLite already exists** (`data/search.db`, opened in `initStore` /
  `initReplicaStore`) and is local-only (never replicated) — FTS5 today,
  but nothing stops a second non-FTS table.
- **Metadata signing already exists** (`src/core/signing.js`): Ed25519
  signatures over canonical identity fields, verified on replicated
  records. This is the real trust boundary for content — a gossiped key
  is only a *connection hint* until fetch + signature checks succeed.
- **Test patterns** (`test/test_replicate.js`): in-memory `Duplex`
  stream pairs simulate connections; no live DHT in tests. Web tests
  (`test/test_web_api.js`) start a real HTTP server on a fixed port.

### Hyperswarm v4 facts that constrain the design

- `info.topics` is **only populated for client-mode connections**.
  A server receiving an inbound connection cannot tell which topic it
  arrived on. (Documented in the Hyperswarm README/PeerInfo API.)
- One peer pair shares **one multiplexed connection** across all common
  topics.
- Consequence: "attach gossip to category-topic connections of the
  archive swarm" (the ARCHITECTURE.md sketch) is not implementable as
  stated — the receiving side can't reliably tell archive-topic
  connections from category-topic connections, and both are polluted by
  `corestore.replicate()` binary traffic anyway.

---

## 2. Design decisions

**D1 — Dedicated third swarm for discovery gossip; `protocol.js` stays dead.**
Riding the archive swarm (magic-byte framing) fails twice over:
(a) our gossip bytes written into a `corestore.replicate()` stream would
be parsed by the *remote* Hypercore protocol handler and corrupt the
replication channel — the remote side never agreed to skip magic-prefixed
bytes; (b) `protocol.js`'s reader assumes message/chunk alignment
(`if (chunk[0] !== MAGIC_BYTE) return` silently drops a JSON message
split across two chunks; a Hypercore binary chunk starting with 0x50 is
a 1-in-256 false positive that desyncs framing). Instead, mirror the
blob-transfer decision: a separate swarm whose connections we own
end-to-end, running length-prefixed JSON. Reuse the framing helpers in
`replicate.js` (extract, don't copy — see M1).

**D2 — Per-subject discovery topics, scoped by who-you-meet, filtered by message content.**
New topic family: `pharos-discovery-<subject>-pharos-v1` (derived with
the existing `topicFromName`, subject normalized exactly like
`categoryTopic()`). A node joins a discovery topic per subject it
publishes or subscribes to. Topics bound *which peers you connect to*;
the `subjects` field inside each announcement bounds *what you learn* —
so no connection→topic mapping is ever needed (which Hyperswarm cannot
provide server-side anyway). Cross-subject pollution on a shared
connection is harmless: receivers store only subjects they care about
(M3). Global-flood risk (the sketch's concern about "every node gossiping
about every subject") is bounded by the connection topology: you only
ever meet peers who share at least one subject interest with you.

**D3 — Local discovery cache in SQLite (`known_publishers` table), not a new Hyperbee, not a flat file.**
The sketch offered "a small Hyperbee table (or even a flat JSON file)".
A Hyperbee table would needlessly occupy a core in the corestore and
invite accidental replication; a flat JSON file has no atomic writes or
queryability. The existing `search.db` is local-only, already open, and
gives upserts/queries for free. (Conceptual note: search.db is today
"the FTS index" — this adds a second, clearly-commented local-only
table. If that coupling offends later, migrating to its own sqlite file
is a mechanical change.)

**D4 — Announcement semantics: "here are keys I can serve."**
A gossip entry is `{bee_key, drive_key, subjects, announced_at,
is_publisher}` where the keys are `store.bee.core.key` /
`store.drive.key`. Because replica stores open the publisher's cores by
key (Investigation §1), this one rule works for every role with zero
extra bookkeeping:
- a **publisher** announces its own cores;
- a **replica** (with drive key) announces its publisher's cores —
  which is *desirable*: replicas can serve read-only copies and keep
  discovery alive when the publisher is offline;
- a **replica without a drive key** has a fresh local drive — it must
  announce `drive_key: null` (bee-only), since its local drive key is
  useless to strangers. Edge case handled in `selfAnnounce()`.
- every node also relays entries it has learned (that's the gossip).

**D5 — Epidemic (push) gossip with pull for one-shot discovery.**
- *Push*: on every new discovery connection, send self + up to N
  recently-seen known entries; on receiving an entry that is new to us,
  upsert locally and forward to other connected discovery peers.
- *Pull*: a `request` message lets a client (the `pharos discover`
  command, web API) ask connected peers to resend their current lists —
  needed because a fresh client has no state to be pushed against
  except self-announce, and the one-shot CLI flow shouldn't have to
  wait for peers' re-announce timers.

**D6 — Unauthenticated-by-construction, verified-on-use.**
Gossip entries are hints, not claims of trust. Nothing stops a peer
announcing bogus keys — but a bogus key must resolve to a real Hyperbee
whose records must still pass the existing Ed25519 metadata-signature
gate to matter, and `fetch-remote` against a dead key simply fails.
UI/CLI must render discovered entries as **unverified** until a
fetch-remote succeeds. Abuse resistance is purely resource-capping
(§5). Optional future hardening: sign self-announcements with the
drive keypair (reuse `signing.js` patterns) to stop *forging someone
else's* announce — does not stop sybils, so it's cosmetic; deferred.

**D7 — The envelope is versioned and extensible.**
Every message carries `v: 1`. Unknown fields are ignored. This keeps
the door open for the post-MVP "distributed gossip-based search"
roadmap item reusing the same channel.

---

## 3. Wire protocol

Transport: Hyperswarm connection on a discovery topic; framing is the
existing 4-byte big-endian length prefix + UTF-8 JSON (`sendMessage` /
`readMessages` from `replicate.js`, extracted to a shared module).
Message size capped at `MAX_MSG_BYTES` (the current framing has no
length cap — see R2).

```
Announce (push; batched):
{ "v": 1,
  "type": "announce",
  "publishers": [
    { "bee_key":     "<64 hex>",
      "drive_key":   "<64 hex>" | null,
      "subjects":    ["q-bio.GN", ...],       // subset of VALID_SUBJECTS
      "announced_at": "<ISO8601, originator's clock>",
      "is_publisher": true|false,
      "hops": 0..HOP_MAX                      // set to 0 by originator
    }, ...                                     // ≤ ANNOUNCE_BATCH_MAX
  ] }

Request (pull; sent on connect by stateless clients):
{ "v": 1, "type": "request", "subjects": ["q-bio.GN"] }
  → receiver replies with an announce batch filtered to those subjects
```

Validation rules (shared helper, unit-tested):
- `bee_key`, `drive_key` match `/^[0-9a-f]{64}$/i` (drive_key nullable)
- every `subjects[i]` ∈ `VALID_SUBJECTS`, array ≤ 12, deduped
- `announced_at` parses as a date within ±`CLOCK_SKEW_TOLERANCE` of now
- `publishers.length` ≤ `ANNOUNCE_BATCH_MAX`
- entries where `bee_key` == our own bee key are dropped (self-echo)
- invalid message → log + ignore (never throw on peer input)

---

## 4. Gossip engine semantics (`src/replicate/discovery.js`)

State, all in-process except the SQLite table:
- `seen`: FIFO-capped Map keyed `${bee_key}:${announced_at}` for
  loop/flood prevention. Relays must never modify `announced_at` — its
  stability across paths is what makes dedup work. A publisher's
  periodic re-announce (new `announced_at`) is what refreshes liveness.
- `rate`: WeakMap `conn → {count, windowStart}` for per-connection
  message rate limiting.
- SQLite `known_publishers` table (M3) is the durable upsert target.

Flows:
1. **On connection** (either side): send `announce` with self entry +
   up to `FORWARD_BATCH_MAX` most-recently-seen known entries; stateless
   discoverers (CLI/web) instead send `request`.
2. **On announce received**: validate batch → for each entry: if in
   `seen`, skip; else if a row with same `bee_key` exists with newer-or-
   equal `announced_at`, skip; else upsert SQLite (`last_seen` = local
   clock) and mark for forwarding.
3. **Forward**: send marked entries (bumped `hops`; drop if `hops` >
   `HOP_MAX`) to all other connected discovery peers, batched.
4. **On request received**: reply with known entries filtered to the
   requested subjects, capped.
5. **Re-announce loop** (while serving): every `REANNOUNCE_INTERVAL_MS`,
   re-emit self entry with fresh `announced_at` to all connected peers.
   Timer must be `unref()`'d like the rest of the shutdown story.
6. **Prune** (on engine start + hourly): delete rows with
   `announced_at` older than `TTL_DAYS`.

### Constants (defaults; all tunable via `opts`)

| Constant | Default | Purpose |
|---|---|---|
| `ANNOUNCE_BATCH_MAX` | 64 | entries per announce message |
| `FORWARD_BATCH_MAX` | 32 | entries forwarded per connection on connect |
| `KNOWN_TABLE_MAX` | 1000 | SQLite rows; LRU-evict by `last_seen` |
| `SEEN_SET_MAX` | 4096 | loop-prevention map size |
| `HOP_MAX` | 3 | relay depth cap |
| `TTL_DAYS` | 7 | entry expiry (originator re-announces every 10 min while alive) |
| `REANNOUNCE_INTERVAL_MS` | 600_000 | liveness re-announce |
| `MAX_MSG_BYTES` | 65_536 | frame cap (reader destroys conn on violation) |
| `MSG_RATE_MAX` | 10 msgs / 5s per connection | flood control (ignore + warn) |
| `CLOCK_SKEW_TOLERANCE_MS` | 600_000 | sanity window for `announced_at` |

---

## 5. Module-by-module changes

**M1 — `src/replicate/framing.js` (new, extraction).**
Move `sendMessage` / `readMessages` out of `replicate.js` verbatim, add
optional `maxBytes` cap to `readMessages` (destroy stream on violation),
and have `replicate.js` re-export them. Zero behavior change to the
blob protocol; gossip uses the same framing from the new module.

**M2 — `src/replicate/discovery.js` (new, the core).**
Pure-ish engine, no Hyperswarm import (connections injected — keeps the
test pattern of fake `Duplex` pairs):
- `createDiscoveryEngine({ store, subjects, opts })` → `{ handleConnection(conn, info), handleDisconnect(conn), announce, selfEntry(), listKnown(subject?), startReannounceLoop(), prune(), stop() }`
- `selfEntry()` — builds D4 self-announce from `store` (keys, subjects
  from local bee scan ∪ subscribe list, `drive_key: null` when replica
  without publisher drive key)
- exported helpers for tests: `validateAnnounceBatch(msg, now)`,
  `entryKey(entry)`, `shouldUpsert(existing, incoming)`
- SQLite access guarded behind `store.db` (already in the store
  instance; create table `IF NOT EXISTS` on engine init)

**M3 — `src/core/store.js` (minor).**
Add `CREATE TABLE IF NOT EXISTS known_publishers (...)` next to the FTS5
table in both `initStore` and `initReplicaStore` (schema below). No
other store changes.

```sql
CREATE TABLE IF NOT EXISTS known_publishers (
  bee_key      TEXT PRIMARY KEY,
  drive_key    TEXT,
  subjects     TEXT NOT NULL,        -- JSON array
  is_publisher INTEGER NOT NULL DEFAULT 0,
  announced_at TEXT NOT NULL,       -- originator clock (dedup/TTL)
  first_seen   TEXT NOT NULL,       -- local clock
  last_seen    TEXT NOT NULL        -- local clock (updated on re-see)
);
CREATE INDEX IF NOT EXISTS idx_known_pub_last_seen
  ON known_publishers (last_seen);
```

**M4 — `src/replicate/swarm.js` (additive).**
- `discoveryTopic(subject)` — `topicFromName('pharos-discovery-' + normalized + '-' + PHAROS_VERSION)`
- `startDiscoverySwarm(onConnection, { subjects, server, client })` —
  one Hyperswarm instance, joins one topic per subject; module-level
  `discoverySwarmInstance` mirroring the existing singleton pattern;
  `stopAll()` extended to stop it. Connections here are *never* passed
  to `corestore.replicate()`.

**M5 — `src/replicate/session.js` (orchestration, shared by CLI+web).**
- `startDiscovery(store, { subjects, subscribe })` — resolves subjects
  (local papers' subjects ∪ subscribe), starts swarm + engine, wires
  `conn → engine.handleConnection`, starts re-announce loop. Returns
  `{ swarm, engine, stop() }`.
- `discoverPublishers(subject, { timeoutMs = 10_000 })` — client-only
  (`server: false`) join of `discoveryTopic(subject)`, send `request`,
  collect announcements until timeout, persist + return the list.
  Same shape/lifetime conventions as `waitForArchiveSync`.
- `startServing(...)` — extended to also launch discovery (opt-out flag
  `discovery: false`), so `pharos serve` and the web server's embedded
  replication gossip by default.

**M6 — `src/cli/cli.js`.**
- New command: `pharos discover <subject> [--timeout 10000] [--no-save]`
  — prints a table (bee_key, drive_key, subjects, is_publisher,
  last_seen, `unverified` marker), persists to `known_publishers` unless
  `--no-save`. Output formatted so keys are copy-pasteable into
  `fetch-remote --bee-key ... --drive-key ...`.
- `serve` — gains `--no-discovery` flag (default on).

**M7 — `src/web/server.js`.**
- `GET /api/discover?subject=X&timeout_ms=10000` — runs
  `discoverPublishers` (timeout clamped ≤ 30s); returns
  `{ publishers: [...] }` with `verified: false` on every row.
- `GET /api/publishers` — lists the cached `known_publishers` table
  (`?subject=` filter).
- Node panel: new "Discovered Publishers" section — subject picker +
  Discover button, results table, and a one-click "Fetch Remote" per row
  that prefills the existing `fr-bee-key` / `fr-drive-key` inputs (reuses
  `doFetchRemote()`).
- `startServer({ ..., discovery })` option plumbed to `startServing`.

**M8 — `src/lib.js`** — export `discoverPublishers`, `listKnownPublishers`.

**M9 — docs.** README (commands, API table, project structure, test
count), ARCHITECTURE.md (replace "Known limitation" + "Sketch" sections
with the as-built design once shipped), IMPLEMENTATION.md progress entry.
`protocol.js` finally deleted (it's the misleading one; framing lives in
`framing.js`).

---

## 6. Trust model & abuse resistance

- Discovery results are **unverified hints**; the existing gates are
  unchanged: blake2b content hash on every blob fetch, Ed25519
  metadata signature verification on replicated records, ORCID identity
  claims inside signed records. Gossip only ever influences *which keys
  you try*, never what you accept.
- Sybil/flood: `MSG_RATE_MAX` per connection, `ANNOUNCE_BATCH_MAX` per
  message, `KNOWN_TABLE_MAX` LRU on storage, `SEEN_SET_MAX` on the dedup
  map, `MAX_MSG_BYTES` frame cap, `HOP_MAX` relay depth. A flooding
  peer's messages are dropped past the rate; its entries occupy at most
  `KNOWN_TABLE_MAX` rows alongside everyone else's.
- Eclipse-style burial of real announcements is theoretically possible
  (fakes outnumbering reals) but bounded: entries compete on
  `last_seen`, not on count per se, and verification happens at
  fetch-remote. UI keeps the `unverified` marker honest.
- Nothing in the discovery path writes to the *replicated* Hyperbee —
  discovery state is strictly local (SQLite table + in-process maps).

---

## 7. Test plan (`test/test_discovery.js`, + web API additions)

Follow the existing fake-stream-pair pattern from `test_replicate.js`:

1. **Framing**: announce/request round-trip over a `Duplex` pair via the
   extracted `framing.js`; oversize frame destroys the stream.
2. **Validation**: malformed keys, invalid subject, oversized batch,
   stale/future `announced_at`, self-echo, all rejected/ignored without
   throwing.
3. **Dedup & ordering**: same `(bee_key, announced_at)` never
   re-forwarded; newer `announced_at` replaces older row; older never
   overwrites newer.
4. **TTL prune**: stale rows deleted on `prune()`.
5. **Relay/fan-out (the actual gossip property)**: three engines wired
   with stream pairs A↔B, B↔C (C has no direct link to A). A announces;
   B learns; C receives the forwarded entry; a looped-back copy at A is
   ignored. `hops` increments and stops at `HOP_MAX`.
6. **Rate limit**: 50 rapid messages on one connection → extras ignored,
   engine state intact.
7. **Persistence**: engine against a real store dir, insert entries,
   recreate engine on same dir, entries survive.
8. **Replica announce semantics**: `initReplicaStore` → `selfEntry()`
   carries the *publisher's* bee/drive keys; without drive key →
   `drive_key: null`.
9. **`request` pull**: stateless client sends request, receives filtered
   batch.
10. **Web API**: `/api/discover` and `/api/publishers` shape + subject
    filtering (pattern from `test_web_api.js`).

Note: tests must not require live DHT — swarm-level wiring is exercised
by the session-level functions with mocked connections where needed
(same compromise the current suite makes for replication).

---

## 8. Build order (phased, weekend-scale like the rest of the project)

**Phase A — engine, storage, tests (no swarm).**
M1 framing extraction (blob protocol keeps passing its tests unchanged),
M3 table, M2 discovery.js, tests 1–4, 7, 9. Ship state: gossip logic
fully proven against fake streams.

**Phase B — swarm + session + CLI.**
M4, M5, M6; `serve` integration (`--no-discovery`); tests 5, 6, 8.
Ship state: two real nodes running `pharos serve --subscribe` (plus a
relaying third) discover each other's keys end-to-end; `pharos discover
q-bio.GN` prints them; `fetch-remote` closes the loop.

**Phase C — web.**
M7, M8, test 10. Ship state: one-click discover → fetch-remote in the
Node panel.

**Phase D — hardening + docs.**
M9, constants review after a live two-node soak, `protocol.js` deletion,
ARCHITECTURE.md rewrite of the limitation/sketch sections.

---

## 9. Open questions & deferred extensions

- **Announce signatures** (D6): cheap to add via `signing.js`, but
  doesn't stop sybils — cosmetic until reputation exists. Deferred.
  *(Still open as of the build.)*
- **Cross-subject forwarding policy**: MVP forwards everything known
  (capped) and filters on receipt. If traffic ever warrants, add
  "interests" to messages so senders pre-filter per receiver.
  *(Resolved at build time in the other direction — receivers filter via
  an interests set; see deviations §10.)*
- **Interest graph bridging**: transitivity only flows through peers
  sharing at least one subject (D2). A node subscribed to *everything*
  becomes a discovery hub — emergent, fine at MVP scale, worth revisiting
  if category silos feel too isolated.
- **Gossip-based distributed search** (post-MVP roadmap): the `request`
   message is the natural seed — extend its payload with a query and
   route responses over the same channel. The versioned envelope (D7)
   is deliberate forward-compatibility for this.
- **Pre-existing issue worth fixing in passing (R2)**: `readMessages` in
  `replicate.js` has no length cap — a peer sending a huge length prefix
  causes unbounded buffering. The `framing.js` extraction adds
  `maxBytes`; wire the blob swarm's reader to it too.
  *(Fixed at build time: blob framing now uses the capped framing.js
  reader with a 256 MiB ceiling.)*
- **Auto-subscribe via discovered publishers**: once keys are known,
  auto-joining category topics / auto-pinning could make replication
  zero-touch — separate feature, but this is its prerequisite.

---

## 10. As-built deviations from this plan

The implementation followed the plan's phases (A–D) and decisions
(D1–D7); the deviations below are simplifications or additions
discovered during the build:

1. **Interest filtering moved into the engine** (strengthens D2). The
   plan said receivers "store only subjects they care about" but left
   the mechanism implicit; the first pull-only test exposed that greet
   pushes everything the sender knows. Engines now take an explicit
   `interests` set — entries outside it are neither stored nor relayed.
   `startDiscovery` derives interests as capabilities ∪ subscriptions;
   `discoverPublishers` uses the queried subject.
2. **`--no-save` on `pharos discover` was dropped.** The cache is
   LRU-capped (1000 rows) and subject-filtered at read time, so
   "pollution" is bounded and self-cleaning; entries for other subjects
   are actually useful for future queries. Simpler to always persist.
3. **`pharos publishers [subject]` added** beyond the plan: a zero-network
   listing of the local gossip cache (CLI counterpart of
   `GET /api/publishers`).
4. **`protocol.js` deleted** as planned (M9) — and its framing lesson is
   now captured in `framing.js`'s header, which also fixed the
   pre-existing unbounded-buffer issue in the blob protocol's reader (R2).
5. **Discovery swarms are not module singletons** (deviation from M4's
   "mirror the existing singleton pattern"): a serving node runs a
   long-lived discovery swarm while `pharos discover` / `GET /api/discover`
   start transient client-only ones in the same process, so swarm.js
   tracks them in a Set that `stopAll()` drains. The engine's timers are
   stopped via the session handle (`serve` shutdown, web
   `stopEmbeddedSwarms`) rather than by `stopAll()` alone.
6. **Self-announce subjects are capabilities only** — papers in the local
   bee — never `--subscribe` interests. Interests affect which discovery
   topics a node joins; capabilities affect what it announces. A pure
   discoverer with no papers announces nothing and only pulls.
7. Verified end-to-end over the live DHT at build time: publisher `serve`
   (gossip on) → fresh node `discover` (direct hit, hops 0) → `fetch-remote`
   with the gossiped keys → hash-verified PDF. Total suite: 135 tests
   (24 new: 21 in `test_discovery.js`, 3 web-API).