import { Router } from 'express';
import { runChecks } from '../lib/monitor.js';
import { commitRate, recentEvents, totals } from '../lib/metrics.js';
import { alertHistory } from '../lib/notify.js';
import { findClips } from '../lib/repo.js';
import { listStations } from '../lib/stations.js';
import { videoStatus } from '../lib/videohealth.js';
import { signalCors } from './signal.js';
import { config } from '../config.js';

export const monitorRouter = Router();

/** GET /api/monitor — ทุกอย่างที่หน้า monitor ต้องใช้ ในการเรียกครั้งเดียว */
monitorRouter.get('/monitor', async (_req, res) => {
  const checks = await runChecks();
  res.json({
    ok: true,
    ...checks,
    totals: totals(),
    alerts: alertHistory(),
    recent: recentEvents(30),
  });
});

/** GET /api/metrics — เฉพาะตัวเลข ใช้ตอนเก็บผล Gate 1 */
monitorRouter.get('/metrics', (req, res) => {
  const hours = Math.min(6, Math.max(1, Number(req.query.hours) || 1));
  res.json({ ok: true, ...commitRate(hours * 60 * 60 * 1000) });
});

/**
 * GET /api/video-health?from=YYYY-MM-DD — ออเดอร์ที่ไม่มีวิดีโอ + โต๊ะที่กำลังไม่ได้บันทึก
 *
 * ให้การ์ดบนหน้าสรุปงาน /work ของ sellcenter อ่าน (มติเจ้าของ 17 ก.ย. 2026: เตือนหัวหน้า
 * ทั้ง Telegram และ /work) · นับเฉพาะคลิปที่ยาวพอจะต้องมีภาพแล้ว — คลิปสั้นกว่า
 * NO_VIDEO_ALERT_SEC ที่ว่างคือการสแกนทับเร็ว ไม่ใช่หลักฐานที่หาย
 */
monitorRouter.get('/video-health', signalCors, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from ?? '')) ? String(req.query.from) : today;

  const rows = await findClips(
    {
      day: { $gte: from },
      status: { $ne: 'aborted' },
      flags: { $in: ['empty', 'no_header'] },
      duration_ms: { $gte: config.noVideoAlertSec * 1000 },
    },
    { limit: 500 },
  );

  res.json({
    ok: true,
    from,
    db: rows !== null,
    stations: listStations().map((s) => ({
      station_id: s.station_id,
      connected: s.connected,
      device_name: s.device_name ?? null,
      camera_ready: s.connected ? s.camera_ready !== false : false,
      ...videoStatus(s.station_id),
    })),
    clips: (rows ?? []).map((c) => ({
      clip_id: c._id,
      station_id: c.station_id,
      packer: c.packer ?? null,
      ordersn: c.ordersn ?? null,
      tracking_no: c.tracking_no ?? null,
      status: c.status,
      started_at: c.started_at,
      duration_ms: c.duration_ms ?? null,
      problem: (c.flags ?? []).includes('no_header') ? 'no_header' : 'empty',
    })),
  });
});
