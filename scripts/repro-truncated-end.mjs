import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:1339';
const STATION = 'desk-repro-' + Date.now();

const signal = (fields) =>
  fetch(`${BASE}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: 'dev-token', station_id: STATION, ...fields }),
  });

const putChunk = (clipId, seq, bytes) =>
  fetch(`${BASE}/api/clip/${clipId}/chunk/${seq}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(bytes),
  });

const finalise = (clipId, status) =>
  fetch(`${BASE}/api/clip/${clipId}/finalise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

const getClips = async () => (await (await fetch(`${BASE}/api/clips`)).json()).clips ?? [];
const findByTrace = async (ordersn) => (await getClips()).find((c) => c.ordersn === ordersn);

console.log(`\nTesting repro against ${BASE} (Station: ${STATION})\n`);

const trace = 'repro-' + Date.now();
const ordersn = 'ORD-' + Date.now();
const tracking = 'SPX-TEST-' + Date.now();

// 1. Start clip
await signal({ event: 'start', trace_id: trace, value: '356938035643809', user: 'ผู้ทดสอบ' });
await sleep(150);

let clip = (await getClips()).find((c) => c.station_id === STATION);
const clipId = clip?.clip_id;
console.log('1. Clip started:', clipId);

// 2. Put chunk 0 and chunk 1 (while packing)
const chunk0Res = await putChunk(clipId, 0, new Uint8Array(1000).fill(1));
const chunk1Res = await putChunk(clipId, 1, new Uint8Array(1000).fill(2));
console.log('2. Uploaded chunk 0 status:', chunk0Res.status, 'chunk 1 status:', chunk1Res.status);

// 3. Commit & Tag
await signal({ event: 'commit', trace_id: trace, ordersn, imei_complete: 'true' });
await sleep(100);
await signal({ event: 'tag', tracking_no: tracking });
await sleep(100);

// 4. Operator scans the barcode/QR code on the box
console.log('3. Scanning barcode to stop...');
await signal({ event: 'scan', value: tracking });
await sleep(100);

// 5. Client stops MediaRecorder and uploads the final chunk (chunk 2)
console.log('4. Client uploads final chunk (chunk 2) containing the scan and packaging conclusion...');
const finalChunkRes = await putChunk(clipId, 2, new Uint8Array(1000).fill(3));
console.log('5. Final chunk upload HTTP status:', finalChunkRes.status);

// 6. Client calls finalise
console.log('6. Client calls finalise...');
const finaliseRes = await finalise(clipId, 'verified');
console.log('   Finalise HTTP status:', finaliseRes.status);

await sleep(300);

clip = await findByTrace(ordersn);
console.log('7. Final clip state:');
console.log('   Status:', clip?.status);
console.log('   Bytes:', clip?.bytes);
console.log('   Chunks:', clip?.chunks);

if (finalChunkRes.status !== 200) {
  console.error(`\n❌ TEST FAILED: Final chunk was rejected with status ${finalChunkRes.status} (expected 200)`);
  process.exit(1);
}

if (clip?.bytes !== 3000) {
  console.error(`\n❌ TEST FAILED: Clip ended up with ${clip?.bytes} bytes instead of 3000 bytes`);
  process.exit(1);
}

console.log('\n✅ PASS: Final chunk was accepted and included in the clip successfully!');
