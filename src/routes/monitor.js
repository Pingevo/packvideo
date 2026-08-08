import { Router } from 'express';
import { runChecks } from '../lib/monitor.js';
import { commitRate, recentEvents, totals } from '../lib/metrics.js';
import { alertHistory } from '../lib/notify.js';

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
