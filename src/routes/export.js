import { Router } from 'express';
import express from 'express';
import { exportClip, exportFrame, LIMITS } from '../lib/export.js';
import { ffmpegCaps } from '../lib/ffmpeg.js';

export const exportRouter = Router();

const json = express.json({ limit: '8kb' });

/** GET /api/export/limits — ให้หน้าเว็บรู้เพดานของแพลตฟอร์มโดยไม่ต้อง hardcode ซ้ำ */
exportRouter.get('/export/limits', (_req, res) => {
  res.json({ ok: true, limits: LIMITS, ffmpeg: ffmpegCaps() });
});

/**
 * POST /api/clips/:clipId/export — สร้างไฟล์สำหรับอัปเข้า Seller Center
 *
 * รับ `start_ms` ตัวเดียวโดยตั้งใจ (FR-5.5) — โครงสร้างนี้ไม่เปิดช่องให้ต่อหลายช่วง
 * เพราะหลักฐานที่ตัดต่อจากหลายช่วงเสียน้ำหนักทันที บังคับที่ API ไม่ใช่ฝากไว้กับวินัยของ CS
 */
exportRouter.post('/clips/:clipId/export', json, async (req, res) => {
  const result = await exportClip(req.params.clipId, {
    startMs: req.body?.start_ms,
    durationMs: req.body?.duration_ms,
    actor: req.body?.by ?? null,
  });
  if (!result.ok) return res.status(422).json(result);

  res.json({
    ok: true,
    cached: result.cached,
    name: result.name,
    bytes: result.bytes,
    mb: +(result.bytes / 1024 / 1024).toFixed(2),
    start_ms: result.start_ms,
    duration_sec: +Number(result.duration_sec).toFixed(2),
    download_url: `/api/clips/${req.params.clipId}/export/${encodeURIComponent(result.name)}`,
  });
});

/** GET — ดาวน์โหลดไฟล์ที่สร้างไว้แล้ว */
exportRouter.get('/clips/:clipId/export/:name', async (req, res) => {
  const m = /^([a-z0-9_]+)_(\d+)_(\d+)\.mp4$/i.exec(req.params.name);
  if (!m || m[1] !== req.params.clipId) return res.status(400).json({ ok: false, error: 'ชื่อไฟล์ไม่ถูกต้อง' });

  const result = await exportClip(req.params.clipId, {
    startMs: Number(m[2]),
    durationMs: Number(m[3]),
    actor: req.query.by ?? null,
  });
  if (!result.ok) return res.status(422).json(result);

  res.download(result.path, `${req.params.clipId}.mp4`);
});

/** GET /api/clips/:clipId/frame?at_ms= — เฟรมนิ่งสำหรับชุดหลักฐานที่ขอเป็นรูป */
exportRouter.get('/clips/:clipId/frame', async (req, res) => {
  const result = await exportFrame(req.params.clipId, {
    atMs: Number(req.query.at_ms) || 0,
    actor: req.query.by ?? null,
  });
  if (!result.ok) return res.status(422).json(result);
  res.sendFile(result.path);
});

/** GET /api/clips/:clipId/cover — รูปปกที่ Lazada บังคับต้องมีคู่กับวิดีโอ (FR-5.4) */
exportRouter.get('/clips/:clipId/cover', async (req, res) => {
  const result = await exportFrame(req.params.clipId, { atMs: Number(req.query.at_ms) || 1000 });
  if (!result.ok) return res.status(422).json(result);
  res.sendFile(result.path);
});
