# Pharos Web Client — Detailed Implementation Plan

Derived from `WEB_PLAN.md`. Breaks each phase into concrete code changes in `src/web/server.js` and related files.

## Prerequisites

### D2 fix — Replica store auto-detection in `startServer()`

**File**: `src/web/server.js`, `startServer()` function (~line 38)

Currently `startServer()` always calls `initStore(dataDir)`, ignoring `remote.json`. On replica nodes this opens a fresh empty publisher store, so all browse/pin/health calls return nothing.

**Fix**: Mirror the CLI's `withStore` logic from `src/cli/cli.js`:
- Check if `dataDir/remote.json` exists
- If yes, call `initReplicaStore(dataDir, remote.bee_key, remote.drive_key)` instead
- If no, call `initStore(dataDir)` as before

```js
async function startServer(opts = {}) {
  const port = opts.port || 8093
  const dataDir = opts.dataDir || 'data'
  const dataDirAbs = path.resolve(dataDir)

  const remoteFile = path.join(dataDirAbs, 'remote.json')
  if (fs.existsSync(remoteFile)) {
    const remote = JSON.parse(fs.readFileSync(remoteFile, 'utf8'))
    await initReplicaStore(dataDirAbs, remote.bee_key, remote.drive_key)
  } else {
    await initStore(dataDirAbs)
  }
  // ... rest unchanged
}
```

Need to add `require('path')` and `require('fs')` at the top of server.js (currently only `http` and `url` are required).

---

## Phase 1 — Read-only node dashboard

### New API endpoints

#### `GET /api/status`
Returns: `{ papers, drive_key, bee_key, db_size_bytes, is_replica }`
- Scan Hyperbee `paper:` keys for count
- Read `store.drive.key` and `store.bee.core.key` (hex)
- Stat `search.db` for size
- Check `storeInstance.isReplica` flag

#### `GET /api/keys`
Returns: `{ drive_key, bee_key }`
- Just the hex keys, copy-friendly format
- Useful for sharing with replica nodes

#### `GET /api/health`
Returns: `{ total, healthy, atRisk, minReplicas, papers: [{paper_id, replicas, status}] }`
- Delegate to `healthReport()` from `src/replicate/health.js`
- Need to require health module in server.js

### UI changes — Homepage Node panel

Add a "Node" section to `renderHomepage()` HTML (after the existing search/browse area):

- **Keys card**: drive key + bee key with copy-to-clipboard buttons (uses `navigator.clipboard.writeText`)
- **Disk usage card**: bar showing store/index/db breakdown, calls existing `/api/disk-usage` endpoint
- **Health table**: total / healthy / at-risk counts, expandable per-paper list with replica counts and status badges (green/orange)

JavaScript: fetch `/api/status`, `/api/health`, `/api/disk-usage` on page load, populate the panel.

### Code locations
- Route handlers: add to `handleRequest()` switch in server.js (~line 70-142)
- API handler functions: add near existing `getStats()` (~line 173)
- HTML: add to `renderHomepage()` return string (the template starts at ~line 415)
- Requires: add `const { healthReport } = require('../replicate/health')` at top

---

## Phase 2 — Replica support

### New API endpoints

#### `POST /api/fetch-remote`
Body: `{ paper_id, bee_key, drive_key }` (or accept query params for shareable links)

Logic (mirror CLI `fetch-remote` command):
1. Call `initReplicaStore(dataDir, bee_key, drive_key)` to open replicated store
2. Persist `remote.json` to dataDir for future `startServer` auto-detection
3. Wait for Hyperbee replication (poll `bee.core.length` or add timeout)
4. Return: `{ ok: true, papers_synced: N }`

Note: This requires re-initializing the store, which means the current `storeInstance` singleton must be closed first. Use `close()` then `initReplicaStore()`.

#### `POST /api/pin`
Body: `{ paper_id }`

Logic (mirror CLI `pin` command with swarm-assisted fallback):
1. Try `pinPaper(paperId)` from health.js
2. If blob not available locally, join archive swarm via `corestore.replicate()` to pull blob on demand
3. Poll-retry pin every 2s up to 30s (same logic as CLI)
4. Return: `{ paper_id, pinned: true, content_hash }` or `{ error }` on failure

### UI changes

- **Fetch-remote form**: in the Node panel, add a collapsible "Connect to publisher" form with fields for paper_id (optional), bee_key, drive_key. Prefill from URL query params (`?bee_key=...&drive_key=...`) for shareable links.
- **Pin button**: on paper detail page (`renderPaperPage`), add a "Pin this paper" button that calls `POST /api/pin` and shows success/failure inline.

### Code locations
- Route handlers: add `POST /api/fetch-remote` and `POST /api/pin` to `handleRequest()`
- Need to require: `pinPaper`, `healthReport` from `src/replicate/health.js`; `initReplicaStore` already imported from store.js
- `remote.json` persistence: use `fs.writeFileSync` to dataDir
- HTML: update `renderHomepage()` for fetch-remote form; update `renderPaperPage()` for pin button

---

## Phase 3 — Storage management

### New API endpoints

#### `POST /api/evict`
Body: `{ max_mb, dry_run }`

Logic:
1. If `dry_run` is true: scan papers, list what *would* be evicted (unpinned, oldest first) with sizes, but don't delete anything
2. If `dry_run` is false: call `evictUnpinned(maxBytes)` from store.js
3. Return: `{ evicted: N, freed_bytes: N, papers: [...] }` (dry_run lists candidates; apply lists actually evicted)

#### `POST /api/rebuild-index`
Logic:
1. Call `rebuildIndex()` from lib.js
2. Return: `{ indexed: N }`

#### `GET /api/download/:paperId`
Logic:
1. Fetch PDF via `fetchPdf(paperId)`
2. Set `Content-Disposition: attachment` (not inline) to trigger browser download
3. Same magic-byte validation as existing `servePdf`

### UI changes

- **Storage management section** under Node panel:
  - Target size input (MB) + "Preview eviction" button (calls `/api/evict` with `dry_run: true`)
  - Preview shows list of papers that would be evicted, with sizes, and explicitly notes "pinned papers are exempt"
  - "Apply eviction" button (second confirm step, warns that evicted unpinned blobs are gone unless publisher is online)
  - "Rebuild search index" button
  - Disk usage refreshes after each operation
- **Download button** on paper detail page (next to pin button)

### Code locations
- `evictUnpinned` already imported from store.js
- `rebuildIndex` needs import from lib.js (or search/index.js)
- Route handlers in `handleRequest()`
- `GET /api/download/:paperId` near existing `servePdf` (~line 188)

---

## Phase 4 — ORCID auth in browser

### New API endpoints

#### `GET /api/orcid/status`
Returns: `{ orcid_id, orcid_name, orcid_verified_at }` or `{ connected: false }`
- Reads `loadCachedOrcid()` from orcid.js
- No state change

#### `GET /api/orcid/authorize`
Logic:
1. Generate state via `generateState()` from orcid.js
2. Build URL via `getOrcidImplicitUrl(clientId, state, null)` (standalone auth, nonce=null)
3. Return HTTP 302 redirect to ORCID authorize URL
4. Store state in a short-lived in-memory map for CSRF validation on callback

#### `POST /api/orcid/callback`
Body: `{ access_token, state }`

Logic:
1. Validate `state` against in-memory map (CSRF check)
2. Call `verifyAccessToken(token)` to get claims from ORCID userinfo endpoint
3. Cache result via `saveOrcidConfig()` to `~/.pharos/config.json`
4. Return: `{ ok: true, orcid_id, orcid_name }`

### UI changes

- **ORCID status badge** on homepage and publish form:
  - Connected: "Connected as {name} ({orcid_id})" with green badge
  - Not connected: "Connect ORCID" button linking to `/api/orcid/authorize`
- **Publish form** reflects auth state: if not connected, show "Connect ORCID first" message (but keep the self-asserted orcid field as escape hatch)
- **Callback page**: reuse existing `orcid-callback.html` logic, but on the same origin. The callback page parses the URL fragment, POSTs the token to `/api/orcid/callback`, then redirects to `/` with a success message.

### Code locations
- `loadCachedOrcid`, `generateState`, `getOrcidImplicitUrl`, `verifyAccessToken`, `saveOrcidConfig` already in orcid.js
- Need to import them into server.js (some already imported: `orcidAuth`, `loadCachedOrcid`)
- Add in-memory state map: `const pendingOrcidStates = new Map()` with 5-min TTL
- Route handlers in `handleRequest()`
- HTML: update publish form section in `renderHomepage()`

---

## Phase 5 — Embedded replication

### Changes to `startServer()`

When `--subscribe` subjects are passed (or by default), embed swarm startup:

```js
async function startServer(opts = {}) {
  // ... existing store init ...
  
  if (opts.serve !== false) {
    const { startArchiveSwarm, startBlobSwarm } = require('../replicate/swarm')
    const { serveBlobs, sendMessage } = require('../replicate/replicate')
    const { getLocalPins, addReplica } = require('../replicate/health')
    
    // Same logic as CLI `serve` command
    const archiveSwarm = await startArchiveSwarm(store, {
      server: true, client: true,
      topics: opts.subscribe || []
    })
    
    const blobSwarm = await startBlobSwarm((conn, info) => {
      serveBlobs(conn, store, {
        onPinAnnounce: async (paperId, pk) => {
          try { await addReplica(paperId, pk) } catch (_) {}
        }
      })
      getLocalPins().then(pins => {
        if (pins.length) sendMessage(conn, { type: 'pin_announce', hashes: pins, peer_key: store.drive.key.toString('hex') })
      })
    })
    
    // Store swarm references for status endpoint
    serverSwarmState = { archiveSwarm, blobSwarm }
  }
  
  // ... existing server.listen ...
}
```

### New API endpoint

#### `GET /api/serve-status`
Returns: `{ serving: true, archive_peers: N, blob_connections: N, topics: [...] }`
- Reads from `serverSwarmState` if set
- Returns `{ serving: false }` if `--no-serve` was passed

### CLI changes

Add `--no-serve` and `--subscribe` flags to the `web` command in `src/cli/cli.js`:

```js
program
  .command('web')
  .option('--port <port>', 'web server port', '8093')
  .option('--no-serve', 'disable embedded replication (offline UI only)')
  .option('--subscribe <subjects...>', 'subject categories to subscribe to', [])
  .action(async (opts) => {
    await pharos.startServer({
      port: parseInt(opts.port),
      dataDir: path.resolve(program.opts().dataDir),
      serve: opts.serve !== false,
      subscribe: opts.subscribe || []
    })
    // ... graceful shutdown ...
  })
```

### UI changes

- **Replication panel** in Node section: shows serving status, connected peers count, blob transfer connections, subscribed topics
- Auto-refresh every 10s via `setInterval`

### Graceful shutdown

Add SIGINT/SIGTERM handlers in `startServer()` to close swarms + store before exit, mirroring the CLI `serve` command.

---

## Testing

### New file: `test/web_api.test.js`

Uses `node:test` built-in runner, consistent with existing test files.

Test groups:
1. **Status/keys/health**: `GET /api/status` returns correct shape (papers count, keys present, is_replica boolean); `GET /api/keys` returns hex keys; `GET /api/health` returns paper list with replica counts
2. **Evict dry-run vs apply**: dry-run returns candidates without deleting; apply actually evicts unpinned papers; pinned papers are exempt
3. **ORCID status**: without cache returns `{ connected: false }`; with mock cache returns orcid_id/name
4. **Fetch-remote**: writes `remote.json`, re-opens store as replica
5. **Pin**: returns `{ pinned: true }` for available blob; returns error for missing paper
6. **Download**: sets `Content-Disposition: attachment`, returns PDF bytes
7. **Serve-status**: returns `{ serving: false }` when `--no-serve`; returns peer counts when serving

Test harness: create a temp data dir, init a publisher store, publish a test paper, start the web server on a random port, make HTTP requests, assert responses, clean up.

### Verify existing tests stay green

Run all 10 test files individually (known quirk: `node --test test/` fails with MODULE_NOT_FOUND):

```bash
for f in test/test_*.js; do node --test "$f"; done
```

---

## Push to GitHub

After all phases are implemented and tests pass:

```bash
cd /mnt/ssd1tb/nanobot/workspace/projects/p2p-preprint-archive
git add -A
git commit -F commit_msg.txt  # use file to avoid arrow/URL encoding issues
git push origin main
```

Commit message: "Web UI full CLI parity: replica support, node dashboard, storage management, ORCID auth, embedded replication"

---

## File change summary

| File | Changes |
|---|---|
| `src/web/server.js` | D2 fix, all new API endpoints, homepage/paper HTML updates, embedded swarm startup, graceful shutdown |
| `src/cli/cli.js` | Add `--no-serve`, `--subscribe` flags to `web` command |
| `test/web_api.test.js` | New test file for all new endpoints |

No changes needed to: `src/core/store.js`, `src/core/constants.js`, `src/core/hash.js`, `src/core/signing.js`, `src/core/schema.js`, `src/publish/publish.js`, `src/publish/orcid.js`, `src/replicate/health.js`, `src/replicate/swarm.js`, `src/replicate/replicate.js`, `src/search/index.js` — all existing modules are sufficient; the work is wiring them into the web server.