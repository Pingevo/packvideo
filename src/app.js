import express from 'express';
import pinoHttp from 'pino-http';
import { log } from './log.js';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';

export function createApp() {
  const app = express();

  // อยู่หลัง nginx เสมอ — ต้องเชื่อ X-Forwarded-* ไม่งั้น ip ใน log เป็นของ nginx ทั้งหมด
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger: log,
      // health ถูกเรียกถี่มาก ถ้า log ทุกครั้งจะกลบ log ที่มีความหมายจนหมด
      autoLogging: { ignore: (req) => req.url.startsWith('/api/health') },
    }),
  );

  app.use('/api', healthRouter);

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: 'ไม่พบเส้นทางนี้' });
  });

  // eslint-disable-next-line no-unused-vars -- express รู้ว่าเป็น error handler จากจำนวนอาร์กิวเมนต์
  app.use((err, req, res, _next) => {
    req.log.error({ err }, 'มี error ที่ไม่ได้จัดการ');
    res.status(500).json({
      ok: false,
      error: config.env === 'production' ? 'เกิดข้อผิดพลาดภายใน' : err.message,
    });
  });

  return app;
}
