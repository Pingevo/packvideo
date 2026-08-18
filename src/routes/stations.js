import { Router } from 'express';
import express from 'express';
import { listStations, claimStation, heartbeat, releaseStation } from '../lib/stations.js';
import { storageStatus } from '../lib/storage.js';
import { signalCors } from './signal.js';

export const stationsRouter = Router();

const json = express.json({ limit: '8kb' });

/**
 * GET /api/stations — สถานะทุกโต๊ะ ใช้ทั้งหน้าตั้งค่าและหน้า monitor
 *
 * เปิด CORS เฉพาะ route นี้ (อ่านอย่างเดียว ไม่มีความลับ) เพื่อให้หน้าแพ็คของ
 * sellcenter ดึงรายชื่อโต๊ะไปทำ dropdown เลือกโต๊ะได้เองโดยไม่ต้องเข้ามาที่
 * pack.digital.in.th เลย — claim/heartbeat/release ยังคง same-origin เท่านั้น
 * เพราะเป็น route ที่เปลี่ยนสถานะจริง
 */
stationsRouter.get('/stations', signalCors, (_req, res) => {
  res.json({ ok: true, stations: listStations() });
});

/**
 * GET /api/desk/:stationId — สถานะย่อของโต๊ะเดียว สำหรับแถบบนหน้าแพ็คของ sellcenter
 *
 * ทำแยกจาก /api/stations และ /api/health ด้วยเหตุผลเดียวกันทั้งคู่ — สองอันนั้นคืน
 * ของที่หน้าแพ็คไม่ควรได้ข้ามโดเมน · /api/stations คืน ip กับ client_id ของทุกโต๊ะ
 * · /api/health คืน path ที่เก็บคลิป เวอร์ชัน ffmpeg และเวลาตอบของ mongo
 *
 * อันนี้คืนเฉพาะสิ่งที่พนักงานหน้าโต๊ะต้องเห็นจริงๆ: กำลังอัดอยู่ไหม คิวเท่าไร
 * ระบบยังบันทึกได้ไหม ดิสก์อยู่ระดับไหน — ไม่มีอะไรที่เอาไปใช้ต่อได้ถ้าหลุด
 */
stationsRouter.get('/desk/:stationId', signalCors, async (req, res) => {
  const station = listStations().find((s) => s.station_id === req.params.stationId);
  if (!station) return res.status(404).json({ ok: false, error: 'ไม่มีโต๊ะหมายเลขนี้' });

  // ห้ามแคชเด็ดขาด — นี่คือสถานะสด ถ้าเบราว์เซอร์เก็บไว้ใช้ซ้ำ แถบบนหน้าแพ็คจะค้าง
  // อยู่ที่ค่าเก่า แล้วพนักงานจะเห็น "พร้อม" ทั้งที่กล้องบันทึกไปแล้ว (เจอตอนทดสอบจริง)
  res.setHeader('Cache-Control', 'no-store');

  const disk = await storageStatus();
  res.json({
    ok: true,
    station_id: station.station_id,
    connected: station.connected,
    device_name: station.device_name ?? null,
    queue_depth: station.queue_depth ?? 0,
    recording: !!station.recording,
    last_seen_at: station.last_seen_at ?? null,
    recording_allowed: disk.recording_allowed,
    disk_level: disk.disk_level,
    disk_free_gb: disk.free_gb,
  });
});

/**
 * POST /api/stations/:id/claim — ตั้งเครื่องนี้เป็นโต๊ะนี้
 *
 * ตอบ 409 พร้อมบอกว่าชนกับเครื่องไหน (FR-9.2) — การตอบแค่ "ไม่ได้" ทำให้คนหน้างาน
 * ไม่รู้จะไปตามหาเครื่องไหน แล้วจบลงด้วยการปิดระบบวิดีโอทิ้งทั้งโต๊ะ
 */
stationsRouter.post('/stations/:id/claim', json, (req, res) => {
  const { client_id: clientId, device_name: deviceName, app_version: appVersion } = req.body ?? {};
  if (!clientId) return res.status(400).json({ ok: false, error: 'ต้องมี client_id' });

  const result = claimStation(req.params.id, {
    clientId,
    deviceName,
    ip: req.ip,
    appVersion,
  });

  if (!result.ok) {
    req.log.warn(
      { station_id: req.params.id, client_id: clientId, held_by: result.held_by },
      'จับจองโต๊ะไม่สำเร็จ',
    );
    return res.status(409).json({ ok: false, error: result.reason, held_by: result.held_by });
  }

  if (result.station.took_over_from) {
    req.log.warn(
      { station_id: req.params.id, from: result.station.took_over_from },
      'รับช่วงโต๊ะต่อจากเครื่องที่เงียบไป',
    );
  }
  req.log.info({ station_id: req.params.id, device_name: deviceName }, 'ตั้งค่าโต๊ะแล้ว');
  res.json({ ok: true, station: result.station });
});

/** POST /api/stations/:id/heartbeat — ต่ออายุการจับจอง ทุก 30 วินาที */
stationsRouter.post('/stations/:id/heartbeat', json, (req, res) => {
  const {
    client_id: clientId, queue_depth: queueDepth, app_version: appVersion, recording,
  } = req.body ?? {};
  const result = heartbeat(req.params.id, { clientId, queueDepth, appVersion, recording });
  // 409 = ให้ฝั่งเครื่องรู้ว่าต้องขอจับจองใหม่ ไม่ใช่เงียบไปแล้วคิดว่ายังทำงานอยู่
  res.status(result.ok ? 200 : 409).json(result);
});

/** POST /api/stations/:id/release — เลิกใช้เครื่องนี้เป็นโต๊ะนี้ */
stationsRouter.post('/stations/:id/release', json, (req, res) => {
  const result = releaseStation(req.params.id, req.body?.client_id);
  res.status(result.ok ? 200 : 409).json(result);
});
