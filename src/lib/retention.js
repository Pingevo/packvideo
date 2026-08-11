import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { getDb } from '../db.js';
import { COL } from './schema.js';
import { alert } from './notify.js';

/**
 * ลบคลิปที่เกินกำหนดเก็บ (design §9.1)
 *
 * งานนี้เป็นงานเดียวในระบบที่ลบข้อมูลถาวร หลักการที่คุมทุกบรรทัดในไฟล์นี้คือ
 * **ยอมไม่ลบดีกว่าลบผิด** — พื้นที่ดิสก์หาเพิ่มได้ แต่คลิปของเคสที่กำลังสู้เงินอยู่
 * ถ้าหายไปแล้วก็จบ
 *
 * ลบทั้งโฟลเดอร์รายวันแทนการไล่ลบทีละไฟล์ เพราะที่ 1,500 คลิป/วัน × 30 วัน
 * การไล่ลบทีละไฟล์เป็นหมื่นไฟล์ช้าและมีโอกาสค้างกลางคัน
 */

const ROOT = () => path.resolve(config.storage.path);
const PINNED = () => path.join(ROOT(), '_pinned');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayDir(day) {
  const [y, m, d] = day.split('-');
  return path.join(ROOT(), y, m, d);
}

/** หาโฟลเดอร์รายวันทั้งหมดที่มีอยู่จริงบนดิสก์ */
async function listDayFolders() {
  const days = [];
  const root = ROOT();
  for (const y of await safeReaddir(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of await safeReaddir(path.join(root, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of await safeReaddir(path.join(root, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        days.push(`${y}-${m}-${d}`);
      }
    }
  }
  return days.sort();
}

async function safeReaddir(dir) {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

/**
 * @param {{dryRun?: boolean, retentionDays?: number}} opts
 */
export async function runRetention(opts = {}) {
  const dryRun = opts.dryRun ?? false;
  const retentionDays = opts.retentionDays ?? config.retentionDays;
  const cutoff = dayKey(daysAgo(retentionDays));

  const db = getDb();
  if (!db) {
    // ไม่รู้ว่าคลิปไหน pin ไว้ = ไม่มีสิทธิ์ลบอะไรทั้งนั้น
    const msg = 'งานลบข้อมูลตามกำหนดหยุดทำงาน — ต่อฐานข้อมูลไม่ได้จึงไม่รู้ว่าคลิปไหนติดเคสอยู่';
    log.error(msg);
    await alert('retention:no-db', msg);
    return { ok: false, reason: 'ต่อฐานข้อมูลไม่ได้', deleted_days: [] };
  }

  const all = await listDayFolders();
  const expired = all.filter((day) => day < cutoff);

  const report = {
    ok: true,
    dry_run: dryRun,
    retention_days: retentionDays,
    cutoff,
    days_on_disk: all.length,
    expired_days: expired.length,
    deleted_days: [],
    moved_pinned: 0,
    skipped: [],
  };

  for (const day of expired) {
    const outcome = await processDay(db, day, dryRun);
    if (outcome.moved) report.moved_pinned += outcome.moved;
    if (outcome.deleted) report.deleted_days.push(day);
    if (outcome.skipped) report.skipped.push({ day, reason: outcome.reason });
  }

  if (report.skipped.length) {
    await alert(
      'retention:skipped',
      `งานลบข้อมูลข้ามไป ${report.skipped.length} วันเพราะย้ายคลิปที่ติดเคสไม่ครบ — ` +
        report.skipped.map((s) => `${s.day} (${s.reason})`).join(', '),
    );
  }

  log.info(report, dryRun ? 'ซ้อมลบข้อมูลตามกำหนด' : 'ลบข้อมูลตามกำหนดเสร็จ');
  return report;
}

async function processDay(db, day, dryRun) {
  const dir = dayDir(day);

  // 1 · คลิปของวันนั้นที่ต้องเก็บไว้
  const pinned = await db
    .collection(COL.clips)
    .find({ day, pinned: true })
    .project({ _id: 1, media_path: 1, media_deleted_at: 1 })
    .toArray();

  // 2 · ย้ายไฟล์ที่ต้องเก็บออกไปก่อน
  let moved = 0;
  const failures = [];
  if (!dryRun) await fs.mkdir(PINNED(), { recursive: true });

  for (const clip of pinned) {
    if (!clip.media_path || clip.media_deleted_at) continue;

    const from = path.join(ROOT(), clip.media_path);
    const to = path.join(PINNED(), path.basename(clip.media_path));
    const fromJson = from.replace(/\.mp4$/, '.json');
    const toJson = to.replace(/\.mp4$/, '.json');

    try {
      await fs.access(from);
    } catch {
      // ไฟล์หายไปแล้วก่อนหน้านี้ — บันทึกไว้แต่ไม่ถือเป็นเหตุให้หยุด
      log.warn({ clip_id: clip._id, path: clip.media_path }, 'คลิปที่ติดเคสไม่มีไฟล์บนดิสก์แล้ว');
      continue;
    }

    if (dryRun) { moved++; continue; }

    try {
      await fs.rename(from, to);
      await fs.rename(fromJson, toJson).catch(() => {});
      await db.collection(COL.clips).updateOne(
        { _id: clip._id },
        { $set: { media_path: path.join('_pinned', path.basename(clip.media_path)), updated_at: new Date() } },
      );
      moved++;
    } catch (err) {
      failures.push({ clip_id: clip._id, error: err.message });
    }
  }

  // 3 · ย้ายไม่ครบ = ไม่ลบอะไรเลย
  //    ขั้นนี้คือขั้นที่สำคัญที่สุดของทั้งงาน ถ้าปล่อยผ่านแล้ว rm -rf ต่อ
  //    คือทำลายหลักฐานของเคสที่กำลังสู้เงินอยู่
  if (failures.length) {
    log.error({ day, failures }, 'ย้ายคลิปที่ติดเคสไม่ครบ — ไม่ลบโฟลเดอร์วันนี้');
    return { skipped: true, reason: `ย้ายไม่สำเร็จ ${failures.length} ไฟล์`, moved };
  }

  // 4 · ตรวจซ้ำด้วยการอ่านดิสก์จริง ว่าไม่มีไฟล์ของคลิปที่ pin หลงเหลือ
  const remaining = await safeReaddir(dir);
  const stillPinned = [];
  for (const clip of pinned) {
    if (!clip.media_path) continue;
    const base = path.basename(clip.media_path);
    if (remaining.includes(base)) stillPinned.push(base);
  }
  if (stillPinned.length && !dryRun) {
    log.error({ day, stillPinned }, 'ยังมีไฟล์ที่ติดเคสอยู่ในโฟลเดอร์ — ไม่ลบ');
    return { skipped: true, reason: `ยังเหลือไฟล์ที่ติดเคส ${stillPinned.length} ไฟล์`, moved };
  }

  // 5 · ลบทั้งโฟลเดอร์ แล้วทำเครื่องหมายว่าไฟล์หายไปแล้ว แต่เก็บ metadata ไว้ตลอดไป (D5)
  //    ทำให้ตอบได้ว่า "เคยมี ลบเมื่อ…" แทน "ไม่พบ" ซึ่งทำให้ทีมเคลมไปตามหาคนผิด
  if (!dryRun) {
    await fs.rm(dir, { recursive: true, force: true });
    await db.collection(COL.clips).updateMany(
      { day, pinned: { $ne: true }, media_deleted_at: { $exists: false } },
      { $set: { media_deleted_at: new Date(), updated_at: new Date() } },
    );
    await pruneEmptyParents(dir);
  }

  return { deleted: true, moved };
}

/** เก็บกวาดโฟลเดอร์เดือน/ปีที่ว่างแล้ว ไม่ให้เหลือโครงเปล่าสะสม */
async function pruneEmptyParents(dir) {
  let cur = path.dirname(dir);
  const root = ROOT();
  while (cur.startsWith(root) && cur !== root) {
    const entries = await safeReaddir(cur);
    if (entries.length) break;
    await fs.rmdir(cur).catch(() => {});
    cur = path.dirname(cur);
  }
}

// ── ตั้งเวลาให้ทำงานตอนตี 2 ───────────────────────────────────
let timer = null;

export function startRetention() {
  if (timer) return;
  // ตรวจทุก 10 นาทีว่าถึงเวลาหรือยัง แทนการคำนวณ setTimeout ยาวๆ
  // ซึ่งเพี้ยนได้เมื่อเครื่องหลับหรือเวลาระบบถูกปรับ
  let lastRunDay = null;
  timer = setInterval(async () => {
    const now = new Date();
    const today = dayKey(now);
    if (now.getHours() !== 2 || lastRunDay === today) return;
    lastRunDay = today;
    try {
      await runRetention();
    } catch (err) {
      log.error({ err: err.message }, 'งานลบข้อมูลตามกำหนดล้มเหลว');
      await alert('retention:failed', `งานลบข้อมูลตามกำหนดล้มเหลว: ${err.message}`);
    }
  }, 10 * 60 * 1000);
  timer.unref();
  log.info({ retention_days: config.retentionDays }, 'ตั้งเวลางานลบข้อมูลตามกำหนดแล้ว (ตี 2)');
}

export function stopRetention() {
  clearInterval(timer);
  timer = null;
}
