import express from 'express';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { signalRouter, signalCors } from './routes/signal.js';
import { stationsRouter } from './routes/stations.js';
import { monitorRouter } from './routes/monitor.js';
import { clipsRouter, mediaRouter } from './routes/clips.js';
import { searchRouter } from './routes/search.js';
import { exportRouter } from './routes/export.js';
import { pinRouter } from './routes/pin.js';
import { shareApiRouter, sharePublicRouter } from './routes/share.js';
import { bridgeRouter } from './routes/bridge.js';
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

  /**
   * ห้ามให้ใครเอาหน้าของเราไปฝัง iframe — `clips.html` มีปุ่มสร้างลิงก์ส่งคนนอก
   * และปุ่มถอนตรึง ถ้าโดนฝังซ้อนแล้วหลอกให้กดคือหลักฐานหลุดหรือถูกลบได้
   *
   * ข้อยกเว้นเดียวคือ /bridge.html ซึ่งมีหน้าที่ถูกฝังโดยตรง — route นั้นเขียนทับ
   * สองหัวข้อนี้เองด้วยรายชื่อจาก ALLOWED_ORIGINS
   */
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');   // เผื่อเบราว์เซอร์เก่าที่ยังไม่รู้จัก CSP
    next();
  });

  // ต้องมาก่อน express.static เพื่อให้ route นี้ชนะไฟล์ที่ชื่อซ้ำกัน
  app.use(bridgeRouter);

  app.use('/api', healthRouter);
  app.use('/api', stationsRouter);
  app.use('/api', monitorRouter);
  app.use('/api', clipsRouter);
  app.use('/api', searchRouter);
  app.use('/api', exportRouter);
  app.use('/api', pinRouter);
  app.use('/api', shareApiRouter);
  app.use(sharePublicRouter);
  app.use('/media', mediaRouter);

  app.use(signalCors);
  app.use(signalRouter);

  // hook.js ถูกโหลดทุกครั้งที่พนักงานเปิดหน้าแพ็ค — ต้องเบาและแคชได้
  // ไม่ต้องมี CORS เพราะ <script src> ไม่ได้อยู่ใต้กฎ CORS
  //
  // บนเครื่องพัฒนาไม่แคชเลย ไม่งั้นแก้ hook.js แล้วทดสอบได้ผลเก่าจนสับสน
  // (เจอมาแล้ว — เสียเวลาไล่หาสาเหตุที่ไม่มีอยู่จริง)
  // ระหว่าง pilot ที่ต้องปรับจูน hook บ่อย ให้รู้ด้วยว่าการแก้ใช้เวลาถึง 5 นาที
  // กว่าจะถึงทุกโต๊ะ เพราะแคชฝั่งเบราว์เซอร์
  app.use(express.static(PUBLIC_DIR, {
    maxAge: config.env === 'production' ? '5m' : 0,
    setHeaders: (res) => {
      // max-age=0 ยังเข้าแคชอยู่ดี ต้อง no-store ถึงจะไม่เก็บเลย
      if (config.env !== 'production') res.setHeader('Cache-Control', 'no-store');
    },
  }));

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
