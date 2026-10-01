import { listStations } from './stations.js';
import { commitRate, msSinceLastSignal, stationsSignalledSince, stationsWithEvent } from './metrics.js';
import { storageStatus } from './storage.js';
import { dbState } from '../db.js';
import { alert } from './notify.js';
import { broadcast } from './sse.js';
import { log } from '../log.js';
import { config } from '../config.js';
import { videoStatus } from './videohealth.js';
import { noListenerFor } from './sse.js';
import { clipStatsByStation } from './repo.js';

/**
 * เฝ้าดูสุขภาพระบบตาม design §9.4
 *
 * หลักการเดียวที่คุมทุกกฎในนี้: **ปัญหาต้องดังก่อนที่คลิปจะหายไปเป็นวันๆ**
 * ระบบนี้ล้มเหลวแบบเงียบได้ง่ายมาก — hook พังก็ไม่มี error, พนักงานปิดหน้าต่างอัด
 * ก็ไม่มีใครรู้ ตัวเลขพวกนี้คือสิ่งเดียวที่ทำให้เห็น
 */

const CHECK_INTERVAL_MS = 15_000;
const MIN_COMMIT_RATE = 0.95;
const MIN_TAG_SAMPLE = 20;          // ต่ำกว่านี้อัตราแกว่งเกินกว่าจะเชื่อ
const SILENCE_MS = 15 * 60 * 1000;
const HOOK_DEAD_MS = 30 * 60 * 1000;   // ต่อมานานขนาดนี้แล้วยังไม่เคยส่งอะไรเลย = ผิดปกติ
const QUEUE_ALERT = 20;
const DEAF_MS = 45 * 1000;          // ต่อ SSE ใหม่ตามปกติใช้ไม่กี่วินาที — เกินนี้คือหูหนวกจริง

let timer = null;
let lastDiskLevel = null;
let lastRecordingAllowed = null;

/**
 * โต๊ะที่ heartbeat ยังมาแต่ไม่มีหน้าต่างอัดฟัง SSE — เริ่มนับเวลาตั้งแต่เห็นครั้งแรก
 * (เก็บไว้ระหว่างรอบตรวจ เพื่อไม่เตือนตอนรีเฟรชหน้าหรือเน็ตสะดุดแวบเดียว)
 */
const deafSince = new Map();

function trackDeaf(stations) {
  const now = Date.now();
  for (const s of stations) {
    if (s.connected && !s.listening) {
      if (!deafSince.has(s.station_id)) deafSince.set(s.station_id, now);
    } else {
      deafSince.delete(s.station_id);
    }
  }
}

const deafForMs = (stationId) => {
  const t = deafSince.get(stationId);
  return t ? Date.now() - t : 0;
};

export async function runChecks() {
  const findings = [];
  const stations = listStations();
  const today = await todayStats();
  const connected = stations.filter((s) => s.connected);
  const rate = commitRate();

  // ── 1 · อัตราคลิปต่อใบปะหน้า (Gate 1 · A1) ──────────────────
  for (const s of rate.by_station) {
    if (s.tag >= MIN_TAG_SAMPLE && s.rate !== null && s.rate < MIN_COMMIT_RATE) {
      findings.push({
        level: 'warn',
        key: `rate:${s.station_id}`,
        text:
          `${s.station_id} อัตราคลิปต่อใบปะหน้าต่ำ ${(s.rate * 100).toFixed(0)}% ` +
          `(ใบปะหน้า ${s.tag} · คลิป ${s.commit}) ในหนึ่งชั่วโมงที่ผ่านมา`,
      });
    }
  }

  // ── 2 · โต๊ะที่พิมพ์ใบปะหน้าอยู่แต่ไม่มีเครื่องต่อ (FR-8.2) ──
  trackDeaf(stations);
  for (const s of rate.by_station) {
    const station = stations.find((x) => x.station_id === s.station_id);
    if (!(s.tag > 0 && station)) continue;

    if (!station.connected) {
      findings.push({
        level: 'error',
        key: `offline:${s.station_id}`,
        text: `${s.station_id} มีการพิมพ์ใบปะหน้า ${s.tag} ใบ แต่ไม่มีเครื่องต่ออยู่ — ไม่ได้บันทึกวิดีโอ`,
      });
    } else if (deafForMs(s.station_id) >= DEAF_MS) {
      // heartbeat ยังมา (จึงขึ้น "ต่ออยู่") แต่ไม่มีหน้าต่างอัดรับสัญญาณ — กฎเดิมมองไม่เห็นเคสนี้เลย
      // เกิดจริง: desk-05 หน้าต่างอัดถูกพาไปค้างที่ /setup.html ซึ่งส่ง heartbeat เอง ทั้งวันไม่มีวิดีโอ
      findings.push({
        level: 'error',
        key: `deaf:${s.station_id}`,
        text:
          `${s.station_id} มีการพิมพ์ใบปะหน้า ${s.tag} ใบ และเครื่องยังส่ง heartbeat แต่ไม่มีหน้าต่างอัดรับสัญญาณ ` +
          `มา ${Math.round(deafForMs(s.station_id) / 1000)} วินาทีแล้ว — น่าจะค้างหน้าตั้งค่า ` +
          'หรือกล้องค้างตอนเปิดหน้า ไม่ได้บันทึกวิดีโอ (เปิด /rec.html บนเครื่องนั้นแล้วอนุญาตกล้อง)',
      });
    }
  }

  // ── 2.1 · โต๊ะที่ต่ออยู่แต่กล้องหลุดหรือไม่ทำงาน ─────────────
  for (const s of connected) {
    if (s.camera_ready === false) {
      findings.push({
        level: 'error',
        key: `camera:${s.station_id}`,
        text: `${s.station_id} ต่ออยู่แต่กล้องหลุดหรือไม่ทำงาน — ไม่ได้บันทึกวิดีโอ`,
      });
    }
  }

  // ── 2.2 · โต๊ะที่ได้คลิปแต่ไม่ได้วิดีโอจริง ──────────────────
  // ดูจากชิ้นวิดีโอที่มาถึงเซิร์ฟเวอร์ ไม่ใช่คำบอกของหน้าต่างอัด — จับกรณีที่ 2.1 มองไม่เห็น
  // quiet: ไม่ส่ง Telegram จากตรงนี้ — คลิปเดียวที่ชิ้นแรกมาช้าไม่ควรปลุกหัวหน้าคลัง
  // videohealth ส่งเองเมื่อว่างติดกันครบเกณฑ์ พร้อมข้อความ "กลับมาแล้ว" เมื่อหาย
  for (const s of stations) {
    const v = videoStatus(s.station_id);
    if (!v.video_ok) {
      findings.push({
        level: 'error',
        quiet: true,
        key: `video:${s.station_id}`,
        text: `${s.station_id} ${v.video_problem_text} — ออเดอร์ที่แพ็คตอนนี้ไม่มีวิดีโอ`,
      });
    } else if (s.connected && noListenerFor(s.station_id) > 15_000) {
      findings.push({
        level: 'error',
        quiet: true,
        key: `nolistener:${s.station_id}`,
        text: `${s.station_id} ต่ออยู่แต่หน้าต่างอัดขาดการเชื่อมต่อสัญญาณ — สแกนตอนนี้จะได้คลิปว่าง ให้รีเฟรชหน้าต่างอัด`,
      });
    }
  }

  // ── 2.3 · ออเดอร์วันนี้ที่ไม่มีวิดีโอ (R6.2) ───────────────
  // quiet: ย้อนหลังแก้ไม่ได้แล้ว เตือน Telegram ซ้ำทุก 30 นาทีไม่มีประโยชน์ — videohealth เตือนตอนเกิดไปแล้ว
  for (const [stationId, t] of Object.entries(today.by_station)) {
    if (t.no_video > 0 || t.corrupt > 0) {
      findings.push({
        level: 'warn',
        quiet: true,
        key: `today:${stationId}`,
        text:
          `${stationId} วันนี้มีออเดอร์ที่ไม่มีวิดีโอ ${t.no_video} จาก ${t.clips} คลิป` +
          (t.corrupt ? ` · ไฟล์เปิดไม่ได้ ${t.corrupt}` : ''),
      });
    }
  }

  // ── 2.5 · โต๊ะที่ต่ออยู่แต่ hook.js ไม่เคยส่งสัญญาณเลย ──────
  /**
   * กฎที่เหลือทุกข้อมองไม่เห็นโต๊ะที่ hook.js ตายสนิท เพราะทุกข้อนับจากสัญญาณ
   * ที่ hook.js เป็นคนส่ง — hook ตาย = tag 0 commit 0 = ไม่มีอะไรให้กฎไหนจับเลย
   * โต๊ะขึ้นเขียวว่า "ต่ออยู่" จาก rec.html ซึ่งอยู่คนละ origin กับ hook.js
   * หัวหน้าจึงเห็นเขียวทั้งที่ไม่มีการอัดสักคลิป — เกิดขึ้นจริงมาแล้ว
   * (localStorage แยกตาม origin ทำให้ hook อ่าน station_id/token ไม่ได้)
   *
   * ลายเซ็นที่ชัดที่สุดคือ **ต่อมานานแล้วแต่ไม่เคยส่งอะไรเลย ทั้งที่โต๊ะอื่นส่งอยู่**
   * เงื่อนไขข้อหลังสำคัญ — ถ้าไม่มีใครส่งเลยแปลว่ายังไม่มีใครเริ่มงาน ไม่ใช่โต๊ะนี้พัง
   * และกรณีนั้นกฎข้อ 3 ดูแลอยู่แล้ว สองกฎนี้จึงเสริมกันโดยไม่เตือนซ้ำและไม่เตือนผิด
   */
  for (const s of connected) {
    // นับจากหลังเที่ยงคืนวันนี้หรือตอนจับจอง แล้วแต่อันไหนหลังกว่า — เครื่องที่เปิดค้างข้ามวัน
    // เคยขึ้นว่า "ต่ออยู่มา 23124 นาที" ซึ่งไม่ได้บอกอะไรคนอ่าน
    const since = Math.max(new Date(s.claimed_at).getTime(), new Date(today.since).getTime() || 0);
    if (!Number.isFinite(since) || Date.now() - since < HOOK_DEAD_MS) continue;

    const signalled = stationsSignalledSince(since);
    if (signalled.has(s.station_id)) continue;
    // ความจริงอยู่ที่ฐานข้อมูล — มีคลิปของโต๊ะนี้หลังจับจอง = hook ทำงาน (R6.1)
    // ตัวนับในหน่วยความจำเก็บแค่ 6 ชม. และหายเมื่อรีสตาร์ท ใช้ตัดสินลำพังไม่ได้
    const last = today.by_station[s.station_id]?.last_at;
    if (last && new Date(last).getTime() >= since) continue;
    if (!today.ok) continue;   // ฐานข้อมูลตอบไม่ได้ = ไม่รู้ ไม่เดาว่าพัง

    const others = [...signalled].filter((x) => x !== s.station_id);
    if (!others.length) continue;   // ไม่มีใครทำงานเลย — กฎข้อ 3 รับผิดชอบกรณีนี้

    findings.push({
      level: 'error',
      key: `hookdead:${s.station_id}`,
      text:
        `${s.station_id} ต่ออยู่ ${Math.round((Date.now() - since) / 60000)} นาทีแล้ววันนี้ ` +
        `แต่ยังไม่มีคลิปหรือสัญญาณจากหน้าแพ็คเลย ทั้งที่อีก ${others.length} โต๊ะส่งอยู่ — ` +
        'หน้าแพ็คของเครื่องนี้อาจโหลด hook.js ไม่ได้ หรืออ่าน station_id/token ไม่ได้ ' +
        '(ดู /bridge.html และ ALLOWED_ORIGINS)',
    });
  }

  // ── 2.6 · hook ทำงานอยู่แต่แตะหน้าเดิมได้ไม่ครบ ─────────────
  // สัญญาณที่ไม่มีใครดูก็เงียบพอกับไม่มีสัญญาณ — ต้องโผล่บนหน้าสถานะระบบ
  // ระดับ warn ไม่ใช่ error เพราะการอัดยังทำงานปกติ แค่หน้าจอบอกพนักงานได้ไม่ครบ
  for (const [stationId, n] of stationsWithEvent('ui_degraded', 60 * 60 * 1000)) {
    findings.push({
      level: 'warn',
      key: `ui:${stationId}`,
      text:
        `${stationId} hook.js แตะหน้าแพ็คได้ไม่ครบ ${n} ครั้งในหนึ่งชั่วโมง — ` +
        'หาป้ายช่องสแกนไม่เจอ ป้ายจึงยังเขียนว่า Imei อยู่ (แถบเตือนกับ placeholder ยังทำงาน) ' +
        'โครงสร้างหน้าของระบบเดิมน่าจะเปลี่ยนไป',
    });
  }

  // ── 3 · hook เงียบทั้งระบบ ──────────────────────────────────
  // ไม่ผูกกับเวลาทำการ แต่ผูกกับ "มีโต๊ะต่ออยู่ไหม" — ถ้าไม่มีใครทำงาน ก็ไม่ต้องเตือน
  // ผูกกับนาฬิกาจะพลาดเวลาทำงานล่วงเวลาและเตือนผิดตอนวันหยุด
  const silence = msSinceLastSignal();
  if (connected.length > 0 && (silence === null || silence > SILENCE_MS)) {
    findings.push({
      level: 'error',
      key: 'silence',
      text:
        `ไม่ได้รับสัญญาณใดๆ มา ${silence === null ? 'ตั้งแต่เริ่มระบบ' : Math.round(silence / 60000) + ' นาที'} ` +
        `ทั้งที่มี ${connected.length} โต๊ะต่ออยู่ — hook.js อาจไม่ทำงานแล้ว`,
    });
  }

  // ── 4 · คิวอัปโหลดค้าง ──────────────────────────────────────
  for (const s of connected) {
    if ((s.queue_depth ?? 0) > QUEUE_ALERT) {
      findings.push({
        level: 'warn',
        key: `queue:${s.station_id}`,
        text: `${s.station_id} มีคลิปค้างรออัปโหลด ${s.queue_depth} ตัว`,
      });
    }
  }

  // ── 5 · ดิสก์ ───────────────────────────────────────────────
  const disk = await storageStatus();

  // ระดับดิสก์เปลี่ยน → บอกทุกหน้าต่างอัดทันที
  // ถ้าส่ง config แค่ตอนต่อ SSE ครั้งแรก หน้าต่างที่เปิดค้างมาตั้งแต่เช้าจะยังอัดต่อ
  // ทั้งที่ดิสก์เต็มไปแล้ว — คือกรณีที่กฎข้อนี้มีไว้ป้องกันพอดี
  //
  // รวมกรณี recording_allowed เปลี่ยนโดยระดับดิสก์ไม่เปลี่ยนด้วย (เช่นตรวจเขียนดิสก์พลาดชั่วคราวแล้วหาย)
  // ไม่งั้นหน้าต่างอัดที่ได้ recording:false ตอนต่อ SSE จะหยุดอัดค้างไปจนกว่าจะต่อใหม่
  if (disk.disk_level !== lastDiskLevel || disk.recording_allowed !== lastRecordingAllowed) {
    if (disk.disk_level !== lastDiskLevel) {
      log.warn({ from: lastDiskLevel, to: disk.disk_level, used_pct: disk.used_pct }, 'ระดับดิสก์เปลี่ยน');
    } else {
      log.warn({ recording_allowed: disk.recording_allowed }, 'สถานะบันทึกได้/ไม่ได้เปลี่ยน');
    }
    lastDiskLevel = disk.disk_level;
    lastRecordingAllowed = disk.recording_allowed;
    broadcast('config', {
      recording: disk.recording_allowed,
      disk_level: disk.disk_level,
      disk_used_pct: disk.used_pct,
    });
  }

  if (disk.disk_level === 'stop') {
    findings.push({
      level: 'error',
      key: 'disk:stop',
      text: `ดิสก์เต็ม ${disk.used_pct}% — หยุดบันทึกวิดีโอแล้ว งานแพ็คยังทำงานปกติ`,
    });
  } else if (disk.disk_level === 'squeeze' || disk.disk_level === 'warn') {
    findings.push({
      level: 'warn',
      key: `disk:${disk.disk_level}`,
      text: `ดิสก์ใช้ไป ${disk.used_pct}% เหลือ ${disk.free_gb} GB`,
    });
  }
  if (!disk.writable) {
    findings.push({ level: 'error', key: 'disk:ro', text: `เขียนที่เก็บคลิปไม่ได้: ${disk.error}` });
  }

  // ── 6 · ฐานข้อมูล ───────────────────────────────────────────
  if (!dbState().connected) {
    findings.push({
      level: 'error',
      key: 'mongo',
      text: `ต่อฐานข้อมูลไม่ได้ — ${dbState().lastError ?? 'ไม่ทราบสาเหตุ'}`,
    });
  }

  for (const f of findings) {
    if (f.quiet) continue;
    await alert(f.key, f.text);
  }

  // สถานะที่หน้าจอต้องใช้แยก "ต่ออยู่และบันทึกจริง" ออกจาก "ต่ออยู่แต่ไม่ได้บันทึก" (R6.3)
  const enriched = stations.map((s) => {
    const v = videoStatus(s.station_id);
    const listenerGone = s.connected && noListenerFor(s.station_id) > 15_000;
    let state;
    if (!s.connected) state = s.stale ? 'lost' : 'off';
    else if (s.camera_ready === false) state = 'camera';
    else if (!v.video_ok) state = 'no_video';
    else if (listenerGone) state = 'no_listener';
    else state = s.recording ? 'recording' : 'ready';
    return { ...s, ...v, state, today: today.by_station[s.station_id] ?? { clips: 0, no_video: 0, corrupt: 0, last_at: null } };
  });

  return { checked_at: new Date().toISOString(), findings, stations: enriched, rate, disk, today: { ok: today.ok, since: today.since } };
}

/** คลิปวันนี้ (เวลาไทย) รายโต๊ะ · แคช 30 วินาที — หน้า monitor รีเฟรชทุก 10 วิ ไม่ต้อง aggregate ทุกครั้ง */
let todayCache = { at: 0, value: null };
async function todayStats() {
  if (todayCache.value && Date.now() - todayCache.at < 30_000) return todayCache.value;
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const since = new Date(`${day}T00:00:00+07:00`).toISOString();
  const rows = await clipStatsByStation(since);
  const by_station = {};
  for (const r of rows ?? []) by_station[r._id] = { clips: r.clips, no_video: r.no_video, corrupt: r.corrupt, last_at: r.last_at };
  const value = { ok: rows !== null, since, by_station };
  if (rows !== null) todayCache = { at: Date.now(), value };
  return value;
}

export function startMonitor() {
  if (timer) return;
  timer = setInterval(() => {
    runChecks().catch((err) => log.error({ err: err.message }, 'ตรวจสุขภาพระบบไม่สำเร็จ'));
  }, CHECK_INTERVAL_MS);
  timer.unref();
  log.info(
    { interval_ms: CHECK_INTERVAL_MS, telegram: !!config.telegram.botToken },
    'เริ่มเฝ้าดูสุขภาพระบบ',
  );
}

export function stopMonitor() {
  clearInterval(timer);
  timer = null;
}
