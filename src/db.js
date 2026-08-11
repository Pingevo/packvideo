import { MongoClient } from 'mongodb';
import { config } from './config.js';
import { log } from './log.js';

let client = null;
let db = null;
let state = { connected: false, lastError: null, since: null };
let retryTimer = null;
let stopped = false;
let onReady = null;

/**
 * ต่อ MongoDB แบบพยายามใหม่เรื่อยๆ อยู่เบื้องหลัง — **ไม่ล้ม process ถ้าต่อไม่ได้**
 *
 * ถ้าปล่อยให้ crash-loop ตอน Mongo ล่ม เราจะเสียหน้า monitor และ health ไปพร้อมกัน
 * ซึ่งเป็นตอนที่ต้องการมันที่สุด · design §12 กำหนดว่า Mongo ล่ม = หยุดอัด
 * แต่ตัวบริการต้องยังอยู่เพื่อรายงานว่าเกิดอะไรขึ้น
 */
export async function connect(readyHandler) {
  stopped = false;
  onReady = readyHandler ?? null;
  client = new MongoClient(config.mongo.url, {
    serverSelectionTimeoutMS: 3000,
    connectTimeoutMS: 3000,
  });

  client.on('serverHeartbeatFailed', () => {
    if (state.connected) {
      state = { connected: false, lastError: 'heartbeat ไม่ตอบ', since: new Date() };
      log.warn('mongo หลุดการเชื่อมต่อ');
    }
  });

  await attempt();
  return db;
}

async function attempt() {
  if (stopped) return;
  try {
    await client.connect();
    await client.db(config.mongo.dbName).command({ ping: 1 });
    db = client.db(config.mongo.dbName);
    state = { connected: true, lastError: null, since: new Date() };
    log.info({ db: config.mongo.dbName }, 'mongo เชื่อมต่อแล้ว');
    // เตรียม index และเก็บกวาดคลิปค้างทุกครั้งที่ต่อติด รวมถึงตอนต่อกลับมาได้หลังหลุด
    if (onReady) {
      try { await onReady(); } catch (err) {
        log.error({ err: err.message }, 'งานเตรียมฐานข้อมูลหลังเชื่อมต่อไม่สำเร็จ');
      }
    }
  } catch (err) {
    state = { connected: false, lastError: err.message, since: new Date() };
    log.error({ err: err.message }, 'mongo เชื่อมต่อไม่ได้ — จะลองใหม่ใน 5 วินาที');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(attempt, 5000);
  }
}

/** @returns {import('mongodb').Db|null} null เมื่อยังต่อไม่ได้ — ผู้เรียกต้องเช็คเสมอ */
export function getDb() {
  return state.connected ? db : null;
}

export function dbState() {
  return { ...state };
}

/**
 * ping สำหรับหน้า health
 *
 * ping จริงเฉพาะตอนที่คิดว่าต่ออยู่ — ถ้ารู้อยู่แล้วว่าหลุด ให้ตอบทันทีจากผลของลูปที่พยายามต่อใหม่
 * ไม่งั้นทุกครั้งที่เรียก health ตอน Mongo ล่มจะค้าง 3 วินาทีรอ serverSelectionTimeout
 * แล้วรายงาน error ที่ไม่ตรงเหตุ ("Topology is closed" แทน ECONNREFUSED)
 */
export async function pingDb() {
  if (!client) return { ok: false, latency_ms: 0, error: 'ยังไม่ได้เริ่มการเชื่อมต่อ' };
  if (!state.connected) {
    return { ok: false, latency_ms: 0, error: state.lastError ?? 'ยังต่อไม่ได้' };
  }
  const started = performance.now();
  try {
    await client.db(config.mongo.dbName).command({ ping: 1 });
    return { ok: true, latency_ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, latency_ms: Math.round(performance.now() - started), error: err.message };
  }
}

export async function close() {
  stopped = true;
  clearTimeout(retryTimer);
  if (client) await client.close().catch(() => {});
  state = { connected: false, lastError: null, since: new Date() };
}
