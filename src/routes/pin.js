import { Router } from 'express';
import express from 'express';
import { getDb } from '../db.js';
import { COL } from '../lib/schema.js';
import { appendEvent } from '../lib/repo.js';
import { runRetention } from '../lib/retention.js';
import { log } from '../log.js';

export const pinRouter = Router();
const json = express.json({ limit: '16kb' });

/**
 * pin = กันคลิปไม่ให้ถูกลบตอนครบกำหนด (FR-6)
 *
 * มี 4 ทางเข้าตามที่ตกลงไว้ — อัตโนมัติตอนปิดคลิปที่ผิดปกติ (ทำใน clips.js),
 * webhook ตอนเปิดเคส, ปุ่มด้วยมือ, และงานกลางคืนจากสถานะขนส่ง (ยังไม่ทำ)
 */
async function setPin(clipId, { pinned, reason, actor, note }) {
  const db = getDb();
  if (!db) return { ok: false, error: 'ต่อฐานข้อมูลไม่ได้' };

  const update = pinned
    ? { $set: { pinned: true, updated_at: new Date() }, $addToSet: { pin_reasons: reason } }
    : { $set: { pinned: false, updated_at: new Date() } };

  const res = await db.collection(COL.clips).updateOne({ _id: clipId }, update);
  if (!res.matchedCount) return { ok: false, error: 'ไม่พบคลิปนี้' };

  // ถอน pin ต้องรู้ว่าใครถอนและทำไม (FR-6.5) — เป็นการเปิดทางให้คลิปถูกลบ
  void appendEvent({
    clip_id: clipId,
    event: pinned ? 'pin' : 'unpin',
    actor: actor ?? null,
    detail: { reason, note: note ?? null },
  });

  log.info({ clip_id: clipId, pinned, reason, actor }, pinned ? 'ตรึงคลิป' : 'ถอนการตรึงคลิป');
  return { ok: true };
}

/** POST /api/clips/:clipId/pin — ตรึงด้วยมือจากหน้าค้นหา (FR-6.2) */
pinRouter.post('/clips/:clipId/pin', json, async (req, res) => {
  const result = await setPin(req.params.clipId, {
    pinned: true,
    reason: 'manual',
    actor: req.body?.by ?? null,
    note: req.body?.note ?? null,
  });
  res.status(result.ok ? 200 : 404).json(result);
});

/** DELETE /api/clips/:clipId/pin — ถอนการตรึง ต้องระบุผู้ทำและเหตุผล */
pinRouter.delete('/clips/:clipId/pin', json, async (req, res) => {
  const by = req.body?.by;
  if (!by) return res.status(400).json({ ok: false, error: 'ต้องระบุ by — การถอนตรึงเปิดทางให้คลิปถูกลบ' });

  const result = await setPin(req.params.clipId, {
    pinned: false,
    reason: 'manual',
    actor: by,
    note: req.body?.note ?? null,
  });
  res.status(result.ok ? 200 : 404).json(result);
});

/**
 * POST /api/hook/case-opened — RefundCases เปิดเคสแล้ว (FR-6.1)
 *
 * รับได้ทั้ง ordersn และ tracking_no เพราะเคสของแต่ละแพลตฟอร์มมีข้อมูลไม่เหมือนกัน
 * ตรึงทุกคลิปที่ตรง ไม่ใช่แค่ตัวแรก — ออเดอร์เดียวอาจมีคลิปหลายตัวถ้าเคยแพ็คซ้ำ
 */
pinRouter.post('/hook/case-opened', json, async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ ok: false, error: 'ต่อฐานข้อมูลไม่ได้' });

  const { ordersn, tracking_no: trackingNo, case_id: caseId, platform } = req.body ?? {};
  if (!ordersn && !trackingNo) {
    return res.status(400).json({ ok: false, error: 'ต้องมี ordersn หรือ tracking_no อย่างน้อยหนึ่งอย่าง' });
  }

  const or = [];
  if (ordersn) or.push({ ordersn: String(ordersn) });
  if (trackingNo) or.push({ tracking_no: String(trackingNo) });

  const clips = await db.collection(COL.clips).find({ $or: or }).project({ _id: 1 }).toArray();

  for (const c of clips) {
    await setPin(c._id, { pinned: true, reason: 'case_opened', actor: `case:${caseId ?? '-'}` });
  }

  log.info({ ordersn, trackingNo, caseId, platform, pinned: clips.length }, 'ตรึงคลิปจากการเปิดเคส');

  // ตอบ 200 แม้ไม่เจอคลิป — ฝั่ง RefundCases ไม่ควรต้องจัดการกรณีนี้
  // ออเดอร์ที่แพ็คก่อนติดตั้งระบบย่อมไม่มีคลิป และไม่ใช่ความผิดพลาด
  res.json({ ok: true, pinned: clips.length, clip_ids: clips.map((c) => c._id) });
});

/**
 * POST /api/retention/run — สั่งงานลบข้อมูลด้วยมือ
 * ค่าปริยายเป็นการซ้อม ต้องส่ง confirm=true ถึงจะลบจริง
 */
pinRouter.post('/retention/run', json, async (req, res) => {
  const dryRun = String(req.body?.confirm) !== 'true';
  const report = await runRetention({
    dryRun,
    retentionDays: req.body?.retention_days ? Number(req.body.retention_days) : undefined,
  });
  res.json(report);
});
