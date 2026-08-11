import { Router } from 'express';
import { findClips, findClip, findEvents } from '../lib/repo.js';
import { dbState } from '../db.js';

export const searchRouter = Router();

/**
 * GET /api/search — ค้นคลิปสำหรับทีมเคลม (FR-4.1–4.3, 4.7)
 *
 * ค้นด้วย `q` ตัวเดียวได้เลยโดยไม่ต้องเลือกก่อนว่าเป็นเลขอะไร — ทีมเคลมคัดลอกเลขมาจาก
 * หน้าเคสแล้ววาง ไม่ควรต้องมานั่งแยกว่านี่คือ ordersn หรือ tracking หรือ IMEI
 */
searchRouter.get('/search', async (req, res) => {
  if (!dbState().connected) {
    return res.status(503).json({ ok: false, error: 'ต่อฐานข้อมูลไม่ได้ — ค้นหาไม่ได้ชั่วคราว' });
  }

  const q = String(req.query.q ?? '').trim();
  const filter = {};
  const and = [];

  if (q) {
    // ค่าที่สแกน/คัดลอกมามักมีขีดหรือช่องว่างติดมา — เทียบทั้งแบบเดิมและแบบตัดอักขระคั่นออก
    const bare = q.replace(/[\s/-]/g, '');
    and.push({
      $or: [
        { ordersn: q }, { ordersn: bare },
        { tracking_no: q }, { tracking_no: bare },
        { imeis: q }, { imeis: bare },
        { _id: q },
      ],
    });
  }

  if (req.query.station) filter.station_id = String(req.query.station);
  if (req.query.packer) filter.packer = String(req.query.packer);
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.pinned === 'true') filter.pinned = true;

  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (from || to) {
    filter.day = {};
    if (from) filter.day.$gte = from;
    if (to) filter.day.$lte = to;
  }

  if (and.length) filter.$and = and;

  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const clips = (await findClips(filter, { limit })) ?? [];

  res.json({
    ok: true,
    count: clips.length,
    truncated: clips.length === limit,
    clips: clips.map(present),
  });
});

/** GET /api/search/:clipId — รายละเอียดพร้อมไทม์ไลน์เหตุการณ์ */
searchRouter.get('/search/:clipId', async (req, res) => {
  const clip = await findClip(req.params.clipId);
  if (!clip) return res.status(404).json({ ok: false, error: 'ไม่พบคลิปนี้' });
  const events = (await findEvents(req.params.clipId)) ?? [];
  res.json({ ok: true, clip: present(clip), events });
});

/**
 * แปลงเอกสารก่อนส่งออก
 *
 * `media_deleted_at` ทำให้ตอบได้ว่า "เคยมี แต่ถูกลบเมื่อ…" แทนที่จะตอบว่า "ไม่พบ" (FR-4.8)
 * เพราะ "ไม่พบ" ทำให้ทีมเคลมเข้าใจผิดว่าระบบพังแล้วไปตามหาคนผิด
 */
function present(clip) {
  const gone = !!clip.media_deleted_at;
  return {
    clip_id: clip._id,
    station_id: clip.station_id,
    packer: clip.packer,
    status: clip.status,
    ordersn: clip.ordersn,
    tracking_no: clip.tracking_no,
    imeis: clip.imeis ?? [],
    flags: clip.flags ?? [],
    pinned: !!clip.pinned,
    pin_reasons: clip.pin_reasons ?? [],
    day: clip.day,
    started_at: clip.started_at,
    ended_at: clip.ended_at,
    duration_ms: clip.duration_ms ?? null,
    bytes: clip.bytes ?? 0,
    checksum: clip.checksum ?? null,
    media_available: !!clip.media_path && !gone,
    media_deleted_at: clip.media_deleted_at ?? null,
    media_url: clip.media_path && !gone ? `/media/${clip._id}` : null,
  };
}
