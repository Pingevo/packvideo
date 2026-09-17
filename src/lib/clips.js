import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { emit } from './sse.js';
import * as repo from './repo.js';
import * as videohealth from './videohealth.js';

/**
 * วงจรชีวิตของคลิป — ดู design §3
 *
 * สถานะของคลิปที่กำลังอัดอยู่ในหน่วยความจำเพื่อความเร็ว และถูกเขียนลงฐานข้อมูล
 * ทุกครั้งที่เปลี่ยนสถานะ พร้อมต่อท้าย clip_events ที่ลบไม่ได้ (FR-7.6)
 *
 * ตามหลัก D4 ฐานข้อมูลคือ index ส่วนไฟล์คือความจริง — ไฟล์ .json ข้างคลิป
 * ทำให้คลิปบอกตัวเองได้ว่าเป็นของออเดอร์ไหนแม้ฐานข้อมูลหายทั้งก้อน
 */

const ROOT = () => path.resolve(config.storage.path);
const TMP = () => path.join(ROOT(), '_tmp');

/**
 * เพดานความปลอดภัยสองชั้น (FR-1.7) — ชั้นเดียวไม่พอเพราะคลิปค้างมีสองแบบคนละสาเหตุ
 *
 * ชั้นที่ 1 `IDLE_MS` — เงียบสนิท ไม่มีทั้งสัญญาณและชิ้นวิดีโอ
 *   แปลว่ากล้องหยุด หน้าต่างอัดถูกปิด หรือเน็ตขาดยาว คลิปตายแล้วแต่ยังค้างเปิดอยู่
 *
 * ชั้นที่ 2 `MAX_MS` — กล้องยังส่งวิดีโอเข้ามาเรื่อยๆ แต่ไม่มีการสแกนปิดสักที
 *   ชั้นที่ 1 จับไม่ได้เลยเพราะชิ้นวิดีโอที่ไหลเข้ามารีเซ็ตตัวจับเวลาทุก ~3 วินาที
 *   เคยเจอจริงตอนทดสอบ: คลิปเดียวอัดไป 14 นาที 100 MB โดยไม่มีอะไรหยุดมัน
 *   ที่ ~7 MB/นาที ถ้าปล่อยค้างทั้งกะคือ ~3.4 GB ต่อโต๊ะ
 *
 * นับจาก `started_at` ไม่ใช่จากกิจกรรมล่าสุด จึงเป็นเพดานจริงที่ยืดไม่ได้
 * และไม่ขัดกับ FR-1.6 (ห้ามจำกัดความยาวคลิปที่ค่าคงที่) เพราะนี่คือ **เพดานความปลอดภัย**
 * ที่ตั้งไว้สูงกว่าเวลาแพ็คปกติมาก ไม่ใช่ความยาวที่ตั้งใจให้คลิปทั่วไปไปชน
 */
const IDLE_MS = 4 * 60 * 1000;
const MAX_MS = () => config.clipMaxMinutes * 60 * 1000;

/** @type {Map<string, object>} clip_id → clip */
const clips = new Map();
/** @type {Map<string, string>} trace_id → clip_id */
const byTrace = new Map();
/** @type {Map<string, string>} station_id → clip_id ที่กำลังเปิดอยู่ */
const openByStation = new Map();

function newId() {
  return 'c_' + crypto.randomBytes(12).toString('hex');
}

function dayFolder(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return { day: `${y}-${m}-${d}`, dir: path.join(y.toString(), m, d) };
}

export function getClip(clipId) {
  return clips.get(clipId) ?? null;
}

export function openClipOf(stationId) {
  const id = openByStation.get(stationId);
  return id ? clips.get(id) ?? null : null;
}

export function listClips({ limit = 100 } = {}) {
  return [...clips.values()].sort((a, b) => b.started_at - a.started_at).slice(0, limit);
}

// ── START ─────────────────────────────────────────────────────
export async function start({ traceId, stationId, imei, user }) {
  // สแกนตัวใหม่ทั้งที่ตัวเก่ายังไม่ปิด → ปิดตัวเก่าเป็น unverified (FR-1.8)
  //
  // ใช้ stop (รอชิ้นสุดท้าย) ไม่ใช่ปิดทันที — ของเดิมปิดทันที ชิ้นท้ายของคลิปเก่าที่ยังไม่ถึง
  // จึงโดน 409 ทิ้ง และในหน้าต่างอัดรุ่นก่อนชิ้นนั้นถูกติดป้ายเป็นชิ้นแรกของคลิปใหม่
  // ทำให้ไฟล์ใหม่ขึ้นต้นด้วย moof แล้วเปิดไม่ได้ (เจอ 324 คลิปถึง 17 ก.ย. 2026)
  const previous = openClipOf(stationId);
  if (previous) await stop({ clipId: previous._id, status: 'unverified', note: 'มีการสแกนออเดอร์ใหม่ทับ' });

  const now = new Date();
  const { day } = dayFolder(now);
  const clip = {
    _id: newId(),
    trace_id: traceId,
    station_id: stationId,
    packer: user ?? null,
    status: 'pending',
    ordersn: null,
    tracking_no: null,
    imeis: imei ? [imei] : [],
    flags: [],
    started_at: now,
    ended_at: null,
    last_activity: now,
    day,
    bytes: 0,
    chunks: 0,
    media_path: null,
    checksum: null,
    pinned: false,
    pin_reasons: [],
  };

  clips.set(clip._id, clip);
  if (traceId) byTrace.set(traceId, clip._id);
  openByStation.set(stationId, clip._id);

  await fs.mkdir(path.join(TMP(), clip._id), { recursive: true });
  persist(clip, 'start', { imei });
  const delivered = emit(stationId, 'start', { clip_id: clip._id, trace_id: traceId });
  // ไม่มีหน้าต่างอัดฟังอยู่เลย = คลิปนี้ว่างแน่นอน บอกได้ทันทีไม่ต้องรอ
  if (!delivered) videohealth.markNoRecorder(stationId);
  watchFirstChunk(clip);
  log.info({ clip_id: clip._id, station_id: stationId }, 'เริ่มคลิป');
  return clip;
}

// ── COMMIT / ABORT ────────────────────────────────────────────
export function commit({ traceId, ordersn, flag, imeiComplete }) {
  const clip = clipByTrace(traceId);
  if (!clip) return null;

  clip.status = 'recording';
  clip.ordersn = ordersn ?? clip.ordersn;
  clip.imei_complete = imeiComplete;
  if (flag && !clip.flags.includes(flag)) clip.flags.push(flag);
  touch(clip);

  persist(clip, 'commit', { flag });
  emit(clip.station_id, 'commit', { clip_id: clip._id, ordersn: clip.ordersn, flag });
  log.info({ clip_id: clip._id, ordersn: clip.ordersn }, 'ยืนยันคลิป');
  return clip;
}

export async function abort({ traceId, reason }) {
  const clip = clipByTrace(traceId);
  if (!clip) return null;

  clip.status = 'aborted';
  clip.ended_at = new Date();
  forget(clip);

  persist(clip, 'abort', { reason });
  emit(clip.station_id, 'abort', { clip_id: clip._id, reason });
  // ทิ้งไฟล์จริง ไม่ปล่อยค้างเป็นขยะ (FR-2.6) — ที่ 1,500 ออเดอร์/วันจะสะสมเป็นพื้นที่จริง
  await removeTmp(clip._id);
  log.info({ clip_id: clip._id, reason }, 'ทิ้งคลิป');
  return clip;
}

// ── TAG ───────────────────────────────────────────────────────
export function tag({ stationId, trackingNo, user }) {
  const clip = openClipOf(stationId);
  if (!clip) return null;

  clip.tracking_no = trackingNo ?? clip.tracking_no;
  if (user && !clip.packer) clip.packer = user;
  if (!trackingNo && !clip.flags.includes('no_tracking')) clip.flags.push('no_tracking');
  touch(clip);

  persist(clip, 'tag');
  emit(stationId, 'tag', { clip_id: clip._id, tracking_no: clip.tracking_no });
  return clip;
}

// ── SCAN → STOP หรือ MISMATCH ─────────────────────────────────
/**
 * เทียบค่าที่สแกนกับเลขพัสดุที่จำไว้
 *
 * เทียบค่าจริงแทนการเขียน regex แยกขนส่งแต่ละเจ้า = ไม่ต้องแก้โค้ดทุกครั้งที่เพิ่มขนส่งใหม่
 * และได้ฟีเจอร์จับใบปะหน้าผิดกล่องมาแถม ซึ่งปัจจุบันไม่มีอะไรดักเลย
 */
export async function scan({ stationId, value }) {
  const clip = openClipOf(stationId);
  if (!clip) return { action: 'ignored' };

  const normalise = (s) => String(s ?? '').replace(/[\s/-]/g, '').toUpperCase();
  const scanned = normalise(value);
  const expected = normalise(clip.tracking_no);

  if (expected && scanned === expected) {
    await stop({ clipId: clip._id, status: 'verified' });
    return { action: 'stop', clip_id: clip._id };
  }

  if (expected) {
    if (!clip.flags.includes('mismatch')) clip.flags.push('mismatch');
    touch(clip);
    persist(clip, 'mismatch', { expected: clip.tracking_no, scanned: value });
    emit(stationId, 'mismatch', {
      clip_id: clip._id,
      expected: clip.tracking_no,
      scanned: value,
      ordersn: clip.ordersn,
    });
    log.warn(
      { clip_id: clip._id, ordersn: clip.ordersn, expected: clip.tracking_no, scanned: value },
      'ใบปะหน้าไม่ตรงกับออเดอร์ที่กำลังแพ็ค',
    );
    return { action: 'mismatch', clip_id: clip._id };
  }

  // ยังไม่รู้เลขพัสดุของคลิปนี้ — ปิดไม่ได้ แต่จำค่าไว้ให้ตรวจสอบภายหลัง
  touch(clip);
  return { action: 'no_tracking_yet', clip_id: clip._id };
}

// ── CLOSE & STOP ─────────────────────────────────────────────
/**
 * @param {string} clipId
 * @param {'verified'|'registered'|'manual_stop'|'unverified'|'timeout'} status
 */
/**
 * เพิ่มชิ้นที่สแกนเข้าไปในคลิปที่เปิดอยู่ โดยไม่ปิดแล้วเปิดใหม่
 *
 * งาน KOL แพ็คหลายชิ้นลงกล่องเดียว พนักงานยิงทีละชิ้นจนครบ ถ้าใช้ start ทุกครั้ง
 * คลิปจะถูกตัดเป็นท่อนๆ ตัวก่อนหน้าปิดเป็น unverified หมด — และช่วงต่อระหว่างชิ้น
 * ซึ่งเป็นช่วงที่คนอ้างว่าของหายจะหายไปพอดี
 */
export function item({ stationId, imei }) {
  const clip = openClipOf(stationId);
  if (!clip) return null;
  if (imei && !clip.imeis.includes(imei)) clip.imeis.push(imei);
  touch(clip);
  persist(clip, 'item', { imei });
  log.info({ clip_id: clip._id, imei, count: clip.imeis.length }, 'เพิ่มชิ้นเข้าคลิป');
  return clip;
}

/**
 * ลงทะเบียนจัดส่งแล้ว — ผูกเลขพัสดุกับคลิป แต่ **ยังไม่ปิด**
 *
 * ตอนแรกทำให้ปิดตรงนี้ แต่ดูหน้างานจริงแล้วหลังลงทะเบียนยังมีอีกสองขั้น คือ
 * พิมพ์ใบปะหน้าแล้วแปะ และถ่ายรูปกล่องที่แปะเสร็จ ถ้าปิดตั้งแต่ลงทะเบียน วิดีโอ
 * จะขาดตรงขั้นตอนที่พิสูจน์ว่าใบปะหน้าใบไหนถูกแปะบนกล่องไหน ซึ่งเป็นข้อที่
 * ขนส่งกับลูกค้าเถียงกันบ่อยที่สุด
 */
export function shipRegistered({ stationId, trackingNo, projectId }) {
  const clip = openClipOf(stationId);
  if (!clip) return null;
  if (trackingNo) clip.tracking_no = trackingNo;
  if (projectId) clip.project_id = projectId;
  touch(clip);
  persist(clip, 'ship', { tracking_no: trackingNo, project_id: projectId });
  emit(clip.station_id, 'ship', { clip_id: clip._id, tracking_no: clip.tracking_no });
  log.info({ clip_id: clip._id, tracking_no: trackingNo, project_id: projectId }, 'ลงทะเบียนจัดส่งแล้ว');
  return clip;
}

/**
 * ถ่ายรูปกล่องเสร็จ = จบงานแพ็คกล่องนี้จริง → ปิดคลิป
 *
 * ปิดด้วยสถานะ `registered` ไม่ใช่ `verified` เพราะสองอย่างนี้ไม่เท่ากัน —
 * verified แปลว่าพนักงานยิงบาร์โค้ดบนใบปะหน้าแล้วตรงกับคลิป ส่วนงาน KOL ไม่มี
 * ขั้นตอนยิงยืนยันเลย เราปิดจากการที่ระบบบอกว่ารูปถูกอัปโหลดแล้วเท่านั้น
 */
export async function photoTaken({ stationId, projectId }) {
  const clip = openClipOf(stationId);
  if (!clip) return null;
  if (projectId) clip.project_id = projectId;
  touch(clip);
  persist(clip, 'photo', { project_id: projectId });
  log.info({ clip_id: clip._id, project_id: projectId }, 'ถ่ายรูปกล่องแล้ว ขอปิดคลิป');
  return stop({ clipId: clip._id, status: 'registered' });
}

/**
 * ส่งสัญญาณบอกให้กล้องหยุดอัด แล้วรอให้ชิ้นวิดีโอสุดท้ายส่งขึ้นมาจนครบ
 */
export async function stop({ clipId, stationId, status = 'verified', note } = {}) {
  const clip = clipId ? clips.get(clipId) : openClipOf(stationId);
  if (!clip || CLOSED.includes(clip.status)) return clip ?? null;

  if (clip.status === 'closing') {
    if (status) clip.target_status = status;
    return clip;
  }

  clip.status = 'closing';
  clip.target_status = status || 'verified';
  clip.closing_at = new Date();
  if (note) clip.note = note;
  touch(clip);
  // คลิปที่กำลังปิดไม่ใช่ "คลิปที่เปิดอยู่ของโต๊ะ" แล้ว — สแกนถัดไปต้องไม่ไปโดนคลิปนี้
  forget(clip);

  emit(clip.station_id, 'stop', {
    clip_id: clip._id,
    status: clip.target_status,
    ordersn: clip.ordersn,
    tracking_no: clip.tracking_no,
  });

  // ตัวจับเวลาสำรอง เผื่อหน้าต่างอัดไม่ยืนยัน (ปิดแท็บ/หลุด/หน้าต่างอัดรุ่นเก่าที่ยังไม่รีโหลด)
  armCloseTimer(clip);

  log.info({ clip_id: clip._id, status: clip.target_status, ordersn: clip.ordersn }, 'ส่งสัญญาณหยุดอัด (รอชิ้นสุดท้าย)');
  return clip;
}

const closingTimers = new Map();

/**
 * นับถอยหลังปิดไฟล์เอง — ยืดออกทุกครั้งที่ชิ้นวิดีโอยังไหลเข้ามา
 *
 * เดิมนับตายตัว 5 วินาทีจากตอนสั่งหยุด ถ้าคิวในเครื่องค้างอยู่สองสามชิ้น (เน็ตช้า)
 * ไฟล์ถูกปิดก่อนชิ้นท้ายถึง ท้ายคลิปหายซึ่งคือช่วงยิงบาร์โค้ดปิดกล่องพอดี
 * เพดาน 60 วินาทีจากตอนสั่งหยุด กันคลิปค้างสถานะ closing ตลอดไป
 */
function armCloseTimer(clip) {
  const prev = closingTimers.get(clip._id);
  if (prev) clearTimeout(prev);
  const hardStop = (clip.closing_at?.getTime() ?? Date.now()) + 60_000;
  const wait = Math.max(0, Math.min(config.closeGraceSec * 1000, hardStop - Date.now()));
  const timer = setTimeout(() => {
    closingTimers.delete(clip._id);
    void finaliseClip(clip._id);
  }, wait);
  if (timer.unref) timer.unref();
  closingTimers.set(clip._id, timer);
}

/** ครบ N วินาทีแล้วยังไม่มีชิ้นแรก = หน้าแพ็คต้องขึ้นแดง */
function watchFirstChunk(clip) {
  const timer = setTimeout(() => {
    if (clip.chunks === 0 && (clip.status === 'pending' || clip.status === 'recording')) {
      videohealth.markNoChunks(clip.station_id);
    }
  }, config.noVideoAlertSec * 1000);
  if (timer.unref) timer.unref();
}

export async function finaliseClip(clipId, finalStatus, note) {
  const clip = clips.get(clipId);
  if (!clip || CLOSED.includes(clip.status)) {
    return clip ?? null;
  }

  const timer = closingTimers.get(clipId);
  if (timer) {
    clearTimeout(timer);
    closingTimers.delete(clipId);
  }

  const status = finalStatus || clip.target_status || 'verified';
  clip.status = status;
  clip.ended_at = new Date();
  clip.duration_ms = clip.ended_at - clip.started_at;
  if (note) clip.note = note;

  // pin ทันทีเมื่อมีสัญญาณผิดปกติ (FR-6.3)
  if (status === 'unverified' || status === 'timeout' || clip.flags.includes('mismatch')) {
    clip.pinned = true;
    clip.pin_reasons.push('anomaly');
  }

  forget(clip);

  try {
    await finalise(clip);
  } catch (err) {
    log.error({ clip_id: clip._id, err: err.message }, 'ปิดไฟล์คลิปไม่สำเร็จ');
    clip.flags.push('finalise_failed');
  }

  persist(clip, 'close', { status, note: note ?? null });
  videohealth.recordClosed(clip);
  log.info(
    { clip_id: clip._id, status, ordersn: clip.ordersn, duration_ms: clip.duration_ms, bytes: clip.bytes },
    'ปิดคลิปและรวมไฟล์สมบูรณ์',
  );
  return clip;
}

export async function close(clipId, status, note) {
  const clip = clips.get(clipId);
  if (!clip || CLOSED.includes(clip.status)) {
    return clip ?? null;
  }

  if (status === 'unverified' || status === 'timeout') {
    return finaliseClip(clipId, status, note);
  }

  return stop({ clipId, status, note });
}

// ── รับชิ้นวิดีโอ ──────────────────────────────────────────────
/**
 * เก็บแต่ละชิ้นเป็นไฟล์แยกตามลำดับ แล้วค่อยต่อกันตอนปิด
 *
 * ทำแบบนี้แทนการต่อท้ายไฟล์เดียว เพราะชิ้นที่มาซ้ำหรือมาสลับลำดับ (เกิดได้ตอน
 * เน็ตสะดุดแล้วฝั่งเครื่องส่งใหม่) จะไม่ทำให้ไฟล์เสีย — เขียนทับชิ้นเดิมเฉยๆ
 */
const CLOSED = ['aborted', 'verified', 'registered', 'manual_stop', 'unverified', 'timeout'];

export async function putChunk(clipId, seq, buffer) {
  const clip = clips.get(clipId);
  if (!clip) return { ok: false, final: true, error: 'ไม่พบคลิปนี้' };

  // คลิปที่ปิดไปแล้วรับชิ้นเพิ่มไม่ได้ — ไฟล์ถูกต่อและคำนวณ checksum ไปแล้ว
  // ถ้ารับเพิ่มจะได้ไฟล์ที่ไม่ตรงกับ checksum ที่ประกาศไว้ ซึ่งทำลายค่าของมันในฐานะหลักฐาน
  // ตอบ final เพื่อให้ฝั่งเครื่องรู้ว่าให้ทิ้งชิ้นนี้ ไม่ใช่วนส่งใหม่ไปเรื่อยๆ
  if (CLOSED.includes(clip.status)) {
    return { ok: false, final: true, error: `คลิปนี้ปิดไปแล้ว (${clip.status})` };
  }

  try {
    const file = path.join(TMP(), clipId, String(seq).padStart(6, '0'));
    await fs.writeFile(file, buffer);
    clip.chunks = Math.max(clip.chunks, seq + 1);
    touch(clip);
    videohealth.markVideo(clip.station_id);
    if (clip.status === 'closing') armCloseTimer(clip);
    return { ok: true, seq };
  } catch (err) {
    // เขียนไม่ได้ = ปัญหาชั่วคราว (ดิสก์/สิทธิ์) ให้ฝั่งเครื่องลองใหม่ ไม่ใช่ทิ้ง
    log.error({ clip_id: clipId, seq, err: err.message }, 'เขียนชิ้นวิดีโอไม่สำเร็จ');
    return { ok: false, final: false, error: err.message };
  }
}

/** ต่อชิ้นทั้งหมดเป็นไฟล์เดียว คำนวณ checksum แล้วเขียน metadata คู่ไว้ */
async function finalise(clip) {
  const dir = path.join(TMP(), clip._id);
  let names = [];
  try {
    names = (await fs.readdir(dir)).sort();
  } catch {
    log.warn({ clip_id: clip._id }, 'ไม่มีชิ้นวิดีโอเลย');
  }

  if (!names.length) {
    if (!clip.flags.includes('empty')) clip.flags.push('empty');
    clip.pinned = true;
    if (!clip.pin_reasons.includes('empty')) clip.pin_reasons.push('empty');
    await removeTmp(clip._id);
    return;
  }

  const { dir: rel } = dayFolder(clip.started_at);
  const outDir = path.join(ROOT(), rel);
  await fs.mkdir(outDir, { recursive: true });

  const outPath = path.join(outDir, `${clip._id}.mp4`);
  const hash = crypto.createHash('sha256');
  const out = createWriteStream(outPath);
  let bytes = 0;

  const head = await findHeader(dir, names);
  if (head.skipChunks || head.skipBytes) {
    clip.flags.push('head_trimmed');
    log.warn(
      { clip_id: clip._id, skip_chunks: head.skipChunks, skip_bytes: head.skipBytes },
      'ตัดข้อมูลของคลิปอื่นที่ติดมาหน้าไฟล์ออก',
    );
  } else if (!head.found) {
    clip.flags.push('no_header');
    log.error({ clip_id: clip._id }, 'ไม่พบส่วนหัวไฟล์วิดีโอ — ไฟล์นี้อาจเปิดไม่ได้');
  }

  // เขียนเองทีละก้อนแทน pipeline(..., { end: false }) — แบบเดิมผูก listener ค้างไว้กับ out
  // ทุกชิ้น คลิปเกิน 10 ชิ้นขึ้น MaxListenersExceededWarning ทุกครั้ง
  for (let i = head.skipChunks; i < names.length; i++) {
    const start = i === head.skipChunks ? head.skipBytes : 0;
    for await (const b of createReadStream(path.join(dir, names[i]), { start })) {
      hash.update(b);
      bytes += b.length;
      if (!out.write(b)) await once(out, 'drain');
    }
  }
  await new Promise((resolve, reject) => out.end(resolve).on('error', reject));

  clip.bytes = bytes;
  clip.checksum = 'sha256:' + hash.digest('hex');
  clip.media_path = path.join(rel, `${clip._id}.mp4`);

  // ไฟล์ metadata คู่กัน — ถ้าฐานข้อมูลหาย คลิปยังบอกตัวเองได้ว่าเป็นของออเดอร์ไหน (D4)
  await fs.writeFile(
    path.join(outDir, `${clip._id}.json`),
    JSON.stringify(toMetadata(clip), null, 2),
    'utf8',
  );

  await removeTmp(clip._id);
}

/**
 * หาจุดเริ่มของไฟล์วิดีโอจริงในชิ้นแรกๆ
 *
 * ไฟล์ MP4 ที่เล่นได้ต้องขึ้นต้นด้วยกล่อง `ftyp` (WebM ขึ้นต้นด้วย EBML 1A45DFA3)
 * หน้าต่างอัดรุ่นก่อน 2026-09 ติดป้ายชิ้นท้ายของคลิปเก่าเป็นชิ้นแรกของคลิปใหม่
 * ไฟล์จึงขึ้นต้นด้วย `moof` ของคลิปอื่นแล้วเปิดไม่ได้ทุกโปรแกรม — ข้อมูลส่วนนั้นไม่ใช่
 * ของคลิปนี้ตั้งแต่แรก ตัดทิ้งก่อนคำนวณ checksum จึงไม่ได้แก้หลักฐาน
 *
 * ดูแค่ 3 ชิ้นแรก — ชิ้นที่หลงมามีได้อย่างมากชิ้นเดียวต่อการสลับคลิป
 */
async function findHeader(dir, names) {
  for (let i = 0; i < Math.min(3, names.length); i++) {
    let buf;
    try { buf = await fs.readFile(path.join(dir, names[i])); } catch { continue; }
    if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return { found: true, skipChunks: i, skipBytes: 0 };
    // กล่อง ftyp จริงยาว 16–64 ไบต์ — กันเจอตัวอักษร "ftyp" บังเอิญกลางข้อมูลภาพ
    for (let at = buf.indexOf('ftyp'); at !== -1; at = buf.indexOf('ftyp', at + 1)) {
      if (at < 4) continue;
      const size = buf.readUInt32BE(at - 4);
      if (size >= 16 && size <= 64) return { found: true, skipChunks: i, skipBytes: at - 4 };
    }
  }
  return { found: false, skipChunks: 0, skipBytes: 0 };
}

export function toMetadata(clip) {
  return {
    clip_id: clip._id,
    station_id: clip.station_id,
    packer: clip.packer,
    status: clip.status,
    ordersn: clip.ordersn,
    tracking_no: clip.tracking_no,
    // งาน KOL ผูกคลิปกับโปรเจกต์ ไม่ใช่ออเดอร์ · saveClip เขียนจากผลของฟังก์ชันนี้
    // อย่างเดียว ไม่ส่งออกตรงนี้ = ไม่ถูกเก็บลงฐานข้อมูลเลย
    project_id: clip.project_id ?? null,
    imeis: clip.imeis,
    flags: clip.flags,
    pinned: clip.pinned,
    pin_reasons: clip.pin_reasons,
    started_at: clip.started_at?.toISOString?.() ?? null,
    ended_at: clip.ended_at?.toISOString?.() ?? null,
    day: clip.day ?? (clip.started_at ? dayFolder(clip.started_at).day : null),
    duration_ms: clip.duration_ms ?? null,
    bytes: clip.bytes,
    chunks: clip.chunks,
    checksum: clip.checksum,
    media_path: clip.media_path,
  };
}

// ── งานกวาดคลิปค้าง ───────────────────────────────────────────
let sweeper = null;

export function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(async () => {
    const now = Date.now();
    for (const clipId of [...openByStation.values()]) {
      const clip = clips.get(clipId);
      if (!clip) continue;

      if (now - clip.last_activity.getTime() > IDLE_MS) {
        await close(clipId, 'timeout', `ไม่มีเหตุการณ์นานเกิน ${IDLE_MS / 60000} นาที`);
        continue;
      }

      // ยังมีชิ้นวิดีโอไหลเข้ามาอยู่ แต่ไม่มีการสแกนปิดจนเลยเพดาน
      // แยก log เป็น warn เพราะแปลว่ามีคลิปที่ไม่ได้ปิดตามขั้นตอน ควรมีคนไปดูว่าทำไม
      if (now - clip.started_at.getTime() > MAX_MS()) {
        log.warn(
          { clip_id: clipId, station_id: clip.station_id, ordersn: clip.ordersn },
          `อัดเกินเพดาน ${config.clipMaxMinutes} นาทีโดยไม่มีการสแกนปิด — ปิดให้อัตโนมัติ`,
        );
        await close(clipId, 'timeout', `อัดเกินเพดาน ${config.clipMaxMinutes} นาทีโดยไม่มีการสแกนปิด`);
      }
    }
  }, 30_000);
  sweeper.unref();
}

export function stopSweeper() {
  clearInterval(sweeper);
  sweeper = null;
}

/** ปิดทุกคลิปที่ยังค้างของโต๊ะนั้น — ใช้ตอนหน้าต่างอัดหลุด (FR-1.9) */
export async function closeStation(stationId, reason) {
  const clip = openClipOf(stationId);
  if (clip) await close(clip._id, 'unverified', reason);
}

// ── บันทึกลงฐานข้อมูล ─────────────────────────────────────────
/**
 * เขียนสถานะล่าสุดของคลิปและต่อท้าย clip_events
 *
 * ไม่ await ในเส้นทางหลัก — ฐานข้อมูลช้าหรือล่มต้องไม่หน่วงการอัด
 * ไฟล์กับ JSON คู่ยังถูกเขียนตามปกติอยู่แล้ว ฐานข้อมูลเป็นแค่ index (D4)
 */
/**
 * คิวการเขียนต่อคลิปหนึ่งตัว — เขียนทีละคำสั่ง ไม่ยิงขนานกัน
 *
 * ของเดิมยิง saveClip ทิ้งแบบขนาน ซึ่งพังทันทีที่มีเหตุการณ์ติดกันเร็วๆ เพราะ
 * mongo ไม่รับประกันลำดับของ updateOne ที่ค้างอยู่พร้อมกัน — เอกสารที่เขียนทีหลัง
 * แต่ถือ snapshot เก่ากว่าจะทับตัวที่ใหม่กว่าทิ้ง
 *
 * เจอจริงตอนทำ flow KOL: ยิง 4 ชิ้นรัวแล้วปิดคลิป ผลคือฐานข้อมูลได้ imeis ครบ
 * ทั้ง 4 แต่สถานะค้างที่ pending ทั้งที่ปิดไปแล้ว — ทีมเคลมค้นเจอคลิปที่ดูเหมือน
 * ยังอัดไม่จบ ทั้งที่ไฟล์ปิดเรียบร้อยแล้ว
 */
const writeChain = new Map();

function persist(clip, event, detail) {
  const meta = toMetadata(clip);
  const evt = {
    clip_id: clip._id,
    event,
    station_id: clip.station_id,
    ordersn: clip.ordersn ?? null,
    tracking_no: clip.tracking_no ?? null,
    actor: clip.packer ?? null,
    detail: detail ?? null,
  };

  const prev = writeChain.get(clip._id) ?? Promise.resolve();
  const next = prev
    .then(() => repo.saveClip(meta))
    .then(() => repo.appendEvent(evt))
    .catch(() => {});          // repo บันทึก error เองแล้ว ห้ามให้คิวขาดตรงนี้
  writeChain.set(clip._id, next);
  void next.then(function () {
    if (writeChain.get(clip._id) === next) writeChain.delete(clip._id);
  });
}

// ── ตัวช่วย ───────────────────────────────────────────────────
function clipByTrace(traceId) {
  const id = byTrace.get(traceId);
  return id ? clips.get(id) ?? null : null;
}

function touch(clip) {
  clip.last_activity = new Date();
}

function forget(clip) {
  if (clip.trace_id) byTrace.delete(clip.trace_id);
  if (openByStation.get(clip.station_id) === clip._id) openByStation.delete(clip.station_id);
}

async function removeTmp(clipId) {
  await fs.rm(path.join(TMP(), clipId), { recursive: true, force: true }).catch(() => {});
}
