import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createShare, resolveShare, recordView, revokeShare, listShares } from '../lib/share.js';

export const shareApiRouter = Router();
export const sharePublicRouter = Router();

const json = express.json({ limit: '8kb' });

// ── ฝั่งทีมเคลม ───────────────────────────────────────────────
shareApiRouter.post('/clips/:clipId/share', json, async (req, res) => {
  const result = await createShare(req.params.clipId, {
    by: req.body?.by ?? null,
    note: req.body?.note ?? null,
    ttlDays: req.body?.days,
  });
  if (!result.ok) return res.status(422).json(result);

  const origin = `${req.protocol}://${req.get('host')}`;
  res.json({
    ok: true,
    url: `${origin}/s/${result.token}`,
    expires_at: result.expires_at,
    days: result.days,
  });
});

shareApiRouter.get('/clips/:clipId/shares', async (req, res) => {
  res.json({ ok: true, shares: await listShares(req.params.clipId) });
});

shareApiRouter.delete('/share/:token', json, async (req, res) => {
  const result = await revokeShare(req.params.token, { by: req.body?.by ?? null });
  res.status(result.ok ? 200 : 404).json(result);
});

// ── ฝั่งผู้รับภายนอก ──────────────────────────────────────────
/**
 * เสิร์ฟหน้า HTML ไม่ใช่ไฟล์ดิบ
 *
 * ทำให้บันทึกการเข้าดูได้ ควบคุมว่าโหลดคลิปไหน และใส่ข้อความกำกับได้
 * ถ้าส่งไฟล์ดิบไปตรงๆ ลิงก์จะถูกส่งต่อและดาวน์โหลดซ้ำโดยไม่มีร่องรอย
 */
sharePublicRouter.get('/s/:token', async (req, res) => {
  const found = await resolveShare(req.params.token);
  if (!found.ok) return res.status(found.status).type('html').send(errorPage(found.error));

  await recordView(req.params.token, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });

  res.type('html').send(playerPage(req.params.token, found.clip));
});

/**
 * สตรีมวิดีโอของลิงก์นั้น — ตรวจสิทธิ์ทุก request
 *
 * การเลื่อนดูสร้าง request ใหม่หลายอัน ถ้าตรวจแค่ตอนเปิดหน้า คนที่เปิดค้างไว้
 * จะยังดูต่อได้หลังลิงก์ถูกยกเลิก ซึ่งทำให้ปุ่มยกเลิกไม่มีความหมาย
 */
sharePublicRouter.get('/s/:token/video', async (req, res) => {
  const found = await resolveShare(req.params.token);
  if (!found.ok) return res.sendStatus(found.status);

  const full = path.join(path.resolve(config.storage.path), found.clip.media_path);
  if (!full.startsWith(path.resolve(config.storage.path))) return res.sendStatus(400);

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch {
    return res.sendStatus(404);
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  // ห้ามแคชที่ตัวกลาง ไม่งั้นลิงก์ที่ยกเลิกแล้วยังถูกเสิร์ฟจาก cache ได้
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(full).pipe(res);
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return res.status(416).end();
  const start = m[1] ? Number.parseInt(m[1], 10) : 0;
  const end = m[2] ? Number.parseInt(m[2], 10) : stat.size - 1;
  if (Number.isNaN(start) || start >= stat.size || start > end) {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }

  const to = Math.min(end, stat.size - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${to}/${stat.size}`);
  res.setHeader('Content-Length', to - start + 1);
  fs.createReadStream(full, { start, end: to }).pipe(res);
});

// ── หน้าเว็บ ──────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const SHELL = (title, body) => `<!doctype html>
<html lang="th"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", Roboto, "Noto Sans Thai", sans-serif;
         margin: 0; padding: 20px; line-height: 1.55; display: flex; justify-content: center; }
  main { width: 100%; max-width: 720px; }
  h1 { font-size: 18px; margin: 0 0 14px; }
  video { width: 100%; border-radius: 10px; background: #000; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 14px;
       margin: 16px 0 0; }
  dt { opacity: .6; }
  dd { margin: 0; font-family: ui-monospace, Menlo, monospace; }
  .note { margin-top: 20px; font-size: 12px; opacity: .6; border-top: 1px solid rgba(128,128,128,.3);
          padding-top: 12px; }
  .err { text-align: center; padding: 60px 20px; }
  .err h1 { font-size: 20px; }
  .err p { opacity: .65; font-size: 14px; }
</style></head><body><main>${body}</main></body></html>`;

function playerPage(token, clip) {
  const when = clip.started_at
    ? new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'medium',
      }).format(new Date(clip.started_at))
    : '—';

  return SHELL(
    'หลักฐานการแพ็คสินค้า',
    `<h1>หลักฐานการแพ็คสินค้า</h1>
     <video controls preload="metadata" playsinline src="/s/${esc(token)}/video"></video>
     <dl>
       <dt>เลขออเดอร์</dt><dd>${esc(clip.ordersn ?? '—')}</dd>
       <dt>เลขพัสดุ</dt><dd>${esc(clip.tracking_no ?? '—')}</dd>
       <dt>วันเวลาที่แพ็ค</dt><dd>${esc(when)}</dd>
     </dl>
     <div class="note">
       วิดีโอนี้บันทึกโดยอัตโนมัติขณะแพ็คสินค้า ไม่มีการบันทึกเสียง<br>
       ลิงก์นี้มีอายุจำกัดและใช้ดูได้เฉพาะคลิปนี้เท่านั้น
     </div>`,
  );
}

function errorPage(message) {
  return SHELL(
    'ลิงก์ใช้ไม่ได้',
    `<div class="err"><h1>${esc(message)}</h1>
     <p>ถ้ายังต้องการดูวิดีโอนี้ กรุณาติดต่อผู้ที่ส่งลิงก์ให้คุณเพื่อขอลิงก์ใหม่</p></div>`,
  );
}
