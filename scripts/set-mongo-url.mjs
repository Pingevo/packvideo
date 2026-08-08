#!/usr/bin/env node
/**
 * ตั้งค่า MONGO_URL ใน .env โดยที่รหัสผ่านไม่ปรากฏบนจอ ไม่เข้าประวัติคำสั่ง และไม่เข้า git
 *
 *   npm run set-mongo
 *
 * ทำไมต้องมีสคริปต์นี้แทนการแก้ไฟล์เอง:
 *  - รหัสผ่านที่มี @ : / ? # [ ] % ต้อง percent-encode ก่อนใส่ใน URI
 *    ไม่งั้นถูกตีความเป็นตัวคั่นแล้วได้ error ที่ชี้ไปผิดทาง
 *  - พิมพ์ชื่อคีย์ผิดแล้วระบบเงียบเหมือนไม่ได้ตั้งค่า (เคยเกิดจริง: MMONGO_URL)
 *  - พิมพ์ในเทอร์มินัลตรงๆ รหัสผ่านจะไปค้างใน ~/.zsh_history
 */

import { readFile, writeFile, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { MongoClient } from 'mongodb';

const ENV_PATH = new URL('../.env', import.meta.url);

const isTty = process.stdin.isTTY === true;

// ใช้ตัววนอ่านบรรทัดแทน rl.question เพราะ rl.question ของ Node 22 ตอบได้แค่
// คำถามแรกเมื่อ stdin เป็น pipe แล้วคำถามถัดไปค้างตลอดกาล
// ("Detected unsettled top-level await") — แบบนี้ทำงานได้ทั้งพิมพ์เองและป้อนผ่าน pipe
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: isTty });
const input = rl[Symbol.asyncIterator]();

let muted = false;
const write = rl._writeToOutput?.bind(rl);
if (write) {
  rl._writeToOutput = function (s) {
    if (muted) return;              // ตอนกรอกรหัสผ่าน ไม่ให้ตัวอักษรปรากฏบนจอ
    write(s);
  };
}

async function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  muted = hidden && isTty;
  const { value, done } = await input.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  if (done) {
    console.error('\n✗ ข้อมูลนำเข้าหมดก่อนตอบครบ — ยกเลิก');
    process.exit(1);
  }
  return value;
}
const host = (await ask('โฮสต์ [digital.in.th:27017]: ')).trim() || 'digital.in.th:27017';
const user = (await ask('ผู้ใช้ [packvideo]: ')).trim() || 'packvideo';
const dbName = (await ask('ฐานข้อมูล [packvideo]: ')).trim() || 'packvideo';
const pwd = await ask('รหัสผ่าน (ไม่แสดงบนจอ): ', { hidden: true });

if (!pwd) {
  console.error('\n✗ ไม่ได้กรอกรหัสผ่าน — ยกเลิก');
  process.exit(1);
}
if (/^<.*>$/.test(pwd)) {
  console.error('\n✗ นั่นคือค่าตัวอย่าง ไม่ใช่รหัสผ่านจริง — ยกเลิก');
  process.exit(1);
}

// encode ทั้งผู้ใช้และรหัสผ่านเสมอ — ปลอดภัยแม้ไม่มีอักขระพิเศษ
const url =
  `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pwd)}` +
  `@${host}/${dbName}?authSource=${dbName}`;

process.stdout.write('\nกำลังทดสอบการเชื่อมต่อ… ');
const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
try {
  await client.connect();
  await client.db(dbName).command({ ping: 1 });
  console.log('สำเร็จ ✓');

  // ยืนยันว่าเขียนได้จริง — สิทธิ์ readWrite ไม่ได้มาพร้อมการ authenticate เสมอไป
  const probe = client.db(dbName).collection('_probe');
  await probe.insertOne({ at: new Date() });
  await probe.drop();
  console.log('สิทธิ์เขียนฐานข้อมูล ✓');
} catch (err) {
  // ข้อความ error ของไดรเวอร์ไม่มีรหัสผ่านอยู่ แต่กันไว้อีกชั้น
  console.log('ไม่สำเร็จ ✗');
  console.error(`\n${String(err.message).replaceAll(pwd, '●●●●●●')}\n`);
  if (/Authentication failed|not authorized/i.test(err.message)) {
    console.error('ผู้ใช้หรือรหัสผ่านไม่ถูก หรือผู้ใช้นี้ยังไม่มีสิทธิ์ในฐานข้อมูลนี้');
    console.error('ถ้ายังไม่ได้สร้างผู้ใช้ ดูวิธีใน docs/dev-setup.md');
  }
  process.exit(1);
} finally {
  await client.close().catch(() => {});
  rl.close();
}

const original = await readFile(ENV_PATH, 'utf8');
const lines = original.split('\n');
const idx = lines.findIndex((l) => /^\s*M+ONGO_URL\s*=/.test(l));   // เผื่อชื่อคีย์ที่พิมพ์ผิดไว้ก่อนหน้า
if (idx === -1) lines.push(`MONGO_URL=${url}`);
else lines[idx] = `MONGO_URL=${url}`;

await writeFile(ENV_PATH, lines.join('\n'), 'utf8');
await chmod(ENV_PATH, 0o600);   // .env ถูก gitignore อยู่แล้ว แต่จำกัดสิทธิ์ในเครื่องด้วย

console.log('\n✓ เขียน MONGO_URL ลง .env แล้ว (สิทธิ์ 600 · ไม่เข้า git)');
console.log('  ต่อไป: npm run dev แล้วอีกหน้าต่างหนึ่ง npm run smoke\n');
