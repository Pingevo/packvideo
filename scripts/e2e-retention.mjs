#!/usr/bin/env node
/**
 * ทดสอบงานลบข้อมูลตามกำหนด — งานเดียวในระบบที่ลบข้อมูลถาวร
 *
 *   npm run e2e:retention
 *
 * สร้างข้อมูลย้อนหลังจริงบนดิสก์และในฐานข้อมูล แล้วตรวจว่า
 *   · คลิปเก่าที่ไม่ติดเคสถูกลบ
 *   · คลิปเก่าที่ติดเคสถูกย้ายไป _pinned/ ไม่ถูกลบ
 *   · คลิปใหม่ไม่ถูกแตะ
 *   · metadata ยังอยู่ ตอบได้ว่า "เคยมี ลบเมื่อ…"
 *   · ย้ายไม่สำเร็จ → ไม่ลบอะไรเลยทั้งวัน
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const BASE = process.env.BASE ?? 'http://127.0.0.1:1338';
const ROOT = path.resolve(process.env.PACK_VIDEO_PATH ?? './data/pack_video');
const MONGO_URL = process.env.MONGO_URL;
const MONGO_DB = process.env.MONGO_DB ?? 'packVideo';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(MONGO_DB);
const clips = db.collection('clips');

const TAG = 'rtest';
const dayOf = (back) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dirOf = (day) => path.join(ROOT, ...day.split('-'));

async function makeClip({ id, day, pinned }) {
  const dir = dirOf(day);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.mp4`), Buffer.alloc(2048, 7));
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ clip_id: id }), 'utf8');
  await clips.insertOne({
    _id: id, station_id: 'desk-rtest', status: 'verified', day, pinned,
    ordersn: `${TAG}-${id}`, tracking_no: null, imeis: [], flags: [],
    pin_reasons: pinned ? ['case_opened'] : [],
    started_at: new Date(`${day}T03:00:00Z`), bytes: 2048,
    media_path: path.join(...day.split('-'), `${id}.mp4`),
  });
}

const exists = async (p) => fs.access(p).then(() => true, () => false);

console.log(`\nทดสอบงานลบข้อมูล — เก็บ 30 วัน\n`);

// ── เตรียมข้อมูล ────────────────────────────────────────────
await clips.deleteMany({ ordersn: { $regex: `^${TAG}-` } });
const OLD = dayOf(45);
const NEW = dayOf(2);
await fs.rm(dirOf(OLD), { recursive: true, force: true });
await fs.rm(dirOf(NEW), { recursive: true, force: true });

await makeClip({ id: `${TAG}_old_plain`, day: OLD, pinned: false });
await makeClip({ id: `${TAG}_old_pinned`, day: OLD, pinned: true });
await makeClip({ id: `${TAG}_new_plain`, day: NEW, pinned: false });

// ── ซ้อมก่อน ────────────────────────────────────────────────
const dry = await (await fetch(`${BASE}/api/retention/run`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
})).json();
check('ซ้อมแล้วไม่ลบอะไรจริง', await exists(path.join(dirOf(OLD), `${TAG}_old_plain.mp4`)),
  `จะลบ ${dry.deleted_days?.length ?? 0} วัน`);

// ── ลบจริง ──────────────────────────────────────────────────
const run = await (await fetch(`${BASE}/api/retention/run`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ confirm: true }),
})).json();

check('งานทำงานสำเร็จ', run.ok === true, `ลบ ${run.deleted_days?.length ?? 0} วัน · ย้าย ${run.moved_pinned} ไฟล์`);
check('คลิปเก่าที่ไม่ติดเคสถูกลบ', !(await exists(path.join(dirOf(OLD), `${TAG}_old_plain.mp4`))));
check('โฟลเดอร์วันเก่าถูกลบทั้งโฟลเดอร์', !(await exists(dirOf(OLD))));
check('คลิปเก่าที่ติดเคสถูกย้ายไป _pinned/',
  await exists(path.join(ROOT, '_pinned', `${TAG}_old_pinned.mp4`)));
check('metadata คู่ไฟล์ถูกย้ายตามไปด้วย',
  await exists(path.join(ROOT, '_pinned', `${TAG}_old_pinned.json`)));
check('คลิปใหม่ไม่ถูกแตะ', await exists(path.join(dirOf(NEW), `${TAG}_new_plain.mp4`)));

// ── metadata ต้องยังอยู่ ────────────────────────────────────
const gone = await clips.findOne({ _id: `${TAG}_old_plain` });
check('แถวของคลิปที่ถูกลบยังอยู่ในฐานข้อมูล', !!gone);
check('มี media_deleted_at ตอบได้ว่า "เคยมี ลบเมื่อ…"', !!gone?.media_deleted_at,
  gone?.media_deleted_at ? new Date(gone.media_deleted_at).toLocaleString('th-TH') : '');

const kept = await clips.findOne({ _id: `${TAG}_old_pinned` });
check('คลิปที่ติดเคสไม่มี media_deleted_at', !kept?.media_deleted_at);
check('path ของคลิปที่ติดเคสชี้ไป _pinned/', String(kept?.media_path).startsWith('_pinned'), kept?.media_path);

// ── ย้ายไม่สำเร็จ → ห้ามลบทั้งวัน ───────────────────────────
const OLD2 = dayOf(50);
await fs.rm(dirOf(OLD2), { recursive: true, force: true });
await makeClip({ id: `${TAG}_old2_plain`, day: OLD2, pinned: false });
await makeClip({ id: `${TAG}_old2_pinned`, day: OLD2, pinned: true });
// ทำให้ย้ายไม่ได้: เปลี่ยนโฟลเดอร์ปลายทางเป็นไฟล์ธรรมดา
const blocker = path.join(ROOT, '_pinned', `${TAG}_old2_pinned.mp4`);
await fs.mkdir(blocker, { recursive: true });   // โฟลเดอร์ชื่อชนกับไฟล์ปลายทาง

const blocked = await (await fetch(`${BASE}/api/retention/run`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ confirm: true }),
})).json();

check('ย้ายไม่สำเร็จ → ข้ามวันนั้น ไม่ลบ', (blocked.skipped ?? []).some((s) => s.day === OLD2),
  JSON.stringify(blocked.skipped ?? []));
check('คลิปที่ไม่ติดเคสของวันนั้นก็ยังอยู่ — ยอมไม่ลบดีกว่าลบผิด',
  await exists(path.join(dirOf(OLD2), `${TAG}_old2_plain.mp4`)));

// ── เก็บกวาด ────────────────────────────────────────────────
await fs.rm(blocker, { recursive: true, force: true });
await fs.rm(dirOf(OLD2), { recursive: true, force: true });
await fs.rm(dirOf(NEW), { recursive: true, force: true });
await fs.rm(path.join(ROOT, '_pinned', `${TAG}_old_pinned.mp4`), { force: true });
await fs.rm(path.join(ROOT, '_pinned', `${TAG}_old_pinned.json`), { force: true });
await clips.deleteMany({ ordersn: { $regex: `^${TAG}-` } });
await client.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน`);
if (failed.length) {
  console.log(`\x1b[31mไม่ผ่าน: ${failed.map((f) => f.name).join(', ')}\x1b[0m\n`);
  process.exit(1);
}
console.log('\x1b[32mผ่านทั้งหมด\x1b[0m\n');
