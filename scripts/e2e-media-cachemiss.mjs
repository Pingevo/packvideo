#!/usr/bin/env node
/**
 * ทดสอบการสตรีมคลิปที่อยู่ในฐานข้อมูลแต่ไม่อยู่ใน memory — สถานะหลัง restart
 *
 *   npm run e2e:media
 *
 * บั๊กที่ทดสอบ: /media/:clipId กับ /api/clips/:clipId เคยอ่านจากแคชใน memory
 * อย่างเดียว ซึ่งถูกเคลียร์ทุกครั้งที่ restart คลิปที่อัดก่อนรอบ restart จึงเล่นไม่ได้
 * (404) ทั้งที่ไฟล์ยังอยู่และดาวน์โหลดได้ เพราะเส้นทาง export ใช้ MongoDB อยู่แล้ว
 *
 * ทดสอบนี้จำลองสถานะหลัง restart โดยแทรกเอกสารคลิปเข้า MongoDB ตรงๆ
 * ข้ามแคชใน memory ของ process ปัจจุบัน แล้วยิง /media/ ดูว่าสตรีมได้ (206)
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:1338';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

// คำนวณ day + dir ล้อ convention ของ clips.js (y/m/d)
function dayParts(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return { day: `${y}-${m}-${d}`, dir: path.join(String(y), m, d) };
}

const RAND = Math.random().toString(36).slice(2, 10);
const CLIP_ID = `c_e2e_cachemiss_${RAND}`;
const now = new Date();
const { day, dir } = dayParts(now);
const MEDIA_REL = path.join(dir, `${CLIP_ID}.mp4`);
const STORAGE = path.resolve(config.storage.path);
const FULL = path.join(STORAGE, MEDIA_REL);
const PAYLOAD = Buffer.from(new Uint8Array(2000).fill(0xab));

let client = null;
let inserted = false;
let written = false;

async function cleanup() {
  try {
    if (client) {
      const db = client.db(config.mongo.dbName);
      await db.collection('clips').deleteOne({ _id: CLIP_ID }).catch(() => {});
      await client.close().catch(() => {});
    }
  } catch { /* ทำความสะอาดเท่าที่ทำได้ */ }
  try {
    if (written) await fsp.rm(FULL, { force: true });
  } catch { /* ไม่สำคัญ */ }
}

console.log(`\nทดสอบ ${BASE} — สตรีมคลิปนอกแคช memory\n`);

try {
  // ── เตรียมไฟล์ + เอกสารฐานข้อมูล ข้ามแคชใน memory ──────────────
  await fsp.mkdir(path.dirname(FULL), { recursive: true });
  await fsp.writeFile(FULL, PAYLOAD);
  written = true;

  client = new MongoClient(config.mongo.url, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000 });
  await client.connect();
  const db = client.db(config.mongo.dbName);

  await db.collection('clips').insertOne({
    _id: CLIP_ID,
    station_id: 'desk-e2e-cachemiss',
    packer: 'e2e',
    status: 'verified',
    ordersn: `E2ECACHEMISS${RAND}`,
    tracking_no: null,
    imeis: [],
    flags: [],
    pinned: false,
    pin_reasons: [],
    day,
    started_at: now,
    ended_at: new Date(now.getTime() + 1000),
    duration_ms: 1000,
    bytes: PAYLOAD.length,
    checksum: 'sha256:' + PAYLOAD.toString('hex'),
    media_path: MEDIA_REL,
    media_deleted_at: null,
    updated_at: new Date(),
  });
  inserted = true;

  // ให้ event loop สักครู่ ไม่จำเป็นแต่ปลอดภัย
  await sleep(50);

  // ── หลักฐานว่าคลิปไม่อยู่ใน memory: /api/clips ไม่ต้องเจอ แต่ /api/search ต้องเจอ ──
  const search = await (await fetch(`${BASE}/api/search?q=E2ECACHEMISS${RAND}`)).json();
  check('ค้นเจอคลิปจาก MongoDB', search.ok && search.count === 1, `count=${search.count}`);

  // ── สิ่งที่เคยพัง: /media/ ตอบ 404 เพราะอ่าน memory อย่างเดียว ──────────
  const part = await fetch(`${BASE}/media/${CLIP_ID}`, { headers: { Range: 'bytes=0-999' } });
  const partBuf = Buffer.from(await part.arrayBuffer());
  check('สตรีมคลิปนอกแคช memory ได้ 206', part.status === 206, `HTTP ${part.status}`);
  check('ได้ข้อมูลตรงช่วงที่ขอ', partBuf.length === 1000 && partBuf[0] === 0xab,
    `${partBuf.length} ไบต์`);

  // ── /api/clips/:clipId ก็ต้องเจอเช่นกัน ──────────────────────
  const meta = await (await fetch(`${BASE}/api/clips/${CLIP_ID}`)).json();
  check('ดึง metadata คลิปนอกแคช memory ได้', meta.ok && meta.clip?.clip_id === CLIP_ID,
    `ok=${meta.ok}`);
} catch (err) {
  check('ทดสอบทำงานได้ (ไม่พังกลางคัน)', false, err.message);
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} ผ่าน${failed ? ` — ${failed} ข้อตก` : ''}`);
process.exit(failed ? 1 : 0);
