import crypto from 'node:crypto';
import { getDb } from '../db.js';
import { COL } from './schema.js';
import { appendEvent } from './repo.js';
import { log } from '../log.js';

/**
 * ลิงก์ให้บุคคลภายนอกดูคลิป (FR-5.9–5.12)
 *
 * ผู้รับคือลูกค้า เจ้าหน้าที่แพลตฟอร์ม และเจ้าหน้าที่ขนส่ง — ไม่มีบัญชีในระบบเรา
 * นี่คือทางเดียวที่ข้อมูลออกนอกองค์กร จึงเป็นจุดที่ต้องระวังที่สุดในเรื่อง PDPA
 * ทุกการเปิดดูถูกบันทึกไว้เพื่อตอบได้ว่าคลิปของออเดอร์หนึ่งถูกเปิดเผยให้ใครไปแล้วบ้าง (NFR-4.7)
 */

const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS = 90;

/** 32 ไบต์ = เดาไม่ได้ในทางปฏิบัติ และไม่มีความสัมพันธ์กับ clip_id (FR-5.12) */
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export async function createShare(clipId, { by, note, ttlDays } = {}) {
  const db = getDb();
  if (!db) return { ok: false, error: 'ต่อฐานข้อมูลไม่ได้' };

  const clip = await db.collection(COL.clips).findOne({ _id: clipId });
  if (!clip) return { ok: false, error: 'ไม่พบคลิปนี้' };
  if (!clip.media_path || clip.media_deleted_at) {
    return { ok: false, error: 'ไม่มีไฟล์วิดีโอของคลิปนี้แล้ว จึงสร้างลิงก์ไม่ได้' };
  }

  const days = Math.min(MAX_TTL_DAYS, Math.max(1, Number(ttlDays) || DEFAULT_TTL_DAYS));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const token = newToken();

  await db.collection(COL.shareLinks).insertOne({
    _id: token,
    clip_id: clipId,
    ordersn: clip.ordersn ?? null,
    created_by: by ?? null,
    created_at: new Date(),
    expires_at: expiresAt,
    revoked_at: null,
    note: note ?? null,
    view_count: 0,
    last_viewed_at: null,
  });

  void appendEvent({
    clip_id: clipId,
    event: 'share',
    ordersn: clip.ordersn ?? null,
    actor: by ?? null,
    detail: { expires_at: expiresAt, note: note ?? null, token_prefix: token.slice(0, 8) },
  });

  log.info({ clip_id: clipId, by, expires_at: expiresAt }, 'สร้างลิงก์ให้บุคคลภายนอก');
  return { ok: true, token, expires_at: expiresAt, days };
}

/**
 * ตรวจลิงก์ — **ต้องเรียกทุก request ไม่ใช่แค่ตอนเปิดหน้า**
 *
 * ถ้าตรวจแค่ตอนเปิดหน้า คนที่เปิดค้างไว้จะยังเลื่อนดูวิดีโอต่อได้หลังถูกยกเลิกลิงก์
 * เพราะการเลื่อนดูเป็น request ใหม่คนละอันกับหน้า
 */
export async function resolveShare(token) {
  const db = getDb();
  if (!db) return { ok: false, status: 503, error: 'ระบบไม่พร้อมชั่วคราว' };

  const link = await db.collection(COL.shareLinks).findOne({ _id: token });
  if (!link) return { ok: false, status: 404, error: 'ลิงก์นี้ใช้ไม่ได้' };
  if (link.revoked_at) return { ok: false, status: 410, error: 'ลิงก์นี้ถูกยกเลิกแล้ว' };
  if (link.expires_at && link.expires_at.getTime() < Date.now()) {
    return { ok: false, status: 410, error: 'ลิงก์นี้หมดอายุแล้ว' };
  }

  const clip = await db.collection(COL.clips).findOne({ _id: link.clip_id });
  if (!clip?.media_path || clip.media_deleted_at) {
    return { ok: false, status: 404, error: 'ไม่มีไฟล์วิดีโอแล้ว' };
  }

  return { ok: true, link, clip };
}

/** นับการเปิดดู — นับเฉพาะการเปิดหน้า ไม่นับทุก request ของวิดีโอ ไม่งั้นตัวเลขเฟ้อ */
export async function recordView(token, { ip, userAgent } = {}) {
  const db = getDb();
  if (!db) return;

  const link = await db.collection(COL.shareLinks).findOneAndUpdate(
    { _id: token },
    { $inc: { view_count: 1 }, $set: { last_viewed_at: new Date() } },
    { returnDocument: 'after' },
  );
  if (!link) return;

  void appendEvent({
    clip_id: link.clip_id,
    event: 'share_view',
    ordersn: link.ordersn ?? null,
    actor: 'ภายนอก',
    detail: { ip: ip ?? null, user_agent: userAgent ?? null, token_prefix: token.slice(0, 8) },
  });
}

export async function revokeShare(token, { by } = {}) {
  const db = getDb();
  if (!db) return { ok: false, error: 'ต่อฐานข้อมูลไม่ได้' };

  const res = await db.collection(COL.shareLinks).findOneAndUpdate(
    { _id: token, revoked_at: null },
    { $set: { revoked_at: new Date(), revoked_by: by ?? null } },
    { returnDocument: 'after' },
  );
  if (!res) return { ok: false, error: 'ไม่พบลิงก์นี้ หรือถูกยกเลิกไปแล้ว' };

  void appendEvent({
    clip_id: res.clip_id,
    event: 'share_revoke',
    ordersn: res.ordersn ?? null,
    actor: by ?? null,
    detail: { token_prefix: token.slice(0, 8) },
  });

  log.info({ clip_id: res.clip_id, by }, 'ยกเลิกลิงก์ภายนอก');
  return { ok: true };
}

/** ลิงก์ทั้งหมดของคลิปหนึ่ง — ไม่คืน token เต็มเพื่อไม่ให้หลุดจากหน้าจอที่ไม่ตั้งใจ */
export async function listShares(clipId) {
  const db = getDb();
  if (!db) return [];

  const links = await db.collection(COL.shareLinks)
    .find({ clip_id: clipId }).sort({ created_at: -1 }).toArray();

  return links.map((l) => ({
    token_prefix: String(l._id).slice(0, 8),
    created_by: l.created_by,
    created_at: l.created_at,
    expires_at: l.expires_at,
    revoked_at: l.revoked_at,
    note: l.note,
    view_count: l.view_count ?? 0,
    last_viewed_at: l.last_viewed_at,
    active: !l.revoked_at && (!l.expires_at || l.expires_at.getTime() > Date.now()),
  }));
}
