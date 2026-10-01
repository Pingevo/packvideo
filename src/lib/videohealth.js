import { config } from '../config.js';
import { log } from '../log.js';
import { alert } from './notify.js';
import { MIN_VIDEO_BYTES } from './schema.js';

/**
 * สุขภาพ "ได้วิดีโอจริงไหม" รายโต๊ะ — มองจากฝั่งเซิร์ฟเวอร์ ไม่เชื่อคำบอกของหน้าต่างอัด
 *
 * ทำไมต้องมีทั้งที่ rec.html ส่ง camera_ready อยู่แล้ว: ข้อมูลจริงก่อน 17 ก.ย. 2026
 * มีคลิปว่าง 578 คลิป 90% มาจากช่วงดับยาวที่ไม่มีใครรู้ — 12 ก.ย. desk-02 ดับ 7.5 ชม.
 * 223 ออเดอร์ คลิปสุดท้ายก่อนดับครบสมบูรณ์ แปลว่าตัวอัดหยุด "ระหว่างคลิป" ซึ่งเข้ากับ
 * กรณีหน้าต่างอัดไม่ได้รับสัญญาณเริ่ม (SSE หลุด) มากกว่ากล้องหลุด — กรณีนั้น heartbeat
 * ยังวิ่งปกติ camera_ready ยังเป็น true แถบบนหน้าแพ็คจึงเขียวทั้งวัน
 *
 * สิ่งเดียวที่เชื่อได้คือ **ชิ้นวิดีโอมาถึงเซิร์ฟเวอร์จริงไหม** ไฟล์นี้จึงนับจากตรงนั้น
 */

/** @type {Map<string, {problem: string|null, since: Date|null, emptyStreak: number, streakFrom: Date|null, streakOrders: string[], alerted: boolean, recovering: boolean}>} */
const byStation = new Map();

function stateOf(stationId) {
  let s = byStation.get(stationId);
  if (!s) {
    s = { problem: null, since: null, emptyStreak: 0, streakFrom: null, streakOrders: [], alerted: false, recovering: false };
    byStation.set(stationId, s);
  }
  return s;
}

const PROBLEM_TEXT = {
  no_recorder: 'หน้าต่างอัดไม่ได้รับสัญญาณเริ่มอัด',
  no_chunks: 'เริ่มคลิปแล้วแต่ไม่มีวิดีโอเข้ามา',
};

/** เริ่มคลิปแล้วไม่มีหน้าต่างอัดรับสัญญาณเลย — รู้ได้ทันที ไม่ต้องรอ */
export function markNoRecorder(stationId) {
  setProblem(stationId, 'no_recorder');
}

/** ครบ N วินาทีแล้วคลิปยังไม่มีชิ้นวิดีโอสักชิ้น */
export function markNoChunks(stationId) {
  const s = stateOf(stationId);
  // no_recorder บอกสาเหตุได้ตรงกว่า อย่าเขียนทับด้วยอาการ
  if (s.problem === 'no_recorder') return;
  setProblem(stationId, 'no_chunks');
}

function setProblem(stationId, problem) {
  const s = stateOf(stationId);
  if (s.problem === problem) return;
  if (!s.problem) s.since = new Date();
  s.problem = problem;
  log.warn({ station_id: stationId, problem }, `${stationId} ${PROBLEM_TEXT[problem]}`);
}

/** มีชิ้นวิดีโอเข้ามา = โต๊ะนี้ได้ภาพจริง ล้างปัญหาทันที */
export function markVideo(stationId) {
  const s = stateOf(stationId);
  if (s.problem) log.info({ station_id: stationId, was: s.problem }, `${stationId} กลับมาได้วิดีโอแล้ว`);
  s.problem = null;
  s.since = null;
  // ช่วงว่างติดกันยังนับค้างไว้จนคลิปนี้ปิดสำเร็จ (ใช้ส่งข้อความ "กลับมาแล้ว")
  // แต่แถบบนหน้าแพ็คต้องกลับเป็นปกติทันทีที่ภาพมา ไม่ต้องรอพนักงานแพ็คจบกล่อง
  s.recovering = true;
}

/**
 * นับคลิปที่ปิดแล้ว เพื่อจับ "ว่างติดกัน" และเตือนหัวหน้าคลัง
 *
 * ไม่นับคลิปสั้นกว่า N วินาทีที่ว่าง — เป็นการสแกนออเดอร์ใหม่ทับเร็วเกินกว่าชิ้นแรกจะถูกปล่อย
 * (ชิ้นแรกออกหลังเริ่มอัด ~3.4 วินาที) ไม่ใช่กล้องดับ ถ้านับจะเตือนผิดจนคนเลิกอ่าน
 */
export function recordClosed(clip) {
  if (!clip?.station_id || clip.status === 'aborted') return;
  const s = stateOf(clip.station_id);
  // ไฟล์ที่มีแค่ส่วนหัวก็คือไม่มีวิดีโอ — เดิมนับเป็นมีวิดีโอ ช่วงไม่มีภาพติดกันจึงไม่เคยเตือน
  const empty = (clip.bytes ?? 0) < MIN_VIDEO_BYTES;

  if (!empty) {
    if (s.alerted) {
      void alert(
        `novideo-ok:${clip.station_id}`,
        `✅ ${clip.station_id} กลับมาบันทึกวิดีโอได้แล้ว — ช่วงที่ไม่มีวิดีโอ ${s.emptyStreak} ออเดอร์ ` +
          `ตั้งแต่ ${fmtTime(s.streakFrom)} ถึง ${fmtTime(new Date())}`,
        { force: true },
      );
    }
    s.emptyStreak = 0;
    s.streakFrom = null;
    s.streakOrders = [];
    s.alerted = false;
    s.recovering = false;
    return;
  }

  if ((clip.duration_ms ?? 0) < config.noVideoAlertSec * 1000) return;

  s.emptyStreak += 1;
  s.recovering = false;
  if (!s.streakFrom) s.streakFrom = clip.started_at ?? new Date();
  if (clip.ordersn && s.streakOrders.length < 5) s.streakOrders.push(clip.ordersn);

  if (s.emptyStreak >= config.emptyStreakAlert && !s.alerted) {
    s.alerted = true;
    void alert(
      `novideo:${clip.station_id}`,
      `🔴 ${clip.station_id} ไม่มีวิดีโอติดกัน ${s.emptyStreak} ออเดอร์ ตั้งแต่ ${fmtTime(s.streakFrom)}` +
        (clip.packer ? ` · พนักงาน ${clip.packer}` : '') +
        (s.streakOrders.length ? ` · เช่น ${s.streakOrders.join(', ')}` : '') +
        ' — ไปดูหน้าต่างอัด/กล้องที่โต๊ะนี้',
      { force: true },
    );
  }
}

/** สถานะย่อสำหรับแถบบนหน้าแพ็คและหน้า monitor */
export function videoStatus(stationId) {
  const s = byStation.get(stationId);
  const streakBad = (x) => x.emptyStreak >= config.emptyStreakAlert && !x.recovering;
  if (!s) return { video_ok: true, video_problem: null, video_problem_text: null, video_problem_since: null, empty_streak: 0 };
  return {
    video_ok: !s.problem && !streakBad(s),
    video_problem: s.problem ?? (streakBad(s) ? 'empty_streak' : null),
    video_problem_text: s.problem
      ? PROBLEM_TEXT[s.problem]
      : streakBad(s) ? `ไม่มีวิดีโอติดกัน ${s.emptyStreak} ออเดอร์` : null,
    video_problem_since: s.since ?? s.streakFrom ?? null,
    empty_streak: s.emptyStreak,
  };
}

export function allVideoStatus() {
  return [...byStation.keys()].map((id) => ({ station_id: id, ...videoStatus(id) }));
}

function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
}
