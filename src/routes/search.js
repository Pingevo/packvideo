import { Router } from 'express';
import { findClips, findClip, findEvents, distinctPackers } from '../lib/repo.js';
import { dbState } from '../db.js';
import { config } from '../config.js';
import { MIN_VIDEO_BYTES } from '../lib/schema.js';

export const searchRouter = Router();

/**
 * ป้ายภาษาไทยของสถานะ — ที่เดียว ใช้ทั้ง API และไฟล์ส่งออก (R4.2)
 * หน้าเว็บอ่านจาก /api/search/options ไม่เขียนซ้ำ
 */
export const STATUS_TH = {
  pending: 'กำลังเริ่ม',
  recording: 'กำลังอัด',
  closing: 'กำลังปิดไฟล์',
  verified: 'ยิงใบปะหน้าตรง',
  registered: 'ลงทะเบียนส่ง (KOL)',
  manual_stop: 'กดหยุดเอง',
  unverified: 'ไม่ได้ยิงปิด',
  timeout: 'ค้างจนหมดเวลา',
  aborted: 'ทิ้ง (ไม่พบออเดอร์)',
};

/** ปัญหาของไฟล์ — สิ่งที่ทีมเคลมต้องรู้ก่อนสัญญากับลูกค้าว่ามีหลักฐาน (R4.1) */
export const PROBLEM_TH = {
  no_video: 'ไม่ได้บันทึก (กล้องไม่ทำงาน)',
  corrupt: 'ไฟล์เปิดไม่ได้',
  deleted: 'ลบแล้วตามกำหนด',
};

const PROBLEM_FILTER = {
  // ไม่มีไฟล์ หรือไฟล์มีแค่ส่วนหัว แต่ไม่ใช่เพราะถูกลบตามกำหนด และไม่ใช่คลิปที่ถูกทิ้ง
  no_video: {
    $or: [{ media_path: null }, { bytes: { $lt: MIN_VIDEO_BYTES } }],
    media_deleted_at: null,
    status: { $nin: ['aborted', 'pending', 'recording', 'closing'] },
  },
  corrupt: { flags: 'no_header', media_offset: { $exists: false } },
  deleted: { media_deleted_at: { $ne: null } },
  any: {
    $or: [
      { media_path: null, media_deleted_at: null, status: { $nin: ['aborted', 'pending', 'recording', 'closing'] } },
      { bytes: { $lt: MIN_VIDEO_BYTES }, media_deleted_at: null, status: { $nin: ['aborted', 'pending', 'recording', 'closing'] } },
      { flags: 'no_header', media_offset: { $exists: false } },
    ],
  },
};

function buildFilter(query) {
  const filter = {};
  const and = [];

  const q = String(query.q ?? '').trim();
  if (q) {
    // ค่าที่สแกน/คัดลอกมามักมีขีดหรือช่องว่างติดมา — เทียบทั้งแบบเดิมและแบบตัดอักขระคั่นออก
    const bare = q.replace(/[\s/-]/g, '');
    and.push({
      $or: [
        { ordersn: q }, { ordersn: bare },
        { tracking_no: q }, { tracking_no: bare },
        { imeis: q }, { imeis: bare },
        { project_id: q },
        { _id: q },
      ],
    });
  }

  if (query.station) filter.station_id = String(query.station);
  if (query.packer) filter.packer = String(query.packer);
  if (query.status) filter.status = String(query.status);
  else if (query.include_aborted !== 'true') filter.status = { $ne: 'aborted' };
  if (query.pinned === 'true') filter.pinned = true;
  if (PROBLEM_FILTER[query.problem]) and.push(PROBLEM_FILTER[query.problem]);

  // started_at เก็บเป็นสตริง ISO (toMetadata) — เทียบสตริงได้ตรง และครอบคลุมคลิปเก่าที่ไม่มี `day` (R4.3)
  const range = {};
  const from = String(query.from ?? '');
  const to = String(query.to ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) range.$gte = new Date(`${from}T00:00:00+07:00`).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) range.$lte = new Date(`${to}T23:59:59.999+07:00`).toISOString();
  // หน้าถัดไป: เอาเฉพาะที่เก่ากว่าแถวสุดท้ายของหน้าก่อน (R4.5) — ไม่ใช้ skip ที่ช้าลงเรื่อยๆ
  if (query.before) range.$lt = String(query.before);
  if (Object.keys(range).length) filter.started_at = range;

  if (and.length) filter.$and = and;
  return filter;
}

/**
 * GET /api/search — ค้นคลิปสำหรับทีมเคลมและพนักงานแพ็ค (FR-4.1–4.3, 4.7 · R4)
 *
 * ค้นด้วย `q` ตัวเดียวได้เลยโดยไม่ต้องเลือกก่อนว่าเป็นเลขอะไร — ทีมเคลมคัดลอกเลขมาจาก
 * หน้าเคสแล้ววาง ไม่ควรต้องมานั่งแยกว่านี่คือ ordersn หรือ tracking หรือ IMEI
 *
 * ตัวกรอง: station · packer · status · problem (no_video|corrupt|deleted|any) · pinned · from/to
 * หน้าถัดไป: ส่ง `before` = `next_before` ของผลก่อนหน้า
 */
searchRouter.get('/search', async (req, res) => {
  if (!dbState().connected) {
    return res.status(503).json({ ok: false, error: 'ต่อฐานข้อมูลไม่ได้ — ค้นหาไม่ได้ชั่วคราว' });
  }

  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  // ขอเกินหนึ่งแถวเพื่อรู้ว่ายังมีหน้าถัดไปไหม แทนการเดาจาก "ได้ครบ limit พอดี"
  const rows = (await findClips(buildFilter(req.query), { limit: limit + 1 })) ?? [];
  const more = rows.length > limit;
  const clips = rows.slice(0, limit);

  res.json({
    ok: true,
    count: clips.length,
    truncated: more,
    next_before: more ? clips[clips.length - 1].started_at : null,
    clips: clips.map(present),
  });
});

/** GET /api/search/options — ตัวเลือกกรอง (โต๊ะ · พนักงาน 60 วันล่าสุด · ป้ายภาษาไทย) */
searchRouter.get('/search/options', async (_req, res) => {
  const since = new Date(Date.now() - 60 * 86400_000).toISOString();
  const packers = ((await distinctPackers(since)) ?? []).filter(Boolean).sort((a, b) => a.localeCompare(b, 'th'));
  res.json({ ok: true, stations: config.stations, packers, status: STATUS_TH, problem: PROBLEM_TH });
});

/**
 * GET /api/search/export.csv — ผลค้นหาเป็นไฟล์ที่เปิดใน Excel ได้ (R4.6)
 *
 * CSV + BOM แทน .xlsx: Excel เปิดภาษาไทยถูกต้องเมื่อมี BOM และไม่ต้องเพิ่ม library
 * เพดาน 5,000 แถว — มากกว่านี้ให้แคบช่วงวันลง
 */
searchRouter.get('/search/export.csv', async (req, res) => {
  if (!dbState().connected) return res.status(503).json({ ok: false, error: 'ต่อฐานข้อมูลไม่ได้' });
  const MAX = 5000;
  const rows = (await findClips(buildFilter(req.query), { limit: MAX })) ?? [];

  const head = ['วันที่', 'เวลา', 'โต๊ะ', 'พนักงาน', 'เลขออเดอร์', 'เลขพัสดุ', 'IMEI', 'สถานะ', 'วิดีโอ',
    'ยาว (วินาที)', 'ขนาด (MB)', 'ตรึงไว้', 'clip_id'];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    // กัน Excel ตีความเป็นสูตร (=, +, -, @) และเลขยาวกลายเป็น 1.23E+14
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const text = (v) => (v ? `="${String(v).replace(/"/g, '')}"` : '');
  const lines = [head.join(',')];
  for (const c of rows.map(present)) {
    const d = c.started_at ? new Date(c.started_at) : null;
    lines.push([
      d ? d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) : '',
      d ? d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok' }) : '',
      cell(c.station_id), cell(c.packer), text(c.ordersn), text(c.tracking_no), text(c.imeis.join(' ')),
      cell(STATUS_TH[c.status] ?? c.status),
      cell(c.problem ? PROBLEM_TH[c.problem] : 'มีวิดีโอ'),
      c.duration_ms == null ? '' : Math.round(c.duration_ms / 1000),
      c.bytes ? (c.bytes / 1048576).toFixed(2) : '',
      c.pinned ? 'ใช่' : '',
      cell(c.clip_id),
    ].join(','));
  }
  if (rows.length >= MAX) lines.push(cell(`แสดงแค่ ${MAX} แถวแรก — แคบช่วงวันลงเพื่อดูที่เหลือ`));

  const name = `packvideo-clips-${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send('﻿' + lines.join('\r\n'));
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
 *
 * `problem` แยกสามกรณีที่เคยปนกันเป็น "ไม่มีวิดีโอแล้ว" คำเดียว (R4.1) — ถึง 17 ก.ย. 2026
 * คลิปว่างจากกล้องดับ 578 คลิปขึ้นป้ายนี้ ทำให้ทีมเคลมเข้าใจว่าถูกลบตามกำหนด
 */
export function present(clip) {
  const gone = !!clip.media_deleted_at;
  const live = ['pending', 'recording', 'closing'].includes(clip.status);
  const flags = clip.flags ?? [];
  let problem = null;
  if (gone) problem = 'deleted';
  else if ((!clip.media_path || (clip.bytes ?? 0) < MIN_VIDEO_BYTES) && !live && clip.status !== 'aborted') problem = 'no_video';
  else if (clip.media_path && flags.includes('no_header') && !clip.media_offset) problem = 'corrupt';

  return {
    clip_id: clip._id,
    station_id: clip.station_id,
    packer: clip.packer,
    status: clip.status,
    status_th: STATUS_TH[clip.status] ?? clip.status,
    ordersn: clip.ordersn,
    tracking_no: clip.tracking_no,
    project_id: clip.project_id ?? null,
    imeis: clip.imeis ?? [],
    flags,
    pinned: !!clip.pinned,
    pin_reasons: clip.pin_reasons ?? [],
    day: clip.day,
    started_at: clip.started_at,
    ended_at: clip.ended_at,
    duration_ms: clip.duration_ms ?? null,
    bytes: clip.bytes ?? 0,
    checksum: clip.checksum ?? null,
    problem,
    problem_th: problem ? PROBLEM_TH[problem] : null,
    repaired: !!clip.media_offset,
    media_available: !!clip.media_path && !gone,
    media_deleted_at: clip.media_deleted_at ?? null,
    media_url: clip.media_path && !gone ? `/media/${clip._id}` : null,
  };
}
