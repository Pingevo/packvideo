#!/usr/bin/env node
/**
 * โต๊ะจะถูกนับว่า "พร้อมอัด" ต่อเมื่อมีหน้าต่างอัดรับสัญญาณ SSE อยู่จริง — ไม่ใช่แค่มี heartbeat
 *
 *   npm run e2e:presence
 *
 * เหตุการณ์จริง (desk-05 · 23–25 ก.ย.): หน้าต่างอัดถูกพาไปหน้า /setup.html แล้วค้างอยู่
 * หน้าตั้งค่าส่ง heartbeat เอง โต๊ะจึงขึ้น "ต่ออยู่ · กล้องพร้อม" ทั้งวันทั้งที่ไม่มีใครรับ
 * สัญญาณ start จึงไม่มีวิดีโอเลย และแถบบนหน้าแพ็คกับ monitor ก็ไม่เตือน
 *
 * ต้องมี server รันอยู่ · เริ่มด้วย SSE_PING_MS=1000 จะทดสอบสัญญาณ ping ได้ด้วย (ไม่ตั้งก็ข้ามข้อนั้น)
 */

import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:1338';
const STATION = process.env.E2E_STATION ?? 'desk-01';
const CLIENT = `e2e-presence-${Date.now()}`;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
}

const j = async (u, init) => (await fetch(`${BASE}${u}`, init)).json();
const post = (u, body) => fetch(`${BASE}${u}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const signal = (fields) => fetch(`${BASE}/signal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ t: 'dev-token', station_id: STATION, ...fields }),
});
const desk = () => j(`/api/desk/${STATION}`);
const stationRow = async () => (await j('/api/stations')).stations.find((s) => s.station_id === STATION);
const clipByOrder = async (ordersn) => (await j('/api/clips')).clips.find((c) => c.ordersn === ordersn);

async function waitFor(fn, ms = 3000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}

/** เปิด SSE แบบเดียวกับ rec.html แล้วเก็บเหตุการณ์ไว้ */
async function openStream() {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/stream/${STATION}`, { signal: ac.signal });
  const events = [];
  let buf = '';
  void (async () => {
    try {
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          if (!event) continue;   // comment ล้วน
          events.push({ event, data: data ? JSON.parse(data) : null, at: Date.now() });
        }
      }
    } catch { /* ปิดเอง */ }
  })();
  return { events, close: () => ac.abort() };
}

console.log(`\nทดสอบ ${BASE} · โต๊ะ ${STATION}\n`);

// จับจองโต๊ะแล้วส่ง heartbeat แบบเดียวกับหน้า /setup.html (มีแค่ client_id)
await post(`/api/stations/${STATION}/claim`, { client_id: CLIENT, device_name: 'e2e-presence' });
await post(`/api/stations/${STATION}/heartbeat`, { client_id: CLIENT });

// ── 1 · ค้างหน้าตั้งค่า: มี heartbeat แต่ไม่มีใครฟัง SSE ──────
{
  const d = await desk();
  check('ไม่มีหน้าต่างอัดฟัง SSE → /api/desk บอก connected=false', d.connected === false, `connected=${d.connected}`);
  check('… และบอก listening=false', d.listening === false, `listening=${d.listening}`);
  check('… และกล้องไม่ถูกนับว่าพร้อม', d.camera_ready === false, `camera_ready=${d.camera_ready}`);

  // หน้าตั้งค่า/แผงตั้งค่าใช้ connected เป็น "ใครถือโต๊ะอยู่" — ความหมายเดิมต้องไม่เปลี่ยน
  const row = await stationRow();
  check('/api/stations ยังบอกว่าโต๊ะมีเครื่องถืออยู่ (connected=true)', row?.connected === true);
  check('… พร้อมบอกว่าไม่มีคนฟัง (listening=false)', row?.listening === false, `listening=${row?.listening}`);
}

// ── 2 · เริ่มคลิปตอนไม่มีใครรับสัญญาณ ต้องถูกตีธงทันที ────────
{
  await signal({ event: 'start', trace_id: 'e2e-norec', value: '111111111111111', user: 'e2e' });
  await signal({ event: 'commit', trace_id: 'e2e-norec', ordersn: 'E2ENORECORDER' });
  const clip = await waitFor(async () => {
    const c = await clipByOrder('E2ENORECORDER');
    return c?.flags.includes('no_recorder') ? c : null;
  }, 1500);
  check('start ที่ไม่มีใครรับ → คลิปติดธง no_recorder ทันที', !!clip, JSON.stringify((await clipByOrder('E2ENORECORDER'))?.flags));
  await signal({ event: 'abort', trace_id: 'e2e-norec', reason: 'e2e' });
  await sleep(150);
}

// ── 3 · มีหน้าต่างอัดฟังอยู่ → ปกติทุกอย่าง ─────────────────
const stream = await openStream();
{
  const cfg = await waitFor(() => stream.events.find((e) => e.event === 'config'), 2000);
  check('ต่อ SSE แล้วได้ config', !!cfg);
  check('config บอก recording เป็น boolean', typeof cfg?.data?.recording === 'boolean');

  await post(`/api/stations/${STATION}/heartbeat`, { client_id: CLIENT, camera_ready: true, recording: false });
  const d = await waitFor(async () => { const x = await desk(); return x.connected ? x : null; }, 1500);
  check('มีคนฟัง SSE + heartbeat → connected=true', d?.connected === true);
  check('… listening=true และกล้องพร้อม', d?.listening === true && d?.camera_ready === true,
    `listening=${d?.listening} camera_ready=${d?.camera_ready}`);

  await signal({ event: 'start', trace_id: 'e2e-rec', value: '222222222222222', user: 'e2e' });
  await signal({ event: 'commit', trace_id: 'e2e-rec', ordersn: 'E2EWITHRECORDER' });
  const got = await waitFor(() => stream.events.find((e) => e.event === 'start'), 1500);
  check('หน้าต่างอัดได้รับสัญญาณ start', !!got);
  const clip = await waitFor(() => clipByOrder('E2EWITHRECORDER'), 1500);
  check('คลิปที่มีคนรับ ไม่ติดธง no_recorder', !!clip && !clip.flags.includes('no_recorder'), JSON.stringify(clip?.flags));
  await signal({ event: 'abort', trace_id: 'e2e-rec', reason: 'e2e' });
  await sleep(150);

  // ping: ให้หน้าต่างอัดจับได้ว่าสายเงียบ (EventSource มองไม่เห็นบรรทัด comment)
  const pingMs = cfg?.data?.ping_ms;
  if (typeof pingMs === 'number' && pingMs <= 3000) {
    const p = await waitFor(() => stream.events.find((e) => e.event === 'ping'), pingMs * 2.5 + 1000, 100);
    check(`เซิร์ฟเวอร์ส่งเหตุการณ์ ping ทุก ${pingMs} ms`, !!p);
  } else {
    console.log(`\u001b[2m- ข้ามข้อ ping (ping_ms=${pingMs ?? 'ไม่มี'} · เริ่มเซิร์ฟเวอร์ด้วย SSE_PING_MS=1000 เพื่อทดสอบ)\u001b[0m`);
    check('config มี ping_ms ให้หน้าต่างอัดใช้ตั้งเวลาเฝ้าสาย', typeof pingMs === 'number', `ping_ms=${pingMs}`);
  }
}

// ── 4 · ปิดหน้าต่างอัด → โต๊ะต้องเลิกพร้อม ────────────────────
{
  stream.close();
  const row = await waitFor(async () => { const r = await stationRow(); return r?.listening === false ? r : null; }, 1500);
  check('ปิด SSE แล้ว listening=false ทันที (ภายใน 1.5 วินาที)', !!row, `listening=${(await stationRow())?.listening}`);

  // /api/desk ผ่อนปรน 5 วินาทีกันกะพริบตอนรีเฟรชหน้า — เกินนั้นต้องเลิกนับว่าพร้อม
  const d = await waitFor(async () => { const x = await desk(); return x.connected === false ? x : null; }, 9000, 200);
  check('… และ /api/desk เลิกนับว่าพร้อมหลังหมดช่วงผ่อนปรน', !!d, `connected=${(await desk()).connected}`);
}

await post(`/api/stations/${STATION}/release`, { client_id: CLIENT });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน`);
if (failed.length) {
  console.log(`\u001b[31mไม่ผ่าน: ${failed.map((f) => f.name).join(', ')}\u001b[0m\n`);
  process.exit(1);
}
console.log('\u001b[32mผ่านทั้งหมด\u001b[0m\n');
