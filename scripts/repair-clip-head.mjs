#!/usr/bin/env node
/**
 * ซ่อมคลิปที่มีไฟล์แต่เปิดไม่ได้ เพราะหน้าไฟล์เป็นชิ้นท้ายของคลิปก่อนหน้า
 *
 *   node --env-file=.env scripts/repair-clip-head.mjs            # ดูอย่างเดียว ไม่แก้อะไร
 *   node --env-file=.env scripts/repair-clip-head.mjs --apply    # บันทึกจริง
 *   ตัวเลือก: --from 2026-08-01  --limit 50  --verify (ตรวจด้วย ffprobe ว่าเปิดได้จริง)
 *
 * ต้นเหตุ: หน้าต่างอัดรุ่นก่อน 0.2.0 ติดป้ายชิ้นสุดท้ายของคลิปเก่าเป็นชิ้นแรกของคลิปใหม่
 * เมื่อสแกนออเดอร์ใหม่ขณะคลิปเก่ายังเปิด ไฟล์ใหม่จึงขึ้นต้นด้วย `moof` แทน `ftyp`
 * ตรวจจริงถึง 17 ก.ย. 2026: 324 จาก 6,221 คลิป (99% เกิดตอนสแกนทับ) · สุ่ม 10 คลิป
 * ข้ามส่วนหัวที่เกินแล้วเล่นได้ครบ 9
 *
 * **ไม่แตะไฟล์ .mp4 เลย** — checksum ของไฟล์ต้นฉบับคือสิ่งที่ทำให้ใช้เป็นหลักฐานได้
 * สคริปต์นี้แค่เขียน `media_offset` ลงเอกสารคลิป + ไฟล์ .json คู่ แล้วทุกทางที่อ่านไฟล์
 * (เล่น / ลิงก์ภายนอก / ส่งออก) ข้ามไบต์ส่วนนั้นเอง · บันทึก clip_event 'repair' ทุกคลิป
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';

const exec = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const APPLY = flag('--apply');
const VERIFY = flag('--verify');
const FROM = opt('--from');
const LIMIT = Number(opt('--limit')) || 0;
const ROOT = path.resolve(process.env.PACK_VIDEO_PATH ?? './data/pack_video');
const MONGO_URL = process.env.MONGO_URL;
const MONGO_DB = process.env.MONGO_DB ?? 'packVideo';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
// ชิ้นที่หลงมาใหญ่สุดที่เจอ ~480 KB · อ่าน 4 MB เผื่อเน็ตช้าจนชิ้นใหญ่
const SCAN_BYTES = 4 * 1024 * 1024;

if (!MONGO_URL) {
  console.error('ต้องตั้ง MONGO_URL (ใช้ --env-file=.env)');
  process.exit(2);
}

/** @returns {{state: 'ok'|'fixable'|'unfixable', offset?: number}} */
function inspect(buf) {
  if (buf.length < 8) return { state: 'unfixable' };
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return { state: 'ok' };           // WebM
  if (buf.toString('latin1', 4, 8) === 'ftyp') return { state: 'ok' };
  for (let at = buf.indexOf('ftyp'); at !== -1; at = buf.indexOf('ftyp', at + 1)) {
    if (at < 4) continue;
    const size = buf.readUInt32BE(at - 4);
    if (size >= 16 && size <= 64) return { state: 'fixable', offset: at - 4 };
  }
  return { state: 'unfixable' };
}

async function readHead(file) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(SCAN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, SCAN_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function probe(file, offset) {
  try {
    const { stdout } = await exec(FFPROBE, ['-v', 'error', '-skip_initial_bytes', String(offset),
      '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000 });
    const n = Number.parseFloat(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db(MONGO_DB);

const filter = {
  media_path: { $ne: null },
  media_deleted_at: null,
  media_offset: { $exists: false },
};
if (FROM) filter.day = { $gte: FROM };

const cursor = db.collection('clips').find(filter).sort({ started_at: 1 });
if (LIMIT) cursor.limit(LIMIT);

const tally = { checked: 0, ok: 0, fixable: 0, fixed: 0, unfixable: 0, missing: 0, verify_failed: 0 };
const rows = [];

for await (const clip of cursor) {
  tally.checked++;
  const file = path.join(ROOT, clip.media_path);
  if (!file.startsWith(ROOT)) continue;

  let head;
  try {
    head = await readHead(file);
  } catch {
    tally.missing++;
    continue;
  }

  const r = inspect(head);
  if (r.state === 'ok') { tally.ok++; continue; }
  if (r.state === 'unfixable') {
    tally.unfixable++;
    rows.push({ clip_id: clip._id, ordersn: clip.ordersn, result: 'ไม่พบส่วนหัวไฟล์ใน 4 MB แรก — ซ่อมไม่ได้' });
    continue;
  }

  tally.fixable++;
  let duration = null;
  if (VERIFY) {
    duration = await probe(file, r.offset);
    if (duration === null || duration < 0.5) {
      tally.verify_failed++;
      rows.push({ clip_id: clip._id, ordersn: clip.ordersn, result: `ข้าม ${r.offset} ไบต์แล้วยังเปิดไม่ได้ — ไม่บันทึก` });
      continue;
    }
  }

  rows.push({
    clip_id: clip._id,
    ordersn: clip.ordersn,
    result: `ข้าม ${r.offset} ไบต์${duration !== null ? ` → เล่นได้ ${duration.toFixed(1)} วิ` : ''}`,
  });
  if (!APPLY) continue;

  const at = new Date();
  await db.collection('clips').updateOne(
    { _id: clip._id, media_offset: { $exists: false } },
    { $set: { media_offset: r.offset, updated_at: at }, $addToSet: { flags: 'head_offset' } },
  );
  await db.collection('clip_events').insertOne({
    clip_id: clip._id,
    event: 'repair',
    station_id: clip.station_id ?? null,
    ordersn: clip.ordersn ?? null,
    tracking_no: clip.tracking_no ?? null,
    actor: 'scripts/repair-clip-head.mjs',
    detail: {
      media_offset: r.offset,
      reason: 'หน้าไฟล์เป็นชิ้นท้ายของคลิปก่อนหน้า (หน้าต่างอัดรุ่นก่อน 0.2.0) — ไม่ได้แก้ไฟล์ต้นฉบับ checksum เดิมยังใช้ได้',
      verified_duration_sec: duration,
    },
    at,
  });

  // ไฟล์ .json คู่คือความจริงเมื่อฐานข้อมูลหาย (D4) ต้องรู้เรื่อง offset ด้วย
  const sidecar = file.replace(/\.mp4$/, '.json');
  try {
    const meta = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    meta.media_offset = r.offset;
    meta.flags = [...new Set([...(meta.flags ?? []), 'head_offset'])];
    await fs.writeFile(sidecar, JSON.stringify(meta, null, 2), 'utf8');
  } catch { /* ไม่มีไฟล์คู่ ก็ไม่เป็นไร ฐานข้อมูลบันทึกแล้ว */ }

  tally.fixed++;
}

await client.close();

for (const r of rows) console.log(`${r.clip_id}  ${r.ordersn ?? '—'}  ${r.result}`);
console.log('\nสรุป', tally);
if (!APPLY && tally.fixable) console.log('\nยังไม่ได้บันทึก — รันซ้ำพร้อม --apply (แนะนำใส่ --verify ด้วย)');
