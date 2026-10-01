import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ffprobeDuration } from '../lib/ffmpeg.js';
import { sendMedia } from '../lib/mediafile.js';
import { log } from '../log.js';

export const camtestRouter = Router();

const DIR = () => path.join(path.resolve(config.storage.path), '_camtest');
const KEEP_MS = 24 * 3600_000;

/**
 * POST /api/camera-test — ทดสอบกล้องแบบครบทาง (R5.2 · R5.3)
 *
 * ภาพในหน้าตั้งค่าขึ้น ไม่ได้แปลว่าคลิปจะถูกบันทึก — ช่วงดับ 12 ก.ย. 2026 กล้องยัง "พร้อม"
 * ตลอด ทดสอบนี้จึงอัดจริง ส่งขึ้นเซิร์ฟเวอร์จริง แล้วให้หน้าเว็บเปิดไฟล์ที่เซิร์ฟเวอร์เก็บไว้
 * กลับมาดู ผ่าน = ทางเดียวกับคลิปจริงใช้ได้ทั้งเส้น (กล้อง → MediaRecorder → เน็ต → ดิสก์)
 *
 * ไฟล์ทดสอบไม่ใช่หลักฐาน เก็บแยกโฟลเดอร์และลบเองหลัง 24 ชั่วโมง
 */
camtestRouter.post('/camera-test', express.raw({ type: '*/*', limit: '12mb' }), async (req, res) => {
  const buf = req.body;
  if (!buf?.length) return res.status(400).json({ ok: false, error: 'ไม่มีข้อมูลวิดีโอ — กล้องไม่ส่งภาพออกมาเลย' });

  const id = crypto.randomBytes(9).toString('hex');
  const file = path.join(DIR(), `${id}.mp4`);
  try {
    await fs.mkdir(DIR(), { recursive: true });
    await fs.writeFile(file, buf);
  } catch (err) {
    log.error({ err: err.message }, 'บันทึกไฟล์ทดสอบกล้องไม่ได้');
    return res.status(503).json({ ok: false, error: `เซิร์ฟเวอร์บันทึกไฟล์ไม่ได้: ${err.message}` });
  }
  void cleanup();

  const mp4 = buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp';
  const webm = buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3;
  const duration = await ffprobeDuration(file);
  const station = String(req.query.station ?? '') || null;

  const problems = [];
  if (!mp4 && !webm) problems.push('ไฟล์ไม่มีส่วนหัววิดีโอ — เปิดไม่ได้');
  if (duration !== null && duration < 1.5) problems.push(`ได้ภาพแค่ ${duration.toFixed(1)} วินาที`);
  if (buf.length < 20_000) problems.push('ไฟล์เล็กผิดปกติ — ภาพอาจดำหรือกล้องค้าง');

  log.info({ station_id: station, by: req.user?.name ?? null, bytes: buf.length, duration, ok: !problems.length }, 'ทดสอบกล้อง');
  res.json({
    ok: !problems.length,
    problems,
    bytes: buf.length,
    duration_sec: duration,
    format: mp4 ? 'mp4' : webm ? 'webm' : 'unknown',
    url: `/api/camera-test/${id}`,
  });
});

camtestRouter.get('/camera-test/:id', async (req, res) => {
  if (!/^[a-f0-9]{18}$/.test(req.params.id)) return res.sendStatus(400);
  const sent = await sendMedia(req, res, { media_path: path.join('_camtest', `${req.params.id}.mp4`) });
  if (!sent) res.status(404).json({ ok: false, error: 'ไฟล์ทดสอบหมดอายุแล้ว' });
});

async function cleanup() {
  try {
    const now = Date.now();
    for (const name of await fs.readdir(DIR())) {
      const p = path.join(DIR(), name);
      const st = await fs.stat(p);
      if (now - st.mtimeMs > KEEP_MS) await fs.rm(p, { force: true });
    }
  } catch { /* ลบไม่ได้รอบนี้ รอบหน้าลองใหม่ */ }
}
