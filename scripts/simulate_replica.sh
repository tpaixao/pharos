#!/bin/bash
# Runs from repo root. Simulates a fresh laptop replica against localhost publisher.
cd "$(dirname "$0")/.."
rm -rf data-sim
node src/index.js fetch-remote pharos:q-bio.GN/2026.08.31/001 \
  --bee-key 60ef7ef7d545e0c3cf679d74e76b9de8d4e24dad071a678bfb7170755fc4f007 \
  --drive-key bae94613e0ee6e180438cb5969b2f84c04e5905662f7e19b2e8c86fc9f204685 \
  --data-dir ./data-sim 2>&1 | grep -Ev -i 'warning|trace-warnings'
echo "=== PIN (loop with sync wait) ==="
node src/index.js pin pharos:q-bio.GN/2026.08.31/001 --data-dir ./data-sim 2>&1 | grep -Ev -i 'warning|trace-warnings'
echo "=== drive entry check ==="
node -e "
const Corestore = require('corestore');
const Hyperdrive = require('hyperdrive');
(async () => {
  const store = new Corestore('./data-sim/store');
  const drive = new Hyperdrive(store, Buffer.from('bae94613e0ee6e180438cb5969b2f84c04e5905662f7e19b2e8c86fc9f204685', 'hex'));
  await drive.ready();
  console.log('drive key:', drive.key.toString('hex'));
  try {
    console.log('drive.entries:', await (async () => { const acc=[]; for await (const e of drive.entries()) acc.push(e); return acc; })());
    const blob = await drive.get('fulltext.pdf');
    console.log('drive.get fulltext.pdf =>', blob ? blob.length + ' bytes' : null);
  } catch (err) { console.log('drive error:', err.message); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
" 2>&1 | grep -Ev -i 'warning|trace-warnings'