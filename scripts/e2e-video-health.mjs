#!/usr/bin/env node
/**
 * ทดสอบสามบั๊กที่ทำให้หลักฐานเสียจริงถึง 17 ก.ย. 2026 และตัวเตือน "ไม่ได้บันทึกวิดีโอ"
 *
 *   NO_VIDEO_ALERT_SEC=2 CLOSE_GRACE_SEC=2 STATIONS=desk-vh npm start
 *   npm run e2e:video
 *
 * ต้องตั้ง STATIONS ให้มี desk-vh เพราะ /api/desk ตอบเฉพาะโต๊ะที่อยู่ในทะเบียน
 * และตั้งเวลาสั้นลงไม่งั้นต้องรอ 8 วินาทีต่อข้อ
 */

import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:1338';
const STATION = process.env.STATION ?? 'desk-vh';
const NO_VIDEO_SEC = Number(process.env.NO_VIDEO_ALERT_SEC ?? 2);
const GRACE_SEC = Number(process.env.CLOSE_GRACE_SEC ?? 2);
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

const signal = (fields) =>
  fetch(`${BASE}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: 'dev-token', station_id: STATION, ...fields }),
  });

const putChunk = (clipId, seq, buf) =>
  fetch(`${BASE}/api/clip/${clipId}/chunk/${seq}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });

const finalise = (clipId, body = {}) =>
  fetch(`${BASE}/api/clip/${clipId}/finalise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const desk = async () => (await fetch(`${BASE}/api/desk/${STATION}`)).json();
const clipsOf = async () => ((await (await fetch(`${BASE}/api/clips?limit=500`)).json()).clips ?? [])
  .filter((c) => c.station_id === STATION);
const clipByOrder = async (ordersn) => (await clipsOf()).find((c) => c.ordersn === ordersn);
const newestId = async () => (await clipsOf()).sort((a, b) => b.started_at.localeCompare(a.started_at))[0]?.clip_id;

/** กล่อง ftyp จริง 24 ไบต์ + ข้อมูลตามหลัง — พอให้ตัวหาหัวไฟล์จำได้ */
function ftypChunk(fill, size = 1000) {
  const b = Buffer.alloc(size, fill);
  b.writeUInt32BE(24, 0);
  b.write('ftypisom', 4, 'latin1');
  return b;
}
/** ชิ้นกลางคลิปของ fragmented MP4 — ขึ้นต้นด้วย moof ไม่มีหัวไฟล์ */
function moofChunk(fill, size = 1000) {
  const b = Buffer.alloc(size, fill);
  b.writeUInt32BE(size, 0);
  b.write('moof', 4, 'latin1');
  return b;
}

/** เปิดช่องรับสัญญาณแบบเดียวกับหน้าต่างอัด */
function listen() {
  const ctrl = new AbortController();
  const events = [];
  const ready = fetch(`${BASE}/api/stream/${STATION}`, { signal: ctrl.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
      }
    }
  }).catch(() => {});
  return { events, close: () => ctrl.abort(), ready };
}

console.log(`\nทดสอบ ${BASE} · โต๊ะ ${STATION}\n`);

// ── 1 · ไม่มีหน้าต่างอัดฟังอยู่ → แดงทันที ─────────────────────
{
  await signal({ event: 'start', trace_id: 'vh-nolisten', value: '350000000000001' });
  await sleep(200);
  const d = await desk();
  check('เริ่มคลิปตอนไม่มีหน้าต่างอัดฟัง → video_ok=false ทันที',
    d.video_ok === false && d.video_problem === 'no_recorder', `${d.video_problem} · ${d.video_problem_text}`);
  await signal({ event: 'abort', trace_id: 'vh-nolisten', reason: 'test' });
}

const sse = listen();
await sleep(300);

// ── 2 · มีหน้าต่างอัดแต่ไม่มีชิ้นเข้า → แดงหลัง N วินาที · ชิ้นมา → เขียว ──
{
  await signal({ event: 'start', trace_id: 'vh-nochunk', value: '350000000000002' });
  await sleep(300);
  const id = await newestId();
  // ชิ้นแรกยังไม่มา แต่ปัญหาเก่าจากข้อ 1 ยังค้าง — ต้องไม่หายเองจนกว่าจะมีภาพจริง
  await sleep(NO_VIDEO_SEC * 1000 + 700);
  let d = await desk();
  check(`ครบ ${NO_VIDEO_SEC} วินาทีไม่มีชิ้นวิดีโอ → ยังแดง`, d.video_ok === false, d.video_problem_text);

  const r = await putChunk(id, 0, ftypChunk(1));
  d = await desk();
  check('ชิ้นวิดีโอมาถึง → กลับเป็นปกติทันที', r.status === 200 && d.video_ok === true, `chunk ${r.status}`);
  await signal({ event: 'abort', trace_id: 'vh-nochunk', reason: 'test' });
}

// ── 3 · ท้ายคลิป: ชิ้นสุดท้ายที่มาหลังสแกนปิดต้องถูกเก็บ ─────────
{
  await signal({ event: 'start', trace_id: 'vh-tail', value: '350000000000003' });
  await sleep(200);
  const id = await newestId();
  await putChunk(id, 0, ftypChunk(1));
  await putChunk(id, 1, moofChunk(2));
  await signal({ event: 'commit', trace_id: 'vh-tail', ordersn: 'VH-TAIL' });
  await signal({ event: 'tag', tracking_no: 'VHTAIL001' });
  await sleep(150);
  await signal({ event: 'scan', value: 'VHTAIL001' });
  await sleep(300);
  // หน้าต่างอัดปล่อยชิ้นสุดท้ายหลัง stop — ช้ากว่าสัญญาณหยุดเสมอ
  const late = await putChunk(id, 2, moofChunk(3));
  await finalise(id);
  await sleep(300);
  const c = await clipByOrder('VH-TAIL');
  check('ชิ้นสุดท้ายหลังสแกนปิดถูกรับ (ไม่ใช่ 409)', late.status === 200, `HTTP ${late.status}`);
  check('ไฟล์รวมครบ 3 ชิ้น', c?.bytes === 3000, `${c?.bytes} ไบต์`);
  check('finalise โดยไม่ส่งสถานะ ใช้สถานะที่ตัดสินตอนสแกน (verified)', c?.status === 'verified', c?.status);
}

// ── 4 · สแกนออเดอร์ใหม่ทับ: ชิ้นท้ายคลิปเก่ายังเข้าคลิปเก่า ────────
{
  await signal({ event: 'start', trace_id: 'vh-old', value: '350000000000004' });
  await sleep(200);
  await signal({ event: 'commit', trace_id: 'vh-old', ordersn: 'VH-OLD' });
  await sleep(150);
  const oldId = (await clipByOrder('VH-OLD'))?.clip_id;
  await putChunk(oldId, 0, ftypChunk(4));

  await signal({ event: 'start', trace_id: 'vh-new', value: '350000000000005' });
  await sleep(250);
  const newId = await newestId();
  const oldTail = await putChunk(oldId, 1, moofChunk(5));
  check('คลิปใหม่เริ่มแล้ว ชิ้นท้ายของคลิปเก่ายังรับ', oldTail.status === 200 && newId !== oldId, `HTTP ${oldTail.status}`);

  const stopEv = sse.events.find((e) => e.ev === 'stop' && e.data?.clip_id === oldId);
  check('ส่งสัญญาณหยุดของคลิปเก่าพร้อม clip_id ให้หน้าต่างอัด', !!stopEv);

  await sleep(GRACE_SEC * 1000 + 800);
  const old = (await clipsOf()).find((c) => c.clip_id === oldId);
  check('หน้าต่างอัดไม่ยืนยัน → ปิดเองหลังรอ', old?.status === 'unverified', old?.status);
  check('คลิปเก่าได้ชิ้นท้ายครบ', old?.bytes === 2000, `${old?.bytes} ไบต์`);

  await putChunk(newId, 0, ftypChunk(6));
  await signal({ event: 'abort', trace_id: 'vh-new', reason: 'test' });
}

// ── 5 · ไฟล์ที่ขึ้นต้นด้วยชิ้นของคลิปอื่น → ตัดออกให้เปิดได้ ────────
{
  await signal({ event: 'start', trace_id: 'vh-head', value: '350000000000006' });
  await sleep(200);
  await signal({ event: 'commit', trace_id: 'vh-head', ordersn: 'VH-HEAD' });
  await sleep(150);
  const id = (await clipByOrder('VH-HEAD'))?.clip_id;
  // จำลองหน้าต่างอัดรุ่นเก่า: ชิ้น 0 คือท้ายคลิปก่อน, ชิ้น 1 คือหัวไฟล์จริง
  await putChunk(id, 0, moofChunk(7, 700));
  await putChunk(id, 1, ftypChunk(8));
  await putChunk(id, 2, moofChunk(9));
  await finalise(id, { status: 'manual_stop' });
  await sleep(300);
  const c = await clipByOrder('VH-HEAD');
  const head = Buffer.from(await (await fetch(`${BASE}/media/${id}`, { headers: { Range: 'bytes=0-11' } })).arrayBuffer());
  check('ตัดชิ้นของคลิปอื่นหน้าไฟล์ออก', c?.bytes === 2000 && c?.flags.includes('head_trimmed'), `${c?.bytes} ไบต์ · ${c?.flags}`);
  check('ไฟล์ขึ้นต้นด้วย ftyp', head.toString('latin1', 4, 8) === 'ftyp', head.toString('latin1', 4, 8));
}

// ── 6 · ว่างติดกัน ≥3 → แดงค้างที่หน้าแพ็ค + เตือนหัวหน้า ────────
{
  for (let i = 0; i < 3; i++) {
    await signal({ event: 'start', trace_id: `vh-empty-${i}`, value: `35000000000001${i}` });
    await sleep(200);
    await signal({ event: 'commit', trace_id: `vh-empty-${i}`, ordersn: `VH-EMPTY-${i}` });
    await sleep(NO_VIDEO_SEC * 1000 + 300);
    const id = (await clipByOrder(`VH-EMPTY-${i}`))?.clip_id;
    await finalise(id, { status: 'manual_stop' });
    await sleep(150);
  }
  let d = await desk();
  check('ว่างติดกัน 3 ออเดอร์ → แถบบนหน้าแพ็คแดง', d.video_ok === false && d.empty_streak === 3, d.video_problem_text);

  const mon = await (await fetch(`${BASE}/api/monitor`)).json();
  check('หน้า monitor มีรายการ novideo', mon.findings?.some((f) => f.key === `video:${STATION}`));
  check('ส่งแจ้งเตือนหัวหน้าคลัง', mon.alerts?.some((a) => a.key === `novideo:${STATION}`),
    mon.alerts?.find((a) => a.key === `novideo:${STATION}`)?.text);

  // คลิปสั้นกว่า N วินาทีที่ว่าง (สแกนทับเร็ว) ต้องไม่นับเป็นกล้องดับ
  await signal({ event: 'start', trace_id: 'vh-quick', value: '350000000000020' });
  await sleep(150);
  const quick = await newestId();
  await finalise(quick, { status: 'manual_stop' });
  await sleep(150);
  d = await desk();
  check('คลิปว่างสั้นๆ ไม่นับเพิ่ม', d.empty_streak === 3, `streak ${d.empty_streak}`);

  await signal({ event: 'start', trace_id: 'vh-back', value: '350000000000021' });
  await sleep(200);
  const back = await newestId();
  await putChunk(back, 0, ftypChunk(1));
  d = await desk();
  check('ภาพกลับมา → แถบหายแดงทันทีโดยไม่ต้องรอปิดกล่อง', d.video_ok === true, d.video_problem_text ?? 'ok');
  await finalise(back, { status: 'manual_stop' });
  await sleep(200);
  const after = await (await fetch(`${BASE}/api/monitor`)).json();
  d = await desk();
  check('ปิดคลิปที่มีภาพ → รีเซ็ตนับ + แจ้ง "กลับมาแล้ว"',
    d.empty_streak === 0 && after.alerts?.some((a) => a.key === `novideo-ok:${STATION}`));
}

sse.close();

// ── 7 · หน้าต่างอัดรุ่นเก่า ───────────────────────────────────
{
  const d = await desk();
  check('/api/desk บอก recorder_outdated ได้', typeof d.recorder_outdated === 'boolean', String(d.recorder_outdated));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน\n`);
process.exit(failed.length ? 1 : 0);
