import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { pingDb, dbState } from '../db.js';
import { storageStatus } from '../lib/storage.js';
import { config } from '../config.js';
import { ffmpegCaps } from '../lib/ffmpeg.js';

const pkg = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);

export const healthRouter = Router();

/**
 * GET /api/health — สถานะรวมของระบบ (FR-9.4)
 *
 * ตอบ 503 เมื่อมีอะไรพังจริง เพื่อให้ตัวเฝ้าระวังภายนอกจับได้
 * สถานะของ endpoint นี้ไม่มีผลต่องานแพ็ค — /signal แยกกันคนละเส้นทางโดยตั้งใจ
 */
healthRouter.get('/health', async (_req, res) => {
  const [mongo, storage] = await Promise.all([pingDb(), storageStatus()]);

  const checks = {
    mongo: { ...mongo, connected: dbState().connected },
    storage,
    // ffmpeg ไม่พร้อม = ส่งออกหลักฐานไม่ได้ ซึ่งเป็นเหตุผลที่ระบบนี้มีอยู่
    // ต้องเห็นในหน้า health ไม่ใช่ไปรู้ตอนทีมเคลมกำลังจะส่งหลักฐาน
    ffmpeg: ffmpegCaps(),
  };

  // ดิสก์เต็มถึงระดับหยุดบันทึก = ปัญหาที่ต้องรีบรู้ แต่ไม่ใช่ "ระบบพัง"
  const healthy = mongo.ok && storage.writable;

  res.status(healthy ? 200 : 503).json({
    ok: healthy,
    service: 'packvideo',
    version: pkg.version,
    env: config.env,
    uptime_s: Math.round(process.uptime()),
    recording_allowed: storage.recording_allowed,
    checks,
  });
});

/** GET /api/health/live — มีชีวิตอยู่ไหม ไม่สนใจ dependency ใช้กับ container restart policy */
healthRouter.get('/health/live', (_req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});
