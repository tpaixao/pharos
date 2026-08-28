# P2P Preprint Archive: Scoping Document

## Codename: Pharos

Named after the Lighthouse of Alexandria, which stood for 1,500 years as a beacon guiding scholars to the world's greatest library. The archive is a network of beacons, each guiding researchers to preserved preprints, with no single library to burn.

## Scope: Preprints Only (MVP)

> **Update:** The MVP was narrowed during implementation. External ingestion (arXiv/bioRxiv) was dropped to focus on proving the core thesis: a full publish-to-read cycle without a central server. See IMPLEMENTATION.md for rationale.

### In scope (MVP as built)
- Author-direct publishing via CLI and web UI upload
- ORCID-verified identity (OAuth 2.0, `/authenticate` scope)
- Content-addressed storage (BLAKE2b-256) via Hyperdrive v13
- Distributed metadata index via Hyperbee (replicates to all peers)
- Local full-text search via SQLite FTS5 (Node built-in `node:sqlite`)
- P2P replication via Hyperswarm (metadata + blob transfer)
- Versioning via `previous_version_hash` links
- Category-based auto-pinning and replication health tracking
- Web UI: browse, search, read PDFs, upload, view versions
- Storage management: disk usage reporting, eviction of unpinned papers

### Post-MVP (deferred)
- External ingestion from arXiv/bioRxiv (bootstrapping mechanism, not core value)
- Tiered key management (institutional attestation, passkeys, sovereign keys)
- Institutional pinning as first-class replication mode
- Bidirectional ORCID linking (write back to ORCID profile)
- Citation graph extraction and content-addressed linking
- Distributed gossip-based search across peers
- Errata, retractions, corrections as appends (never deletions)
- Peer review (on-archive review as appends)

### Out of scope (entire project)
- Published journal articles (copyright, licensing barriers)
- Datasets (different storage profile, different metadata standards)
- Government datasets (Data Rescue Project is handling this; complementary, not competing)

### Original scope (superseded by MVP as built above)
The following was the original ingestion-centric scope, preserved for historical context.

- arXiv preprints (metadata + full text PDF + LaTeX source when available)
- bioRxiv preprints (metadata + full text PDF)
- Optional: ChemRxiv, SocArXiv, Preprints.org (same architecture, additional ingestion sources)
- Author-signed publications, institution co-signed publications
- Citation graph as native protocol data
- Errata, retractions, corrections as appends (never deletions)

---

## Architecture

### Layer 1: Ingestion

**arXiv ingestion:**
- OAI-PMH interface for incremental metadata harvesting (arXiv supports this)
- Full-text PDF download via arXiv API (rate-limited; respect delays)
- LaTeX source when available (arXiv provides source tarballs for many papers)
- Ingestion daemon runs on each archive node; nodes can divide subject categories to avoid duplicate work
- Metadata stored as structured JSON: `{arxiv_id, title, authors, abstract, subjects, doi, comments, license, timestamp, source_url}`

**bioRxiv ingestion:**
- bioRxiv API for metadata (already used in the bioRxiv digest pipeline)
- Full-text PDF via direct URL (Cloudflare-protected; use the cascading fallback approach from the bioRxiv paper-fetch skill)
- Ingestion daemon reuses the existing bioRxiv digest fetcher logic
- Metadata: `{biorxiv_id, title, authors, abstract, category, doi, posted_date, version, source_url}`

**Ingestion coordination:**
- Nodes announce which subject categories they are ingesting on a shared Hyperswarm topic
- Two nodes ingesting the same category is fine (redundancy); they deduplicate by content hash
- The ingestion Hypercore is a per-node log of what has been fetched; other nodes can request specific papers from peers if they missed them

### Layer 2: Storage

**Content model:**
- Each preprint is a blob: `{content_hash, type (pdf|source|metadata), paper_id, version, signed_by, bytes}`
- Blobs stored in a Hyperdrive (file system over Hypercore): `/papers/{paper_id}/{version}/{metadata.json, fulltext.pdf, source.tar.gz}`
- Content-addressed: the blob key is the BLAKE2b hash; the same content in two nodes is deduplicated
- The metadata index maps paper_id -> content_hash -> Hyperdrive key

**Metadata index:**
- A Hyperbee (key-value store over Hypercore) mapping:
  - `paper_id -> {content_hash, hyperdrive_key, first_seen, versions, signed_by}`
  - `content_hash -> {paper_id, type, size, replicated_by}`
  - `doi -> paper_id` (for DOI resolution)
- The index is small (pointers only); all peers replicate the index
- Content is replicated selectively: each peer decides what to pin

**Versioning:**
- Preprints have versions (arXiv v1, v2; bioRxiv v1-v4). Each version is a separate blob.
- The metadata index tracks all versions; the latest is the default
- Errata and retractions are appends to a per-paper correction Hypercore: `{paper_id, type: erratum|retraction|correction, content, signed_by, timestamp}`
- The original paper is never modified; corrections are new appends referencing the original

### Layer 3: Replication

**Replication modes:**
- **Full node:** replicates everything (for well-resourced institutions). Storage: ~TB scale for all arXiv + bioRxiv full text.
- **Selective node:** replicates specific subject categories (e.g., q-bio only). Storage: ~GB scale.
- **Institutional pinning node:** pins all content from affiliated authors, past and present. Storage scales with institutional output. Institutions are first-class citizens in the replication layer, not passive storage. An institution that pins its researchers' output gains a verifiable, replicated record of its research portfolio that survives server migrations, budget cuts, and vendor lock-in. Institutional pinners announce their ROR ID on the archive topic; other nodes can verify institutional coverage.
- **Pinning node:** pins specific high-value or at-risk papers explicitly. Storage: user-defined.
- **Index-only node:** replicates only the metadata index, fetches content on demand from peers. Storage: ~MB scale. This is the lightweight client.

**Tiered replication model (cold-start protection):**
Not all authors have an institutional pinner. Independent researchers, researchers at under-resourced institutions, and researchers in politically unstable environments are the exact people Pharos should protect. The architecture supports a tiered model: institutional pinning as the primary layer, community pinning (other researchers, libraries, NGOs) as a fallback, and self-pinning as the floor. No one is excluded because their institution will not or cannot participate.

**Replication protocol:**
- Each node announces what it pins on a shared Hyperswarm topic (the "archive topic")
- When a node needs content it does not have, it queries peers via the index, then requests the blob
- Replication health: the index records `replicated_by` (list of peers pinning each paper). A paper with 1 replica is at risk; the system flags papers below a threshold (e.g., 3 replicas) for additional pinning.
- Anti-entropy: periodic Merkle-tree comparison between peers ensures consistency. Hypercore handles this natively (replication is based on Merkle trees).

### Layer 4: Verification

**Content integrity:**
- Every blob is content-addressed (BLAKE2b hash). If a peer serves a blob, the hash is verified on receipt. Mismatch = corrupted or tampered data, rejected.
- Hypercore replication itself is cryptographically verified (Ed25519 signatures on every append).

**Author signing:**
- Authors sign their preprints with an Ed25519 key. The signature is stored in the metadata.
- Author key publication: authors register their public key on their identity core (see Layer 6), creating a verifiable identity chain.
- Institutions can co-sign, vouching for the author's affiliation. This is optional but creates a trust gradient: unsigned preprints are available but unverified; signed preprints have cryptographic provenance; institution-co-signed preprints have institutional backing.

**Citation verification:**
- When a paper cites another paper in the archive, the citation includes the content hash of the cited paper
- If the cited paper is later modified (new version), the citation still resolves to the exact version cited (content addressing)
- This eliminates link rot: citations are permanent, verifiable pointers, not URLs

### Layer 5: Discovery

**Hyperswarm topics:**
- Global archive topic: `hash("pharos-archive-v1")` for general discovery
- Per-category topics: `hash("pharos-qbio")`, `hash("pharos-csai")` etc., for category-specific peer discovery
- Private topics: for sensitive content (at-risk papers), a pre-shared key derives a private topic

**Search:**
- MVP: no global search. Each node maintains a local SQLite FTS5 index over replicated metadata and full text.
- Distributed search (future): query peers via a search protocol; peers respond with results from their local indexes. This is a gossip-based search, not a centralized search engine.
- The metadata index (replicated by all) supports DOI lookup, paper_id lookup, and author lookup across the entire archive, even without full-text search.

### Layer 6: Author Identity and Key Infrastructure

The core design principle: **separate identity from affiliation.** Identity is persistent; affiliation is temporary. An author who changes institutions five times still has one continuous, verifiable identity core that any third party can audit from genesis to head.

**Identity cores:**
Each author has an identity core (a Hypercore) that serves as a verifiable append-only log containing:
- Public key registrations and rotations (each rotation signed by the previous key, creating a chain)
- Institutional affiliations with time bounds (start date, end date, ROR ID for the institution)
- Pointers to their preprint cores (discovery keys)
- Recovery set designations (trusted peers and/or institutions who can co-sign key recovery)

The identity core's discovery key is derived from a persistent identifier. ORCID is the obvious choice: it already survives institutional moves, is widely adopted, and is institution-independent. ORCID becomes the human-facing handle; the Hypercore is the cryptographic backing.

**Affiliation entries:**
```
{type: "affiliation_start", ror_id: "https://ror.org/04jsn6108", institution_name: "GIMM", start: "2024-09-01", signed_by: <author_key>}
{type: "affiliation_end", ror_id: "https://ror.org/04jsn6108", end: "2026-08-15", signed_by: <author_key>}
```

Institutions can counter-sign affiliation entries, vouching that the author is genuinely affiliated. This creates a bidirectional trust claim: the author asserts affiliation, the institution confirms it.

**Institution changes:**
When an author moves from GIMM to EMBL:
1. The author appends an `affiliation_end` entry to their identity core (signed by their current key)
2. They append a new `affiliation_start` entry for EMBL
3. GIMM's institutional pinner may stop replicating *new* content from that author, but already-pinned content stays in the network (other pinners, EMBL's pinner, the author's own node)
4. If the author rotates keys for security reasons, the rotation is appended and signed by the old key, so the chain remains verifiable

The author's signing key belongs to the author, not the institution. Institutions pin content; they do not own identity. This ensures that institutional disputes, departures, or closures do not invalidate an author's body of work.

**Key rotation (normal):**
```
{type: "key_rotation", old_key: K1_pub, new_key: K2_pub, reason: "routine", timestamp: "...", signed_by: K1_priv}
```
Anyone can verify K1 signed the rotation. The chain is unbroken.

**Social trust key recovery:**

If an author loses their private key (device loss, disk failure, theft), the identity chain breaks unless there is a recovery mechanism. Pharos uses a threshold social recovery scheme modeled on smart contract wallet recovery (e.g., Argent on Ethereum) but applied to academic identity.

*Setup:*
At identity core creation (or any key rotation), the author designates a recovery set: N trusted peers, collaborators, or institutions, each identified by their own public key. The author specifies a threshold M (e.g., 3-of-5). The recovery set is recorded in the identity core:
```
{type: "recovery_set", members: [pubkey1, pubkey2, pubkey3, pubkey4, pubkey5], threshold: 3, signed_by: <author_key>}
```

*Recovery rotation (key lost):*
When the author loses their key, M-of-N designated recoverers co-sign a recovery rotation entry:
```
{type: "recovery_rotation", old_key: K1_pub, new_key: K2_pub, reason: "device_loss", timestamp: "...", 
 signatures: [sig_r1, sig_r3, sig_r5], signers: [pubkey1, pubkey3, pubkey5]}
```
Anyone can verify that M-of-N designated recoverers signed the rotation. The chain continues from K2. The old key is cryptographically invalidated; any future preprints signed by K1 are rejected by verification.

*Recovery set updates:*
The author can add or remove recoverers at any time using a normal key rotation append (signed by the current key). This allows the author to adapt their recovery set as collaborations change.

*Institutional recoverers:*
Institutions are natural recoverers. They have stable key management (IT departments, key escrow, hardware security modules), survive personnel changes, and have a vested interest in their researchers maintaining access to their scholarly identity. An institution designated as a recoverer provides the same stability it provides as a pinner: long-term organizational continuity that individual researchers cannot guarantee on their own.

*Edge cases and tradeoffs:*
- **Collusion risk:** M colluding recoverers could hijack an identity by signing an unauthorized recovery rotation. Mitigation: the recovery is visible on the public append-only log, so the author and community can detect it. However, the author cannot cryptographically dispute it without a key. This is a fundamental trust assumption: social recovery trades cryptographic certainty for practical key survivability. The threshold should be set high enough to make collusion impractical (e.g., 3-of-5, not 1-of-2).
- **Recoverer key loss:** If a recoverer loses their own key, the author should update their recovery set (signed by current key). If both the author and a recoverer lose keys simultaneously, the effective threshold shrinks. Mitigation: institutions as recoverers provide redundant stability; an author should include at least one institutional recoverer.
- **Dead recovery set:** If enough recoverers leave the network or lose keys that M-of-N can no longer be reached, the author is locked out of their identity core. This is the catastrophic failure mode. Mitigation: periodic recovery drills (authors test-rotate with their recovery set), and institutional recoverers that maintain key continuity across personnel turnover.
- **No silent recovery:** Recovery rotations are distinguishable from normal key rotations (different entry type, multiple signatures). Third parties can see that a recovery occurred and scrutinize it if warranted. Transparency is the audit mechanism.

**Proposal: Tiered key management with upgrade path**

The social recovery scheme above assumes the author already has a key to designate recoverers with. This is circular for someone who has never managed a cryptographic key. Researchers, including biologists, are notoriously bad at key and password management. The default experience must require zero key management, with a graduated path to full sovereignty.

*Tier 1: Institutional attestation (zero key management)*

The author never touches cryptographic material. They authenticate to their institution via SSO (SAML/OIDC, already deployed at most universities through eduGAIN, the same "Login with your institution" flow researchers use daily). The institution holds a key and signs preprints on the author's behalf. The author's identity core is created and maintained by the institution as a托管 service.

This is not a compromise; it is how most researchers already interact with ORCID. The institutional login IS the key infrastructure they already use without knowing it. The tradeoff is real: if the institution closes or the author has a falling out, they lose signing authority. But for the 90% case (researcher at a stable institution who just wants their preprints signed), this is frictionless.

*Tier 2: Passkey-based identity (device-backed, biometric)*

Instead of raw Ed25519 keys that the author must manage, use WebAuthn/FIDO2 passkeys. The author generates a passkey on their phone or laptop (the same flow as adding a passkey to Google or Apple). The private key lives in the device's secure enclave; the author never sees raw key material. Signing a preprint is unlocked with FaceID or fingerprint, something they do dozens of times a day already.

Crucially, passkeys support cloud sync (Apple Keychain, Google Password Manager). If the author loses their phone, the passkey syncs to their new device. This solves the key loss problem at the device level without requiring social recovery at all for the common case. The social recovery scheme becomes the fallback for when cloud sync fails, the author uses a non-mainstream platform, or they want institutional redundancy.

The institution counter-signs the passkey registration, anchoring the device key to the institutional identity. This creates a bridge: the author graduates from institutional attestation to device-backed signing without breaking their identity chain.

*Tier 3: Full sovereign keys (power users)*

Raw Ed25519 keys, manual rotation, social recovery as designed above. For the minority who want full control: independent researchers, dissident scientists, people who do not trust their institution or cloud providers. This is the escape hatch.

*Upgrade path*

- Tier 1 to Tier 2: the author generates a passkey, authenticated through their institutional SSO. The institution signs a key-registration append to the identity core, delegating signing authority to the device key. From that point, the author can sign preprints with their passkey without institutional involvement.
- Tier 2 to Tier 3: the author generates a raw Ed25519 key and rotates to it using a normal key-rotation append signed by their passkey. They then set up their social recovery set. Full sovereignty, no institution required.
- Downgrade is also possible: an author at Tier 3 can delegate back to Tier 1 or Tier 2 if they tire of key management. A key-rotation append signs authority to an institutional key or a new passkey.

*Why this works for biologists*

The key insight is graduated sovereignty. Most researchers do not want to be cryptographers. They want their work signed, preserved, and attributable, and they want it to survive institutional moves. Tier 1 gives them that with zero new habits. Tier 2 gives them device-level independence using biometrics they already use. Tier 3 exists for the cases where institutional trust or cloud trust is insufficient, and it should, but it should not be the default.

The social recovery mechanism remains important, but its role changes: it is the safety net for Tier 2 users when cloud sync fails, and the primary mechanism for Tier 3 users. It is not the front door.

*Implementation note*

Passkeys produce ECDSA P-256 signatures (WebAuthn standard), not Ed25519. The identity core must accept multiple key types. A key-registration entry includes a `key_type` field (`ed25519`, `webauthn_p256`, `institutional_delegated`). Verification logic dispatches on key type. This is a modest complexity increase for a major usability gain. Alternatively, the signing layer can wrap the passkey authentication in a service that produces Ed25519 signatures on behalf of the author, keeping the core protocol Ed25519-only; this adds a trusted service component but simplifies the verification layer.

*Open questions*

- How does Tier 1 work for researchers at institutions without eduGAIN/SSO? Fallback: ORCID OAuth as an identity provider (ORCID already supports OAuth, is institution-independent, and most researchers already have an ORCID).
- What happens when an institution at Tier 1 refuses to release an author's identity core on departure? The author cannot cryptographically claim their own identity without a key. Mitigation: the upgrade path (Tier 1 to Tier 2) should be encouraged proactively, not only on departure. Institutions that offer Tier 1 should also facilitate Tier 2 upgrade as a standard onboarding step.
- Should there be a Tier 0 (no signing at all)? Yes. Unsigned preprints are already part of the archive (ingested from arXiv/bioRxiv). The trust gradient is: unsigned (available, no provenance) → institutionally attested (Tier 1) → device-signed (Tier 2) → sovereign-signed (Tier 3). Each step adds independence, not access.

**Proposal: ORCID integration**

ORCID touches Pharos at five integration points, each solving a different problem. ORCID is the convenient default for discovery and bootstrap, not a load-bearing dependency. The system works without it; it works better with it.

*1. Discovery handle*

The ORCID iD is the persistent identifier from which the identity core is discoverable. A global Pharos registry core (a replicated Hyperbee) maps ORCID iD to identity core discovery key. All nodes replicate this index. To find an author's identity core, a peer looks up the ORCID iD in the registry, obtains the discovery key, then connects via Hyperswarm. The discovery key is not derived directly from the ORCID iD because Hypercore discovery keys are derived from the core's public key and cannot be arbitrarily chosen; the registry provides the indirection.

*2. Bootstrap identity verification*

ORCID supports OAuth 2.0 / OpenID Connect. The onboarding flow for a new researcher:

1. "Sign in with ORCID" on a Pharos node
2. ORCID OAuth returns a verified ORCID iD, name, and (if scoped) affiliation data
3. Pharos creates the identity core (generates a keypair)
4. First entry: identity registration, signed by the provisioned key, includes the ORCID iD and the OAuth transaction reference as proof of ORCID control
5. Registry core gets an append: `orcid_id -> discovery_key`

This proves the researcher controls the ORCID iD without Pharos ever touching ORCID credentials. ORCID tokens do not expire by default, so this is a one-time bootstrap.

*3. Affiliation import from ORCID profiles*

ORCID profiles can contain employment and education records with institution names and, increasingly, ROR IDs. At bootstrap, these can be imported as initial affiliation entries in the identity core. They are pending institutional counter-signature until the institution confirms them. This bootstraps the affiliation history without the author manually re-entering everything, which is the kind of friction that kills adoption.

*4. Bidirectional linking*

- Pharos to ORCID: the author adds a "works" or "external identifier" entry to their ORCID profile pointing to their Pharos identity core discovery key. This requires ORCID Member API access (the `/activities/update` scope), which means Pharos would need ORCID membership (free for institutions, paid for organizations). Alternatively, the author manually adds a URL to their ORCID profile's "websites" section.
- ORCID to Pharos: the identity core's registration entry includes the ORCID iD, verified via OAuth. Third parties can cross-check: does the ORCID profile point to this identity core? Does the identity core claim this ORCID iD? If both hold, the link is bidirectionally verified.

*5. ORCID as Tier 1 identity provider (no institutional SSO needed)*

For researchers at institutions without eduGAIN/SSO, ORCID OAuth is the universal fallback. It is institution-independent, works regardless of IT maturity, and most researchers already have an ORCID. This is particularly relevant for independent researchers, those between positions, or those at less-resourced institutions. The researcher authenticates with ORCID, gets a Tier 0+ identity core (ORCID-verified but no institutional attestation), and can upgrade to Tier 2 (passkeys) at any time without an institution in the loop.

*Centralization tension*

ORCID is a centralized nonprofit. Pharos is designed to be decentralized. The integration must not create a hard dependency:

- ORCID is the bootstrap and convenience layer, not the substrate. Once the identity core exists, it is self-sovereign (Hypercore, Ed25519, no ORCID dependency for ongoing operation).
- If ORCID disappears: existing identity cores continue to function; the registry core still maps ORCID iDs to discovery keys (the data persists in the Hyperbee); new bootstraps break, but could fall back to institutional SSO or direct discovery-key exchange.
- Alternative identifiers (ResearcherID, Scopus Author ID, even institutional employee IDs) could map to the same identity core via additional registry entries. The registry supports multiple identifiers per core.

---

## Threat Mitigation

| Threat | Mitigation |
|---|---|
| Server outage | Content replicated across N peers; no single point of failure. A node going offline does not affect content availability as long as one peer has it. |
| Financial collapse | No operating budget. Peers self-fund storage and bandwidth. A university can run a full node for the cost of a few TB of disk. An individual can run an index-only node for free. |
| Political pressure | Peers are jurisdictionally distributed. A takedown notice to one peer does not affect others. No central entity to serve a injunction to. Each peer makes its own legal decision about what to host. |
| Editorial censorship | Content is append-only. No moderator can remove content. Corrections and retractions are new appends, not deletions. The scientific record is immutable. |
| DMCA takedown | No central platform. A DMCA notice can target a specific peer, which can remove its replica, but other peers are not affected. The content hash persists in the index, and other peers can re-pin. |
| Tampering | Content-addressed storage (BLAKE2b) + Hypercore signatures (Ed25519). Any tampering is detected on verification. |
| Link rot | Citations are content-addressed, not URLs. A citation to a paper resolves to the exact version, permanently, as long as any peer has it. |
| Spam/fabrication | Author signing creates provenance. Reputation layer (future): endorsements from verified researchers. The index records who published what; problematic content can be flagged without being removed. |
| Key loss | Tiered key management (Tier 1-3). Tier 1: no key, institutional attestation. Tier 2: passkeys with cloud sync, biometric unlock, social recovery as fallback. Tier 3: raw Ed25519 with social recovery as primary. Default is zero key management. |
| Institutional lock-in (Tier 1) | Upgrade path to Tier 2 (passkeys) proactively encouraged during onboarding. Author can delegate signing to device key without institutional involvement after upgrade. |
| ORCID dependency | ORCID is bootstrap/convenience layer, not substrate. Identity cores are self-sovereign once created. Registry core persists ORCID-to-discovery-key mappings even if ORCID disappears. Multiple identifiers can map to one core. |
| Author institution change | Identity is separate from affiliation. Affiliation entries have time bounds; identity core persists across moves. Institutional pinners preserve already-pinned content; new institution takes over pinning. |
| Institutional closure | Content remains replicated across other pinners. Identity cores are author-owned, not institution-owned. Institutional co-signatures remain valid as historical attestations even after the institution ceases to exist. |

---

## MVP Build Plan

The MVP demonstrates that Pharos is a publishing platform, not just a backup system. arXiv and bioRxiv ingestion seeds the archive at launch so it is not empty on day one, but the primary path is direct publishing. The full publish-to-read cycle must work without a central server.

### Phase 1: Ingestion + Index (Weeks 1-3)
- arXiv OAI-PMH metadata harvester (Node.js, reuses Hypercore)
- bioRxiv API metadata fetcher (reuses existing digest pipeline logic)
- Metadata stored in a Hyperbee index (paper_id, title, authors, DOI, content hash, source, category, version)
- Content hashes computed for fetched PDFs
- Single-node: Pi as the first archive node
- This phase is mostly glue code on existing libraries. The bioRxiv fetcher is already built; arXiv OAI-PMH is a standard protocol.

### Phase 2: Distributed Metadata Replication (Weeks 3-4)
- Hyperbee metadata index replicates to all connected peers
- When a paper is ingested or published, the index entry propagates
- Every peer has the full catalog locally, even without downloading PDFs
- This is how browsing works without a central API: the index IS the arXiv listing page, distributed
- Category-based subscriptions: peers subscribe to categories (q-bio.GN, cs.AI, etc.) and auto-replicate new papers in subscribed categories
- Storage limits: auto-evict oldest unpinned papers when disk fills

### Phase 3: Direct Publishing (Weeks 4-6)
- `pharos publish <pdf>`: author submits a preprint directly to Pharos, not via arXiv
- Metadata: title, authors (ORCID iDs as strings), abstract, subject category
- Paper gets a content hash, lands in Hyperdrive, metadata index gets a new entry
- Publishing node announces it on the Hyperswarm topic
- Minimal author identity via ORCID OAuth at publish time: author authenticates with ORCID, Pharos records the verified ORCID iD in the paper metadata. No Ed25519 keys, no identity cores, no passkeys. Just verified ORCID attribution. This is Tier 0+ from the identity proposal.
- Versioning: `--revises <paper_id>` links v1 and v2 via content hashes. Index shows latest version by default, preserves full history. `previous_version_hash` field in metadata entry. Readers can access any version; citations can target a specific version.
- arXiv/bioRxiv ingestion becomes a bootstrap seeder (fill the archive with existing content at launch), not the primary publishing path

### Phase 4: Replication + Verification (Weeks 6-8)
- Hyperdrive for blob storage
- Hyperswarm topic for peer discovery (global + per-category)
- Replication protocol: announce pins, request blobs, verify hashes on receipt
- BLAKE2b content hash verification: compute, compare, reject on mismatch
- Category-based auto-replication: papers propagate to all peers subscribed to that category
- Two-node test: Pi + laptop (same as p2p-digest POC, different content)
- The p2p-digest POC already proved this transport works; the new part is blob-level (Hyperdrive) vs message-level (Hypercore)

### Phase 5: CLI + Web UI (Weeks 8-10)
- `pharos fetch <paper_id>`: fetch a paper from peers, verify, store locally
- `pharos pin <paper_id>`: pin a paper for permanent local replication
- `pharos search <query>`: local FTS5 search over replicated content
- `pharos status`: replication health, pinned papers, peer count, peer subscriptions
- `pharos serve`: run as a replication daemon (background)
- `pharos publish <pdf>`: direct publishing with ORCID auth
- `pharos browse <category> --recent`: list recent papers by category
- Minimal web UI: browse recent papers by category, search (local FTS5), view metadata + abstract, download or read PDF in-browser, see version history. Single-page app talking to local node HTTP API. This is what makes it a product instead of a tool.

### What the MVP demo looks like

```
# Author publishes directly to Pharos
$ pharos publish paper.pdf --title "..." --orcid-auth
  ORCID verified: 0000-0003-2361-3953
  Published: pharos:q-bio.GN/2026.08.23.001
  Content hash: blake2b:7f3a...
  Announced to 3 peers subscribed to q-bio.GN
  Replicated: 2/3 peers confirmed

# Reader on another node
$ pharos browse q-bio.GN --recent
  [2026-08-23] Toward a Unifying Framework... (Paixao, T.)
  [2026-08-22] Single-cell Leiden pipeline... (Smith, J.)
  ...

# Or via web UI at http://localhost:8091
# Reader sees the paper, downloads PDF, hash verified on receipt

# Author publishes v2
$ pharos publish paper_v2.pdf --revises pharos:q-bio.GN/2026.08.23.001
  Published: pharos:q-bio.GN/2026.08.23.001v2
  Links to v1 (blake2b:7f3a...)
  Announced to peers
```

### Explicitly out of MVP scope

- Full tiered key management, passkeys, social recovery, identity cores (Phase 2)
- Institutional pinning as a first-class mode (Phase 2)
- Bidirectional ORCID linking (writing back to ORCID profile) (Phase 2)
- Citation graph extraction and content-addressed linking (Phase 2)
- Formal correction/erratum protocol (append-only handles it structurally; UX comes later)
- Distributed gossip-based search (local FTS5 sufficient for MVP)
- Reputation layer, endorsements, peer review (Phase 3+)

### Timeline

~10-12 weeks of evenings/weekends for a solo developer. The web UI and publishing workflow add ~4 weeks over a replication-only MVP. The ORCID OAuth integration is standard but has real setup overhead (OAuth app registration, callback handling, token storage).

---

## Post-MVP Roadmap

### Phase 2: Identity and Trust
- Identity cores (Hypercore append-only logs per author)
- Full tiered key management (Tier 1 institutional attestation, Tier 2 passkeys, Tier 3 sovereign Ed25519)
- Social trust key recovery (M-of-N threshold)
- Institutional pinning as first-class replication mode
- Bidirectional ORCID linking (write back to ORCID profile)
- Author signing of preprints (Ed25519 signatures in metadata)
- Institutional co-signing of affiliations

### Phase 3: Citation Network
- Citation graph extraction from published papers
- Content-addressed citation linking (cite exact version, permanently)
- Citation queries (who cites this paper, what does this paper cite)
- Correction/erratum append protocol with UI

### Phase 4: Distributed Search and Scale
- Gossip-based search protocol across peers
- Peer-to-peer query/response for content not locally replicated
- Reputation layer: endorsements from verified researchers
- Selective pinning policies (institutional, by-author, by-category)
- Anti-entropy optimizations for large-scale replication

---

## Relationship to Existing Projects

- **bioRxiv digest pipeline:** The ingestion layer reuses the bioRxiv fetcher. The digest becomes a discovery layer for the archive: each daily digest links to archived full-text, replicated across peers. The digest's `top_papers.json` becomes a "pin list" for the archive.
- **Research wiki (GIMM):** The wiki's citation network could eventually resolve to Pharos content hashes instead of URLs, eliminating the known issue of incorrect paper links.
- **Scientific Commons essay:** Pharos is the infrastructure argument of the essay, built and running. The eight arguments (historical pattern, collateral damage, chilling effect, brain drain, precedent, service vulnerability, non-geopolitical threats, IGO model) are architectural features, not just rhetorical points.
- **Project Anvil:** The provenance layer (datalad) and the archive share the content-addressing principle. Anvil analysis artifacts could be published to Pharos, creating a provenance chain from raw data through analysis to published preprint.

---

## What This Is Not

- Not just a replication layer for arXiv or bioRxiv. Those are ingestion sources that seed the archive at launch. Pharos is a publishing platform that replaces the need for centralized preprint servers.
- Not Sci-Hub. No paywalled content. Only preprints and open-access material.
- Not a publisher. No peer review (yet), no editorial decisions, no formatting. It preserves and replicates.
- Not a blockchain. No tokens, no consensus mechanism, no mining. Hypercore is a signed append-only log, not a cryptocurrency.
- Not a dark archive. Content is accessible to any peer that replicates it. Transparency is a feature.
