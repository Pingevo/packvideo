import { getDb } from '../db.js';
import { log } from '../log.js';

/**
 * โครงสร้างฐานข้อมูลและ index (P1-2)
 *
 * `createIndex` เรียกซ้ำได้ ไม่มีผลถ้ามีอยู่แล้ว จึงเรียกทุกครั้งที่ต่อฐานข้อมูลติด
 * ไม่ต้องมีระบบ migration แยกสำหรับโครงสร้างขนาดนี้
 */

export const COL = {
  clips: 'clips',
  events: 'clip_events',
  stations: 'stations',
  shareLinks: 'share_links',
};

export async function ensureIndexes() {
  const db = getDb();
  if (!db) return { ok: false, reason: 'ยังต่อฐานข้อมูลไม่ได้' };

  const created = [];

  // ── clips ──────────────────────────────────────────────────
  // สามตัวแรกคือเส้นทางค้นหาของทีมเคลม (FR-4.1–4.3) ต้องใช้ index เสมอ
  // ที่ 1,500 คลิป/วัน × 30 วัน = 45,000 เอกสาร การ scan ทั้ง collection ยอมรับไม่ได้
  created.push(await idx(db, COL.clips, { ordersn: 1 }, { name: 'ordersn', sparse: true }));
  created.push(await idx(db, COL.clips, { tracking_no: 1 }, { name: 'tracking_no', sparse: true }));
  created.push(await idx(db, COL.clips, { imeis: 1 }, { name: 'imeis', sparse: true }));

  // งาน retention กวาดทีละวัน (design §9.1) และหน้า monitor ดูรายโต๊ะรายวัน
  created.push(await idx(db, COL.clips, { day: 1, station_id: 1 }, { name: 'day_station' }));
  // หา "คลิปที่ pin ในวันนี้" ก่อนลบทั้งโฟลเดอร์ — ข้อผิดพลาดตรงนี้คือทำลายหลักฐานของเคสจริง
  created.push(await idx(db, COL.clips, { pinned: 1, day: 1 }, { name: 'pinned_day' }));
  created.push(await idx(db, COL.clips, { status: 1, day: 1 }, { name: 'status_day' }));
  created.push(await idx(db, COL.clips, { started_at: -1 }, { name: 'started_at' }));

  // ── clip_events ────────────────────────────────────────────
  // append-only ตาม FR-7.6 — ไม่มี endpoint ไหนลบหรือแก้ collection นี้
  created.push(await idx(db, COL.events, { clip_id: 1, at: 1 }, { name: 'clip_at' }));
  created.push(await idx(db, COL.events, { at: -1 }, { name: 'at' }));
  created.push(await idx(db, COL.events, { ordersn: 1 }, { name: 'ordersn', sparse: true }));

  // ── share_links ────────────────────────────────────────────
  created.push(await idx(db, COL.shareLinks, { clip_id: 1 }, { name: 'clip' }));
  // ลิงก์ที่หมดอายุแล้วถูกลบเอง — ข้อมูลที่ไม่ควรมีอยู่ต่อไม่ควรต้องรอคนมากวาด
  created.push(
    await idx(db, COL.shareLinks, { expires_at: 1 }, { name: 'ttl', expireAfterSeconds: 0 }),
  );

  const failed = created.filter((c) => !c.ok);
  if (failed.length) {
    log.error({ failed }, 'สร้าง index บางตัวไม่สำเร็จ');
  } else {
    log.info({ count: created.length }, 'index พร้อมใช้งาน');
  }
  return { ok: !failed.length, created };
}

async function idx(db, collection, keys, options) {
  try {
    const name = await db.collection(collection).createIndex(keys, options);
    return { ok: true, collection, name };
  } catch (err) {
    return { ok: false, collection, name: options?.name, error: err.message };
  }
}
