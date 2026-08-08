import { Router } from 'express';
import express from 'express';
import { config } from '../config.js';

export const signalRouter = Router();

const EVENTS = new Set(['start', 'commit', 'abort', 'tag', 'scan']);

/**
 * นับสัญญาณไว้ในหน่วยความจำเพื่อให้ทดสอบ hook.js ได้ตั้งแต่ตอนนี้
 * ของจริงเก็บลง `clips` กับ `clip_events` ใน P1-5 — ตัวนี้จะถูกแทนที่
 */
const counters = { total: 0, byEvent: {}, byStation: {}, rejected: 0, lastAt: null };

export function signalStats() {
  return JSON.parse(JSON.stringify(counters));
}

// body เล็กมาก จำกัดไว้แน่นๆ กันคนยิงของใหญ่เข้ามา
const parseForm = express.urlencoded({ extended: false, limit: '8kb' });

/**
 * POST /signal — รับสัญญาณจากหน้าแพ็คของ sellcenter
 *
 * **ตอบ 204 เสมอ ไม่ว่าเกิดอะไรขึ้น**
 * hook ใช้ sendBeacon ซึ่งอ่านคำตอบไม่ได้อยู่แล้ว การตอบ 4xx/5xx มีผลอย่างเดียวคือ
 * ทำให้ console ของหน้าแพ็คเต็มไปด้วย error ที่พนักงานเห็นแล้วตกใจ
 * ทุกความผิดพลาดถูกบันทึกฝั่งเซิร์ฟเวอร์แทน
 */
signalRouter.post('/signal', parseForm, (req, res) => {
  res.status(204).end();   // ตอบก่อน แล้วค่อยทำงาน — ไม่ให้ปลายทางรอเรา

  try {
    const b = req.body ?? {};
    const event = String(b.event ?? '');
    const stationId = String(b.station_id ?? '');

    if (!EVENTS.has(event)) {
      counters.rejected++;
      req.log.warn({ event, station_id: stationId }, 'สัญญาณที่ไม่รู้จัก');
      return;
    }
    if (!b.t || !stationId) {
      counters.rejected++;
      req.log.warn({ event, station_id: stationId }, 'สัญญาณไม่มี token หรือ station_id');
      return;
    }

    counters.total++;
    counters.byEvent[event] = (counters.byEvent[event] ?? 0) + 1;
    counters.byStation[stationId] = (counters.byStation[stationId] ?? 0) + 1;
    counters.lastAt = new Date().toISOString();

    // correlate กับ log ฝั่ง sellcenter ด้วย ordersn ตั้งแต่วันแรก (NFR-5.1)
    req.log.info(
      {
        signal: event,
        station_id: stationId,
        trace_id: b.trace_id ?? null,
        ordersn: b.ordersn ?? null,
        tracking_no: b.tracking_no ?? null,
        reason: b.reason ?? null,
        flag: b.flag ?? null,
        user: b.user ?? null,
        hook_version: b.v ?? null,
      },
      'รับสัญญาณ',
    );

    // TODO(P1-5): สร้าง/อัปเดตเอกสารใน clips + เขียน clip_events + ส่งต่อทาง SSE
  } catch (err) {
    counters.rejected++;
    req.log.error({ err }, 'ประมวลผลสัญญาณไม่สำเร็จ');
  }
});

/** ให้ hook.js จาก origin ของ sellcenter เรียกได้ — ระบุ origin ตรงๆ ไม่ใช้ '*' */
export function signalCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  next();
}
