import express from 'express';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { signalRouter, signalCors } from './routes/signal.js';
import { stationsRouter } from './routes/stations.js';
import { devRouter } from './dev/routes.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));

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
  app.use('/api', stationsRouter);

  app.use(signalCors);
  app.use(signalRouter);

  // hook.js ถูกโหลดทุกครั้งที่พนักงานเปิดหน้าแพ็ค — ต้องเบาและแคชได้
  // ไม่ต้องมี CORS เพราะ <script src> ไม่ได้อยู่ใต้กฎ CORS
  app.use(express.static(PUBLIC_DIR, { maxAge: '5m' }));

  // หน้าจำลองหน้าแพ็คของ sellcenter ไว้ทดสอบ hook — ไม่เสิร์ฟบน production
  if (config.env !== 'production') {
    app.use('/dev', express.static(fileURLToPath(new URL('./dev', import.meta.url))));
    app.use(devRouter);
  }

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
