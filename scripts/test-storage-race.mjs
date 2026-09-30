#!/usr/bin/env node
/**
 * storageStatus() ต้องไม่รายงาน "เขียนไม่ได้" เพียงเพราะมีสองคำขอเรียกซ้อนกัน
 *
 *   npm run test:storage-race
 *
 * บั๊กเดิม: ตรวจการเขียนดิสก์ด้วยไฟล์ชื่อตายตัว `.probe-<pid>` สองการเรียกที่ทับกัน
 * ตัวหลัง unlink ไม่เจอไฟล์ (ENOENT) → writable=false → recording_allowed=false
 * แล้ว /api/stream ส่ง `config: recording:false` ให้หน้าต่างอัด ซึ่งหยุดอัดจนกว่าจะต่อใหม่
 *
 * ไม่ต้องมี server หรือ Mongo — ใช้โฟลเดอร์ชั่วคราวของตัวเอง ไม่แตะที่เก็บคลิปจริง
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-storage-race-'));
// config.js อ่าน env ตอน import — ต้องตั้งก่อน import storage.js
process.env.PACK_VIDEO_PATH = ROOT;
process.env.NODE_ENV = 'test';

const { storageStatus, ensureStorage } = await import('../src/lib/storage.js');
await ensureStorage();

const N = Number(process.env.N ?? 300);
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
}

console.log(`\nทดสอบ storageStatus() ซ้อนกัน · ${N} รอบต่อกรณี · ${ROOT}\n`);

// control: ถ้าข้อนี้ไม่ผ่าน แปลว่าเทสต์เองพัง (เช่นโฟลเดอร์ไม่พร้อม) ผลข้ออื่นเชื่อไม่ได้
{
  let bad = 0;
  for (let i = 0; i < N; i++) if (!(await storageStatus()).writable) bad++;
  check('control: เรียกทีละครั้ง เขียนได้ทุกรอบ', bad === 0, `พลาด ${bad}/${N}`);
}

async function overlap(offsetMs) {
  let bad = 0;
  for (let i = 0; i < N; i++) {
    const a = storageStatus();
    if (offsetMs > 0) await sleep(offsetMs);
    const b = storageStatus();
    const [ra, rb] = await Promise.all([a, b]);
    if (!ra.writable || !rb.writable || !ra.recording_allowed || !rb.recording_allowed) bad++;
  }
  return bad;
}

for (const off of [0, 0.5, 1]) {
  const bad = await overlap(off);
  check(`เรียกซ้อนกัน เหลื่อม ${off} ms ต้องเขียนได้ทั้งคู่`, bad === 0, `พลาด ${bad}/${N}`);
}

// เรียกพร้อมกันหลายตัว (โต๊ะทั้งหมดต่อ SSE พร้อมกันตอนเริ่มกะ)
{
  let bad = 0;
  for (let i = 0; i < Math.ceil(N / 10); i++) {
    const rs = await Promise.all(Array.from({ length: 12 }, () => storageStatus()));
    if (rs.some((r) => !r.writable)) bad++;
  }
  check('เรียกพร้อมกัน 12 ตัว ต้องเขียนได้ทุกตัว', bad === 0, `รอบที่พลาด ${bad}`);
}

// ไม่ทิ้งไฟล์ probe ค้างในที่เก็บ
{
  const left = (await fs.readdir(path.join(ROOT, '_tmp'))).filter((n) => n.startsWith('.probe'));
  check('ไม่มีไฟล์ probe ค้างใน _tmp', left.length === 0, left.join(',') || '');
}

await fs.rm(ROOT, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน`);
if (failed.length) {
  console.log(`\u001b[31mไม่ผ่าน: ${failed.map((f) => f.name).join(', ')}\u001b[0m\n`);
  process.exit(1);
}
console.log('\u001b[32mผ่านทั้งหมด\u001b[0m\n');
