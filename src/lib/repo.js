import { getDb } from '../db.js';
import { log } from '../log.js';
import { COL, MIN_VIDEO_BYTES } from './schema.js';

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
 * คลิปที่ค้างจากรอบก่อน — เกิดเมื่อ process ถูกปิดกลางคัน · clips.recoverOrphans() ต่อไฟล์และปิดให้
 *
 * ถ้าไม่จัดการ มันจะค้างเป็น recording ตลอดไปแล้วทำให้ตัวเลข % verified ผิด
 * และทำให้คนอ่านหน้า monitor เข้าใจผิดว่ายังมีอะไรกำลังทำงานอยู่
 *
 * สองกลุ่ม:
 *   1. ยังเปิดค้างอยู่ — เฉพาะที่เริ่มก่อน process นี้เกิด เพราะ Mongo ต่อติดช้ากว่าเซิร์ฟเวอร์รับสัญญาณ
 *      ได้หลายวินาที ถ้าไม่จำกัด คลิปแรกๆ หลังรีสตาร์ทที่กำลังอัดจริงจะถูกปิดไปด้วย (เจอตอนทดสอบ)
 *   2. ปิดไปแล้วแต่ไม่มีไฟล์ ทั้งที่ชิ้นยังค้างใน _tmp (leftoverIds) — โค้ดก่อน 2026-10-01 ปิดคลิปรีสตาร์ท
 *      โดยไม่ต่อชิ้นเลย หรือรอบก่อนต่อไม่สำเร็จ · ตัวที่ retention ประกาศลบไฟล์ไปแล้ว (media_deleted_at)
 *      ไม่เอามา — ถ้าไปสร้างไฟล์ขึ้นใหม่ retention จะไม่ย้ายมันแล้วข้ามการลบทั้งวันทุกรอบ
 */
const BOOTED_AT = new Date().toISOString();

export function findOrphanClips(leftoverIds, closedStatuses) {
  return guard('findOrphanClips', (conn) =>
    conn.collection(COL.clips).find({
      $or: [
        { status: { $in: ['pending', 'recording', 'closing'] }, started_at: { $lt: BOOTED_AT } },
        {
          _id: { $in: leftoverIds },
          status: { $in: closedStatuses },
          media_path: null,
          media_deleted_at: { $exists: false },
        },
      ],
    }).toArray(),
  );
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

/** รายชื่อพนักงานที่มีคลิปตั้งแต่วันที่กำหนด — ให้หน้าค้นหาทำตัวเลือกกรอง */
export function distinctPackers(sinceIso) {
  return guard('distinctPackers', (conn) =>
    conn.collection(COL.clips).distinct('packer', { started_at: { $gte: sinceIso }, packer: { $ne: null } }),
  );
}

/**
 * สรุปคลิปรายโต๊ะตั้งแต่เวลาที่กำหนด — หน้าสถานะระบบ (R6.1 · R6.2)
 *
 * นับจากฐานข้อมูล ไม่ใช่ตัวนับในหน่วยความจำ — รีสตาร์ทแล้วไม่หาย และตอบได้จริงว่าโต๊ะนี้
 * มีคลิปเข้ามาไหม (ตัวนับในหน่วยความจำเคยทำให้เตือนผิดว่าโต๊ะที่มีคลิป 190+ ตัว "ไม่เคยได้สัญญาณ")
 */
export function clipStatsByStation(sinceIso) {
  return guard('clipStatsByStation', (conn) =>
    conn.collection(COL.clips).aggregate([
      { $match: { started_at: { $gte: sinceIso }, status: { $ne: 'aborted' } } },
      { $group: {
        _id: '$station_id',
        clips: { $sum: 1 },
        last_at: { $max: '$started_at' },
        // ไม่มีวิดีโอ = ปิดแล้วแต่ไม่มีไฟล์ หรือไฟล์มีแค่ส่วนหัว (ไม่นับคลิปที่ยังอัดอยู่)
        no_video: { $sum: { $cond: [{ $and: [
          { $not: [{ $in: ['$status', ['pending', 'recording', 'closing']] }] },
          { $or: [
            { $in: [{ $ifNull: ['$media_path', null] }, [null]] },
            { $lt: [{ $ifNull: ['$bytes', 0] }, MIN_VIDEO_BYTES] },
          ] },
        ] }, 1, 0] } },
        // ชิ้นมาไม่ครบตามที่หน้าต่างอัดบอก — วิดีโอขาดช่วง
        incomplete: { $sum: { $cond: [{ $in: ['incomplete', { $ifNull: ['$flags', []] }] }, 1, 0] } },
        corrupt: { $sum: { $cond: [{ $and: [
          { $in: ['no_header', { $ifNull: ['$flags', []] }] },
          { $not: [{ $gt: ['$media_offset', 0] }] },
        ] }, 1, 0] } },
      } },
    ]).toArray(),
  );
}
