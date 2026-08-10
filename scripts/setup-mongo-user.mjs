#!/usr/bin/env node
/**
 * สร้างผู้ใช้ฐานข้อมูลของ packvideo และตั้ง MONGO_URL ให้เสร็จในคำสั่งเดียว
 *
 *   npm run setup-mongo
 *
 * ไม่ต้องติดตั้ง mongosh — ใช้ไดรเวอร์ที่โปรเจกต์มีอยู่แล้ว
 *
 * รหัสผ่านของผู้ใช้ใหม่ถูกสุ่มให้ ไม่ต้องคิดเองและไม่ต้องพิมพ์ที่ไหน
 * ถูกเขียนลง .env อย่างเดียว ซึ่ง gitignore ไว้แล้วและตั้งสิทธิ์ 600
 */

import crypto from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { MongoClient } from 'mongodb';

const ENV_PATH = new URL('../.env', import.meta.url);
const DB_NAME = 'packvideo';
const DB_USER = 'packvideo';

const isTty = process.stdin.isTTY === true;
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTty });
const input = rl[Symbol.asyncIterator]();
let muted = false;
const write = rl._writeToOutput?.bind(rl);
if (write) rl._writeToOutput = (s) => { if (!muted) write(s); };

async function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  muted = hidden && isTty;
  const { value, done } = await input.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  if (done) { console.error('\n✗ ยกเลิก'); process.exit(1); }
  return value.trim();
}

function line(s = '') { console.log(s); }
function fail(msg) { console.error(`\n\x1b[31m✗ ${msg}\x1b[0m\n`); rl.close(); process.exit(1); }

line('\n\x1b[1mตั้งค่าฐานข้อมูลของ packvideo\x1b[0m');
line('ต้องใช้บัญชี MongoDB ที่มีสิทธิ์สร้างผู้ใช้ (เช่น root หรือ userAdminAnyDatabase)');
line('รหัสผ่านที่กรอกจะไม่แสดงบนจอและไม่ถูกบันทึกที่ไหน\n');

const host = (await ask('โฮสต์ [digital.in.th:27017]: ')) || 'digital.in.th:27017';
const adminUser = await ask('บัญชีผู้ดูแล: ');
const adminPass = await ask('รหัสผ่าน (ไม่แสดงบนจอ): ', { hidden: true });
const authSource = (await ask('authSource [admin]: ')) || 'admin';

if (!adminUser || !adminPass) fail('ต้องกรอกทั้งบัญชีและรหัสผ่าน');

const adminUrl =
  `mongodb://${encodeURIComponent(adminUser)}:${encodeURIComponent(adminPass)}` +
  `@${host}/?authSource=${encodeURIComponent(authSource)}`;

const mask = (s) => String(s).replaceAll(adminPass, '●●●●●●');

process.stdout.write('\nกำลังเชื่อมต่อ… ');
const client = new MongoClient(adminUrl, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
let roles = [];
try {
  await client.connect();
  const status = await client.db('admin').command({ connectionStatus: 1 });
  roles = status?.authInfo?.authenticatedUserRoles ?? [];
  line('สำเร็จ ✓');
} catch (err) {
  line('ไม่สำเร็จ ✗');
  if (/Authentication failed/i.test(err.message)) {
    fail('บัญชีหรือรหัสผ่านไม่ถูก · ถ้าบัญชีนี้อยู่คนละฐานข้อมูล ลองเปลี่ยน authSource');
  }
  fail(mask(err.message));
}

line('\nบทบาทที่บัญชีนี้ถือ:');
if (!roles.length) line('  (ไม่มี)');
for (const r of roles) line(`  · ${r.role} บน ${r.db}`);

const canCreate = roles.some(
  (r) => ['root', 'userAdminAnyDatabase', 'dbOwner'].includes(r.role)
      || (r.role === 'userAdmin' && (r.db === DB_NAME || r.db === 'admin')),
);

if (!canCreate) {
  line('\n\x1b[33mบัญชีนี้สร้างผู้ใช้ใหม่ไม่ได้\x1b[0m');
  line('\nส่งข้อความนี้ให้คนที่ดูแลเครื่อง MongoDB:');
  line('\n  ขอผู้ใช้ใหม่สำหรับระบบ packvideo');
  line(`    ฐานข้อมูล : ${DB_NAME}`);
  line(`    ชื่อผู้ใช้  : ${DB_USER}`);
  line(`    สิทธิ์     : readWrite เฉพาะฐานข้อมูล ${DB_NAME} เท่านั้น`);
  line('\n  คำสั่งบนเครื่อง MongoDB:');
  line(`    db.getSiblingDB("${DB_NAME}").createUser({`);
  line(`      user: "${DB_USER}", pwd: passwordPrompt(),`);
  line(`      roles: [{ role: "readWrite", db: "${DB_NAME}" }]`);
  line('    })');
  line('\nได้รหัสผ่านมาแล้วรัน:  npm run set-mongo\n');
  await client.close();
  rl.close();
  process.exit(2);
}

// รหัสผ่านสุ่ม — ไม่ต้องคิดเอง ไม่ต้องพิมพ์ ไม่ผ่านตาใคร
const password = crypto.randomBytes(24).toString('base64url');

process.stdout.write('\nกำลังสร้างผู้ใช้… ');
try {
  const db = client.db(DB_NAME);
  const existing = await db.command({ usersInfo: DB_USER }).catch(() => ({ users: [] }));
  if (existing.users?.length) {
    await db.command({ updateUser: DB_USER, pwd: password, roles: [{ role: 'readWrite', db: DB_NAME }] });
    line('มีผู้ใช้อยู่แล้ว — ตั้งรหัสผ่านใหม่ให้ ✓');
  } else {
    await db.command({ createUser: DB_USER, pwd: password, roles: [{ role: 'readWrite', db: DB_NAME }] });
    line('สร้างแล้ว ✓');
  }
} catch (err) {
  line('ไม่สำเร็จ ✗');
  fail(mask(err.message));
} finally {
  await client.close().catch(() => {});
}

// ── ยืนยันว่าใช้ได้จริงด้วยผู้ใช้ใหม่ ────────────────────────
const url =
  `mongodb://${DB_USER}:${encodeURIComponent(password)}@${host}/${DB_NAME}?authSource=${DB_NAME}`;

process.stdout.write('ทดสอบด้วยผู้ใช้ใหม่… ');
const check = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });
try {
  await check.connect();
  await check.db(DB_NAME).command({ ping: 1 });
  // สิทธิ์ readWrite ไม่ได้มาพร้อมการยืนยันตัวตนเสมอไป ต้องลองเขียนจริง
  const probe = check.db(DB_NAME).collection('_probe');
  await probe.insertOne({ at: new Date() });
  await probe.drop();
  line('เชื่อมต่อและเขียนได้ ✓');
} catch (err) {
  line('ไม่สำเร็จ ✗');
  fail(String(err.message).replaceAll(password, '●●●●●●'));
} finally {
  await check.close().catch(() => {});
}

// ── เขียนลง .env ─────────────────────────────────────────────
const original = await readFile(ENV_PATH, 'utf8').catch(() => '');
const lines = original ? original.split('\n') : [];
const idx = lines.findIndex((l) => /^\s*M+ONGO_URL\s*=/.test(l));
if (idx === -1) lines.push(`MONGO_URL=${url}`);
else lines[idx] = `MONGO_URL=${url}`;

await writeFile(ENV_PATH, lines.join('\n'), 'utf8');
await chmod(ENV_PATH, 0o600);

line('\n\x1b[32m✓ เสร็จแล้ว\x1b[0m');
line(`  ผู้ใช้ ${DB_USER} มีสิทธิ์ readWrite เฉพาะฐานข้อมูล ${DB_NAME}`);
line('  รหัสผ่านถูกสุ่มและเขียนลง .env เท่านั้น (สิทธิ์ 600 · ไม่เข้า git)');
line('\n  ต่อไป:  npm run dev   แล้วอีกหน้าต่างหนึ่ง  npm run smoke\n');

rl.close();
