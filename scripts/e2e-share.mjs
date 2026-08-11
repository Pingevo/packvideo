#!/usr/bin/env node
/**
 * ทดสอบลิงก์สำหรับบุคคลภายนอก — จุดเดียวที่ข้อมูลออกนอกองค์กร
 *
 *   npm run e2e:share
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:1338';
const STATION = 'desk-share';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const signal = (fields) =>
  fetch(`${BASE}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: 'dev-token', station_id: STATION, ...fields }),
  });

const putChunk = (clipId, seq, n) =>
  fetch(`${BASE}/api/clip/${clipId}/chunk/${seq}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(n, 3),
  });

console.log(`\nทดสอบลิงก์ภายนอก ${BASE}\n`);

// ── เตรียมคลิปหนึ่งตัว ──────────────────────────────────────
const trace = `share-${Date.now()}`;
await signal({ event: 'start', trace_id: trace, value: '356938035643809', user: 'ผู้ทดสอบ' });
await sleep(200);
const clipId = (await (await fetch(`${BASE}/api/clips`)).json()).clips
  .find((c) => c.station_id === STATION && c.status === 'pending')?.clip_id;
await putChunk(clipId, 0, 4000);
await signal({ event: 'commit', trace_id: trace, ordersn: '250808SHARE1' });
await sleep(150);
await signal({ event: 'tag', tracking_no: 'SPXSHARE001' });
await sleep(150);
await signal({ event: 'scan', value: 'SPXSHARE001' });
await sleep(600);
check('เตรียมคลิปสำหรับทดสอบได้', !!clipId, clipId);

// ── สร้างลิงก์ ──────────────────────────────────────────────
const made = await (await fetch(`${BASE}/api/clips/${clipId}/share`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ by: 'ทีมเคลม', note: 'ส่งให้ Flash เคลมของหาย', days: 7 }),
})).json();
check('สร้างลิงก์ได้', made.ok === true, made.url?.replace(BASE, ''));
const token = made.url?.split('/s/')[1];
const tokenLen = token?.length ?? 0;
check('token ยาวพอจะเดาไม่ได้', tokenLen >= 40, `${tokenLen} ตัวอักษร`);

// ── เปิดดูได้โดยไม่ต้องล็อกอิน ──────────────────────────────
const page = await fetch(`${BASE}/s/${token}`);
const html = await page.text();
check('เปิดหน้าดูได้โดยไม่ต้องล็อกอิน', page.status === 200);
check('หน้าแสดงเลขออเดอร์และเลขพัสดุ',
  html.includes('250808SHARE1') && html.includes('SPXSHARE001'));
check('หน้าไม่ให้ค้นหาเจอ', html.includes('noindex'));

const vid = await fetch(`${BASE}/s/${token}/video`, { headers: { Range: 'bytes=0-999' } });
check('ดูวิดีโอได้และรองรับการเลื่อน', vid.status === 206, vid.headers.get('content-range'));
check('ห้ามแคชที่ตัวกลาง', (vid.headers.get('cache-control') ?? '').includes('no-store'));

// ── นับการเข้าดู ────────────────────────────────────────────
await fetch(`${BASE}/s/${token}`);
const shares = await (await fetch(`${BASE}/api/clips/${clipId}/shares`)).json();
const link = shares.shares?.[0];
check('นับจำนวนครั้งที่เปิดดู', link?.view_count === 2, `เปิดไป ${link?.view_count} ครั้ง`);
check('ไม่คืน token เต็มออกมาในรายการ', !!link?.token_prefix && !JSON.stringify(shares).includes(token));

// ── token ที่เดาขึ้นมาต้องใช้ไม่ได้ ──────────────────────────
const guess = await fetch(`${BASE}/s/${'A'.repeat(43)}`);
check('token ที่เดาขึ้นมาใช้ไม่ได้', guess.status === 404);

// ── ยกเลิกแล้วต้องใช้ไม่ได้ทันที รวมถึงการเลื่อนดู ───────────
const revoked = await (await fetch(`${BASE}/api/share/${token}`, {
  method: 'DELETE', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ by: 'ทีมเคลม' }),
})).json();
check('ยกเลิกลิงก์ได้', revoked.ok === true);

const after = await fetch(`${BASE}/s/${token}`);
check('ยกเลิกแล้วเปิดหน้าไม่ได้', after.status === 410);

const afterVid = await fetch(`${BASE}/s/${token}/video`, { headers: { Range: 'bytes=0-99' } });
check('ยกเลิกแล้วเลื่อนดูวิดีโอต่อไม่ได้ด้วย', afterVid.status === 410,
  'ตรวจสิทธิ์ทุก request ไม่ใช่แค่ตอนเปิดหน้า');

// ── ไทม์ไลน์ต้องบอกได้ว่าเปิดเผยให้ใครไปแล้วบ้าง ────────────
const detail = await (await fetch(`${BASE}/api/search/${clipId}`)).json();
const kinds = (detail.events ?? []).map((e) => e.event);
check('บันทึกการสร้างลิงก์ การเปิดดู และการยกเลิกไว้ครบ',
  kinds.includes('share') && kinds.includes('share_view') && kinds.includes('share_revoke'),
  kinds.join(' → '));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน`);
if (failed.length) {
  console.log(`\x1b[31mไม่ผ่าน: ${failed.map((f) => f.name).join(', ')}\x1b[0m\n`);
  process.exit(1);
}
console.log('\x1b[32mผ่านทั้งหมด\x1b[0m\n');
