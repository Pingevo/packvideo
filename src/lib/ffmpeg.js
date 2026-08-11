import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from '../log.js';

const run = promisify(execFile);

/**
 * ความสามารถของ ffmpeg ที่ต้องมีจริงถึงจะส่งออกหลักฐานได้
 *
 * ffmpeg บางบิลด์ไม่มีฟิลเตอร์ drawtext (คอมไพล์มาโดยไม่มี libfreetype)
 * ซึ่งแปลว่า **เบิร์นวันเวลาลงภาพไม่ได้** และไฟล์ที่ได้จะไม่ผ่านเงื่อนไขหลักฐานข้อ 4
 *
 * ตรวจตั้งแต่ตอนบูตแล้วบอกให้ชัด ดีกว่าไปพังตอนทีมเคลมกำลังจะส่งหลักฐาน
 */
let caps = null;

export async function probeFfmpeg() {
  const out = {
    available: false,
    version: null,
    libx264: false,
    drawtext: false,
    can_export: false,
    reason: null,
  };

  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-version'], { timeout: 10_000 });
    out.available = true;
    out.version = stdout.split('\n')[0]?.replace(/^ffmpeg version /, '') ?? null;
  } catch {
    out.reason = 'ไม่พบคำสั่ง ffmpeg';
    caps = out;
    return out;
  }

  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 10_000 });
    out.libx264 = /\blibx264\b/.test(stdout);
  } catch { /* ปล่อยเป็น false */ }

  // เชื่อการทดลองใช้จริง ไม่เชื่อรายการฟิลเตอร์ — บางบิลด์ประกาศไว้แต่ใช้ไม่ได้
  try {
    await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
       '-vf', "drawtext=text='0':fontcolor=white:fontsize=12", '-frames:v', '1', '-f', 'null', '-'],
      { timeout: 10_000 },
    );
    out.drawtext = true;
  } catch { out.drawtext = false; }

  out.can_export = out.available && out.libx264 && out.drawtext;
  if (!out.can_export) {
    out.reason = !out.libx264 ? 'ffmpeg บิลด์นี้ไม่มีตัวเข้ารหัส libx264'
      : !out.drawtext ? 'ffmpeg บิลด์นี้ไม่มีฟิลเตอร์ drawtext จึงเบิร์นวันเวลาลงภาพไม่ได้'
      : null;
  }

  caps = out;
  if (out.can_export) {
    log.info({ version: out.version }, 'ffmpeg พร้อมส่งออกหลักฐาน');
  } else {
    log.error({ ...out }, 'ffmpeg ยังส่งออกหลักฐานไม่ได้');
  }
  return out;
}

export function ffmpegCaps() {
  return caps ?? { available: false, can_export: false, reason: 'ยังไม่ได้ตรวจ' };
}

export async function ffmpeg(args, { timeout = 120_000 } = {}) {
  return run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export async function ffprobeDuration(file) {
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 20_000 },
    );
    const n = Number.parseFloat(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
