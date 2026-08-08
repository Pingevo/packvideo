#!/usr/bin/env node
/**
 * ทดสอบวงจรชีวิตคลิปแบบครบวง โดยไม่ต้องมีเบราว์เซอร์หรือกล้อง
 *
 *   npm run e2e
 *
 * จำลองทั้งสองฝั่งพร้อมกัน: hook.js ยิงสัญญาณ และหน้าต่างอัดส่งชิ้นวิดีโอ
 * แล้วตรวจว่าไฟล์กับ metadata ลงดิสก์ถูกต้อง
 */

import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:1338';
const STATION = 'desk-e2e';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[32m✓[0m' : '[31m✗[0m'} ${name}${detail ? `  [2m${detail}[0m` : ''}`);
}

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

const getClips = async () => (await (await fetch(`${BASE}/api/clips`)).json()).clips ?? [];
const findByTrace = async (ordersn) => (await getClips()).find((c) => c.ordersn === ordersn);

console.log(`\nทดสอบ ${BASE}\n`);

// ── 1 · เส้นทางปกติ: สแกน → ยืนยัน → ใบปะหน้า → สแกนปิด ─────
{
  const trace = 'e2e-happy';
  await signal({ event: 'start', trace_id: trace, value: '356938035643809', user: 'ผู้ทดสอบ' });
  await sleep(150);

  let clip = (await getClips()).find((c) => c.station_id === STATION);
  check('สแกนแล้วได้คลิปสถานะ pending', clip?.status === 'pending', clip?.clip_id);
  const clipId = clip?.clip_id;

  // ส่งชิ้นวิดีโอ 5 ชิ้น รวม 5,000 ไบต์
  for (let i = 0; i < 5; i++) await putChunk(clipId, i, new Uint8Array(1000).fill(i + 1));

  await signal({ event: 'commit', trace_id: trace, ordersn: '250808E2E001', imei_complete: 'true' });
  await sleep(120);
  clip = await findByTrace('250808E2E001');
  check('ยืนยันแล้วสถานะเป็น recording', clip?.status === 'recording');

  await signal({ event: 'tag', tracking_no: 'SPX999888777' });
  await sleep(120);
  clip = await findByTrace('250808E2E001');
  check('ผูกเลขพัสดุเข้าคลิปเดิมได้', clip?.tracking_no === 'SPX999888777');

  // สแกนเลขที่ต่างจากที่จำไว้ → ต้องเตือน ไม่ใช่ปิดคลิป
  await signal({ event: 'scan', value: 'SPX111111111' });
  await sleep(120);
  clip = await findByTrace('250808E2E001');
  check('สแกนใบปะหน้าผิด → เตือนและคลิปยังอัดต่อ',
    clip?.status === 'recording' && clip?.flags.includes('mismatch'));

  // สแกนเลขที่ตรง (มีขีดคั่นด้วย ต้องยังตรงอยู่)
  await signal({ event: 'scan', value: 'SPX-999-888-777' });
  await sleep(400);
  clip = await findByTrace('250808E2E001');
  check('สแกนตรง → ปิดคลิปเป็น verified', clip?.status === 'verified', clip?.status);
  check('รวมชิ้นวิดีโอครบ 5,000 ไบต์', clip?.bytes === 5000, `${clip?.bytes} ไบต์`);
  check('มี checksum ของไฟล์ต้นฉบับ', String(clip?.checksum ?? '').startsWith('sha256:'));
  check('คลิปที่เคยเตือนใบปะหน้าผิดถูก pin อัตโนมัติ', clip?.pinned === true);

  // ── สตรีมกลับพร้อม Range ──
  const full = await fetch(`${BASE}/media/${clipId}`);
  check('ดึงคลิปกลับมาได้', full.status === 200 && full.headers.get('content-type') === 'video/mp4');
  check('ประกาศว่ารองรับ Range', full.headers.get('accept-ranges') === 'bytes');

  const part = await fetch(`${BASE}/media/${clipId}`, { headers: { Range: 'bytes=1000-1999' } });
  const partBuf = Buffer.from(await part.arrayBuffer());
  check('ขอช่วงกลางไฟล์ได้ 206', part.status === 206, part.headers.get('content-range'));
  check('ได้ข้อมูลตรงช่วงที่ขอ', partBuf.length === 1000 && partBuf[0] === 2);

  const bad = await fetch(`${BASE}/media/${clipId}`, { headers: { Range: 'bytes=99999-' } });
  check('ขอช่วงเกินไฟล์ได้ 416', bad.status === 416);
}

// ── 2 · ทิ้งคลิปเมื่อสแกนผิด ────────────────────────────────
{
  const trace = 'e2e-abort';
  await signal({ event: 'start', trace_id: trace, value: '111111111111111' });
  await sleep(120);
  const clipId = (await getClips()).find((c) => c.station_id === STATION && c.status === 'pending')?.clip_id;
  await putChunk(clipId, 0, new Uint8Array(500).fill(9));

  await signal({ event: 'abort', trace_id: trace, reason: 'not_found' });
  await sleep(250);
  const clip = (await getClips()).find((c) => c.clip_id === clipId);
  check('ไม่พบออเดอร์ → ทิ้งคลิป', clip?.status === 'aborted');
  check('คลิปที่ถูกทิ้งไม่มีไฟล์บนดิสก์', !clip?.media_path);
}

// ── 3 · สแกนตัวใหม่ทับตัวเก่าที่ยังไม่ปิด ───────────────────
{
  await signal({ event: 'start', trace_id: 'e2e-old', value: '222222222222222' });
  await sleep(100);
  await signal({ event: 'commit', trace_id: 'e2e-old', ordersn: '250808E2EOLD' });
  await sleep(100);
  const oldId = (await findByTrace('250808E2EOLD'))?.clip_id;
  await putChunk(oldId, 0, new Uint8Array(300).fill(7));

  await signal({ event: 'start', trace_id: 'e2e-new', value: '333333333333333' });
  await sleep(350);

  const old = (await getClips()).find((c) => c.clip_id === oldId);
  check('สแกนตัวใหม่ทับ → ตัวเก่าถูกปิดเป็น unverified', old?.status === 'unverified', old?.status);
  check('คลิป unverified ถูก pin อัตโนมัติ', old?.pinned === true);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน`);
if (failed.length) {
  console.log(`[31mไม่ผ่าน: ${failed.map((f) => f.name).join(', ')}[0m\n`);
  process.exit(1);
}
console.log('[32mผ่านทั้งหมด[0m\n');
