#!/usr/bin/env node
/**
 * เซิร์ฟเวอร์ตายกลางคลิปแล้วบูตใหม่ — คลิปที่ยังอัดอยู่ต้องทำงานต่อได้ ไม่เสียวิดีโอ
 *
 *   - คลิปที่กำลังอัด (เริ่มไม่เกิน CLIP_MAX_MINUTES) ถูกรับกลับมาเป็นคลิปเปิดของโต๊ะ ชิ้นที่ตามมาเข้าได้ สแกนปิดได้ตามปกติ
 *   - คลิปที่กำลังรอชิ้นค้าง (หน้าต่างอัดบอกจำนวนชิ้นแล้ว) รอต่อจนครบ
 *   - ช่วงบูตก่อนต่อ Mongo ได้ ชิ้นของคลิปที่ยังไม่รู้จักได้ 503 (ให้ส่งใหม่) ไม่ใช่ 409 (ให้ทิ้ง)
 *   - คลิปค้างที่เก่าเกินเพดาน หรือคลิปปิดแล้วที่ชิ้นยังค้าง → ต่อไฟล์จากชิ้นที่มี ปิดเป็น unverified และปักหมุด
 *
 *   E2E_MONGO_URL=mongodb://127.0.0.1:27017/packvideo_e2e npm run e2e:restart
 *
 * สคริปต์เปิดเซิร์ฟเวอร์เอง (node src/server.js) สามรอบบนพอร์ตและโฟลเดอร์ชั่วคราว แล้ว kill -9 กลางคลิป
 * **ต้องเป็นฐานทดสอบเท่านั้น** — สคริปต์ลบทั้งฐานตอนจบ จึงไม่ยอมรันกับฐานชื่อ packVideo
 *
 * เหตุการณ์จริง (2026-10-01 10:47): rebuild packvideo ตอนมีคนแพ็ค 4 คลิปที่กำลังอัดถูกปิดเป็น unverified
 * โดยไม่มีไฟล์เลยทั้งที่ชิ้นอยู่ใน _tmp ครบ และไม่ได้ pinned (retention ดู pinned อย่างเดียว)
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';

const MONGO_URL = process.env.E2E_MONGO_URL;
if (!MONGO_URL) {
  console.error('ต้องตั้ง E2E_MONGO_URL ให้ชี้ฐานทดสอบ (สคริปต์ลบทั้งฐานตอนจบ)');
  process.exit(2);
}
const DB_NAME = new URL(MONGO_URL).pathname.slice(1) || 'packvideo_e2e';
if (/^packvideo$/i.test(DB_NAME)) {
  console.error(`ไม่รันกับฐาน ${DB_NAME} — ใช้ชื่อฐานทดสอบแยก`);
  process.exit(2);
}

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.E2E_PORT ?? 13399);
const BASE = `http://127.0.0.1:${PORT}`;
const STORE = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-restart-'));
const TMP = path.join(STORE, '_tmp');
const NOTE = 'เซิร์ฟเวอร์รีสตาร์ทระหว่างอัด';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
}

// ── Mongo ผ่าน proxy ที่ปิดได้ — จำลองช่วงบูตที่เซิร์ฟเวอร์ขึ้นแล้วแต่ยังต่อฐานไม่ได้ ──
const mongoTarget = new URL(MONGO_URL);
const mongoProxy = { up: true };
const mongoProxyServer = net.createServer((sock) => {
  if (!mongoProxy.up) { sock.destroy(); return; }
  const upstream = net.connect(Number(mongoTarget.port || 27017), mongoTarget.hostname);
  sock.pipe(upstream).pipe(sock);
  sock.on('error', () => upstream.destroy());
  upstream.on('error', () => sock.destroy());
});
await new Promise((r) => mongoProxyServer.listen(0, '127.0.0.1', r));
const SERVER_MONGO_URL = `mongodb://127.0.0.1:${mongoProxyServer.address().port}/${DB_NAME}`;

// ── เซิร์ฟเวอร์ ────────────────────────────────────────────────
let server = null;
let serverLog = [];

async function boot(label, { waitMongo = true, env = {} } = {}) {
  serverLog = [];
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      MONGO_URL: SERVER_MONGO_URL,
      MONGO_DB: DB_NAME,
      CLOSE_GRACE_SEC: '2',
      ...env,
      PACK_VIDEO_PATH: STORE,
      SELLCENTER_JWT_SECRET: '',
      TELEGRAM_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [server.stdout, server.stderr]) s.on('data', (d) => serverLog.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      if (!waitMongo) {
        if ((await fetch(`${BASE}/api/health/live`)).ok) return;
      } else {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok && (await r.json()).checks?.mongo?.connected) return;
      }
    } catch { /* ยังไม่ขึ้น */ }
    await sleep(100);
  }
  throw new Error(`เซิร์ฟเวอร์รอบ ${label} ไม่ขึ้น\n${serverLog.join('').slice(-2000)}`);
}

async function kill() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGKILL');   // ตายจริง ไม่ผ่าน shutdown — แบบ docker ฆ่าตอนเกิน 10 วิ หรือเครื่องดับ
  await new Promise((r) => s.once('exit', r));
}

const signal = (station, fields) =>
  fetch(`${BASE}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: 'dev-token', station_id: station, ...fields }),
  });

const putChunk = (clipId, seq, buf) =>
  fetch(`${BASE}/api/clip/${clipId}/chunk/${seq}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
  });

// ชิ้นแรกต้องขึ้นต้นด้วยกล่อง ftyp ไม่งั้น finalise ติดป้าย no_header
function chunk(seq, size = 900) {
  const b = Buffer.alloc(size, seq + 1);
  if (seq === 0) {
    b.writeUInt32BE(24, 0);
    b.write('ftypisom', 4, 'latin1');
  }
  return b;
}
const finalise = (clipId, body) =>
  fetch(`${BASE}/api/clip/${clipId}/finalise`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
const apiClip = async (id) => (await (await fetch(`${BASE}/api/clips/${id}`)).json()).clip ?? null;
const sha = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
const exists = (p) => fs.stat(p).then(() => true, () => false);

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(100);
  }
}

// ── ทดสอบ ─────────────────────────────────────────────────────
const client = await MongoClient.connect(MONGO_URL);
const db = client.db(DB_NAME);
const clipsCol = db.collection('clips');
const events = db.collection('clip_events');

try {
  await db.dropDatabase();
  console.log(`\nทดสอบคลิปค้างตอนบูต · ${BASE} · ${STORE}\n`);

  // ── รอบ A: เปิดคลิปค้างไว้สองโต๊ะ แล้วฆ่าเซิร์ฟเวอร์ ──
  await boot('A');

  await signal('desk-r1', { event: 'start', trace_id: 'r1', value: '356938035643801', user: 'ผู้ทดสอบ' });
  await signal('desk-r1', { event: 'commit', trace_id: 'r1', ordersn: 'E2E-ORPHAN-1' });
  const s1 = await waitFor(() => clipsCol.findOne({ ordersn: 'E2E-ORPHAN-1', status: 'recording' }));
  check('รอบ A: คลิปที่ 1 กำลังอัด', !!s1, s1?._id);
  const s1Chunks = [chunk(0), chunk(1), chunk(2, 500)];
  for (let i = 0; i < s1Chunks.length; i++) await putChunk(s1._id, i, s1Chunks[i]);

  await signal('desk-r2', { event: 'start', trace_id: 'r2', value: '356938035643802' });
  await signal('desk-r2', { event: 'commit', trace_id: 'r2', ordersn: 'E2E-ORPHAN-2' });
  const s2 = await waitFor(() => clipsCol.findOne({ ordersn: 'E2E-ORPHAN-2', status: 'recording' }));
  check('รอบ A: คลิปที่ 2 กำลังอัด (ยังไม่มีชิ้น)', !!s2, s2?._id);

  // 8: สแกนปิดแล้ว หน้าต่างอัดบอกว่ามี 3 ชิ้น แต่ได้แค่ชิ้นแรก (ที่เหลือค้างในคิวเครื่องเพราะเน็ตช้า)
  await signal('desk-r8', { event: 'start', trace_id: 'r8', value: '356938035643808' });
  await signal('desk-r8', { event: 'commit', trace_id: 'r8', ordersn: 'E2E-AWAIT-8' });
  const s8 = await waitFor(() => clipsCol.findOne({ ordersn: 'E2E-AWAIT-8', status: 'recording' }));
  const s8Chunks = [chunk(0, 760), chunk(1, 600), chunk(2, 400)];
  await putChunk(s8._id, 0, s8Chunks[0]);
  await signal('desk-r8', { event: 'tag', tracking_no: 'SPXAWAIT8' });
  await sleep(200);
  await signal('desk-r8', { event: 'scan', value: 'SPXAWAIT8' });
  await sleep(300);
  const f8 = await (await finalise(s8._id, { chunks: 3, status: 'verified' })).json();
  check('รอบ A: คลิปที่ 8 รอชิ้นที่ค้าง', f8.clip?.status === 'closing', f8.clip?.status);
  await sleep(500);   // ให้สถานะลงฐานก่อนเครื่องดับ

  await kill();

  // ── ของค้างแบบอื่นที่วางไว้เองระหว่างเซิร์ฟเวอร์ดับ ──
  const past = (min) => new Date(Date.now() - min * 60_000).toISOString();

  // 3: คลิปรีสตาร์ทที่โค้ดเดิมปิดเป็น unverified โดยไม่ต่อไฟล์ (ชิ้นยังอยู่)
  const s3 = { _id: 'c_e2e_oldorphan', station_id: 'desk-r3', status: 'unverified', note: NOTE, media_path: null,
    flags: [], pinned: false, pin_reasons: ['anomaly'], started_at: past(30), ordersn: 'E2E-OLD-3', imeis: [] };
  await clipsCol.insertOne(s3);
  const s3Chunks = [chunk(0, 700), chunk(1, 300)];
  await fs.mkdir(path.join(TMP, s3._id), { recursive: true });
  for (let i = 0; i < s3Chunks.length; i++) {
    await fs.writeFile(path.join(TMP, s3._id, String(i).padStart(6, '0')), s3Chunks[i]);
  }

  // 10: คลิปค้างสถานะ recording ที่เก่าเกิน CLIP_MAX_MINUTES (15) — โต๊ะเดียวกับคลิปที่ 1 ที่ยังใหม่
  //     รับกลับได้แค่คลิปเปิดตัวเดียวต่อโต๊ะ ตัวเก่าต้องถูกต่อไฟล์และปิดทันทีแบบเดิม
  const s10 = { _id: 'c_e2e_stale_open', station_id: 'desk-r1', status: 'recording', media_path: null, flags: [],
    pinned: false, pin_reasons: [], started_at: past(30), ordersn: 'E2E-STALE-10', imeis: [] };
  await clipsCol.insertOne(s10);
  const s10Chunks = [chunk(0, 800), chunk(1, 500)];
  await fs.mkdir(path.join(TMP, s10._id), { recursive: true });
  for (let i = 0; i < s10Chunks.length; i++) {
    await fs.writeFile(path.join(TMP, s10._id, String(i).padStart(6, '0')), s10Chunks[i]);
  }

  // 4: ปิดไปแล้ว ไม่มีชิ้นเหลือ — ต้องไม่ถูกแตะ
  const s4 = { _id: 'c_e2e_nochunks', station_id: 'desk-r4', status: 'unverified', note: NOTE, media_path: null,
    flags: [], pinned: false, pin_reasons: ['anomaly'], started_at: past(40), updated_at: new Date('2026-01-01') };
  await clipsCol.insertOne(s4);

  // 5: retention ประกาศลบไฟล์ไปแล้ว — ต้องไม่สร้างไฟล์ใหม่ (retention จะข้ามวันนั้นทุกรอบ)
  const s5 = { _id: 'c_e2e_deleted', station_id: 'desk-r5', status: 'unverified', note: NOTE, media_path: null,
    flags: [], pinned: false, pin_reasons: [], started_at: past(50), media_deleted_at: new Date('2026-01-02'),
    updated_at: new Date('2026-01-02') };
  await clipsCol.insertOne(s5);
  await fs.mkdir(path.join(TMP, s5._id), { recursive: true });
  await fs.writeFile(path.join(TMP, s5._id, '000000'), chunk(0));

  // 6: ปิดครบแล้ว (ไฟล์ + .json คู่ลงดิสก์ _tmp ถูกลบ) แต่ฐานยังค้าง closing — ต้องเชื่อ .json คู่
  const s6Start = new Date(Date.now() - 20 * 60_000);
  const y = s6Start.getFullYear(), m = String(s6Start.getMonth() + 1).padStart(2, '0'), d = String(s6Start.getDate()).padStart(2, '0');
  const s6Rel = path.join(String(y), m, d, 'c_e2e_closed.mp4');
  const s6Buf = chunk(0, 1200);
  await fs.mkdir(path.join(STORE, String(y), m, d), { recursive: true });
  await fs.writeFile(path.join(STORE, s6Rel), s6Buf);
  await fs.writeFile(path.join(STORE, s6Rel.replace(/\.mp4$/, '.json')), JSON.stringify({
    clip_id: 'c_e2e_closed', station_id: 'desk-r6', packer: null, status: 'verified', ordersn: 'E2E-CLOSED-6',
    tracking_no: 'SPXE2E6', project_id: null, imeis: [], flags: [], pinned: false, pin_reasons: [],
    started_at: s6Start.toISOString(), ended_at: new Date(s6Start.getTime() + 30_000).toISOString(),
    day: `${y}-${m}-${d}`, duration_ms: 30_000, bytes: s6Buf.length, chunks: 1, checksum: sha(s6Buf), media_path: s6Rel,
  }));
  await clipsCol.insertOne({ _id: 'c_e2e_closed', station_id: 'desk-r6', status: 'closing', media_path: null,
    flags: [], pinned: false, pin_reasons: [], started_at: s6Start.toISOString(), ordersn: 'E2E-CLOSED-6' });

  // ── รอบ B: บูตใหม่ ──
  await boot('B');

  // 1 · คลิปที่กำลังอัดถูกรับกลับมาเป็นคลิปเปิดของโต๊ะ — อัดต่อ ผูกเลขพัสดุ สแกนปิดได้ตามปกติ
  const a1 = await waitFor(async () => {
    const c = await apiClip(s1._id);
    return c?.status === 'recording' ? c : null;
  });
  check('1 · คลิปที่กำลังอัดถูกรับกลับมาอัดต่อ (ไม่ถูกปิด)', a1?.status === 'recording', a1?.status);
  check('1 · ติดป้าย server_restart', a1?.flags?.includes('server_restart'), JSON.stringify(a1?.flags));
  const s1More = chunk(3, 700);
  const late = await putChunk(s1._id, 3, s1More);
  check('1 · ชิ้นที่ส่งมาหลังบูตเข้าได้', late.status === 200, String(late.status));
  await signal('desk-r1', { event: 'tag', tracking_no: 'SPXORPHAN1' });
  await sleep(200);
  await signal('desk-r1', { event: 'scan', value: 'SPXORPHAN1' });
  await sleep(300);
  await finalise(s1._id, { chunks: 4, status: 'verified' });
  const r1 = await waitFor(async () => {
    const c = await apiClip(s1._id);
    return c?.status === 'verified' && c.media_path ? c : null;
  });
  const s1All = Buffer.concat([...s1Chunks, s1More]);
  check('1 · สแกนปิดแล้วเป็น verified ครบทุกชิ้น', r1?.status === 'verified' && r1?.chunks === 4
    && r1?.bytes === s1All.length && r1?.checksum === sha(s1All), `${r1?.status} · ${r1?.chunks} ชิ้น ${r1?.bytes} ไบต์`);
  const f1 = r1 ? await (await fetch(`${BASE}/media/${s1._id}`)).arrayBuffer().then((b) => Buffer.from(b)) : null;
  check('1 · ไฟล์ที่เปิดผ่าน /media ตรงทุกไบต์', !!f1 && f1.equals(s1All));
  check('1 · ไม่ติด incomplete', r1 && !r1.flags.includes('incomplete'), JSON.stringify(r1?.flags));

  // 2 · คลิปที่ยังไม่มีชิ้นถูกรับกลับมา แล้วออเดอร์ถัดไปของโต๊ะปิดมันตามปกติ (สแกนทับ)
  const a2 = await apiClip(s2._id);
  check('2 · คลิปที่ยังไม่มีชิ้นถูกรับกลับมาเป็นคลิปเปิด', a2?.status === 'recording', a2?.status);
  await signal('desk-r2', { event: 'start', trace_id: 'r2b', value: '356938035643822' });
  const r2 = await waitFor(async () => {
    const c = await apiClip(s2._id);
    return c && !['pending', 'recording', 'closing'].includes(c.status) ? c : null;
  }, 10_000);
  check('2 · ออเดอร์ถัดไปปิดคลิปเดิม → unverified + empty', r2?.status === 'unverified'
    && r2?.flags?.includes('empty') && r2?.flags?.includes('server_restart'), `${r2?.status} ${JSON.stringify(r2?.flags)}`);
  await signal('desk-r2', { event: 'abort', trace_id: 'r2b', reason: 'e2e' });   // ไม่ให้ค้างไปถึงรอบ C

  // 8 · คลิปที่รอชิ้นค้างยังรอต่อหลังบูต แล้วปิดครบเมื่อชิ้นมาถึง
  const a8 = await apiClip(s8._id);
  check('8 · คลิปที่รอชิ้นค้างยังรอต่อหลังบูต', a8?.status === 'closing', a8?.status);
  const p81 = await putChunk(s8._id, 1, s8Chunks[1]);
  const p82 = await putChunk(s8._id, 2, s8Chunks[2]);
  const r8 = await waitFor(async () => {
    const c = await apiClip(s8._id);
    return c?.media_path ? c : null;
  });
  const s8All = Buffer.concat(s8Chunks);
  check('8 · ชิ้นที่ค้างมาถึงหลังบูต → verified ครบ', p81.status === 200 && p82.status === 200
    && r8?.status === 'verified' && r8?.bytes === s8All.length && !r8.flags.includes('incomplete'),
  `${p81.status} ${p82.status} · ${r8?.status} ${r8?.bytes} ไบต์ ${JSON.stringify(r8?.flags)}`);

  // 10 · คลิปค้างที่เก่าเกินเพดาน → ต่อไฟล์ ปิดเป็น unverified และปักหมุดทันที
  const r10 = await waitFor(async () => {
    const c = await apiClip(s10._id);
    return c?.media_path ? c : null;
  });
  const s10All = Buffer.concat(s10Chunks);
  check('10 · คลิปค้างที่เก่าเกินเพดานถูกปิดทันที', r10?.status === 'unverified' && r10?.pinned === true
    && r10?.bytes === s10All.length && r10?.flags?.includes('server_restart') && r10?.flags?.includes('recovered'),
  `${r10?.status} ${r10?.bytes} ไบต์ ${JSON.stringify(r10?.flags)}`);

  const r3 = await waitFor(() => clipsCol.findOne({ _id: s3._id, media_path: { $ne: null } }));
  const s3All = Buffer.concat(s3Chunks);
  check('3 · คลิปรีสตาร์ทจากโค้ดเดิมถูกต่อไฟล์', r3?.bytes === s3All.length && r3?.checksum === sha(s3All),
    `${r3?.bytes} ไบต์`);
  check('3 · คงสถานะ unverified · ปักหมุด · server_restart + recovered',
    r3?.status === 'unverified' && r3?.pinned === true
      && r3?.flags?.includes('server_restart') && r3?.flags?.includes('recovered'), JSON.stringify(r3?.flags));
  check('3 · บันทึก clip_event repair', !!(await events.findOne({ clip_id: s3._id, event: 'repair' })));
  check('3 · ลบ _tmp แล้ว', !(await exists(path.join(TMP, s3._id))));

  const r4 = await clipsCol.findOne({ _id: s4._id });
  check('4 · ไม่มีชิ้นเหลือ → ไม่แตะเลย', r4?.updated_at?.getTime() === s4.updated_at.getTime()
    && !(await events.countDocuments({ clip_id: s4._id })));

  const r5 = await clipsCol.findOne({ _id: s5._id });
  check('5 · retention ลบไฟล์ไปแล้ว → ไม่สร้างไฟล์ใหม่', !r5?.media_path
    && r5?.updated_at?.getTime() === s5.updated_at.getTime() && (await exists(path.join(TMP, s5._id))));

  const r6 = await waitFor(() => clipsCol.findOne({ _id: 'c_e2e_closed', media_path: { $ne: null } }));
  check('6 · ไฟล์ปิดครบแล้ว → ใช้ค่าจาก .json คู่ (verified ไม่ใช่ unverified)',
    r6?.status === 'verified' && r6?.media_path === s6Rel && r6?.checksum === sha(s6Buf)
      && !r6?.flags?.includes('server_restart'), r6?.status);

  // คลิปใหม่หลังบูตยังเดินตามปกติ
  await signal('desk-r7', { event: 'start', trace_id: 'r7', value: '356938035643807' });
  await signal('desk-r7', { event: 'commit', trace_id: 'r7', ordersn: 'E2E-AFTER-7' });
  const s7 = await waitFor(() => clipsCol.findOne({ ordersn: 'E2E-AFTER-7', status: 'recording' }));
  if (s7) {
    await putChunk(s7._id, 0, chunk(0));
    await fetch(`${BASE}/api/clip/${s7._id}/finalise`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'verified' }),
    });
  }
  const r7 = await waitFor(() => clipsCol.findOne({ ordersn: 'E2E-AFTER-7', status: 'verified', media_path: { $ne: null } }));
  check('7 · คลิปใหม่หลังบูตปิดได้ตามปกติ', !!r7 && !r7.flags?.includes('recovered'), r7?.status);

  // ── รอบ W: บูตแล้วยังต่อ Mongo ไม่ได้ — ชิ้นของคลิปที่ค้างต้องได้ 503 (ส่งใหม่) ไม่ใช่ 409 (ทิ้ง) ──
  await signal('desk-r9', { event: 'start', trace_id: 'r9', value: '356938035643809' });
  await signal('desk-r9', { event: 'commit', trace_id: 'r9', ordersn: 'E2E-WINDOW-9' });
  const s9 = await waitFor(() => clipsCol.findOne({ ordersn: 'E2E-WINDOW-9', status: 'recording' }));
  await putChunk(s9._id, 0, chunk(0));
  await sleep(300);
  await kill();
  mongoProxy.up = false;
  await boot('W', { waitMongo: false });
  const w1 = await putChunk(s9._id, 1, chunk(1));
  check('W · ช่วงบูตก่อนต่อฐานได้ ชิ้นได้ 503 (ให้ส่งใหม่) ไม่ใช่ 409', w1.status === 503, String(w1.status));
  const w1f = await finalise(s9._id, { chunks: 2, status: 'verified' });
  check('W · สั่งปิดช่วงบูตได้ 503 (ให้ส่งใหม่) ไม่ใช่ 404', w1f.status === 503, String(w1f.status));
  mongoProxy.up = true;
  const a9 = await waitFor(async () => {
    const c = await apiClip(s9._id).catch(() => null);
    return c?.status === 'recording' ? c : null;
  }, 15_000);
  check('W · ต่อฐานได้แล้วคลิปถูกรับกลับมา', a9?.status === 'recording', a9?.status);
  const w2 = await putChunk(s9._id, 1, chunk(1));
  check('W · ส่งชิ้นเดิมซ้ำหลังต่อฐานได้ → เข้าได้', w2.status === 200, String(w2.status));
  await finalise(s9._id, { chunks: 2, status: 'manual_stop' });
  const r9 = await waitFor(async () => {
    const c = await apiClip(s9._id);
    return c?.media_path ? c : null;
  });
  check('W · ปิดได้ครบ 2 ชิ้น', r9?.chunks === 2 && !r9.flags.includes('incomplete'), `${r9?.status} ${r9?.chunks}`);

  // ── รอบ W2: ต่อ Mongo ไม่ได้นานเกินช่วงผ่อนผัน — ต้องกลับไปตอบ 409 ตามเดิม ──
  // ไม่งั้นชิ้นของคลิปที่ไม่มีใครรู้จักได้ 503 ไม่จบ คิวในเครื่องส่งทีละชิ้นจะค้างอยู่ที่มัน
  // ชิ้นของคลิปใหม่ต่อคิวข้างหลังไม่ได้ส่ง จนคลิปใหม่หมดเวลาแล้วเสียวิดีโอแทน
  await kill();
  mongoProxy.up = false;
  await boot('W2', { waitMongo: false, env: { BOOT_RECOVERY_GRACE_SEC: '3' } });
  const u1 = await putChunk('c_e2e_unknown_w2', 1, chunk(1));
  await sleep(4000);
  const u2 = await putChunk('c_e2e_unknown_w2', 1, chunk(1));
  check('W2 · Mongo ล่มนานเกินช่วงผ่อนผัน → คลิปที่ไม่รู้จักกลับไปได้ 409 (ไม่ค้างคิว)', u1.status === 503 && u2.status === 409,
    `${u1.status} → ${u2.status}`);
  mongoProxy.up = true;
  await waitFor(async () => (await (await fetch(`${BASE}/api/health`)).json()).checks?.mongo?.connected, 15_000);

  // ── รอบ C: บูตซ้ำโดยไม่มีอะไรค้าง → ต้องไม่เขียนอะไรเพิ่ม ──
  // เซิร์ฟเวอร์บันทึกลงฐานแบบ async — รอจนนิ่งก่อนจับภาพ ไม่งั้นงานของรอบ W ที่ยังเขียนไม่เสร็จจะดูเหมือนรอบ C ทำ
  for (let last = -1, i = 0; i < 40; i++) {
    const n = await events.countDocuments({});
    if (n === last) break;
    last = n;
    await sleep(500);
  }
  const before = await clipsCol.find({}).sort({ _id: 1 }).toArray();
  const evBefore = await events.countDocuments({});
  const tSnap = new Date();
  await kill();
  await boot('C');
  await sleep(1500);
  const after = await clipsCol.find({}).sort({ _id: 1 }).toArray();
  const changed = after.filter((a, i) => JSON.stringify(a) !== JSON.stringify(before[i])).map((a) => a._id);
  check('C · บูตซ้ำไม่แตะคลิปที่จัดการแล้ว', changed.length === 0,
    changed.map((id) => { const x = before.find((b) => b._id === id); return `${id} ${x?.station_id} ${x?.ordersn} ${x?.status}`; }).join(', '));
  const evAfter = await events.find({ at: { $gt: tSnap } }).toArray();
  check('C · ไม่มี clip_event เพิ่ม', evAfter.length === 0,
    evAfter.map((e) => `${e.event}:${e.clip_id}@${new Date(e.at).toISOString().slice(11, 19)}`).join(', '));
} catch (err) {
  check('สคริปต์ทำงานจนจบ', false, err.message);
  console.error(serverLog.join('').slice(-3000));
} finally {
  await kill();
  mongoProxyServer.close();
  await db.dropDatabase().catch(() => {});
  await client.close();
  await fs.rm(STORE, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน\n`);
process.exit(failed.length ? 1 : 0);
