#!/usr/bin/env node
/**
 * หน้าสถานะระบบต้องไม่เตือนผิด (R6.1) และแยกโต๊ะที่ไม่ได้บันทึกออกมา (R6.2 · R6.3)
 *
 *   npm run e2e:monitor     (ต้องมี Mongo — ตัวเลขคลิปวันนี้มาจากฐานข้อมูล)
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { commitRate, record, stationsSignalledSince, totals } from '../src/lib/metrics.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:1338';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

// ── ต้นเหตุเตือนผิด: ถามชั่วโมงเดียวแล้วประวัติทั้งหมดถูกตัดเหลือชั่วโมงเดียว ─────
{
  const realNow = Date.now;
  const t0 = realNow();
  Date.now = () => t0 - 2 * 3600_000;   // สัญญาณเมื่อ 2 ชั่วโมงก่อน
  record('tag', 'desk-idle');
  Date.now = () => t0;
  record('tag', 'desk-busy');
  commitRate(60 * 60 * 1000);
  totals();
  const seen = stationsSignalledSince(t0 - 3 * 3600_000);
  Date.now = realNow;
  check('ถามอัตราชั่วโมงล่าสุดแล้ว สัญญาณเก่า 2 ชม. ยังอยู่', seen.has('desk-idle'), [...seen].join(','));
}

if (process.env.SKIP_HTTP) process.exit(results.every((r) => r.ok) ? 0 : 1);

const HEAD = process.env.PACKVIDEO_COOKIE ? { Cookie: process.env.PACKVIDEO_COOKIE } : {};
const signal = (station, fields) => fetch(`${BASE}/signal`, { method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ t: 'x', station_id: station, ...fields }) });

// โต๊ะที่เริ่มคลิปโดยไม่มีหน้าต่างอัดฟัง → ต้องขึ้น "ต่ออยู่แต่ไม่ได้บันทึก" ไม่ใช่เขียว
await fetch(`${BASE}/api/stations/desk-mon/claim`, { method: 'POST', headers: { ...HEAD, 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_id: 'mon-client', device_name: 'ทดสอบ' }) });
await signal('desk-mon', { event: 'start', trace_id: 'mon-1', value: '1' });
await sleep(300);
const m = await (await fetch(`${BASE}/api/monitor`, { headers: HEAD })).json();
const st = (m.stations ?? []).find((s) => s.station_id === 'desk-mon');
check('โต๊ะต่ออยู่แต่ไม่มีวิดีโอ → state=no_video', st?.state === 'no_video', st?.state);
check('มีตัวเลขคลิปวันนี้จากฐานข้อมูล', typeof st?.today?.clips === 'number' && m.today?.ok === true, JSON.stringify(st?.today));
check('ไม่มีเตือน hookdead กับโต๊ะที่เพิ่งมีคลิป', !(m.findings ?? []).some((f) => f.key === 'hookdead:desk-mon'));
await signal('desk-mon', { event: 'abort', trace_id: 'mon-1' });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน\n`);
process.exit(failed.length ? 1 : 0);
