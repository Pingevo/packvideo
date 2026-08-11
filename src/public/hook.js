/**
 * hook.js — สคริปต์ที่หน้าแพ็คของ sellcenter โหลด
 *
 *   <script async src="https://packvideo.digital.in.th/hook.js"></script>
 *
 * หน้าที่เดียว: ยิงสัญญาณบอกว่าเกิดอะไรขึ้นที่โต๊ะ **แล้วไม่รอคำตอบ**
 * ห้ามทำให้หน้าแพ็คช้าลงหรือพังไม่ว่ากรณีใด (NFR-1.1)
 *
 * จุดเกาะหลักคือการเรียก AJAX ไม่ใช่ DOM id — ดู design.md D1
 */
(function () {
  'use strict';

  var API_PATH = '/shopee/imei/get_order_new';   // จุดเกาะหลัก: สัญญาของ API ไม่ใช่โครงสร้างหน้า
  var DEDUPE_MS = 2000;
  var VERSION = '0.1.0';

  // ── หา origin ของระบบวิดีโอจาก src ของตัวเอง ────────────────
  var self = document.currentScript;
  if (!self) {
    var tags = document.getElementsByTagName('script');
    for (var i = tags.length - 1; i >= 0; i--) {
      if (tags[i].src && tags[i].src.indexOf('hook.js') !== -1) { self = tags[i]; break; }
    }
  }
  var BASE = self ? self.src.replace(/\/hook\.js.*$/, '') : '';

  var station = null, token = null;
  try {
    station = localStorage.getItem('packvideo.station_id');
    token = localStorage.getItem('packvideo.token');
  } catch (e) { /* localStorage ถูกปิด — ทำงานต่อไม่ได้ แต่ต้องไม่ throw */ }

  // ── ส่งสัญญาณ ───────────────────────────────────────────────
  var recent = {};

  function beacon(event, fields) {
    try {
      if (!BASE || !station || !token) return;

      // กันยิงซ้ำจากชั้นหลักกับชั้นสำรองที่ทำงานพร้อมกัน
      //
      // `scan` ต้องกันซ้ำด้วยค่าที่สแกนอย่างเดียว ห้ามรวม trace_id เข้าไป
      // เพราะเราดักทั้ง keydown และ keyup ซึ่งสร้าง trace_id คนละตัว
      // ถ้ารวมเข้าไปจะได้สัญญาณซ้ำสองครั้งต่อการสแกนหนึ่งครั้ง
      var key = event === 'scan'
        ? 'scan|' + (fields.value || '')
        : event + '|' + (fields.trace_id || '') + '|' + (fields.value || '');
      var now = Date.now();
      if (recent[key] && now - recent[key] < DEDUPE_MS) return;
      recent[key] = now;
      for (var k in recent) { if (now - recent[k] > 30000) delete recent[k]; }

      var body = new URLSearchParams();
      body.set('t', token);
      body.set('station_id', station);
      body.set('event', event);
      body.set('v', VERSION);
      for (var f in fields) {
        if (fields[f] !== undefined && fields[f] !== null) body.set(f, String(fields[f]));
      }

      // sendBeacon = ยิงแล้วไม่รอ · form-encoded = simple request ไม่มี preflight
      // คืน false เมื่อคิวเต็ม — ไม่ retry เพราะหน้ากำลังจะ navigate อยู่แล้ว
      if (navigator.sendBeacon) {
        navigator.sendBeacon(BASE + '/signal', body);
      }
    } catch (e) { swallow(e); }
  }

  function swallow(e) {
    try { if (window.console && console.debug) console.debug('[packvideo]', e && e.message); } catch (e2) {}
  }

  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return 'x-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ── ตัดสินจากคำตอบของ API ว่าจะเก็บคลิปหรือทิ้ง ──────────────
  // ตรรกะอยู่ที่นี่ไม่ใช่ใน sellcenter จึงปรับจูนช่วง pilot ได้โดยไม่ต้อง deploy ระบบเดิม
  function decide(r) {
    if (!r || typeof r !== 'object') return { event: 'abort', reason: 'ตอบกลับไม่ใช่วัตถุ' };
    if (r.is_low_price === true) return { event: 'abort', reason: 'low_price' };
    if (r.ordersn === null || r.ordersn === undefined || r.ordersn === '') {
      return { event: 'abort', reason: 'not_found' };
    }
    if (r.is_cancelled === true) return { event: 'commit', flag: 'cancelled' };
    // imei_complete = false ก็ COMMIT และอัดต่อ เพราะเป็นออเดอร์เดียวกันที่สแกนหลายชิ้น
    return { event: 'commit' };
  }

  function fieldFrom(data, name) {
    try {
      if (typeof data === 'string') {
        var m = new RegExp('(?:^|&)' + name + '=([^&]*)').exec(data);
        return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
      }
      if (data && typeof data === 'object') return data[name] != null ? String(data[name]) : null;
    } catch (e) { swallow(e); }
    return null;
  }

  var ctx = { trace_id: null, at: 0 };

  function onScan(value, user) {
    ctx = { trace_id: uuid(), at: Date.now() };
    // START ที่จังหวะกด Enter ไม่ใช่ตอน API ตอบ — ช่วง "กล่องยังว่าง" คือเงื่อนไขหลักฐานข้อ 1
    // และโค้ดเดิมตั้ง timeout ไว้ถึง 10 วินาที แปลว่าเคยเจอกรณี API ช้าจริง
    beacon('start', { trace_id: ctx.trace_id, value: value, user: user });
  }

  function onResult(result) {
    if (!ctx.trace_id) return;
    var d = decide(result);
    beacon(d.event, {
      trace_id: ctx.trace_id,
      ordersn: result && result.ordersn,
      reason: d.reason,
      flag: d.flag,
      imei_complete: result && result.imei_complete,
    });
    ctx = { trace_id: null, at: 0 };
  }

  // ── ชั้นหลัก: ดักการเรียก AJAX ──────────────────────────────
  // ไม่พึ่ง #txt_imei หรือชื่อฟังก์ชัน get_airway() — เกาะกับสัญญาของ API ที่ประกาศแล้วว่าไม่แตะ
  function bindAjax() {
    try {
      var $ = window.jQuery;
      if (!$ || !$.fn) return false;

      $(document).ajaxSend(function (e, xhr, opts) {
        try {
          if (!opts || String(opts.url).indexOf(API_PATH) === -1) return;
          onScan(fieldFrom(opts.data, 'imei'), fieldFrom(opts.data, 'user'));
        } catch (err) { swallow(err); }
      });

      $(document).ajaxSuccess(function (e, xhr, opts, data) {
        try {
          if (!opts || String(opts.url).indexOf(API_PATH) === -1) return;
          onResult(data);
        } catch (err) { swallow(err); }
      });

      // API ล่ม/หมดเวลา = ไม่มีคลิปที่ใช้ได้ ต้องทิ้ง ไม่ปล่อยค้าง
      $(document).ajaxError(function (e, xhr, opts) {
        try {
          if (!opts || String(opts.url).indexOf(API_PATH) === -1) return;
          if (ctx.trace_id) {
            beacon('abort', { trace_id: ctx.trace_id, reason: 'api_error' });
            ctx = { trace_id: null, at: 0 };
          }
        } catch (err) { swallow(err); }
      });

      return true;
    } catch (err) { swallow(err); return false; }
  }

  // ── ชั้นสำรอง: ดักการกด Enter ที่ช่องสแกน ───────────────────
  // ทำงานพร้อมชั้นหลัก กันซ้ำด้วย dedupe — ถ้าวันหนึ่งหน้าเดิมเลิกใช้ jQuery ยังมีตัวนี้เหลือ
  //
  // **ต้องดักที่ keyup ไม่ใช่แค่ keydown** — หน้าจริงผูก validate() ไว้กับ
  // onkeyup="validate(this, event)" ที่ #txt_imei การเรียก preventDefault ตอน keydown
  // ไม่หยุด keyup ที่ตามมา การดักเลขพัสดุจึงจะไม่ทำงานเลยถ้าดักผิดจังหวะ
  //
  // ตัวรับแบบ capture ที่ document ทำงานก่อน handler ที่ตัว element เสมอ
  // stopImmediatePropagation จึงหยุด onkeyup ของหน้าเดิมได้จริง
  function bindKey() {
    ['keydown', 'keyup'].forEach(function (type) {
      document.addEventListener(type, function (ev) {
        try {
          if (ev.keyCode !== 13 && ev.key !== 'Enter') return;
          var el = ev.target;
          if (!el || el.tagName !== 'INPUT' || el.id !== 'txt_imei') return;

          var value = (el.value || '').trim();
          if (!value) return;

          if (isTrackingLike(value)) {
            // ค่านี้ไม่ใช่ IMEI — ถ้าปล่อยให้หน้าเดิมยิง API จะเด้งไปหน้า not_found ทุกออเดอร์
            // ดูหมายเหตุเรื่องนี้ใน docs/design.md §4.2.1
            if (INTERCEPT_TRACKING) {
              ev.preventDefault();
              ev.stopImmediatePropagation();
              // เคลียร์ช่องตอน keyup เท่านั้น ถ้าเคลียร์ตอน keydown ค่าจะหายไป
              // ก่อนที่ keyup จะได้อ่าน แล้วเราจะดักตัวที่สองไม่ทัน
              if (type === 'keyup') el.value = '';
            }
            beacon('scan', { value: value, trace_id: uuid() });
            return;
          }

          // ปล่อยให้หน้าเดิมทำงานตามปกติ ชั้นหลักจะจับตอนมันยิง AJAX
          // ยิง start จากที่นี่ด้วยเผื่อ jQuery ไม่อยู่ — dedupe จะตัดตัวซ้ำทิ้งเอง
          if (!hasJquery && type === 'keyup') onScan(value, userName());
        } catch (err) { swallow(err); }
      }, true);   // capture — ต้องได้ก่อน handler ของหน้าเดิม
    });
  }

  // เลขพัสดุมีตัวอักษรนำ (SPX… TH…) ส่วน IMEI เป็นตัวเลขล้วน 15 หลัก
  // ชั้นนี้แค่คัดหยาบๆ การตัดสินจริงว่าตรงกับคลิปที่กำลังอัดไหม ทำที่เซิร์ฟเวอร์
  function isTrackingLike(v) {
    var cleaned = v.replace(/[\s/-]/g, '');
    if (/^\d{15}$/.test(cleaned)) return false;          // IMEI
    if (/^\d+$/.test(cleaned)) return false;             // ตัวเลขล้วนความยาวอื่น ปล่อยให้ระบบเดิมตัดสิน
    return /[A-Za-z]/.test(cleaned) && cleaned.length >= 8;
  }

  function userName() {
    try {
      var el = document.getElementById('lblUser');
      return el ? (el.textContent || '').trim() : null;
    } catch (e) { return null; }
  }

  // ── หน้าใบปะหน้า: เก็บเลขพัสดุ ──────────────────────────────
  // อ่านหลัง DOMContentLoaded เพราะสคริปต์นี้โหลดแบบ async จึงรับประกันลำดับกับ
  // arr_tracking.push(...) ที่ฝังอยู่ inline ไม่ได้ — แต่ตอน DOM พร้อม มันถูกเติมครบแล้วเสมอ
  function readTracking() {
    try {
      var list = window.arr_tracking;
      if (list && list.length) {
        return String(list[list.length - 1]).trim() || null;
      }
      // สำรอง: หน้าใบปะหน้าสร้าง <svg id="svg_{tracking_no}"> ไว้สำหรับวาดบาร์โค้ด
      var svgs = document.querySelectorAll('[id^="svg_"]');
      if (svgs.length) return svgs[svgs.length - 1].id.slice(4) || null;
    } catch (e) { swallow(e); }
    return null;
  }

  function onLabelPage() {
    var tracking = readTracking();
    // ยิง tag เสมอแม้หาเลขไม่เจอ — ตัวนับนี้คือตัวหารของ health check (design D6)
    // ถ้าไม่ยิงตอนหาไม่เจอ ปัญหาจะกลายเป็นมองไม่เห็นแทนที่จะขึ้นเป็นตัวเลข
    beacon('tag', {
      trace_id: uuid(),
      tracking_no: tracking,
      user: userName(),
      ok: tracking ? '1' : '0',
    });
  }

  function isLabelPage() {
    try {
      return !!(window.arr_tracking || document.querySelector('[id^="svg_"]'));
    } catch (e) { return false; }
  }

  // ── เริ่มทำงาน ──────────────────────────────────────────────
  var INTERCEPT_TRACKING = true;
  var hasJquery = false;

  function boot() {
    try {
      hasJquery = bindAjax();
      bindKey();
      if (isLabelPage()) onLabelPage();
      if (!station || !token) {
        // ไม่ขัดจังหวะงาน แค่ให้เห็นว่าเครื่องนี้ยังไม่ได้ตั้งค่า
        try { console.warn('[packvideo] เครื่องนี้ยังไม่ได้ตั้ง station_id — ไม่มีการบันทึก'); } catch (e) {}
      }
    } catch (err) { swallow(err); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
