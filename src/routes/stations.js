import { Router } from 'express';
import express from 'express';
import { listStations, claimStation, heartbeat, releaseStation } from '../lib/stations.js';

export const stationsRouter = Router();

const json = express.json({ limit: '8kb' });

/** GET /api/stations — สถานะทุกโต๊ะ ใช้ทั้งหน้าตั้งค่าและหน้า monitor */
stationsRouter.get('/stations', (_req, res) => {
  res.json({ ok: true, stations: listStations() });
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
  const { client_id: clientId, queue_depth: queueDepth, app_version: appVersion } = req.body ?? {};
  const result = heartbeat(req.params.id, { clientId, queueDepth, appVersion });
  // 409 = ให้ฝั่งเครื่องรู้ว่าต้องขอจับจองใหม่ ไม่ใช่เงียบไปแล้วคิดว่ายังทำงานอยู่
  res.status(result.ok ? 200 : 409).json(result);
});

/** POST /api/stations/:id/release — เลิกใช้เครื่องนี้เป็นโต๊ะนี้ */
stationsRouter.post('/stations/:id/release', json, (req, res) => {
  const result = releaseStation(req.params.id, req.body?.client_id);
  res.status(result.ok ? 200 : 409).json(result);
});
