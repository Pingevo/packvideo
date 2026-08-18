import { Router } from 'express';
import express from 'express';
import { config } from '../config.js';
import { record } from '../lib/metrics.js';
import * as clips from '../lib/clips.js';

export const signalRouter = Router();

// ui_degraded = hook ทำงานอยู่แต่แตะหน้าเดิมได้ไม่ครบ (เช่น หาป้ายช่องสแกนไม่เจอ)
// ต้องเป็นสัญญาณ ไม่ใช่ความเงียบ — เงียบคือสิ่งที่ทำให้บั๊กรอบก่อนอยู่ได้นาน
const EVENTS = new Set(['start', 'commit', 'abort', 'tag', 'scan', 'ui_degraded']);

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
    record(event, stationId);

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

    // เดินวงจรชีวิตของคลิปแบบไม่รอ — ปลายทางได้ 204 ไปแล้ว
    void dispatch(event, b, stationId).catch((err) =>
      req.log.error({ err: err.message, signal: event }, 'เดินวงจรชีวิตคลิปไม่สำเร็จ'),
    );
  } catch (err) {
    counters.rejected++;
    req.log.error({ err }, 'ประมวลผลสัญญาณไม่สำเร็จ');
  }
});

async function dispatch(event, b, stationId) {
  switch (event) {
    case 'start':
      return clips.start({
        traceId: b.trace_id,
        stationId,
        imei: b.value ?? null,
        user: b.user ?? null,
      });
    case 'commit':
      return clips.commit({
        traceId: b.trace_id,
        ordersn: b.ordersn ?? null,
        flag: b.flag ?? null,
        imeiComplete: b.imei_complete === 'true' ? true : b.imei_complete === 'false' ? false : null,
      });
    case 'abort':
      return clips.abort({ traceId: b.trace_id, reason: b.reason ?? null });
    case 'tag':
      return clips.tag({
        stationId,
        trackingNo: b.tracking_no || null,
        user: b.user ?? null,
      });
    case 'scan':
      return clips.scan({ stationId, value: b.value ?? '' });
    default:
      return null;
  }
}

/** ให้ hook.js จาก origin ของ sellcenter เรียกได้ — ระบุ origin ตรงๆ ไม่ใช้ '*' */
export function signalCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  next();
}
