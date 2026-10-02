#!/usr/bin/env node
/**
 * ด่านก่อน deploy/รีสตาร์ท packvideo — รอจนไม่มีโต๊ะไหนอัดหรือรอชิ้นค้างอยู่ต่อเนื่องครบเวลา แล้วค่อยปล่อยผ่าน
 *
 *   node scripts/wait-idle.mjs [--quiet 15] [--timeout 900]
 *   PACKVIDEO_URL=http://127.0.0.1:1338 (ค่าเริ่มต้น)
 *
 *   exit 0 = ว่างแล้ว รีสตาร์ทได้ · exit 1 = หมดเวลา ยังมีงาน · exit 2 = ถามเซิร์ฟเวอร์ไม่ได้
 *
 * วันที่ 2026-10-01 รีสตาร์ทกลางกะ 3 ครั้ง วิดีโอของคลิปที่กำลังอัดเสียทุกครั้ง ตอนนี้เซิร์ฟเวอร์รับคลิปค้าง
 * กลับมาทำต่อได้แล้ว แต่รีสตาร์ทตอนว่างยังปลอดภัยที่สุด · ดูจาก open_clip/closing ใน /api/stations
 * (สถานะฝั่งเซิร์ฟเวอร์ ไม่ใช่ heartbeat ที่ช้าได้ 30 วินาที) และ GET /api/stations ไม่ต้องล็อกอิน
 */

const BASE = process.env.PACKVIDEO_URL ?? 'http://127.0.0.1:1338';
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const QUIET_MS = arg('--quiet', 15) * 1000;
const TIMEOUT_MS = arg('--timeout', 900) * 1000;
const POLL_MS = 1000;

const t0 = Date.now();
let idleSince = null;
let lastLine = '';

for (;;) {
  let stations;
  try {
    const r = await fetch(`${BASE}/api/stations`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    stations = (await r.json()).stations ?? [];
  } catch (err) {
    console.error(`ถามสถานะโต๊ะจาก ${BASE} ไม่ได้: ${err.message}`);
    process.exit(2);
  }
  if (stations.some((s) => typeof s.open_clip !== 'boolean')) {
    // เซิร์ฟเวอร์รุ่นก่อนไม่บอก open_clip — ตัดสินไม่ได้ ห้ามเดาว่าว่าง
    console.error('เซิร์ฟเวอร์รุ่นนี้ไม่บอกงานค้างใน /api/stations — ตรวจเองก่อนรีสตาร์ท');
    process.exit(2);
  }

  const busy = stations.filter((s) => s.open_clip || s.closing > 0);
  const now = Date.now();
  if (busy.length) {
    idleSince = null;
    const line = 'ยังมีงาน: ' + busy.map((s) => `${s.station_id}${s.open_clip ? ' กำลังอัด' : ''}${s.closing ? ` รอชิ้น ${s.closing}` : ''}`).join(', ');
    if (line !== lastLine) console.log(line);
    lastLine = line;
  } else {
    idleSince ??= now;
    if (now - idleSince >= QUIET_MS) {
      console.log(`ว่างต่อเนื่อง ${Math.round(QUIET_MS / 1000)} วินาที — รีสตาร์ทได้`);
      process.exit(0);
    }
  }
  if (now - t0 >= TIMEOUT_MS) {
    console.error(`รอครบ ${Math.round(TIMEOUT_MS / 1000)} วินาทีแล้วยังมีงาน — ไม่รีสตาร์ท`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
