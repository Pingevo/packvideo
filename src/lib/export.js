import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { ffmpeg, ffmpegCaps, ffprobeDuration } from './ffmpeg.js';
import { findClip } from './repo.js';
import { appendEvent } from './repo.js';

/**
 * ท่อส่งออกหลักฐาน (design §8)
 *
 * ข้อจำกัดมาจากแพลตฟอร์ม ไม่ใช่จากเรา — อ่านจากหน้า Shopee Seller Centre
 * และบันทึกไว้ใน sellcenter api/services/RefundCaseActionService.js:987
 *   { image_mb: 10, video_mb: 30, video_sec: 60 }
 * รับ MP4 MOV JPG JPEG PNG
 *
 * ตัวที่บีบจริงคือ 60 วินาที ไม่ใช่ 30 MB — ต้นฉบับ 1 Mbps × 60 วิ ≈ 7.5 MB
 */

export const LIMITS = {
  videoSec: 60,
  videoMb: 30,
  imageMb: 10,
  maxFrames: 6,
};

const ROOT = () => path.resolve(config.storage.path);
const EXPORT_DIR = () => path.join(ROOT(), '_export');

/** ตัวอักษรที่ต้องหลบก่อนใส่ลงฟิลเตอร์ของ ffmpeg ไม่งั้นคำสั่งเพี้ยน */
function escapeText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%');
}

function drawtext(text, y, fontSize) {
  return [
    `drawtext=text='${escapeText(text)}'`,
    `x=(w-text_w)/2`,
    `y=${y}`,
    `fontsize=${fontSize}`,
    'fontcolor=white',
    // พื้นทึบใต้ตัวอักษร ให้อ่านออกทุกพื้นหลัง — กล่องขาวบนโต๊ะขาวคืออ่านไม่ออก
    'box=1',
    'boxcolor=black@0.65',
    'boxborderw=8',
  ].join(':');
}

/**
 * วันเวลาที่จะเบิร์นลงภาพ
 *
 * **ต้องเป็นอักขระ ASCII ล้วน** — ฟอนต์ปริยายที่ ffmpeg หยิบมาใช้ไม่มีอักษรไทย
 * ตัวอักษรไทยจะกลายเป็นกล่องว่าง □ ซึ่งบนหลักฐานที่ส่งให้แพลตฟอร์มดูแย่มาก
 * (เจอจริงตอนทดสอบ: "น." ออกมาเป็น "□.")
 *
 * ใช้ปี ค.ศ. เพราะเจ้าหน้าที่แพลตฟอร์มอ่านได้ทุกชาติ และเขียน +07 กำกับไว้
 * ให้ชัดว่าเป็นเวลาไทย ไม่ต้องเดาว่าเป็น timezone ไหน
 */
function fmtWhen(date) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}/${g('month')}/${g('year')} ${g('hour')}:${g('minute')}:${g('second')} +07`;
}

/**
 * สร้างไฟล์สำหรับอัปโหลดเข้าแพลตฟอร์ม
 *
 * @param {string} clipId
 * @param {{startMs?: number, durationMs?: number, actor?: string}} opts
 */
export async function exportClip(clipId, opts = {}) {
  const caps = ffmpegCaps();
  if (!caps.can_export) {
    // ห้ามส่งไฟล์ที่ไม่มีวันเวลาเบิร์นออกไปเงียบๆ — มันดูเหมือนหลักฐานแต่ใช้ไม่ได้จริง
    // และไม่มีใครรู้จนกว่าแพลตฟอร์มจะปฏิเสธตอนที่แก้อะไรไม่ทันแล้ว
    return { ok: false, error: `ส่งออกไม่ได้: ${caps.reason ?? 'ffmpeg ไม่พร้อม'}` };
  }

  const clip = await findClip(clipId);
  if (!clip) return { ok: false, error: 'ไม่พบคลิปนี้' };
  if (!clip.media_path || clip.media_deleted_at) {
    return { ok: false, error: 'ไม่มีไฟล์วิดีโอของคลิปนี้แล้ว' };
  }

  const source = path.join(ROOT(), clip.media_path);
  try {
    await fs.access(source);
  } catch {
    return { ok: false, error: 'ไฟล์หายไปจากดิสก์' };
  }

  const sourceSec = (await ffprobeDuration(source)) ?? (clip.duration_ms ?? 0) / 1000;
  const startMs = Math.max(0, Math.floor(opts.startMs ?? suggestStart(clip, sourceSec)));
  // ตัดที่ 60 วินาทีเสมอ ไม่ว่าจะขอมาเท่าไร — เพดานนี้เป็นของแพลตฟอร์ม เราต่อรองไม่ได้
  const durationSec = Math.min(
    LIMITS.videoSec,
    (opts.durationMs ?? LIMITS.videoSec * 1000) / 1000,
    Math.max(1, sourceSec - startMs / 1000),
  );

  await fs.mkdir(EXPORT_DIR(), { recursive: true });
  const name = `${clipId}_${startMs}_${Math.round(durationSec * 1000)}.mp4`;
  const outPath = path.join(EXPORT_DIR(), name);

  // กดซ้ำต้องได้ทันที — ทีมเคลมมักดาวน์โหลดซ้ำหลายรอบระหว่างสู้เคสเดียว
  try {
    const cached = await fs.stat(outPath);
    if (cached.size > 0) {
      // ต้องบันทึกด้วยว่าใครโหลดแม้เป็นไฟล์ที่เคยสร้างไว้แล้ว
      //
      // เดิมทางลัดนี้ return ออกไปเลยโดยไม่บันทึกอะไร ผลคือการโหลดครั้งที่สองเป็นต้นไป
      // ไม่มีร่องรอยเลย — NFR-4.7 บอกว่าต้องตอบได้ว่าคลิปหนึ่งถูกเปิดเผยให้ใครไปแล้วบ้าง
      // ซึ่งตอบไม่ได้จริงถ้านับเฉพาะครั้งแรก · สำคัญขึ้นอีกเมื่อคนแพ็คโหลดเองได้ (FR-12.5)
      void appendEvent({
        clip_id: clipId,
        event: 'export',
        ordersn: clip.ordersn ?? null,
        actor: opts.actor ?? null,
        detail: { start_ms: startMs, duration_sec: durationSec, bytes: cached.size, cached: true },
      });
      return { ok: true, cached: true, path: outPath, name, bytes: cached.size,
               start_ms: startMs, duration_sec: durationSec };
    }
  } catch { /* ยังไม่มี cache */ }

  const when = fmtWhen(new Date(clip.started_at));
  const bottom = [clip.ordersn, clip.tracking_no].filter(Boolean).join('   ');

  const filters = [
    drawtext(when, '24', 34),
    bottom ? drawtext(bottom, 'h-th-24', 30) : null,
  ].filter(Boolean).join(',');

  const args = [
    // -ss ก่อน -i คือค้นหาเร็ว · ใส่ -accurate_seek กันคลาดเคลื่อนที่หัวคลิป
    '-accurate_seek', '-ss', String(startMs / 1000),
    '-i', source,
    '-t', String(durationSec),
    '-vf', filters,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    // ไม่มีเสียงตั้งแต่ตอนอัดอยู่แล้ว ระบุซ้ำกันไฟล์แปลกๆ หลุดออกไป
    '-an',
    // ให้เล่นได้ทันทีที่โหลดถึงต้นไฟล์ ไม่ต้องรอทั้งไฟล์
    '-movflags', '+faststart',
    outPath,
  ];

  const started = Date.now();
  try {
    await ffmpeg(args, { timeout: 180_000 });
  } catch (err) {
    log.error({ clip_id: clipId, err: err.stderr ?? err.message }, 'ส่งออกไม่สำเร็จ');
    return { ok: false, error: 'แปลงไฟล์ไม่สำเร็จ' };
  }

  const stat = await fs.stat(outPath);
  const mb = stat.size / 1024 / 1024;

  // ตรวจของจริงก่อนส่งมอบ ไม่ใช่เชื่อว่าการตั้งค่าถูกแล้วต้องได้ผลถูก
  if (mb > LIMITS.videoMb) {
    await fs.rm(outPath, { force: true });
    return { ok: false, error: `ไฟล์ที่ได้ ${mb.toFixed(1)} MB เกินเพดาน ${LIMITS.videoMb} MB ของแพลตฟอร์ม` };
  }
  const outSec = await ffprobeDuration(outPath);
  if (outSec && outSec > LIMITS.videoSec + 0.5) {
    await fs.rm(outPath, { force: true });
    return { ok: false, error: `ไฟล์ที่ได้ยาว ${outSec.toFixed(1)} วินาที เกินเพดาน ${LIMITS.videoSec} วินาที` };
  }

  void appendEvent({
    clip_id: clipId,
    event: 'export',
    ordersn: clip.ordersn ?? null,
    actor: opts.actor ?? null,
    detail: { start_ms: startMs, duration_sec: durationSec, bytes: stat.size },
  });

  log.info(
    { clip_id: clipId, bytes: stat.size, duration_sec: durationSec, took_ms: Date.now() - started },
    'ส่งออกหลักฐานแล้ว',
  );

  return { ok: true, cached: false, path: outPath, name, bytes: stat.size,
           start_ms: startMs, duration_sec: outSec ?? durationSec };
}

/**
 * ช่วงเริ่มต้นที่เสนอให้ (FR-5.6)
 *
 * ถอยหลัง 60 วินาทีจากท้ายคลิป เพราะช่วงท้ายคือตอนปิดกล่อง แปะใบปะหน้า และสแกนปิด
 * ซึ่งเป็นช่วงที่มีทั้งการปิดกล่องและเลขพัสดุอยู่ในเฟรมเดียวกัน
 */
function suggestStart(clip, sourceSec) {
  const total = sourceSec || (clip.duration_ms ?? 0) / 1000;
  if (total <= LIMITS.videoSec) return 0;
  return Math.max(0, (total - LIMITS.videoSec)) * 1000;
}

/** ดึงเฟรมนิ่ง (FR-5.3) — TikTok บังคับต้องมีรูปการแพ็คในบางชุดหลักฐาน */
export async function exportFrame(clipId, { atMs = 0, actor } = {}) {
  const caps = ffmpegCaps();
  if (!caps.can_export) return { ok: false, error: `ส่งออกไม่ได้: ${caps.reason}` };

  const clip = await findClip(clipId);
  if (!clip?.media_path || clip.media_deleted_at) return { ok: false, error: 'ไม่มีไฟล์วิดีโอของคลิปนี้' };

  const source = path.join(ROOT(), clip.media_path);
  await fs.mkdir(EXPORT_DIR(), { recursive: true });
  const name = `${clipId}_f${Math.round(atMs)}.jpg`;
  const outPath = path.join(EXPORT_DIR(), name);

  try {
    const cached = await fs.stat(outPath);
    if (cached.size > 0) return { ok: true, cached: true, path: outPath, name, bytes: cached.size };
  } catch { /* ยังไม่มี */ }

  const when = fmtWhen(new Date((clip.started_at ? new Date(clip.started_at).getTime() : 0) + atMs));
  const bottom = [clip.ordersn, clip.tracking_no].filter(Boolean).join('   ');
  const filters = [drawtext(when, '24', 34), bottom ? drawtext(bottom, 'h-th-24', 30) : null]
    .filter(Boolean).join(',');

  try {
    await ffmpeg([
      '-accurate_seek', '-ss', String(atMs / 1000),
      '-i', source, '-frames:v', '1',
      '-vf', filters,
      '-q:v', '3',
      outPath,
    ], { timeout: 60_000 });
  } catch (err) {
    log.error({ clip_id: clipId, err: err.stderr ?? err.message }, 'ดึงเฟรมไม่สำเร็จ');
    return { ok: false, error: 'ดึงเฟรมไม่สำเร็จ' };
  }

  const stat = await fs.stat(outPath);
  if (stat.size / 1024 / 1024 > LIMITS.imageMb) {
    await fs.rm(outPath, { force: true });
    return { ok: false, error: `รูปที่ได้เกินเพดาน ${LIMITS.imageMb} MB` };
  }

  void appendEvent({
    clip_id: clipId, event: 'frame', ordersn: clip.ordersn ?? null,
    actor: actor ?? null, detail: { at_ms: atMs, bytes: stat.size },
  });

  return { ok: true, cached: false, path: outPath, name, bytes: stat.size };
}
