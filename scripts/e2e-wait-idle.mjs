#!/usr/bin/env node
/**
 * ด่านก่อน deploy — scripts/wait-idle.mjs ต้องปล่อยผ่านเฉพาะตอนที่ไม่มีโต๊ะไหนอัดหรือรอชิ้นค้างอยู่
 *
 *   E2E_MONGO_URL=mongodb://127.0.0.1:27017/packvideo_e2e npm run e2e:wait-idle
 *
 * วันที่ 2026-10-01 รีสตาร์ท packvideo กลางกะ 3 ครั้ง คลิปที่กำลังอัดเสียทุกครั้ง
 * เปิดเซิร์ฟเวอร์เองบนพอร์ตชั่วคราว · ลบทั้งฐานตอนจบ จึงไม่ยอมรันกับฐาน packVideo
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
const PORT = 13397;
const BASE = `http://127.0.0.1:${PORT}`;
const STORE = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-idle-'));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
}

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT_DIR,
  env: { ...process.env, NODE_ENV: 'development', PORT: String(PORT), MONGO_URL, MONGO_DB: DB_NAME, PACK_VIDEO_PATH: STORE,
    CLOSE_GRACE_SEC: '2', SELLCENTER_JWT_SECRET: '', TELEGRAM_BOT_TOKEN: '' },
  stdio: 'ignore',
});

const signal = (station, fields) =>
  fetch(`${BASE}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: 'e2e', station_id: station, ...fields }),
  });

/** รันด่านจริงเป็น process แยก แล้วดู exit code กับเวลาที่ใช้ */
function gate(args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, ['scripts/wait-idle.mjs', ...args], {
      cwd: ROOT_DIR, env: { ...process.env, PACKVIDEO_URL: BASE }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, sec: Math.round((Date.now() - t0) / 100) / 10, out }));
  });
}

const client = await MongoClient.connect(MONGO_URL);
const db = client.db(DB_NAME);
try {
  await db.dropDatabase();
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* ยังไม่ขึ้น */ }
    await sleep(100);
  }

  // ── 1 · ไม่มีงาน → ผ่านเมื่อว่างต่อเนื่องครบเวลา ──
  const r1 = await gate(['--quiet', '2', '--timeout', '20']);
  check('1 · ไม่มีงานค้าง → ผ่าน (exit 0)', r1.code === 0, `exit ${r1.code} · ${r1.sec} วิ`);

  // ── 2 · มีคลิปกำลังอัด → ไม่ผ่านจนหมดเวลา ──
  await signal('desk-01', { event: 'start', trace_id: 'I1', value: '356938035640101' });
  await signal('desk-01', { event: 'commit', trace_id: 'I1', ordersn: 'IDLE-1' });
  await sleep(300);
  const st = (await (await fetch(`${BASE}/api/stations`)).json()).stations.find((s) => s.station_id === 'desk-01');
  check('2 · /api/stations บอกว่าโต๊ะมีคลิปเปิดอยู่', st?.open_clip === true, JSON.stringify({ open_clip: st?.open_clip, closing: st?.closing }));
  const r2 = await gate(['--quiet', '2', '--timeout', '4']);
  check('2 · มีคลิปกำลังอัด → ไม่ผ่าน (exit ≠ 0)', r2.code !== 0, `exit ${r2.code} · ${r2.sec} วิ`);

  // ── 3 · คลิปรอชิ้นค้าง (closing) → ยังไม่ผ่าน ──
  const id = (await (await fetch(`${BASE}/api/clips`)).json()).clips.find((c) => c.ordersn === 'IDLE-1').clip_id;
  await fetch(`${BASE}/api/clip/${id}/chunk/0`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(800, 1) });
  await fetch(`${BASE}/api/clip/${id}/finalise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chunks: 3 }) });
  const st3 = (await (await fetch(`${BASE}/api/stations`)).json()).stations.find((s) => s.station_id === 'desk-01');
  check('3 · /api/stations บอกจำนวนคลิปที่รอชิ้นค้าง', st3?.open_clip === false && st3?.closing === 1, JSON.stringify({ open_clip: st3?.open_clip, closing: st3?.closing }));
  const r3 = await gate(['--quiet', '2', '--timeout', '4']);
  check('3 · คลิปรอชิ้นค้าง → ไม่ผ่าน', r3.code !== 0, `exit ${r3.code} · ${r3.sec} วิ`);

  // ── 4 · ชิ้นมาครบ คลิปปิด → ผ่าน ──
  for (const seq of [1, 2]) {
    await fetch(`${BASE}/api/clip/${id}/chunk/${seq}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(800, seq) });
  }
  const r4 = await gate(['--quiet', '2', '--timeout', '20']);
  check('4 · งานจบแล้ว → ผ่าน', r4.code === 0, `exit ${r4.code} · ${r4.sec} วิ`);
} catch (err) {
  check('สคริปต์ทำงานจนจบ', false, err.message);
} finally {
  server.kill('SIGKILL');
  await db.dropDatabase().catch(() => {});
  await client.close();
  await fs.rm(STORE, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน\n`);
process.exit(failed.length ? 1 : 0);
