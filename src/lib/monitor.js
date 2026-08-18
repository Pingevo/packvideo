import { listStations } from './stations.js';
import { commitRate, msSinceLastSignal, stationsSignalledSince, stationsWithEvent } from './metrics.js';
import { storageStatus } from './storage.js';
import { dbState } from '../db.js';
import { alert } from './notify.js';
import { broadcast } from './sse.js';
import { log } from '../log.js';
import { config } from '../config.js';

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

let timer = null;
let lastDiskLevel = null;

export async function runChecks() {
  const findings = [];
  const stations = listStations();
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
  for (const s of rate.by_station) {
    const station = stations.find((x) => x.station_id === s.station_id);
    if (s.tag > 0 && station && !station.connected) {
      findings.push({
        level: 'error',
        key: `offline:${s.station_id}`,
        text: `${s.station_id} มีการพิมพ์ใบปะหน้า ${s.tag} ใบ แต่ไม่มีเครื่องต่ออยู่ — ไม่ได้บันทึกวิดีโอ`,
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
    const since = new Date(s.claimed_at).getTime();
    if (!Number.isFinite(since) || Date.now() - since < HOOK_DEAD_MS) continue;

    const signalled = stationsSignalledSince(since);
    if (signalled.has(s.station_id)) continue;

    const others = [...signalled].filter((x) => x !== s.station_id);
    if (!others.length) continue;   // ไม่มีใครทำงานเลย — กฎข้อ 3 รับผิดชอบกรณีนี้

    findings.push({
      level: 'error',
      key: `hookdead:${s.station_id}`,
      text:
        `${s.station_id} ต่ออยู่มา ${Math.round((Date.now() - since) / 60000)} นาที ` +
        `แต่ไม่เคยได้รับสัญญาณจาก hook.js เลยสักครั้ง ทั้งที่อีก ${others.length} โต๊ะส่งอยู่ — ` +
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
  if (disk.disk_level !== lastDiskLevel) {
    log.warn({ from: lastDiskLevel, to: disk.disk_level, used_pct: disk.used_pct }, 'ระดับดิสก์เปลี่ยน');
    lastDiskLevel = disk.disk_level;
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
    await alert(f.key, f.text);
  }

  return { checked_at: new Date().toISOString(), findings, stations, rate, disk };
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
