#!/usr/bin/env node
/**
 * ทดสอบควันของ P1-1 — ยิงจริงเข้า instance ที่รันอยู่
 *
 *   npm run smoke                       # ยิงไป http://127.0.0.1:1338
 *   BASE=https://packvideo… npm run smoke
 *
 * เจตนาให้รันบนเครื่องโต๊ะแพ็คได้ด้วย เพื่อปิด DoD ของ P1-1 ที่ระบุว่า
 * "เปิด /api/health จากเครื่องโต๊ะแพ็คได้"
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:1338';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '[32m✓[0m' : '[31m✗[0m';
  console.log(`${mark} ${name}${detail ? `  [2m${detail}[0m` : ''}`);
}

async function get(path) {
  const started = performance.now();
  const res = await fetch(`${BASE}${path}`);
  const ms = Math.round(performance.now() - started);
  let body = null;
  try { body = await res.json(); } catch { /* ไม่ใช่ JSON ก็ปล่อย */ }
  return { res, body, ms };
}

console.log(`\nทดสอบ ${BASE}\n`);

try {
  const live = await get('/api/health/live');
  check('/api/health/live ตอบ 200', live.res.status === 200, `${live.ms} ms`);
  check('มีชีวิตอยู่', live.body?.ok === true);

  const h = await get('/api/health');
  check('/api/health ตอบกลับได้', [200, 503].includes(h.res.status),
    `HTTP ${h.res.status} · ${h.ms} ms`);

  // health ถูกเรียกถี่ ถ้าช้าแปลว่ามี dependency ที่บล็อกอยู่
  check('/api/health ตอบภายใน 1 วินาที', h.ms < 1000, `${h.ms} ms`);

  const s = h.body?.checks?.storage;
  check('ที่เก็บคลิปเขียนได้', s?.writable === true, s?.path ?? '');
  check('อ่านสถานะดิสก์ได้', typeof s?.used_pct === 'number',
    s ? `ใช้ไป ${s.used_pct}% · เหลือ ${s.free_gb} GB · ระดับ ${s.disk_level}` : '');
  check('บันทึกได้ (ดิสก์ยังไม่ถึงระดับหยุด)', h.body?.recording_allowed === true);

  const m = h.body?.checks?.mongo;
  check('mongo ต่อได้', m?.ok === true, m?.ok ? `${m.latency_ms} ms` : (m?.error ?? ''));

  const nf = await get('/api/ไม่มีเส้นทางนี้');
  check('เส้นทางที่ไม่มีตอบ 404 เป็น JSON', nf.res.status === 404 && nf.body?.ok === false);
} catch (err) {
  check('เชื่อมต่อได้', false, err.message);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน`);
if (failed.length) {
  console.log(`[31mไม่ผ่าน: ${failed.map((f) => f.name).join(', ')}[0m\n`);
  process.exit(1);
}
console.log('[32mผ่านทั้งหมด[0m\n');
