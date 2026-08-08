import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * ระดับการใช้ดิสก์ตาม design §9.2
 * `stop` = หยุดบันทึก แต่ **งานแพ็คต้องเดินต่อ** — /signal ยังตอบ 204 ตามปกติ
 */
export function diskLevel(usedPct) {
  const { warnPct, squeezePct, stopPct } = config.storage;
  if (usedPct >= stopPct) return 'stop';
  if (usedPct >= squeezePct) return 'squeeze';
  if (usedPct >= warnPct) return 'warn';
  return 'normal';
}

/** สร้างโฟลเดอร์ที่เก็บถ้ายังไม่มี แล้วคืน path สัมบูรณ์ */
export async function ensureStorage() {
  const root = path.resolve(config.storage.path);
  for (const sub of ['', '_pinned', '_export', '_tmp']) {
    await fs.mkdir(path.join(root, sub), { recursive: true });
  }
  return root;
}

/**
 * สถานะดิสก์ของ path ที่ใช้เก็บคลิป
 *
 * ใช้ `statfs` ของ Node เพื่อวัดที่ตัว **ดิสก์จริงที่ mount อยู่** ไม่ใช่ขนาดของโฟลเดอร์ —
 * เพราะ HDD ลูกนี้ mount แยกต่างหาก การไล่นับขนาดไฟล์จะช้าและได้ตัวเลขผิดความหมาย
 */
export async function storageStatus() {
  const root = path.resolve(config.storage.path);
  const out = {
    path: root,
    exists: false,
    writable: false,
    total_gb: null,
    free_gb: null,
    used_pct: null,
    // ตั้งชื่อ disk_level ไม่ใช่ level เพราะ pino ใช้คีย์ `level` เป็นระดับความรุนแรงของ log
    // ถ้าใช้ชื่อซ้ำแล้วส่งวัตถุนี้เข้า log จะได้ JSON ที่มีคีย์ `level` สองตัว
    disk_level: null,
    recording_allowed: false,
    error: null,
  };

  try {
    await fs.access(root);
    out.exists = true;
  } catch {
    out.error = 'ไม่พบโฟลเดอร์ที่เก็บ';
    return out;
  }

  try {
    // เขียนไฟล์จริงแล้วลบทิ้ง — สิทธิ์ในเมตาดาต้าเชื่อไม่ได้เมื่อเป็น volume ที่ mount มา
    const probe = path.join(root, '_tmp', `.probe-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    out.writable = true;
  } catch (err) {
    out.error = `เขียนไม่ได้: ${err.message}`;
  }

  try {
    const s = await fs.statfs(root);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;      // bavail = ที่ว่างสำหรับผู้ใช้ทั่วไป ไม่ใช่ bfree
    const usable = total - free;
    out.total_gb = +(total / 1024 ** 3).toFixed(1);
    out.free_gb = +(free / 1024 ** 3).toFixed(1);
    out.used_pct = total > 0 ? +((usable / total) * 100).toFixed(1) : null;
    out.disk_level = out.used_pct == null ? null : diskLevel(out.used_pct);
    out.recording_allowed = out.writable && out.disk_level !== 'stop';
  } catch (err) {
    out.error = out.error ?? `อ่านสถานะดิสก์ไม่ได้: ${err.message}`;
  }

  return out;
}
