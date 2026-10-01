import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * อ่านไฟล์คลิปโดยข้ามไบต์หน้าไฟล์ที่ไม่ใช่ของคลิปนี้
 *
 * หน้าต่างอัดรุ่นก่อน 0.2.0 ติดป้ายชิ้นท้ายของคลิปก่อนหน้าเป็นชิ้นแรกของคลิปใหม่
 * ไฟล์จึงขึ้นต้นด้วย moof ของคลิปอื่นแล้วเปิดไม่ได้ (324 คลิปถึง 17 ก.ย. 2026)
 * ตัวภาพจริงของคลิปยังอยู่ครบถัดจากนั้น
 *
 * **ไม่แก้ไฟล์ต้นฉบับ** — checksum ถูกประกาศไปแล้วตอนปิดคลิปและเป็นสิ่งที่ทำให้ไฟล์ใช้เป็น
 * หลักฐานได้ จึงเก็บแค่ `media_offset` (จำนวนไบต์ที่ต้องข้าม) ไว้ในเอกสารคลิป แล้วทุกทางที่
 * อ่านไฟล์ (เล่น / ลิงก์ภายนอก / ส่งออก) ข้ามเอง · สคริปต์ที่ตั้งค่านี้: scripts/repair-clip-head.mjs
 */
export function mediaOffset(clip) {
  const n = clip?.media_offset;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function mediaFullPath(clip) {
  const root = path.resolve(config.storage.path);
  const full = path.join(root, clip.media_path);
  return full.startsWith(root) ? full : null;   // กัน path traversal
}

/** อาร์กิวเมนต์ที่ต้องใส่ก่อน -i ของ ffmpeg/ffprobe */
export function ffmpegSkipArgs(clip) {
  const off = mediaOffset(clip);
  return off ? ['-skip_initial_bytes', String(off)] : [];
}

/**
 * สตรีมคลิปพร้อม Range → 206 (FR-4.5) โดยตำแหน่งไบต์นับหลังส่วนที่ข้ามแล้ว
 * @returns {Promise<boolean>} false = หาไฟล์ไม่เจอ ให้ผู้เรียกตอบ 404 เอง
 */
export async function sendMedia(req, res, clip, headers = {}) {
  const full = mediaFullPath(clip);
  if (!full) { res.sendStatus(400); return true; }

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return false;
  }

  const offset = Math.min(mediaOffset(clip), stat.size);
  const size = stat.size - offset;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', size);
    if (!size) { res.end(); return true; }
    fs.createReadStream(full, { start: offset }).pipe(res);
    return true;
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) { res.status(416).end(); return true; }
  const start = m[1] ? Number.parseInt(m[1], 10) : 0;
  const end = m[2] ? Number.parseInt(m[2], 10) : size - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return true;
  }

  const to = Math.min(end, size - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${to}/${size}`);
  res.setHeader('Content-Length', to - start + 1);
  fs.createReadStream(full, { start: offset + start, end: offset + to }).pipe(res);
  return true;
}
