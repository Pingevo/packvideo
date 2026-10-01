#!/usr/bin/env node
/**
 * เซิร์ฟเวอร์ตายกลางคลิปแล้วบูตใหม่ — ต้องต่อชิ้นที่รับไว้แล้วเป็นไฟล์ ปิดเป็น unverified และปักหมุด
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

// ── เซิร์ฟเวอร์ ────────────────────────────────────────────────
let server = null;
let serverLog = [];

async function boot(label) {
  serverLog = [];
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      MONGO_URL,
      MONGO_DB: DB_NAME,
      PACK_VIDEO_PATH: STORE,
      SELLCENTER_JWT_SECRET: '',
      TELEGRAM_BOT_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [server.stdout, server.stderr]) s.on('data', (d) => serverLog.push(String(d)));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok && (await r.json()).checks?.mongo?.connected) return;
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
  const r1 = await waitFor(async () => {
    const c = await clipsCol.findOne({ _id: s1._id });
    return c?.status === 'unverified' && c.media_path ? c : null;
  });

  const s1All = Buffer.concat(s1Chunks);
  check('1 · คลิปที่ค้างถูกปิดเป็น unverified', r1?.status === 'unverified', r1?.status);
  check('1 · ต่อชิ้นที่รับไว้แล้วเป็นไฟล์', r1?.bytes === s1All.length, `${r1?.bytes} ไบต์`);
  check('1 · checksum ตรงกับชิ้นที่ต่อกัน', r1?.checksum === sha(s1All));
  const f1 = r1?.media_path ? await fs.readFile(path.join(STORE, r1.media_path)).catch(() => null) : null;
  check('1 · ไฟล์บนดิสก์ตรงทุกไบต์', !!f1 && f1.equals(s1All));
  check('1 · ปักหมุด (pinned) ไม่ใช่แค่ pin_reasons',
    r1?.pinned === true && r1?.pin_reasons?.includes('anomaly'), JSON.stringify(r1?.pin_reasons));
  check('1 · ติดป้าย server_restart + recovered',
    r1?.flags?.includes('server_restart') && r1?.flags?.includes('recovered'), JSON.stringify(r1?.flags));
  check('1 · ended_at ไม่ก่อน started_at', !!r1?.ended_at && r1.ended_at >= r1.started_at && r1.duration_ms >= 0,
    `${r1?.duration_ms} ms`);
  const side1 = r1?.media_path
    ? JSON.parse(await fs.readFile(path.join(STORE, r1.media_path.replace(/\.mp4$/, '.json')), 'utf8').catch(() => 'null'))
    : null;
  check('1 · .json คู่ตรงกับฐาน', side1?.status === 'unverified' && side1?.flags?.includes('recovered')
    && side1?.checksum === r1?.checksum);
  check('1 · ลบ _tmp ของคลิปแล้ว', !(await exists(path.join(TMP, s1._id))));
  const e1 = await events.findOne({ clip_id: s1._id, event: 'close' });
  check('1 · บันทึก clip_event close พร้อมเหตุผล', e1?.detail?.note === NOTE && e1?.detail?.chunks === 3);
  const late = await putChunk(s1._id, 3, chunk(3));
  check('1 · ชิ้นที่ส่งมาหลังบูตถูกตอบ 409 ให้ทิ้ง', late.status === 409, String(late.status));

  const r2 = await clipsCol.findOne({ _id: s2._id });
  check('2 · คลิปค้างที่ไม่มีชิ้น → unverified + empty + ปักหมุด',
    r2?.status === 'unverified' && r2?.flags?.includes('empty') && r2?.flags?.includes('server_restart')
      && r2?.pinned === true && !r2?.media_path, JSON.stringify(r2?.flags));

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

  // ── รอบ C: บูตซ้ำโดยไม่มีอะไรค้าง → ต้องไม่เขียนอะไรเพิ่ม ──
  const before = await clipsCol.find({}).sort({ _id: 1 }).toArray();
  const evBefore = await events.countDocuments({});
  await kill();
  await boot('C');
  await sleep(1500);
  const after = await clipsCol.find({}).sort({ _id: 1 }).toArray();
  const changed = after.filter((a, i) => JSON.stringify(a) !== JSON.stringify(before[i])).map((a) => a._id);
  check('C · บูตซ้ำไม่แตะคลิปที่จัดการแล้ว', changed.length === 0, changed.join(', '));
  check('C · ไม่มี clip_event เพิ่ม', (await events.countDocuments({})) === evBefore);
} catch (err) {
  check('สคริปต์ทำงานจนจบ', false, err.message);
  console.error(serverLog.join('').slice(-3000));
} finally {
  await kill();
  await db.dropDatabase().catch(() => {});
  await client.close();
  await fs.rm(STORE, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน\n`);
process.exit(failed.length ? 1 : 0);
