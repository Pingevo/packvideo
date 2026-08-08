import { log } from '../log.js';

/**
 * ช่องส่งสัญญาณจากเซิร์ฟเวอร์ไปหน้าต่างอัด แยกตามโต๊ะ
 *
 * ทำไมต้องผ่านเซิร์ฟเวอร์แทนที่จะใช้ postMessage ระหว่างหน้าต่าง (design D8):
 * postMessage เร็วกว่าแต่ไม่มีใครรู้สถานะ ถ้าพนักงานเผลอปิดหน้าต่างอัดของโต๊ะ 4
 * จะไม่มีใครรู้จนกว่าจะถึงวันที่ต้องใช้คลิป — ที่ 6 โต๊ะกับพนักงานที่ไม่ใช่สายเทคนิค
 * การมองเห็นปัญหาสำคัญกว่า 50 ms
 */

/** @type {Map<string, Set<import('express').Response>>} */
const channels = new Map();

/** nginx ตัดการเชื่อมต่อที่เงียบเกิน proxy_read_timeout — ต้องส่งอะไรสักอย่างก่อนถึงเวลานั้น */
const PING_MS = 20_000;

export function subscribe(stationId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // กัน nginx buffer ไว้จนสัญญาณไปไม่ถึง
  });
  res.write(': เชื่อมต่อแล้ว\n\n');

  const set = channels.get(stationId) ?? new Set();
  set.add(res);
  channels.set(stationId, set);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ปิดไปแล้ว ปล่อยให้ close จัดการ */ }
  }, PING_MS);

  const cleanup = () => {
    clearInterval(ping);
    const s = channels.get(stationId);
    if (s) {
      s.delete(res);
      if (!s.size) channels.delete(stationId);
    }
    log.debug({ station_id: stationId, remaining: channels.get(stationId)?.size ?? 0 }, 'ตัวอัดตัดการเชื่อมต่อ');
  };

  res.on('close', cleanup);
  res.on('error', cleanup);

  log.info({ station_id: stationId, listeners: set.size }, 'ตัวอัดเชื่อมต่อเข้ามา');
}

/** ส่งเหตุการณ์ไปยังหน้าต่างอัดของโต๊ะนั้น — คืนจำนวนตัวรับที่ได้รับจริง */
export function emit(stationId, event, data) {
  const set = channels.get(stationId);
  if (!set || !set.size) return 0;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  let delivered = 0;
  for (const res of set) {
    try { res.write(payload); delivered++; } catch { /* ตัวที่ตายแล้ว เดี๋ยว close จัดการ */ }
  }
  return delivered;
}

export function broadcast(event, data) {
  for (const stationId of channels.keys()) emit(stationId, event, data);
}

export function connectedStations() {
  return [...channels.keys()];
}

export function listenerCount(stationId) {
  return channels.get(stationId)?.size ?? 0;
}
