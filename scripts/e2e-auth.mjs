#!/usr/bin/env node
/**
 * ทดสอบการล็อกอินด้วยบัญชี sellcenter (R3)
 *
 *   SELLCENTER_JWT_SECRET=e2e-secret PACKVIDEO_API_KEY=e2e-key npm start
 *   SELLCENTER_JWT_SECRET=e2e-secret PACKVIDEO_API_KEY=e2e-key npm run e2e:auth
 *
 * สร้าง JWT แบบเดียวกับ AuthenController ของ sellcenter (HS256 · name/emp_id/group · หมดอายุ 9 ชม.)
 */
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE ?? 'http://127.0.0.1:1338';
const SECRET = process.env.SELLCENTER_JWT_SECRET ?? 'e2e-secret';
const API_KEY = process.env.PACKVIDEO_API_KEY ?? 'e2e-key';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(payload, { secret = SECRET, alg = 'HS256' } = {}) {
  const head = b64({ alg, typ: 'JWT' });
  const body = b64(payload);
  const sig = alg === 'none' ? '' : crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
// เครื่องทดสอบอาจไม่มี Mongo — 503 แปลว่าผ่านด่านล็อกอินไปแล้วแต่ต่อฐานไม่ได้ ไม่ใช่โดนกั้น
const passedGate = (status) => status !== 401 && status !== 302;
const now = Math.floor(Date.now() / 1000);
const good = jwt({ name: 'สมชาย ทดสอบ (Test)', emp_id: '999', group: ['delivery'], iat: now, exp: now + 9 * 3600 });
const get = (path, cookie, headers = {}) =>
  fetch(BASE + path, { redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });

console.log(`\nทดสอบล็อกอิน ${BASE}\n`);

// ── ไม่ได้ล็อกอิน ─────────────────────────────────────────────
{
  let r = await get('/api/search?limit=1');
  check('ไม่ล็อกอิน → ค้นคลิปไม่ได้ (401)', r.status === 401, String(r.status));
  r = await get('/clips.html');
  check('ไม่ล็อกอิน → หน้าค้นหาคลิปพาไปหน้าล็อกอิน', r.status === 302 && /\/login\.html\?next=%2Fclips\.html/.test(r.headers.get('location') ?? ''), r.headers.get('location'));
  r = await get('/media/c_anything');
  check('ไม่ล็อกอิน → โหลดวิดีโอไม่ได้', r.status === 401, String(r.status));
  r = await get('/monitor.html');
  check('ไม่ล็อกอิน → หน้าสถานะระบบไม่ได้', r.status === 302);
  r = await fetch(BASE + '/api/stations/desk-01/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"client_id":"x"}' });
  check('ไม่ล็อกอิน → ตั้งโต๊ะไม่ได้', r.status === 401, String(r.status));
}

// ── เส้นทางของหน้าแพ็คต้องไม่โดนกั้น (งานแพ็คห้ามหยุด) ─────────
{
  const sig = await fetch(BASE + '/signal', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: 'x', station_id: 'desk-01', event: 'ui_degraded' }) });
  check('/signal ยังรับได้โดยไม่ล็อกอิน', sig.status === 204, String(sig.status));
  for (const [p, want] of [['/hook.js', 200], ['/api/desk/desk-01', 200], ['/api/health', 200], ['/api/stations', 200], ['/login.html', 200], ['/bridge.html', 200], ['/chunk-queue.js', 200], ['/s/not-a-real-token', 404]]) {
    const r = await get(p);
    check(`${p} ไม่ต้องล็อกอิน`, want === 200 ? passedGate(r.status) && r.status !== 404 : passedGate(r.status), String(r.status));
  }
}

// ── ล็อกอินด้วย cookie ของ sellcenter ──────────────────────────
let session = null;
{
  let r = await get('/api/search?limit=1', `token=${good}`);
  check('token ของ sellcenter → ค้นคลิปได้', passedGate(r.status), String(r.status));
  const setCookie = r.headers.get('set-cookie') ?? '';
  session = /pv_session=([^;]+)/.exec(setCookie)?.[1];
  check('ออก session ของ packvideo ให้ (HttpOnly)', !!session && /HttpOnly/i.test(setCookie));

  r = await get('/api/me', `token=${good}`);
  const me = await r.json();
  check('/api/me บอกชื่อจากบัญชี', me.user?.name === 'สมชาย ทดสอบ (Test)', me.user?.name);

  r = await get('/clips.html', `token=${good}`);
  check('ล็อกอินแล้วเปิดหน้าค้นหาคลิปได้', r.status === 200, String(r.status));
}

// ── session ของเรายังใช้ได้หลัง token sellcenter หมดอายุ (R3.4) ───
{
  const expired = jwt({ name: 'สมชาย ทดสอบ (Test)', emp_id: '999', iat: now - 10 * 3600, exp: now - 3600 });
  let r = await get('/api/search?limit=1', `token=${expired}`);
  check('token หมดอายุอย่างเดียว → ไม่ผ่าน', r.status === 401, String(r.status));
  r = await get('/api/search?limit=1', `token=${expired}; pv_session=${session}`);
  check('token หมดอายุแต่ยังมี session → หน้าต่างอัดทำงานต่อได้', passedGate(r.status), String(r.status));
}

// ── ปลอม ────────────────────────────────────────────────────
{
  const forged = jwt({ name: 'แฮกเกอร์', emp_id: '1', exp: now + 3600 }, { secret: 'Evolution' });
  let r = await get('/api/search?limit=1', `token=${forged}`);
  check('token ลงนามด้วย secret อื่น → ไม่ผ่าน', r.status === 401, String(r.status));
  const none = jwt({ name: 'แฮกเกอร์', exp: now + 3600 }, { alg: 'none' });
  r = await get('/api/search?limit=1', `token=${none}`);
  check('alg=none → ไม่ผ่าน', r.status === 401, String(r.status));
  const [body] = session.split('.');
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), name: 'แฮกเกอร์' })).toString('base64url') + '.' + session.split('.')[1];
  r = await get('/api/search?limit=1', `pv_session=${tampered}`);
  check('แก้ชื่อใน session → ไม่ผ่าน', r.status === 401, String(r.status));
}

// ── sellcenter ดึงสรุปวิดีโอจากฝั่งเซิร์ฟเวอร์ ─────────────────
{
  let r = await get('/api/video-health', null, { 'X-Packvideo-Key': API_KEY });
  check('/api/video-health ด้วยกุญแจ → ได้', r.status === 200, String(r.status));
  r = await get('/api/video-health', null, { 'X-Packvideo-Key': 'wrong' });
  check('/api/video-health กุญแจผิด → ไม่ได้', r.status === 401, String(r.status));
}

// ── ชื่อพนักงานในคลิปมาจากบัญชี ไม่ใช่ข้อความบนหน้าเว็บ ─────────
{
  const trace = 'auth-' + Date.now();
  await fetch(BASE + '/signal', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `token=${good}` },
    body: new URLSearchParams({ t: 'x', station_id: 'desk-auth', event: 'start', trace_id: trace, value: '1', user: 'ชื่อปลอมบนหน้า' }) });
  await sleep(200);
  const clips = (await (await get('/api/clips?limit=50', `token=${good}`)).json()).clips ?? [];
  const c = clips.find((x) => x.station_id === 'desk-auth');
  check('packer = ชื่อจากบัญชีที่ล็อกอิน', c?.packer === 'สมชาย ทดสอบ (Test)', c?.packer);
  await fetch(BASE + '/signal', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: 'x', station_id: 'desk-auth', event: 'abort', trace_id: trace }) });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน\n`);
process.exit(failed.length ? 1 : 0);
