/**
 * ตัวชี้วัดจากสัญญาณที่รับเข้ามา
 *
 * เก็บในหน่วยความจำแบบหน้าต่างเลื่อน — ของจริงคำนวณจาก `clip_events` ใน P1-5
 * แต่ตัวเลขที่ Gate 1 ต้องใช้วัดผลเป็นตัวเลขระดับชั่วโมง ไม่ต้องย้อนหลังหลายวัน
 * หน้าต่างในหน่วยความจำจึงพอสำหรับตอนนี้
 */

const WINDOW_MS = 6 * 60 * 60 * 1000;   // เก็บย้อนหลัง 6 ชั่วโมง
const MAX_EVENTS = 50_000;              // เพดานกันหน่วยความจำบวมถ้ามีอะไรผิดปกติ

/** @type {{t: number, event: string, station: string}[]} */
let events = [];

export function record(event, station) {
  events.push({ t: Date.now(), event, station: station || '(ไม่ระบุ)' });
  if (events.length > MAX_EVENTS) events = events.slice(-Math.floor(MAX_EVENTS / 2));
}

function within(ms) {
  const cutoff = Date.now() - ms;
  // ตัดของเก่าทิ้งไปด้วยเลย จะได้ไม่ต้องมีงานกวาดแยก
  const idx = events.findIndex((e) => e.t >= cutoff);
  if (idx > 0) events = events.slice(idx);
  return events.filter((e) => e.t >= cutoff);
}

/**
 * อัตราคลิปต่อใบปะหน้า — ตัวชี้วัดหลักของ Gate 1 ข้อ A1
 *
 * ตัวหารคือสัญญาณ `tag` ที่เรานับเองจากการเรนเดอร์หน้าใบปะหน้า (design D6)
 * จึงไม่ต้องไปถามระบบเดิมว่าพิมพ์ใบปะหน้าไปกี่ใบ
 */
export function commitRate(ms = 60 * 60 * 1000) {
  const recent = within(ms);
  const byStation = {};

  for (const e of recent) {
    const s = (byStation[e.station] ??= { start: 0, commit: 0, abort: 0, tag: 0, scan: 0 });
    if (e.event in s) s[e.event]++;
  }

  let totalTag = 0;
  let totalCommit = 0;
  for (const [station, c] of Object.entries(byStation)) {
    totalTag += c.tag;
    totalCommit += c.commit;
    // ตัวหารเป็น 0 แปลว่ายังไม่มีใบปะหน้าเลย ไม่ใช่ว่าอัตราเป็น 0 — ต้องแยกสองอย่างนี้
    c.rate = c.tag > 0 ? +(c.commit / c.tag).toFixed(3) : null;
    c.station_id = station;
  }

  return {
    window_ms: ms,
    overall: totalTag > 0 ? +(totalCommit / totalTag).toFixed(3) : null,
    total_tag: totalTag,
    total_commit: totalCommit,
    by_station: Object.values(byStation),
  };
}

/**
 * โต๊ะที่ส่งสัญญาณเข้ามาตั้งแต่เวลาที่กำหนด
 *
 * ใช้ตอบคำถามว่า "โต๊ะนี้ต่ออยู่แต่ไม่เคยส่งอะไรมาเลย ทั้งที่โต๊ะอื่นส่งอยู่" ซึ่งเป็น
 * ลายเซ็นของ hook.js ที่ไม่ทำงานบนเครื่องนั้น — แยกจากกรณีที่ยังไม่มีใครเริ่มงาน
 */
export function stationsSignalledSince(t) {
  const set = new Set();
  for (const e of events) {
    if (e.t >= t) set.add(e.station);
  }
  return set;
}

/** โต๊ะที่ส่งเหตุการณ์ชนิดนี้เข้ามาในช่วงเวลาที่กำหนด → จำนวนครั้ง */
export function stationsWithEvent(event, ms) {
  const out = new Map();
  const cutoff = Date.now() - ms;
  for (const e of events) {
    if (e.t >= cutoff && e.event === event) out.set(e.station, (out.get(e.station) ?? 0) + 1);
  }
  return out;
}

/** เวลาที่ผ่านไปนับจากสัญญาณล่าสุด — ใช้ดักกรณี hook เงียบทั้งระบบ */
export function msSinceLastSignal() {
  if (!events.length) return null;
  return Date.now() - events[events.length - 1].t;
}

export function recentEvents(limit = 50) {
  return events.slice(-limit).reverse();
}

export function totals() {
  const hour = within(60 * 60 * 1000);
  const byEvent = {};
  for (const e of hour) byEvent[e.event] = (byEvent[e.event] ?? 0) + 1;
  return { last_hour: byEvent, kept: events.length };
}
