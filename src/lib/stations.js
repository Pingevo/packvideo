import { config } from '../config.js';

/**
 * ทะเบียนโต๊ะแพ็ค
 *
 * ตอนนี้เก็บในหน่วยความจำ — ของจริงย้ายลง collection `stations` ใน P1-2
 * ทุกฟังก์ชันในไฟล์นี้ออกแบบให้เป็นจุดเดียวที่แตะข้อมูล จะได้เปลี่ยนที่เก็บได้โดยไม่กระทบที่อื่น
 *
 * หน้าที่สำคัญคือ **กันสองเครื่องตั้งเป็นโต๊ะเดียวกัน** (FR-9.2)
 * ถ้าปล่อยให้ซ้ำ คลิปของสองโต๊ะจะปนกันโดยไม่มีใครรู้ และตัวเลข % verified รายโต๊ะจะเชื่อไม่ได้
 */

/** ถือว่าเครื่องหายไปแล้วถ้าไม่ส่งสัญญาณเป็นเวลานี้ — เครื่องที่ดับไปต้องไม่ล็อกโต๊ะไว้ตลอดกาล */
const STALE_MS = 90_000;

/** @type {Map<string, {client_id: string, device_name: string, ip: string, claimed_at: Date, last_seen_at: Date, app_version: string|null, queue_depth: number}>} */
const claims = new Map();

function isStale(claim) {
  return Date.now() - claim.last_seen_at.getTime() > STALE_MS;
}

/** รายการโต๊ะทั้งหมดพร้อมสถานะ ณ ขณะนี้ */
export function listStations() {
  return config.stations.map((id) => {
    const claim = claims.get(id);
    if (!claim || isStale(claim)) {
      return {
        station_id: id,
        connected: false,
        device_name: claim?.device_name ?? null,
        last_seen_at: claim?.last_seen_at ?? null,
        stale: !!claim,
      };
    }
    return {
      station_id: id,
      connected: true,
      device_name: claim.device_name,
      client_id: claim.client_id,
      ip: claim.ip,
      claimed_at: claim.claimed_at,
      last_seen_at: claim.last_seen_at,
      app_version: claim.app_version,
      queue_depth: claim.queue_depth,
      stale: false,
    };
  });
}

/**
 * ขอจับจองโต๊ะ
 *
 * เครื่องเดิมขอซ้ำได้เสมอ (รีเฟรชหน้าไม่ควรทำให้ตัวเองถูกปฏิเสธ)
 * เครื่องอื่นขอได้ก็ต่อเมื่อเจ้าของเดิมเงียบไปนานพอ
 *
 * @returns {{ok: true, station: object} | {ok: false, reason: string, held_by: object}}
 */
export function claimStation(stationId, { clientId, deviceName, ip, appVersion }) {
  if (!config.stations.includes(stationId)) {
    return { ok: false, reason: 'ไม่มีโต๊ะหมายเลขนี้', held_by: null };
  }

  // เครื่องนี้จับจองโต๊ะอื่นค้างอยู่หรือเปล่า — ปล่อยของเก่าก่อน ไม่งั้นจะค้างเป็นผี
  for (const [id, claim] of claims) {
    if (claim.client_id === clientId && id !== stationId) claims.delete(id);
  }

  const existing = claims.get(stationId);
  if (existing && existing.client_id !== clientId && !isStale(existing)) {
    return {
      ok: false,
      reason: 'มีเครื่องอื่นตั้งเป็นโต๊ะนี้อยู่แล้ว',
      held_by: {
        device_name: existing.device_name,
        ip: existing.ip,
        last_seen_at: existing.last_seen_at,
      },
    };
  }

  const now = new Date();
  claims.set(stationId, {
    client_id: clientId,
    device_name: deviceName || 'ไม่ได้ตั้งชื่อ',
    ip,
    claimed_at: existing?.client_id === clientId ? existing.claimed_at : now,
    last_seen_at: now,
    app_version: appVersion ?? null,
    queue_depth: existing?.client_id === clientId ? existing.queue_depth : 0,
    // ถ้าแย่งมาจากเครื่องที่เงียบไป บอกให้รู้ว่าเกิดอะไรขึ้น
    took_over_from: existing && existing.client_id !== clientId ? existing.device_name : null,
  });

  return { ok: true, station: { station_id: stationId, ...claims.get(stationId) } };
}

/** ต่ออายุการจับจอง — เครื่องที่ไม่ได้ถือโต๊ะนี้อยู่จะถูกปฏิเสธ ไม่ใช่แอบเขียนทับ */
export function heartbeat(stationId, { clientId, queueDepth, appVersion }) {
  const claim = claims.get(stationId);
  if (!claim || claim.client_id !== clientId) return { ok: false, reason: 'การจับจองหมดอายุแล้ว' };

  claim.last_seen_at = new Date();
  if (typeof queueDepth === 'number') claim.queue_depth = queueDepth;
  if (appVersion) claim.app_version = appVersion;
  return { ok: true };
}

export function releaseStation(stationId, clientId) {
  const claim = claims.get(stationId);
  if (claim && claim.client_id === clientId) {
    claims.delete(stationId);
    return { ok: true };
  }
  return { ok: false, reason: 'เครื่องนี้ไม่ได้ถือโต๊ะนี้อยู่' };
}

/** โต๊ะที่ควรมีคนทำงานอยู่แต่ไม่มีเครื่องต่ออยู่ — ใช้ในหน้า monitor (FR-8.2) */
export function disconnectedStations() {
  return listStations().filter((s) => !s.connected);
}
