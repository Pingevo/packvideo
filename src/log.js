import pino from 'pino';
import { config } from './config.js';

/**
 * log ต้อง correlate กับ sellcenter ด้วย `ordersn` ได้ตั้งแต่วันแรก (NFR-5.1)
 * จึงใช้ log แบบมีโครงสร้าง ไม่ใช่ข้อความล้วน
 */
export const log = pino({
  level: config.logLevel,
  base: { service: 'packvideo' },
  redact: {
    // token โผล่ใน log ครั้งเดียวก็ต้องหมุนเวียนใหม่ทั้งชุด
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.t'],
    censor: '[ตัดออก]',
  },
});
