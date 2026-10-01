import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from '../log.js';

/**
 * เวอร์ชันของหน้าต่างอัดที่เซิร์ฟเวอร์เสิร์ฟอยู่ตอนนี้ — อ่านจาก `var VERSION` ใน rec.html
 *
 * หน้าต่างอัดเปิดค้างทั้งกะและไม่รีเฟรชเอง deploy แก้บั๊กการอัดแล้วเครื่องที่เปิดค้างอยู่
 * ยังรันโค้ดเก่าต่อไปจนกว่าจะมีคนกด — วัดได้จริงวันที่ 17 ก.ย. 2026: หลัง deploy
 * คลิปยังท้ายหายเหมือนเดิมทุกโต๊ะ เทียบค่านี้กับ app_version ใน heartbeat จึงรู้ว่าโต๊ะไหนค้างรุ่นเก่า
 */
let cached;

export function recVersion() {
  if (cached !== undefined) return cached;
  try {
    const html = readFileSync(fileURLToPath(new URL('../public/rec.html', import.meta.url)), 'utf8');
    cached = /var VERSION = '([^']+)'/.exec(html)?.[1] ?? null;
  } catch (err) {
    log.error({ err: err.message }, 'อ่านเวอร์ชันหน้าต่างอัดไม่ได้');
    cached = null;
  }
  return cached;
}
