import { getDb } from '../db.js';
import { log } from '../log.js';
import { COL } from './schema.js';

/**
 * ที่เดียวที่แตะฐานข้อมูล — ส่วนอื่นเรียกผ่านไฟล์นี้เท่านั้น
 *
 * ทุกฟังก์ชันในนี้ **ห้าม throw** เพราะถูกเรียกจากเส้นทางที่ห้ามล้ม
 * ฐานข้อมูลล่มต้องไม่ทำให้คลิปที่กำลังอัดพัง — ไฟล์กับ JSON คู่ยังถูกเขียนตามปกติ
 * (design D4: ฐานข้อมูลคือ index ไฟล์คือความจริง)
 */

function db() {
  return getDb();
}

async function guard(name, fn) {
  const conn = db();
  if (!conn) return null;
  try {
    return await fn(conn);
  } catch (err) {
    log.error({ err: err.message, op: name }, 'เขียนฐานข้อมูลไม่สำเร็จ');
    return null;
  }
}

// ── clips ─────────────────────────────────────────────────────
export function saveClip(metadata) {
  return guard('saveClip', (conn) =>
    conn.collection(COL.clips).updateOne(
      { _id: metadata.clip_id },
      { $set: { ...metadata, updated_at: new Date() } },
      { upsert: true },
    ),
  );
}

export function findClips(filter, { limit = 100 } = {}) {
  return guard('findClips', (conn) =>
    conn.collection(COL.clips).find(filter).sort({ started_at: -1 }).limit(limit).toArray(),
  );
}

export function findClip(clipId) {
  return guard('findClip', (conn) => conn.collection(COL.clips).findOne({ _id: clipId }));
}

/**
 * คลิปที่ค้างสถานะ "กำลังอัด" จากรอบก่อน — เกิดเมื่อ process ถูกปิดกลางคัน
 *
 * ถ้าไม่จัดการ มันจะค้างเป็น recording ตลอดไปแล้วทำให้ตัวเลข % verified ผิด
 * และทำให้คนอ่านหน้า monitor เข้าใจผิดว่ายังมีอะไรกำลังทำงานอยู่
 */
export function reconcileOrphans() {
  return guard('reconcileOrphans', async (conn) => {
    const res = await conn.collection(COL.clips).updateMany(
      { status: { $in: ['pending', 'recording'] } },
      {
        $set: { status: 'unverified', note: 'เซิร์ฟเวอร์รีสตาร์ทระหว่างอัด', updated_at: new Date() },
        // pin ไว้เพราะเป็นสัญญาณผิดปกติ (FR-6.3) — คลิปที่ขาดตอนคือคลิปที่ต้องมีคนดู
        $addToSet: { pin_reasons: 'anomaly' },
      },
    );
    if (res.modifiedCount) {
      log.warn({ count: res.modifiedCount }, 'พบคลิปค้างจากรอบก่อน — ปิดเป็น unverified');
    }
    return res.modifiedCount;
  });
}

// ── clip_events ───────────────────────────────────────────────
/** append-only — ไม่มีฟังก์ชันลบหรือแก้ในไฟล์นี้โดยตั้งใจ (FR-7.6) */
export function appendEvent(event) {
  return guard('appendEvent', (conn) =>
    conn.collection(COL.events).insertOne({ ...event, at: event.at ?? new Date() }),
  );
}

export function findEvents(clipId) {
  return guard('findEvents', (conn) =>
    conn.collection(COL.events).find({ clip_id: clipId }).sort({ at: 1 }).toArray(),
  );
}

// ── stations ──────────────────────────────────────────────────
export function saveStation(station) {
  return guard('saveStation', (conn) =>
    conn.collection(COL.stations).updateOne(
      { _id: station.station_id },
      { $set: { ...station, updated_at: new Date() } },
      { upsert: true },
    ),
  );
}

export function loadStations() {
  return guard('loadStations', (conn) => conn.collection(COL.stations).find({}).toArray());
}
