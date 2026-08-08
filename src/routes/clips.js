import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as clips from '../lib/clips.js';
import { subscribe } from '../lib/sse.js';
import { storageStatus } from '../lib/storage.js';

export const clipsRouter = Router();

const json = express.json({ limit: '8kb' });

// ── SSE ───────────────────────────────────────────────────────
/** GET /api/stream/:stationId — หน้าต่างอัดเปิดค้างไว้ตลอดกะ */
clipsRouter.get('/stream/:stationId', async (req, res) => {
  subscribe(req.params.stationId, res);

  // บอกสถานะปัจจุบันทันทีที่ต่อเข้ามา ไม่ต้องรอเหตุการณ์ถัดไป
  const disk = await storageStatus();
  const open = clips.openClipOf(req.params.stationId);
  res.write(
    `event: config\ndata: ${JSON.stringify({
      recording: disk.recording_allowed,
      disk_level: disk.disk_level,
      disk_used_pct: disk.used_pct,
      // ขอชิ้นทุก 1 วินาที — S1 วัดแล้วว่าเบราว์เซอร์ส่งจริงห่างได้ถึง 4 วินาที
      // การขอ 5 วินาทีจะได้ช่วงห่าง >=5 โดยไม่ได้อะไรกลับมา
      timeslice_ms: 1000,
      video_bps: 1_000_000,
      open_clip: open ? { clip_id: open._id, ordersn: open.ordersn, tracking_no: open.tracking_no } : null,
    })}\n\n`,
  );
});

// ── รับชิ้นวิดีโอ ──────────────────────────────────────────────
/**
 * PUT /api/clip/:clipId/chunk/:seq
 *
 * ยิงซ้ำได้ไม่เกิดข้อมูลซ้อน เพราะแต่ละชิ้นถูกเขียนเป็นไฟล์ตามลำดับของตัวเอง
 * ฝั่งเครื่องจึงส่งใหม่ได้อย่างปลอดภัยเมื่อเน็ตสะดุด
 */
clipsRouter.put(
  '/clip/:clipId/chunk/:seq',
  express.raw({ type: '*/*', limit: '8mb' }),
  async (req, res) => {
    const seq = Number.parseInt(req.params.seq, 10);
    if (!Number.isInteger(seq) || seq < 0) {
      return res.status(400).json({ ok: false, error: 'seq ไม่ถูกต้อง' });
    }
    if (!req.body?.length) return res.status(400).json({ ok: false, error: 'ไม่มีข้อมูล' });

    const result = await clips.putChunk(req.params.clipId, seq, req.body);
    // 409 = ทิ้งชิ้นนี้ได้เลย · 503 = ปัญหาชั่วคราว ให้ส่งใหม่
    const status = result.ok ? 200 : result.final ? 409 : 503;
    res.status(status).json(result);
  },
);

/** POST /api/clip/:clipId/close — ปิดคลิปจากฝั่งเครื่อง */
clipsRouter.post('/clip/:clipId/close', json, async (req, res) => {
  const allowed = ['manual_stop', 'unverified'];
  const status = allowed.includes(req.body?.status) ? req.body.status : 'unverified';
  const clip = await clips.close(req.params.clipId, status, req.body?.note);
  if (!clip) return res.status(404).json({ ok: false, error: 'ไม่พบคลิปนี้' });
  res.json({ ok: true, clip: clips.toMetadata(clip) });
});

/** POST /api/station/:stationId/detach — หน้าต่างอัดกำลังจะปิด ปิดคลิปค้างให้ด้วย */
clipsRouter.post('/station/:stationId/detach', json, async (req, res) => {
  await clips.closeStation(req.params.stationId, req.body?.reason ?? 'หน้าต่างอัดถูกปิด');
  res.json({ ok: true });
});

// ── อ่านคลิป ──────────────────────────────────────────────────
clipsRouter.get('/clips', (req, res) => {
  res.json({
    ok: true,
    clips: clips.listClips({ limit: Number(req.query.limit) || 100 }).map(clips.toMetadata),
  });
});

clipsRouter.get('/clips/:clipId', (req, res) => {
  const clip = clips.getClip(req.params.clipId);
  if (!clip) return res.status(404).json({ ok: false, error: 'ไม่พบคลิปนี้' });
  res.json({ ok: true, clip: clips.toMetadata(clip) });
});

// ── สตรีมวิดีโอ ───────────────────────────────────────────────
/**
 * GET /media/:clipId
 *
 * ต้องรองรับ Range → 206 ไม่งั้นเลื่อนดูกลางคลิปไม่ได้ (FR-4.5)
 * ซึ่งเป็นสิ่งที่ทีมเคลมต้องทำตลอดเวลา — ไม่มีใครดูคลิปแพ็คของตั้งแต่วินาทีแรก
 */
export const mediaRouter = Router();

mediaRouter.get('/:clipId', async (req, res) => {
  const clip = clips.getClip(req.params.clipId);
  if (!clip?.media_path) return res.status(404).json({ ok: false, error: 'ไม่พบไฟล์คลิป' });

  const full = path.join(path.resolve(config.storage.path), clip.media_path);
  // กัน path traversal แม้ clip_id จะมาจากที่เก็บของเราเอง
  if (!full.startsWith(path.resolve(config.storage.path))) return res.sendStatus(400);

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return res.status(404).json({ ok: false, error: 'ไฟล์หายไปจากดิสก์' });
  }

  const range = req.headers.range;
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');

  if (!range) {
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(full).pipe(res);
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return res.status(416).end();
  const start = m[1] ? Number.parseInt(m[1], 10) : 0;
  const end = m[2] ? Number.parseInt(m[2], 10) : stat.size - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }

  const to = Math.min(end, stat.size - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${to}/${stat.size}`);
  res.setHeader('Content-Length', to - start + 1);
  fs.createReadStream(full, { start, end: to }).pipe(res);
});
