#!/usr/bin/env node
/**
 * เน็ตขาขึ้นช้า — ชิ้นวิดีโอมาถึงหลังสแกนปิดนานกว่า CLOSE_GRACE_SEC ต้องยังได้ครบ ไม่โดน 409 ทิ้ง
 *
 *   E2E_MONGO_URL=mongodb://127.0.0.1:27017/packvideo_e2e npm run e2e:late
 *
 * เปิดเซิร์ฟเวอร์เอง (node src/server.js) บนพอร์ตและโฟลเดอร์ชั่วคราว · ลบทั้งฐานตอนจบ จึงไม่ยอมรันกับฐาน packVideo
 *
 * เหตุการณ์จริง (2026-10-01 12:02–12:13): ชิ้นละ 15–40 วินาที เซิร์ฟเวอร์ปิดไฟล์ที่ 8 วินาทีหลังสแกนปิด
 * ชิ้นที่ตามมาได้ 409 หน้าต่างอัดลบทิ้งทั้งคลิป เหลือแต่ส่วนหัว 760 ไบต์ 14 คลิป และ monitor ไม่เตือน
 */

import { spawn } from 'node:child_process';
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
const PORT = Number(process.env.E2E_PORT ?? 13398);
const BASE = `http://127.0.0.1:${PORT}`;
const STORE = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-late-'));
const GRACE_SEC = 2;      // CLOSE_GRACE_SEC ของเซิร์ฟเวอร์ทดสอบ (จริง 8)
const IDLE_SEC = 8;       // LATE_CHUNK_IDLE_SEC ของเซิร์ฟเวอร์ทดสอบ (จริง 120) · ต้องนานกว่าช่วงห่างของชิ้นในเคส A
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
}

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT_DIR,
  env: {
    ...process.env, NODE_ENV: 'development', PORT: String(PORT), MONGO_URL, MONGO_DB: DB_NAME, PACK_VIDEO_PATH: STORE,
    CLOSE_GRACE_SEC: String(GRACE_SEC), LATE_CHUNK_IDLE_SEC: String(IDLE_SEC), SELLCENTER_JWT_SECRET: '', TELEGRAM_BOT_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
for (const s of [server.stdout, server.stderr]) s.on('data', (d) => serverLog.push(String(d)));

const client = await MongoClient.connect(MONGO_URL);
const db = client.db(DB_NAME);
const clipsCol = db.collection('clips');

const signal = (station, fields) =>
  fetch(`${BASE}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: 'dev-token', station_id: station, ...fields }),
  });
const put = (id, seq, buf) =>
  fetch(`${BASE}/api/clip/${id}/chunk/${seq}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
  });
const finalise = (id, body) =>
  fetch(`${BASE}/api/clip/${id}/finalise`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

// ส่วนหัวแบบที่ MediaRecorder ปล่อยเป็นชิ้นแรก (~760 ไบต์ ไม่มีภาพ) · ชิ้นถัดไปคือภาพ
function head() {
  const b = Buffer.alloc(760, 0);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
}
const frames = (seq, n = 200_000) => Buffer.alloc(n, seq);

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await sleep(100);
  }
}

/** เปิดคลิป ส่งส่วนหัว ผูกเลขพัสดุ แล้วสแกนปิด → เซิร์ฟเวอร์อยู่สถานะ closing */
async function openAndScan(station, ordersn, tracking) {
  await signal(station, { event: 'start', trace_id: ordersn, value: '35693803564' + ordersn.slice(-4) });
  await signal(station, { event: 'commit', trace_id: ordersn, ordersn });
  const c = await waitFor(() => clipsCol.findOne({ ordersn }));
  await put(c._id, 0, head());
  await signal(station, { event: 'tag', tracking_no: tracking });
  await sleep(200);
  await signal(station, { event: 'scan', value: tracking });
  return c._id;
}

try {
  await db.dropDatabase();
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok && (await r.json()).checks?.mongo?.connected) break;
    } catch { /* ยังไม่ขึ้น */ }
    await sleep(100);
  }
  console.log(`\nทดสอบชิ้นวิดีโอที่มาช้า · ${BASE} · grace ${GRACE_SEC}s · idle ${IDLE_SEC}s\n`);

  // ── A · หน้าต่างอัดรุ่นใหม่บอกจำนวนชิ้น แล้วชิ้นทยอยมาช้ากว่า grace หลายเท่า ──
  {
    const id = await openAndScan('desk-la', 'LATE-A', 'SPXLATEA');
    await sleep(700);
    const f = await finalise(id, { chunks: 3 });
    check('A · สั่งปิดพร้อมจำนวนชิ้น → ยังไม่ปิดไฟล์', (await f.json()).clip?.status === 'closing');
    await sleep((GRACE_SEC + 2) * 1000);                 // เลย grace ไปแล้ว
    const r1 = await put(id, 1, frames(1));
    await sleep((GRACE_SEC + 1) * 1000);
    const r2 = await put(id, 2, frames(2, 150_000));
    const tLast = Date.now();
    check('A · ชิ้นที่มาหลัง grace ยังรับ (ไม่ใช่ 409)', r1.status === 200 && r2.status === 200, `${r1.status} ${r2.status}`);
    const c = await waitFor(() => clipsCol.findOne({ _id: id, status: 'verified', media_path: { $ne: null } }));
    check('A · ได้ครบ 3 ชิ้นแล้วปิดเป็น verified', c?.chunks === 3 && c?.bytes === 760 + 200_000 + 150_000, `${c?.bytes} ไบต์`);
    const lag = c ? Date.parse(c.ended_at) - tLast : NaN;
    check('A · ปิดทันทีที่ครบ ไม่รอจนหมดเวลา', lag > -200 && lag < 1500, `${lag} ms หลังชิ้นสุดท้าย`);
    check('A · ไม่ติดป้าย incomplete', c && !c.flags.includes('incomplete'), JSON.stringify(c?.flags));
  }

  // ── B · บอกจำนวนชิ้นแล้วแต่มีชิ้นที่ไม่มาเลย → ปิดเมื่อเงียบเกิน idle และติดป้าย ──
  {
    const id = await openAndScan('desk-lb', 'LATE-B', 'SPXLATEB');
    await sleep(700);
    await finalise(id, { chunks: 3 });
    await sleep(1500);
    await put(id, 1, frames(1));
    const c = await waitFor(() => clipsCol.findOne({ _id: id, media_path: { $ne: null } }), (IDLE_SEC + 4) * 1000);
    check('B · เงียบเกิน idle → ปิดไฟล์ด้วยชิ้นที่มี', c?.status === 'verified' && c?.chunks === 2, `${c?.status} · ${c?.chunks} ชิ้น`);
    check('B · ติดป้าย incomplete และปักหมุด', c?.flags?.includes('incomplete') && c?.pinned === true, JSON.stringify(c?.flags));
    const late = await put(id, 2, frames(2));
    check('B · ชิ้นที่มาหลังปิดแล้วได้ 409', late.status === 409);
  }

  // ── C · หน้าต่างอัดรุ่นเก่า (ไม่บอกจำนวนชิ้น) → ปิดทันทีแบบเดิม ──
  {
    const id = await openAndScan('desk-lc', 'LATE-C', 'SPXLATEC');
    await sleep(700);
    const f = await finalise(id, {});
    const body = await f.json();
    check('C · ไม่บอกจำนวนชิ้น → ปิดทันทีแบบเดิม', body.clip?.status === 'verified', body.clip?.status);
    const late = await put(id, 1, frames(1));
    check('C · ชิ้นที่มาหลังปิดได้ 409 (พฤติกรรมเดิม)', late.status === 409);
  }

  // ── D · หน้าต่างอัดไม่ยืนยันเลย → grace เดิมยังปิดให้ ──
  {
    const id = await openAndScan('desk-ld', 'LATE-D', 'SPXLATED');
    const c = await waitFor(() => clipsCol.findOne({ _id: id, status: 'verified' }), (GRACE_SEC + 4) * 1000);
    check('D · ไม่มีใครยืนยัน → ปิดเองตาม grace', !!c, c?.status);
  }

  // ── E · ไฟล์มีแค่ส่วนหัว → นับเป็นไม่มีวิดีโอทั้ง monitor และหน้าค้นหา ──
  // ใช้โต๊ะที่อยู่ในรายชื่อ STATIONS ค่าเริ่มต้น เพราะ monitor แสดงตัวเลขรายโต๊ะเฉพาะโต๊ะในรายชื่อ
  {
    const id = await openAndScan('desk-06', 'LATE-E', 'SPXLATEE');
    await sleep(700);
    await finalise(id, { chunks: 1 });
    const c = await waitFor(() => clipsCol.findOne({ _id: id, media_path: { $ne: null } }));
    check('E · คลิปที่มีแค่ส่วนหัวมีไฟล์ 760 ไบต์', c?.bytes === 760);
    // ตัวเลขวันนี้แคช 30 วินาที (monitor รอบแรกตอนบูตเก็บค่า 0 ไว้) — รอจนแคชรอบใหม่
    const today = await waitFor(async () => {
      const m = await (await fetch(`${BASE}/api/monitor`)).json();
      const t = m.stations?.find((x) => x.station_id === 'desk-06')?.today;
      return t?.clips ? t : null;
    }, 40_000);
    check('E · monitor นับเป็นไม่มีวิดีโอ', today?.no_video === 1, JSON.stringify(today));
    const s = await (await fetch(`${BASE}/api/search?problem=no_video&station=desk-06`)).json();
    const row = (s.clips ?? []).find((x) => x.clip_id === id);
    check('E · หน้าค้นหากรอง "ไม่มีวิดีโอ" เจอคลิปนี้', row?.problem === 'no_video', row?.problem);
  }
} catch (err) {
  check('สคริปต์ทำงานจนจบ', false, err.message);
  console.error(serverLog.join('').slice(-3000));
} finally {
  server.kill('SIGKILL');
  await db.dropDatabase().catch(() => {});
  await client.close();
  await fs.rm(STORE, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน\n`);
process.exit(failed.length ? 1 : 0);
