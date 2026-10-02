#!/usr/bin/env node
/**
 * หน้าต่างอัดจริงในเบราว์เซอร์ (rec.html?fakecam) กับเซิร์ฟเวอร์จริง — เน็ตช้า · รีสตาร์ท · ปิดหน้าต่างกลางคลิป
 *
 *   docker build -f Dockerfile.e2e -t packvideo-e2e .
 *   docker run --rm --network <net> -e E2E_MONGO_URL=mongodb://<mongo>:27017/packvideo_e2e packvideo-e2e \
 *     node scripts/e2e-recorder-browser.mjs [ชื่อเคส ...]
 *
 * สคริปต์เปิดเซิร์ฟเวอร์เองเป็น process ลูก (ฆ่า/รีสตาร์ทได้) และ proxy ที่หน่วงการส่งชิ้นภาพ
 * เพื่อจำลองเน็ตขาขึ้นของคลังที่ช้า (2026-10-01 ชิ้นละ 15–40 วินาที) · หน้าต่างอัดเข้าทาง proxy
 * ส่วนสัญญาณจาก hook.js และการอ่านผลยิงตรงเข้าเซิร์ฟเวอร์ · ลบทั้งฐานตอนจบ จึงไม่ยอมรันกับฐาน packVideo
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import puppeteer from 'puppeteer-core';

const MONGO_URL = process.env.E2E_MONGO_URL;
if (!MONGO_URL) {
  console.error('ต้องตั้ง E2E_MONGO_URL ให้ชี้ฐานทดสอบ (สคริปต์ลบทั้งฐานตอนจบ)');
  process.exit(2);
}
const DB_NAME = new URL(MONGO_URL).pathname.slice(1) || 'packvideo_e2e';
if (/^packvideo$/i.test(DB_NAME)) {
  console.error(`ไม่รันกับฐาน ${DB_NAME} — ใช้ชื่อฐานทดสอบแยก`);
  process.exit(2);
}

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const PORT = 13396;
const PROXY_PORT = 13395;
const API = `http://127.0.0.1:${PORT}`;
const PAGE = `http://127.0.0.1:${PROXY_PORT}`;
const STATION = 'desk-01';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m'} ${name}${detail ? `  \u001b[2m${detail}\u001b[0m` : ''}`);
}

// ── เซิร์ฟเวอร์ (process ลูก) ──────────────────────────────────
let server = null;
let serverLog = [];
let store = null;

async function bootServer(env = {}) {
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), MONGO_URL, MONGO_DB: DB_NAME,
      PACK_VIDEO_PATH: store, SELLCENTER_JWT_SECRET: '', TELEGRAM_BOT_TOKEN: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [server.stdout, server.stderr]) s.on('data', (d) => serverLog.push(String(d)));
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${API}/api/health`);
      if (r.ok && (await r.json()).checks?.mongo?.connected) return;
    } catch { /* ยังไม่ขึ้น */ }
    await sleep(100);
  }
  throw new Error('เซิร์ฟเวอร์ไม่ขึ้น');
}

async function killServer() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGKILL');
  await new Promise((r) => s.once('exit', r));
}

// ── proxy หน่วงชิ้นภาพ (ชิ้นที่ 1 ขึ้นไป) — ทางเดียวที่หน้าต่างอัดคุยกับเซิร์ฟเวอร์ ──
const proxy = { delayMs: 0, uploads: [], log: [], blockStream: false, streams: new Set(), pages: {} };
const proxyServer = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (d) => parts.push(d));
  req.on('end', () => {
    // หน้าจำลองหน้าแพ็คของ sellcenter (โหลด hook.js จาก origin เดียวกับ proxy เหมือนหน้าจริงโหลดจาก pack.)
    if (req.url.startsWith('/__test/') && proxy.pages[req.url]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(proxy.pages[req.url]);
      return;
    }
    const body = Buffer.concat(parts);
    const m = /\/api\/clip\/([^/]+)\/chunk\/(\d+)$/.exec(req.url);
    if (process.env.DEBUG && !m) proxy.log.push(`${new Date().toISOString().slice(14, 23)} ${req.method} ${req.url}`);
    const delay = req.method === 'PUT' && m && Number(m[2]) >= 1 ? proxy.delayMs : 0;
    const isStream = req.url.startsWith('/api/stream/');
    // จำลองหน้าต่างอัดหลุด SSE (เน็ตสะดุดเฉพาะสายนี้) — ตัดสายที่เปิดอยู่และไม่ให้ต่อใหม่จนกว่าจะปลด
    if (isStream && proxy.blockStream) { res.writeHead(502); res.end(); return; }
    if (isStream) { proxy.streams.add(res); res.on('close', () => proxy.streams.delete(res)); }
    setTimeout(() => {
      const headers = { ...req.headers, host: `127.0.0.1:${PORT}`, 'content-length': body.length };
      const p = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers }, (pr) => {
        if (m && req.method === 'PUT') proxy.uploads.push({ clip: m[1], seq: Number(m[2]), status: pr.statusCode, at: Date.now() });
        res.writeHead(pr.statusCode, pr.headers);
        pr.pipe(res);
        // เซิร์ฟเวอร์ตายกลางสาย (เช่น SSE) — nginx ปิดฝั่งเบราว์เซอร์ทันที ("upstream prematurely closed")
        // ถ้าไม่ปิดตาม เบราว์เซอร์ค้างอยู่กับสายที่ตายแล้วจน watchdog ตัด ซึ่งไม่ใช่สิ่งที่เกิดบน production
        pr.on('aborted', () => res.destroy());
        pr.on('error', () => res.destroy());
      });
      // เซิร์ฟเวอร์ดับ = แบบเดียวกับ nginx ตอบ 502
      p.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); });
      p.end(body);
    }, delay);
  });
});

// ── หน้าต่างอัด ───────────────────────────────────────────────
let browser = null;

async function openRecorder() {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  // ค่าที่หน้าตั้งค่า (setup.html) เขียนไว้ให้ — ไม่มี client_id จะจองโต๊ะไม่ได้
  await page.evaluateOnNewDocument((st) => {
    localStorage.setItem('packvideo.station_id', st);
    if (!localStorage.getItem('packvideo.client_id')) localStorage.setItem('packvideo.client_id', 'e2e-' + Date.now());
    localStorage.setItem('packvideo.device_name', 'e2e-browser');
  }, STATION);
  await page.goto(`${PAGE}/rec.html?fakecam`, { waitUntil: 'load' });
  const ready = await waitFor(async () => {
    const s = (await api('/api/stations')).stations.find((x) => x.station_id === STATION);
    return s?.listening && s?.camera_ready ? s : null;
  }, 15_000);
  if (!ready) {
    const s = (await api('/api/stations')).stations.find((x) => x.station_id === STATION);
    throw new Error(`หน้าต่างอัดไม่พร้อม · ${JSON.stringify(s)} · ${page.url()} · ${logs.slice(-6).join(' | ')}`);
  }
  return { page, logs };
}

// ── สัญญาณจาก hook.js และการอ่านผลผ่าน API ─────────────────────
const signal = (fields) =>
  fetch(`${API}/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: 'e2e', station_id: STATION, ...fields }),
  });
const api = async (p) => (await fetch(`${API}${p}`)).json();
const clip = async (id) => (await api(`/api/clips/${id}`)).clip ?? null;
const CLOSED = ['verified', 'registered', 'manual_stop', 'unverified', 'timeout', 'aborted'];

async function waitFor(fn, ms = 10_000, step = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}

/** สแกน IMEI → ยืนยันออเดอร์ → ผูกเลขพัสดุ เหมือนพนักงานแพ็คหนึ่งกล่อง · คืน clip_id */
async function beginOrder(ordersn) {
  await signal({ event: 'start', trace_id: ordersn, value: `3569380356${String(Math.random()).slice(2, 7)}` });
  await signal({ event: 'commit', trace_id: ordersn, ordersn });
  const c = await waitFor(async () => (await api('/api/clips')).clips.find((x) => x.ordersn === ordersn));
  await signal({ event: 'tag', tracking_no: `SPX${ordersn}` });
  return c.clip_id;
}
const scanClose = (ordersn) => signal({ event: 'scan', value: `SPX${ordersn}` });

/** ดึงไฟล์ผ่าน /media (ทางเดียวกับที่ทีมเคลมเปิดดู) แล้ววัดความยาววิดีโอที่เล่นได้จริงด้วย ffprobe */
async function playableSec(id) {
  const r = await fetch(`${API}/media/${id}`);
  if (!r.ok) return 0;
  const f = path.join(store, `dl-${id}.mp4`);
  await fs.writeFile(f, Buffer.from(await r.arrayBuffer()));
  try {
    const { stdout } = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]);
    return Math.round(Number.parseFloat(stdout) * 10) / 10 || 0;
  } catch { return 0; }
}

/** รอจนคลิปปิดและต่อไฟล์เสร็จ — สถานะเปลี่ยนก่อนต่อไฟล์เสร็จเล็กน้อย อ่านตอนนั้นจะได้ 0 ไบต์ */
async function settled(id, ms = 120_000) {
  return waitFor(async () => {
    const c = await clip(id);
    const done = c && CLOSED.includes(c.status) && (c.media_path || c.status === 'aborted' || c.flags.includes('empty'));
    return done ? c : null;
  }, ms, 300);
}

// ── เคส ───────────────────────────────────────────────────────
/** หน้าแพ็คจำลองที่โหลด hook.js — station/token/เลขพัสดุที่รอ ใส่ไว้ก่อนเหมือนเครื่องที่ตั้งค่าแล้วและเพิ่งพิมพ์ใบปะหน้า */
async function openHookPage(url, station) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument((st) => {
    localStorage.setItem('packvideo.station_id', st);
    localStorage.setItem('packvideo.token', 'e2e');
    localStorage.setItem('packvideo.expect', JSON.stringify({ v: 'SPXHOOK1', at: Date.now() }));
    localStorage.setItem('packvideo.rec_opened', '1');
  }, station);
  await page.goto(`${PAGE}${url}`, { waitUntil: 'load' });
  await sleep(2000);
  return page;
}

const CASES = {
  /**
   * hook.js ต้องรายงาน "หาป้ายไม่เจอ" เฉพาะเมื่อหน้ามีป้าย Imei อยู่จริงแต่หาตำแหน่งไม่เจอ (โครงสร้างหน้าเปลี่ยน)
   * หน้า Shopee Express / ส่งของ KOL ไม่มีป้าย Imei ตั้งแต่แรก — เดิมรายงานทุกครั้ง monitor เตือนรัว 38–48 ครั้ง/ชม.
   */
  async hook_label_warning_only_when_label_exists() {
    const head = '<!doctype html><meta charset="utf-8"><span id="lblUser">e2e</span>';
    const tail = '<script async src="/hook.js"></script>';
    proxy.pages['/__test/normal.html'] = `${head}<table><tr><th>Imei</th><td><input id="txt_imei"></td></tr></table>${tail}`;
    proxy.pages['/__test/express.html'] = `${head}<table><tr><td><input id="txt_imei"></td></tr></table>${tail}`;
    proxy.pages['/__test/moved.html'] = `${head}<h3>Imei</h3><p>สแกนด้านล่าง</p><section><div><input id="txt_imei"></div></section>${tail}`;

    const pn = await openHookPage('/__test/normal.html', 'desk-01');
    const label = await pn.$eval('th', (el) => el.textContent);
    await openHookPage('/__test/express.html', 'desk-02');
    await openHookPage('/__test/moved.html', 'desk-03');
    await sleep(1000);
    const keys = ((await api('/api/monitor')).findings ?? []).map((f) => f.key);
    check('hook · หน้าปกติเปลี่ยนป้ายเป็น "เลขพัสดุ" ไม่รายงาน', label === 'เลขพัสดุ' && !keys.includes('ui:desk-01'), `ป้าย "${label}"`);
    check('hook · หน้าที่ไม่มีป้าย Imei (Shopee Express/KOL) ไม่รายงานว่าหาไม่เจอ', !keys.includes('ui:desk-02'), keys.join(','));
    check('hook · หน้าที่มีป้าย Imei แต่ย้ายที่ ยังรายงาน', keys.includes('ui:desk-03'), keys.join(','));
  },

  /**
   * ข้อ 7 · production: ไฟล์ของหน้าต่างอัดต้องถูกตรวจใหม่ทุกครั้งที่โหลด (หน้าต่างอัดรีเฟรชเองหลัง deploy)
   * ถ้าแคช 5 นาที รีโหลดแล้วได้ rec.html รุ่นใหม่แต่ chunk-queue.js รุ่นเก่าจากแคช — คิวผิดรุ่นโดยไม่มีใครรู้
   */
  async recorder_assets_revalidate() {
    await killServer();
    await bootServer({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://example.test' });
    for (const f of ['rec.html', 'chunk-queue.js', 'session.js', 'camtest.js', 'panel.js']) {
      const cc = (await fetch(`${API}/${f}`)).headers.get('cache-control') ?? '';
      check(`7 · ${f} ตรวจใหม่ทุกครั้ง (no-cache)`, /no-cache|no-store/.test(cc), cc);
    }
    // hook.js อยู่ในหน้าแพ็คที่โหลดบ่อยมาก ตั้งใจให้แคชได้ — ต้องไม่เปลี่ยน
    const hook = (await fetch(`${API}/hook.js`)).headers.get('cache-control') ?? '';
    check('7 · hook.js ยังแคชได้ 5 นาที', /max-age=300/.test(hook), hook);
  },

  /**
   * ข้อ 2 · เซิร์ฟเวอร์รีสตาร์ท (deploy/crash) ระหว่างอัดและคิวยังค้าง
   * หน้าต่างอัดเก็บชิ้นไว้ในเครื่องระหว่างเซิร์ฟเวอร์ดับ เซิร์ฟเวอร์ใหม่รับคลิปกลับมา แล้วสแกนปิดได้ตามปกติ
   */
  async restart_mid_clip_keeps_video() {
    const { page, logs } = await openRecorder();
    proxy.delayMs = 6000;
    const tStart = Date.now();
    const c = await beginOrder('RST-A');
    await sleep(10_000);
    await killServer();                                   // ดับระหว่างอัด — ชิ้นที่ส่งช่วงนี้ได้ 502 แล้วรอส่งใหม่
    await sleep(6000);
    await bootServer();
    await sleep(6000);
    await scanClose('RST-A');
    const tScan = Date.now();
    const done = await settled(c, 150_000);
    const sec = await playableSec(c);
    const dropped = proxy.uploads.filter((u) => u.clip === c && u.status === 409).length;
    check('2 · ไม่มีชิ้นโดน 409 ทิ้ง', dropped === 0, `409 ${dropped} ครั้ง`);
    check('2 · สแกนปิดหลังรีสตาร์ทได้ verified ครบ', done?.status === 'verified' && !done.flags.includes('incomplete')
      && done.flags.includes('server_restart'), `${done?.status} · ${done?.chunks} ชิ้น ${JSON.stringify(done?.flags)}`);
    // อัดทั้งหมด ~22 วิ (10 ก่อนดับ + 6 ตอนดับ + 6 หลังบูต) — ต้องได้ครบรวมช่วงที่เซิร์ฟเวอร์ดับ
    check('2 · วิดีโอเล่นได้ครบรวมช่วงที่เซิร์ฟเวอร์ดับ', sec >= 20, `เล่นได้ ${sec} วิ`);
    // สัญญาณหยุดตอนสแกนปิดอาจไปไม่ถึงเพราะหน้าต่างอัดยังต่อ SSE กลับไม่ทัน — ต้องได้รับเมื่อต่อกลับมาไม่นาน
    // ไม่ใช่อัดเลยไปอีกครึ่งนาที (ระหว่างนั้นสัญญาณเริ่มของออเดอร์ใหม่ก็ไปไม่ถึง = ออเดอร์ใหม่ไม่มีวิดีโอ)
    // วัดจากความยาววิดีโอเทียบเวลาที่สแกนปิด · เวลาปิดไฟล์บนเซิร์ฟเวอร์ยาวได้ตามคิวที่ค้าง (รอชิ้นครบถูกแล้ว)
    const untilScan = Math.round((tScan - tStart) / 1000);
    check('2 · หยุดอัดไม่นานหลังสแกนปิด แม้สัญญาณหยุดไปถึงตอนต่อ SSE กลับมา', sec <= untilScan + 8,
      `สแกนปิดที่วินาทีที่ ${untilScan} · วิดีโอยาว ${sec} วิ`);
    if (process.env.DEBUG) {
      for (const l of proxy.log.filter((x) => /stream|finalise|claim/.test(x))) console.log('  [proxy]', l);
      for (const l of logs) console.log('  [page]', l);
      for (const l of serverLog.join('').split('\n')) {
        if (!l.includes(c) && !/stream\/desk/.test(l)) continue;
        try { const j = JSON.parse(l); console.log('  [srv]', new Date(j.time).toISOString().slice(14, 23), j.msg, j.req?.method ?? '', j.req?.url ?? '', j.res?.statusCode ?? ''); } catch {}
      }
    }
    await page.close();
  },

  /**
   * ข้อ 2 (ต่อ) · สแกนปิดตอนหน้าต่างอัดหลุด SSE อยู่ — สัญญาณหยุดต้องถูกส่งซ้ำเมื่อต่อกลับมา
   * ไม่งั้นหน้าต่างอัดอัดคลิปเดิมต่อไปจนเซิร์ฟเวอร์ปิดเองที่เพดาน แล้วภาพหลังจากนั้นโดน 409 ทิ้ง
   */
  async stop_replayed_after_reconnect() {
    const { page } = await openRecorder();
    const tStart = Date.now();
    const c = await beginOrder('RPL-A');
    await sleep(8000);
    proxy.blockStream = true;
    for (const r of proxy.streams) r.destroy();
    await sleep(1000);
    await scanClose('RPL-A');                             // stop ส่งไม่ถึงใคร
    const tScan = Date.now();
    await sleep(6000);
    proxy.blockStream = false;                            // หน้าต่างอัดต่อกลับได้ภายใน ~3 วิ
    const done = await settled(c, 150_000);
    const sec = await playableSec(c);
    const untilScan = Math.round((tScan - tStart) / 1000);
    check('2 · สแกนปิดตอนหลุด SSE → ปิดคลิปครบ verified', done?.status === 'verified' && !done.flags.includes('incomplete'),
      `${done?.status} · ${done?.chunks} ชิ้น ${JSON.stringify(done?.flags)}`);
    // หลุดอยู่ 6 วิหลังสแกน + ต่อใหม่ไม่เกิน 3 วิ — วิดีโอยาวเกินจุดสแกนได้ไม่เกินช่วงนั้น
    check('2 · หยุดอัดเมื่อต่อ SSE กลับมา ไม่อัดเลยไปถึงเพดาน', sec <= untilScan + 12,
      `สแกนปิดที่วินาทีที่ ${untilScan} · วิดีโอยาว ${sec} วิ`);
    await page.close();
  },

  /**
   * ข้อ 3 · รีเฟรช/ปิดหน้าต่างอัดกลางคลิประหว่างที่คิวยังค้าง (เช่นกดแถบแดง "เปิดหน้าต่างอัดใหม่")
   * ชิ้นที่ค้างอยู่ในเครื่องต้องถูกส่งต่อจนครบเมื่อหน้าต่างอัดเปิดขึ้นมาใหม่ ไม่ใช่โดน 409 แล้วทิ้ง
   */
  async reload_mid_clip_keeps_video() {
    const { page } = await openRecorder();
    proxy.delayMs = 10_000;
    const c = await beginOrder('RLD-A');
    await sleep(16_000);
    await page.reload({ waitUntil: 'load' });           // beforeunload → detach แล้วหน้าใหม่ส่งคิวที่ค้างต่อ
    const done = await settled(c, 150_000);
    const sec = await playableSec(c);
    const dropped = proxy.uploads.filter((u) => u.clip === c && u.status === 409).length;
    check('3 · ชิ้นที่ค้างตอนรีเฟรชไม่โดน 409', dropped === 0, `409 ${dropped} ครั้ง`);
    // ชิ้นที่กำลังอัดอยู่ตอนหน้าปิดหายไปกับหน้าเว็บ (Chromium ตัดชิ้นทุก ~5 วิ) — ที่เหลือต้องมาครบทุกชิ้น
    check('3 · ชิ้นที่ลงเครื่องแล้วมาครบ (ไม่ incomplete)', !!done && !done.flags.includes('incomplete'), JSON.stringify(done?.flags));
    check('3 · วิดีโอเล่นได้ถึงจุดที่รีเฟรช (เสียไม่เกินชิ้นสุดท้าย)', sec >= 10,
      `${done?.status} · ${done?.chunks} ชิ้น · อัด 16 วิ เล่นได้ ${sec} วิ`);
    check('3 · ปิดคลิปเป็น unverified (หน้าต่างอัดถูกปิดกลางคลิป)', done?.status === 'unverified', done?.status);
    await page.close();
  },

  /**
   * ข้อ 3 (ต่อ) · รีเฟรชหน้าต่างอัดทันทีหลังสแกนปิด ก่อนหน้าต่างอัดสั่งปิดคลิปพร้อมจำนวนชิ้น (~0.6 วิ)
   * คลิปนั้นไม่ใช่ "คลิปที่กำลังอัด" แล้วแต่ยังไม่ได้บอกจำนวนชิ้น — detach ต้องบอกจำนวนชิ้นของมันด้วย
   */
  async reload_right_after_scan() {
    const { page } = await openRecorder();
    proxy.delayMs = 10_000;
    const c = await beginOrder('RLS-A');
    await sleep(15_000);
    await scanClose('RLS-A');
    await sleep(150);                                     // stop ถึงหน้าต่างอัดแล้ว แต่ยังไม่ถึง 600 มิลลิวินาทีที่จะสั่งปิด
    await page.reload({ waitUntil: 'load' });
    const done = await settled(c, 180_000);
    const sec = await playableSec(c);
    const dropped = proxy.uploads.filter((u) => u.clip === c && u.status === 409).length;
    check('3 · รีเฟรชทันทีหลังสแกนปิด → ชิ้นที่ค้างไม่โดน 409', dropped === 0, `409 ${dropped} ครั้ง`);
    check('3 · รีเฟรชทันทีหลังสแกนปิด → ปิดครบ verified', done?.status === 'verified' && !done.flags.includes('incomplete'),
      `${done?.status} · ${done?.chunks} ชิ้น ${JSON.stringify(done?.flags)}`);
    // อัด 15 วิ แล้วชิ้นที่กำลังอัดตอนรีเฟรชหายไปกับหน้าเว็บ (~5 วิ)
    check('3 · รีเฟรชทันทีหลังสแกนปิด → เล่นได้ถึงจุดที่รีเฟรช', sec >= 10, `อัด 15 วิ เล่นได้ ${sec} วิ`);
    await page.close();
  },

  /**
   * ข้อ 1 · คิวค้างชิ้นของออเดอร์ก่อนหน้าแล้วสแกนออเดอร์ใหม่ — ต้องไม่เตือน "ไม่ได้บันทึก"
   * เพราะหน้าต่างอัดเริ่มอัดแล้วจริง (เตือนผิดทำให้พนักงานกดเปิดหน้าต่างอัดใหม่ แล้ววิดีโอหายเอง)
   */
  async header_jumps_backlog() {
    const { page } = await openRecorder();
    // ชิ้นละ ~5 วิ ส่งชิ้นละ 10 วิ → ตอนออเดอร์ใหม่เริ่ม คิวยังค้างชิ้นของออเดอร์แรก 20 วินาทีขึ้นไป
    proxy.delayMs = 10_000;
    const a = await beginOrder('HDR-A');
    await sleep(16_000);
    await scanClose('HDR-A');
    await sleep(1500);
    const b = await beginOrder('HDR-B');
    await sleep(9000);                                   // เลย NO_VIDEO_ALERT_SEC (8)
    const desk = await api(`/api/desk/${STATION}`);
    const backlog = proxy.uploads.filter((u) => u.clip === a).length;
    check('1 · ออเดอร์ใหม่ระหว่างคิวค้าง → ไม่เตือนว่าไม่ได้บันทึก', desk.video_ok !== false,
      `video_ok=${desk.video_ok} ${desk.video_problem_text ?? ''} · ตอนนี้ส่งชิ้นของออเดอร์แรกไปแล้ว ${backlog} ชิ้น`);
    await sleep(4000);
    await scanClose('HDR-B');
    const [ca, cb] = [await settled(a), await settled(b)];
    const [sa, sb] = [await playableSec(a), await playableSec(b)];
    // อัดออเดอร์แรก ~16 วิ และออเดอร์ใหม่ ~13 วิ (9 + 4) — ไฟล์ต้องเล่นได้เกือบเต็มเวลา ไม่ใช่แค่มีไบต์
    check('1 · ออเดอร์ก่อนหน้าได้ครบ เล่นได้เต็ม', ca?.status === 'verified' && !ca.flags.includes('incomplete') && sa >= 14,
      `${ca?.status} · ${ca?.chunks} ชิ้น · เล่นได้ ${sa} วิ ${JSON.stringify(ca?.flags)}`);
    check('1 · ออเดอร์ใหม่ได้ครบ เล่นได้เต็ม', cb?.status === 'verified' && !cb.flags.includes('incomplete') && sb >= 11,
      `${cb?.status} · ${cb?.chunks} ชิ้น · เล่นได้ ${sb} วิ ${JSON.stringify(cb?.flags)}`);
    await page.close();
  },
};

// ── รัน ────────────────────────────────────────────────────────
const only = process.argv.slice(2);
const client = await MongoClient.connect(MONGO_URL);
const db = client.db(DB_NAME);
await new Promise((r) => proxyServer.listen(PROXY_PORT, r));
browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  for (const [name, fn] of Object.entries(CASES)) {
    if (only.length && !only.includes(name)) continue;
    console.log(`\n── ${name}`);
    await db.dropDatabase();
    store = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-rec-'));
    serverLog = [];
    proxy.delayMs = 0;
    proxy.uploads = [];
    try {
      await bootServer();
      await fn();
    } catch (err) {
      check(`${name} ทำงานจนจบ`, false, err.message);
      console.error(serverLog.join('').slice(-2000));
    } finally {
      await killServer();
      await fs.rm(store, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  proxyServer.close();
  await db.dropDatabase().catch(() => {});
  await client.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน\n`);
process.exit(failed.length ? 1 : 0);
