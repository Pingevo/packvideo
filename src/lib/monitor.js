import { listStations } from './stations.js';
import { commitRate, msSinceLastSignal } from './metrics.js';
import { storageStatus } from './storage.js';
import { dbState } from '../db.js';
import { alert } from './notify.js';
import { log } from '../log.js';
import { config } from '../config.js';

/**
 * เฝ้าดูสุขภาพระบบตาม design §9.4
 *
 * หลักการเดียวที่คุมทุกกฎในนี้: **ปัญหาต้องดังก่อนที่คลิปจะหายไปเป็นวันๆ**
 * ระบบนี้ล้มเหลวแบบเงียบได้ง่ายมาก — hook พังก็ไม่มี error, พนักงานปิดหน้าต่างอัด
 * ก็ไม่มีใครรู้ ตัวเลขพวกนี้คือสิ่งเดียวที่ทำให้เห็น
 */

const CHECK_INTERVAL_MS = 60_000;
const MIN_COMMIT_RATE = 0.95;
const MIN_TAG_SAMPLE = 20;          // ต่ำกว่านี้อัตราแกว่งเกินกว่าจะเชื่อ
const SILENCE_MS = 15 * 60 * 1000;
const QUEUE_ALERT = 20;

let timer = null;

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
