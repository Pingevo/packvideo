/**
 * hook.js — สคริปต์ที่หน้าแพ็คของ sellcenter โหลด
 *
 *   <script async src="https://pack.digital.in.th/hook.js"></script>
 *
 * หน้าที่เดียว: ยิงสัญญาณบอกว่าเกิดอะไรขึ้นที่โต๊ะ **แล้วไม่รอคำตอบ**
 * ห้ามทำให้หน้าแพ็คช้าลงหรือพังไม่ว่ากรณีใด (NFR-1.1)
 *
 * จุดเกาะหลักคือการเรียก AJAX ไม่ใช่ DOM id — ดู design.md D1
 */
(function () {
  'use strict';

  var API_PATH = '/shopee/imei/get_order_new';   // จุดเกาะหลัก: สัญญาของ API ไม่ใช่โครงสร้างหน้า

  /**
   * Lazada — คนละหน้าตากับ shopee: /lazada/imei ไม่เรียก get_order_new เลย
   * มันยิง check_low_price แล้ว redirect เต็มหน้าไป /lazada/imei/airway/... เสมอ
   * ไม่มี AJAX endpoint ไหนที่คืน ordersn ตรง ๆ ให้เกาะแบบ shopee ได้
   *
   * check_low_price ตอบ {found, is_low_price, is_clearance_low_price} ซึ่งพอจะแปลงเป็น
   * รูปที่ decide() ของ shopee เข้าใจได้อยู่แล้ว (found ทำหน้าที่แทน ordersn) จึงเกาะจุดนี้
   * แทน ไม่ต้องเขียน decide() ใหม่ซ้ำ — ยังไม่ครอบคลุมเคส "ราคาต่ำกว่าทุนแบบ clearance
   * แล้วพนักงานกด Cancel ที่ popup" เพราะ AJAX ตอบก่อน popup จะขึ้น รู้แค่ว่าเจอ imei
   * ไม่รู้ว่าสุดท้ายพนักงานกดไปต่อหรือไม่ — ยอมรับช่องว่างนี้ไว้ก่อน (เหมือน shopee เดิม)
   */
  var LAZ_CHECK_PATH = '/lazada/imei/check_low_price';

  function decideLazadaCheck(r) {
    if (!r || typeof r !== 'object') return { ordersn: null };
    // เลขออเดอร์จริงต้องมาจาก check_low_price เอง (field order_id) — ห้ามใส่ค่าคงที่
    // แทน เพราะ decide() เอาค่านี้ไปโชว์ตรงๆ บนหน้า rec.html ว่า "ออเดอร์: ..."
    // ถ้าใส่ placeholder คนหน้างานจะเห็นเลขเดียวกันซ้ำทุกคลิป ใช้ตรวจย้อนหลังไม่ได้เลย
    var found = r.found === true;
    return {
      ordersn: found && r.order_id != null ? String(r.order_id) : (found ? 'unknown' : null),
      is_low_price: r.is_low_price === true,
      is_cancelled: false,
    };
  }

  /**
   * Shopee Express — หน้า /shp/express/api/ship คนละ endpoint กับหน้า imei ปกติ
   * ยิง /shp/express/api/check_imei ไม่ใช่ /shopee/imei/get_order_new เลยไม่เคยเข้า
   * เงื่อนไข API_PATH ด้านบนสักครั้ง — response เป็น {success, order_sn, msg} ตรงๆ
   * อยู่แล้ว แค่เปลี่ยนชื่อ field ให้เข้ารูปที่ decide() เข้าใจ ไม่ต้องแต่งอะไรเพิ่ม
   */
  var EXPRESS_CHECK_PATH = '/shp/express/api/check_imei';

  function decideExpressCheck(r) {
    if (!r || typeof r !== 'object') return { ordersn: null };
    return {
      ordersn: r.success === true && r.order_sn != null ? String(r.order_sn) : null,
      is_low_price: false,
      is_cancelled: false,
    };
  }

  /**
   * งาน KOL — คนละจังหวะกับ shopee ทั้งหมด
   *
   *   shopee : ยิง IMEI 1 ครั้ง = 1 ออเดอร์ = 1 คลิป · ปิดด้วยการยิงเลขพัสดุ
   *   KOL    : ยิงหลายชิ้นลงกล่องเดียว เลขพัสดุมาตอนท้ายหลังกดลงทะเบียนจัดส่ง
   *            และ**ไม่มีขั้นตอนยิงเลขพัสดุปิดเลย**
   *
   * จึงเป็นหนึ่งคลิปต่อโปรเจกต์ — เริ่มตอนยิงชิ้นแรก อัดยาวคลุมทุกชิ้น ปิดตอน
   * ลงทะเบียนจัดส่งสำเร็จ ซึ่งเป็นจังหวะที่กล่องถูกปิดและได้เลขพัสดุจริง
   */
  var KOL_ADD_PATH = '/kol/shipping/add';
  var KOL_REGIS_PATH = '/kol/shipping/regis';
  // ปิดคลิปตรงนี้ ไม่ใช่ตอนลงทะเบียนจัดส่ง — หลังลงทะเบียนยังต้องพิมพ์ใบปะหน้า
  // แล้วแปะ แล้วถ่ายรูปกล่อง ซึ่งเป็นขั้นที่พิสูจน์ว่าใบไหนอยู่บนกล่องไหน
  var KOL_PHOTO_PATH = '/kol/shipping/save_image';
  var KOL_OPEN_KEY = 'packvideo.kol_open';
  var KOL_TTL_MS = 60 * 60 * 1000;   // เกินชั่วโมงถือว่าคนละรอบงาน เริ่มคลิปใหม่

  /** โปรเจกต์นี้มีคลิปเปิดค้างอยู่แล้วหรือยัง — ต้องข้ามการรีโหลดหน้าได้ */
  function kolHasOpen(projectId) {
    try {
      var raw = localStorage.getItem(KOL_OPEN_KEY);
      if (!raw) return false;
      var o = JSON.parse(raw);
      if (!o || o.p !== projectId || Date.now() - o.at > KOL_TTL_MS) return false;
      return true;
    } catch (e) { return false; }
  }

  function kolMarkOpen(projectId) {
    try { localStorage.setItem(KOL_OPEN_KEY, JSON.stringify({ p: projectId, at: Date.now() })); }
    catch (e) { swallow(e); }
  }

  function kolClearOpen() {
    try { localStorage.removeItem(KOL_OPEN_KEY); } catch (e) {}
  }

  function onKolScan(data) {
    var projectId = fieldFrom(data, 'project_id');
    var imei = fieldFrom(data, 'imei');
    var user = fieldFrom(data, 'user');
    if (!projectId) return;

    if (kolHasOpen(projectId)) {
      // ชิ้นถัดไปของกล่องเดิม — ห้ามยิง start ไม่งั้นเซิร์ฟเวอร์จะปิดคลิปเดิมทิ้ง
      beacon('item', { value: imei, trace_id: uuid() });
      return;
    }
    ctx = { trace_id: uuid(), at: Date.now() };
    beacon('start', { trace_id: ctx.trace_id, value: imei, user: user });
    kolMarkOpen(projectId);
    guessRecording(true);
  }

  /** ลงทะเบียนจัดส่งสำเร็จ — ผูกเลขพัสดุ แต่ยังอัดต่อจนกว่าจะถ่ายรูปเสร็จ */
  function onKolRegistered(data, result) {
    var trackingNo = (result && (result.tracking_no || (result.data && result.data.tracking_no))) || null;
    beacon('ship', {
      trace_id: uuid(),
      tracking_no: trackingNo,
      project_id: fieldFrom(data, 'project_id'),
    });
  }

  /** ถ่ายรูปกล่องเสร็จ = จบงานกล่องนี้ → ปิดคลิป */
  function onKolPhoto(data) {
    beacon('photo', { trace_id: uuid(), project_id: fieldFrom(data, 'project_id') });
    kolClearOpen();
    guessRecording(false);
  }
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

  /**
   * ค่าประจำเครื่อง — ต้องอ่านซ้ำได้ ไม่ใช่อ่านครั้งเดียวตอนสคริปต์ถูกประเมิน
   *
   * bridge.html ส่งค่ามาแบบ async (รอ iframe โหลดแล้วค่อย postMessage) ถ้าอ่านครั้งเดียว
   * ตอนโหลด การโหลดหน้าครั้งแรกหลังล้าง localStorage จะอ่านได้ null ไปแล้วก่อน bridge
   * จะส่งมาถึง แล้ว hook จะเงียบทั้งที่ตั้งค่าไว้ถูก — ต้องรีเฟรชอีกรอบถึงจะทำงาน
   * ซึ่งเป็นการพึ่งโชค ไม่ใช่การออกแบบ
   */
  var station = null, token = null;

  function refreshConfig() {
    try {
      station = localStorage.getItem('packvideo.station_id');
      token = localStorage.getItem('packvideo.token');
    } catch (e) { /* localStorage ถูกปิด — ทำงานต่อไม่ได้ แต่ต้องไม่ throw */ }
    return !!(BASE && station && token);
  }

  refreshConfig();

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
    guessRecording(true);
  }

  function onResult(result) {
    if (!ctx.trace_id) return;
    var d = decide(result);
    if (d.event === 'commit' || d.event === 'abort') guessRecording(false);
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
          if (!opts) return;
          if (String(opts.url).indexOf(KOL_ADD_PATH) !== -1) return onKolScan(opts.data);
          if (String(opts.url).indexOf(LAZ_CHECK_PATH) !== -1 ||
              String(opts.url).indexOf(EXPRESS_CHECK_PATH) !== -1) {
            return onScan(fieldFrom(opts.data, 'imei'), fieldFrom(opts.data, 'user'));
          }
          if (String(opts.url).indexOf(API_PATH) === -1) return;
          onScan(fieldFrom(opts.data, 'imei'), fieldFrom(opts.data, 'user'));
        } catch (err) { swallow(err); }
      });

      $(document).ajaxSuccess(function (e, xhr, opts, data) {
        try {
          if (!opts) return;
          // ลงทะเบียนจัดส่งสำเร็จ = กล่องปิดแล้ว ได้เลขพัสดุแล้ว → ปิดคลิป
          if (String(opts.url).indexOf(KOL_REGIS_PATH) !== -1) {
            if (data && data.success) onKolRegistered(opts.data, data);
            return;
          }
          if (String(opts.url).indexOf(KOL_PHOTO_PATH) !== -1) {
            if (data && data.success) onKolPhoto(opts.data);
            return;
          }
          if (String(opts.url).indexOf(LAZ_CHECK_PATH) !== -1) {
            return onResult(decideLazadaCheck(data));
          }
          if (String(opts.url).indexOf(EXPRESS_CHECK_PATH) !== -1) {
            return onResult(decideExpressCheck(data));
          }
          if (String(opts.url).indexOf(API_PATH) === -1) return;
          onResult(data);
        } catch (err) { swallow(err); }
      });

      // API ล่ม/หมดเวลา = ไม่มีคลิปที่ใช้ได้ ต้องทิ้ง ไม่ปล่อยค้าง
      $(document).ajaxError(function (e, xhr, opts) {
        try {
          if (!opts) return;
          var isTracked = String(opts.url).indexOf(API_PATH) !== -1 ||
            String(opts.url).indexOf(LAZ_CHECK_PATH) !== -1 ||
            String(opts.url).indexOf(EXPRESS_CHECK_PATH) !== -1;
          if (!isTracked) return;
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

          // ตรงกับเลขพัสดุที่รอให้สแกนปิดคลิปอยู่ — ตัวเดียวที่เรากล้าดัก
          if (INTERCEPT_TRACKING && isExpectedTracking(value)) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            // เคลียร์ช่องตอน keyup เท่านั้น ถ้าเคลียร์ตอน keydown ค่าจะหายไป
            // ก่อนที่ keyup จะได้อ่าน แล้วเราจะดักตัวที่สองไม่ทัน
            if (type === 'keyup') { el.value = ''; clearExpected(); }
            debug('ดักเลขพัสดุที่รออยู่', value);
            beacon('scan', { value: value, trace_id: uuid() });
            // นี่คือจังหวะที่คลิปถูกปิดจริง — ไม่ใช่ onResult ซึ่งเป็นเส้นทางของการ
            // สแกน IMEI เท่านั้น ถ้าไม่บอกแถบตรงนี้ พนักงานจะเห็น "กำลังบันทึก"
            // ค้างต่อไปจนกว่าจะถึงรอบถามสถานะ ทั้งที่ปิดคลิปไปแล้ว
            if (type === 'keyup') guessRecording(false);
            return;
          }

          // ไม่ตรงกับที่รออยู่ — **ปล่อยให้หน้าเดิมทำงานตามปกติเสมอ**
          // ถ้าเป็นเลขพัสดุใบอื่นก็ยังยิงสัญญาณไปให้เซิร์ฟเวอร์ตรวจว่าแปะผิดใบ
          // แต่ไม่กลืนค่าไว้ เพราะเราไม่รู้ว่าหน้าเดิมต้องใช้ค่านี้ทำอะไรหรือเปล่า
          if (looksLikeTracking(value)) {
            debug('เลขพัสดุที่ไม่ตรงกับที่รออยู่ — ส่งต่อให้หน้าเดิมตามปกติ', value);
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

  function normalise(v) {
    return String(v || '').replace(/[\s/-]/g, '').toUpperCase();
  }

  /**
   * จำเลขพัสดุที่เพิ่งพิมพ์ใบปะหน้าไป เพื่อรู้ว่ากำลังรอให้สแกนเลขไหนปิดคลิป
   *
   * ต้องเก็บข้ามหน้า เพราะหน้าใบปะหน้าจะ redirect กลับ /shopee/imei ก่อนที่พนักงาน
   * จะสแกนปิด — คนละการโหลดหน้ากัน ตัวแปรในหน่วยความจำจึงใช้ไม่ได้
   */
  function rememberExpected(tracking) {
    try {
      if (!tracking) return;
      localStorage.setItem('packvideo.expect',
        JSON.stringify({ v: normalise(tracking), at: Date.now() }));
    } catch (e) { swallow(e); }
  }

  var EXPECT_TTL_MS = 10 * 60 * 1000;

  /** ค่าที่รออยู่พร้อมเวลาที่จำไว้ — ใช้ทั้งการดักและการนับเวลาถอยหลังบนหน้าจอ */
  function expectedInfo() {
    try {
      var raw = localStorage.getItem('packvideo.expect');
      if (!raw) return null;
      var o = JSON.parse(raw);
      // เกิน 10 นาทีถือว่าเลิกรอ — กันค้างข้ามกะแล้วไปดักค่าของออเดอร์อื่น
      if (!o || !o.v || Date.now() - o.at > EXPECT_TTL_MS) {
        localStorage.removeItem('packvideo.expect');
        return null;
      }
      return o;
    } catch (e) { return null; }
  }

  function expectedTracking() {
    var o = expectedInfo();
    return o ? o.v : null;
  }

  function clearExpected() {
    try { localStorage.removeItem('packvideo.expect'); } catch (e) {}
    syncUi();
  }

  // ── หน้าจอตอนรอสแกนปิดคลิป ──────────────────────────────────
  /**
   * หลังกลับจากหน้าใบปะหน้า ช่องสแกนต้องการ **เลขพัสดุ** ไม่ใช่ IMEI
   * แต่หน้าเดิมยังเขียนว่า "Imei" เหมือนเดิมทุกอย่าง — พนักงานไม่มีทางรู้
   * ว่าจังหวะนี้ต้องยิงอะไร นอกจากจำเอาเอง
   *
   * แถบนี้จึงขึ้นเฉพาะช่วงที่กำลังรอเลขพัสดุ และหายไปเองเมื่อปิดคลิปสำเร็จ
   * หรือเมื่อเลิกรอตามกำหนด 10 นาที
   *
   * **ทุกอย่างเป็นการเพิ่มเข้าไป ไม่ลบไม่ทับของเดิม** ค่าที่แก้ (ข้อความป้าย
   * placeholder padding ของ body) ถูกจำค่าเดิมไว้แล้วคืนให้ครบเมื่อเลิกรอ
   *
   *   ปิดแถบนี้:  localStorage.setItem('packvideo.ui','off')   แล้วรีเฟรช
   */
  var UI_ENABLED = readFlag('packvideo.ui') !== 'off';
  var BAR_ID = 'packvideo-waiting-bar';
  var saved = null;          // ค่าเดิมของหน้าที่เราไปแก้ ไว้คืนตอนเลิกรอ
  var uiTimer = null;

  function inputEl() {
    try { return document.getElementById('txt_imei'); } catch (e) { return null; }
  }

  function ensureStyle() {
    if (document.getElementById('packvideo-style')) return;
    var s = document.createElement('style');
    s.id = 'packvideo-style';
    s.textContent =
      '#' + BAR_ID + '{position:fixed;top:0;left:0;right:0;z-index:2147483000;' +
      'background:#b3261e;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'padding:10px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.35)}' +
      '#' + BAR_ID + ' .pv-rec{font-weight:700;font-size:15px;white-space:nowrap}' +
      '#' + BAR_ID + ' .pv-dot{display:inline-block;width:11px;height:11px;border-radius:50%;' +
      'background:#fff;margin-right:7px;animation:pv-blink 1s steps(1) infinite}' +
      '@keyframes pv-blink{50%{opacity:.15}}' +
      '#' + BAR_ID + ' .pv-msg{font-size:17px;font-weight:700}' +
      '#' + BAR_ID + ' .pv-no{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:22px;' +
      'font-weight:700;letter-spacing:1px;background:#fff;color:#b3261e;padding:2px 12px;border-radius:5px}' +
      '#' + BAR_ID + ' .pv-left{margin-left:auto;font-size:13px;opacity:.9;white-space:nowrap}' +
      'body.packvideo-waiting #txt_imei{outline:3px solid #b3261e!important;background:#fff5f5!important;' +
      'font-family:ui-monospace,Menlo,Consolas,monospace!important}' +
      // แถบสถานะมุมขวาล่าง — ป้ายเลือกโต๊ะของ sellcenter อยู่มุมซ้ายล่าง ต้องไม่ทับกัน
      '#' + PILL_ID + '{position:fixed;right:14px;bottom:14px;z-index:99997;display:flex;' +
      'align-items:center;gap:9px;padding:7px 13px;border-radius:20px;border:0;cursor:default;' +
      'font:12px system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Thai",sans-serif;' +
      'background:#1a1a1a;color:#eee;box-shadow:0 2px 10px rgba(0,0,0,.3);opacity:.9}' +
      '#' + PILL_ID + '.pv-bad{background:#b3261e;color:#fff;cursor:pointer;opacity:1;' +
      'font-size:13px;font-weight:700}' +
      '#' + PILL_ID + '.pv-warn{background:#9a6700;color:#fff;opacity:1}' +
      // เขียว = พร้อม ไม่กะพริบ · แดงกะพริบ = กำลังบันทึกจริง ให้เหมือนหน้าต่างอัด
      '#' + PILL_ID + ' .pv-live{width:9px;height:9px;border-radius:50%;background:#2da44e}' +
      '#' + PILL_ID + '.pv-rec .pv-live{background:#f85149;' +
      'animation:pv-pulse 1.1s ease-in-out infinite}' +
      // จางอย่างเดียวไม่พอ จุดแดง 9px บนพื้นแดงเข้มจางลงแล้วแทบแยกไม่ออกว่าติดหรือดับ
      // จึงให้ย่อ-ขยายและมีวงแหวนกระจายออกด้วย เห็นจากมุมตาได้โดยไม่ต้องจ้อง
      '@keyframes pv-pulse{' +
      '0%,100%{opacity:1;transform:scale(1);box-shadow:0 0 0 0 rgba(248,81,73,.7)}' +
      '50%{opacity:.35;transform:scale(.7);box-shadow:0 0 0 5px rgba(248,81,73,0)}}' +
      '#' + PILL_ID + '.pv-rec{background:#2b1113;color:#ffd7d5;opacity:1}' +
      '#' + PILL_ID + '.pv-bad .pv-live,#' + PILL_ID + '.pv-warn .pv-live{background:#fff;animation:none}';
    (document.head || document.documentElement).appendChild(s);
  }

  /**
   * หาป้ายของช่องสแกนเพื่อเปลี่ยน "Imei" เป็น "เลขพัสดุ"
   *
   * เดิมเดาโครงสร้างเดียว — `closest('tr')` แล้วหยิบ `<th>` ตัวแรก โดยมีคอมเมนต์ว่า
   * "หน้าจริงเป็น <th> คู่กับ <td>" ซึ่งไม่เคยถูกทดสอบเลย เพราะหน้าจำลองที่ใช้ทดสอบ
   * วางช่องไว้ใน `<p>` เฉยๆ · เดาผิดแล้วเงียบ ไม่มีใครรู้ว่าป้ายไม่เปลี่ยน
   *
   * ตอนนี้ลองหลายทางเรียงจากที่มั่นใจที่สุดลงไป และถ้าไม่เจอสักทางจะยิงสัญญาณบอก
   * ไม่ปล่อยเงียบ — แถบแดงกับ placeholder ยังทำงานอยู่ดี ป้ายเป็นของแถม ไม่ใช่ตัวหลัก
   */
  function findLabel(el) {
    var cands = [];
    try {
      if (el.id) {
        var forEl = document.querySelector('label[for="' + el.id + '"]');
        if (forEl) cands.push(forEl);
      }
      var row = el.closest && el.closest('tr');
      if (row) {
        var th = row.querySelector('th');
        if (th) cands.push(th);
        var tds = row.querySelectorAll('td');
        for (var i = 0; i < tds.length; i++) {
          if (!tds[i].contains(el)) { cands.push(tds[i]); break; }
        }
      }
      var wrapLabel = el.closest && el.closest('label');
      if (wrapLabel) cands.push(wrapLabel);
      // ป้ายที่วางไว้ก่อนหน้าช่องตรงๆ — รูปแบบที่ใช้กันบ่อยเวลาไม่ได้ใช้ตาราง
      var prev = el.previousElementSibling || (el.parentNode && el.parentNode.previousElementSibling);
      if (prev) cands.push(prev);
    } catch (e) { swallow(e); }

    // **เปลี่ยนเฉพาะป้ายที่เขียนว่า IMEI จริงๆ เท่านั้น**
    //
    // เรากำลังแก้หน้าของระบบอื่น การเดาจากตำแหน่งอย่างเดียวอันตราย — บนหน้าจำลอง
    // ที่ใช้ทดสอบ ตัวที่อยู่ก่อนช่องสแกนคือ "ผู้ใช้: tester" ซึ่งผ่านเกณฑ์โครงสร้าง
    // ทุกข้อ ถ้าไม่กรองด้วยข้อความจะไปเปลี่ยนชื่อคนใช้งานเป็น "เลขพัสดุ" แทน
    //
    // ไม่เจอตัวที่เขียนว่า IMEI ก็ไม่ต้องเปลี่ยนอะไรเลย แล้วรายงานว่าทำได้ไม่ครบ —
    // แถบแดงกับ placeholder ยังบอกอยู่ ป้ายเป็นของแถม ไม่ใช่ตัวหลัก
    for (var j = 0; j < cands.length; j++) {
      if (usableLabel(cands[j], el) && /imei/i.test(cands[j].textContent || '')) return cands[j];
    }
    return null;
  }

  /**
   * ป้ายที่แตะได้ต้องเป็นข้อความสั้นๆ ที่ไม่มีของสำคัญอยู่ข้างใน
   *
   * ถ้าไม่กรอง การเขียนทับอาจไปลบทั้งเซลล์ที่มีปุ่มหรือช่องกรอกอื่นของหน้าเดิมทิ้ง
   * — เรากำลังแก้หน้าของระบบอื่น ห้ามทำให้ของเขาพัง
   */
  function usableLabel(node, el) {
    if (!node || node === el || node.nodeType !== 1) return false;
    if (node.contains(el)) return false;
    if (node.querySelector('input,select,textarea,button,a,img')) return false;
    var t = (node.textContent || '').trim();
    return t.length > 0 && t.length <= 40;
  }

  var degradedSent = false;

  /** บอกเซิร์ฟเวอร์ว่าแตะหน้าเดิมได้ไม่ครบ — ยิงครั้งเดียวต่อการโหลดหน้า */
  function reportDegraded(reason) {
    if (degradedSent) return;
    degradedSent = true;
    debug('แตะหน้าเดิมได้ไม่ครบ:', reason);
    beacon('ui_degraded', { reason: reason, trace_id: uuid() });
  }

  // ── แถบสถานะถาวร + เปิดหน้าต่างอัดให้เอง ────────────────────
  /**
   * เอา "สถานะ" มาไว้ในหน้าที่พนักงานมองอยู่ ไม่ใช่เอา "กล้อง" มา
   *
   * ฝังตัวอัดเป็น iframe ในหน้านี้ไม่ได้ เพราะหน้าแพ็คเปลี่ยนหน้าจริงระหว่างแพ็ค
   * หนึ่งออเดอร์ (imei → ใบปะหน้า → กลับมา imei) ทุกครั้งที่เปลี่ยนหน้า iframe
   * ถูกทำลาย MediaRecorder ตายตาม คลิปจะขาดตรงจังหวะหยิบของใส่กล่องพอดี ซึ่งเป็น
   * วินาทีที่มีค่าที่สุดของหลักฐาน — หน้าต่างอัดจึงต้องแยกและอยู่ยาวตลอดกะ
   *
   * สิ่งที่ทำได้และทำตรงนี้คือ ทำให้พนักงานไม่ต้องคอยจำว่าหน้าต่างนั้นเปิดอยู่ไหม
   */
  var PILL_ID = 'packvideo-status';
  var STATUS_POLL_MS = 15000;   // การแพ็คหนึ่งออเดอร์ราวหนึ่งนาที ช้ากว่านี้แถบจะตามไม่ทัน
  var statusTimer = null;
  var lastStatus = null;
  var autoOpenTried = false;

  function deskUrl() { return BASE + '/api/desk/' + encodeURIComponent(station); }

  /**
   * เปิดหน้าต่างอัด
   *
   * ตั้งชื่อหน้าต่างไว้ เรียกซ้ำจะไปโฟกัสอันเดิมแทนการเปิดใหม่ซ้อน · เรียกเฉพาะตอนที่
   * โต๊ะยังไม่มีใครถืออยู่เท่านั้น ไม่งั้นเครื่องสแกนจะไปแย่งโต๊ะจากเครื่องที่ต่อกล้องอยู่
   */
  var lastOpenAt = 0;

  var REC_OPENED_KEY = 'packvideo.rec_opened';

  // `lastOpenAt`/`autoOpenTried` อยู่ใน memory ของ script ตัวเดียว — รีเซ็ตทุกครั้งที่
  // หน้าโหลดใหม่ หน้าที่ redirect เต็มหน้าต่อการสแกนหนึ่งครั้ง (lazada, shopee เมื่อสแกนจบ
  // ออเดอร์) จึงรีเซ็ตทั้งคู่ทุกรอบ ทำให้ debounce 5 วิ กับ "ลองครั้งเดียว" ใช้ไม่ได้ข้ามหน้า
  // เลย — เครื่องที่ recorder หลุดจริงจะโดนพยายามเปิดซ้ำทุกครั้งที่กดคีย์บนหน้าใหม่ ไม่ใช่
  // แค่ครั้งเดียวต่อ session ต้องกันด้วย localStorage ถึงจะรอดข้ามหน้า
  var AUTO_OPEN_COOLDOWN_KEY = 'packvideo.auto_open_last_at';
  var AUTO_OPEN_COOLDOWN_MS = 60000;

  function openedBefore() { return readFlag(REC_OPENED_KEY) === '1'; }

  function autoOpenOnCooldown() {
    var last = Number(readFlag(AUTO_OPEN_COOLDOWN_KEY)) || 0;
    return Date.now() - last < AUTO_OPEN_COOLDOWN_MS;
  }

  function openRecorder(byUser) {
    try {
      // กันเปิดซ้ำติดๆ กัน — หน้าต่างมีชื่อจึงเป็นตัวเดิม แต่การเรียกซ้ำจะสั่งให้มัน
      // โหลดใหม่ ซึ่งถ้าเผอิญเริ่มอัดไปแล้วก็คือทำคลิปที่กำลังอัดขาด
      if (Date.now() - lastOpenAt < 5000) return true;
      lastOpenAt = Date.now();
      try { localStorage.setItem(AUTO_OPEN_COOLDOWN_KEY, String(Date.now())); } catch (e) {}
      var w = window.open(BASE + '/rec.html', 'packvideo-rec');
      if (!w) return false;          // ตัวบล็อกป๊อปอัปกัน — ปล่อยให้ปุ่มบนแถบเป็นทางสำรอง
      // จำไว้ว่าเครื่องนี้เคยเปิดหน้าต่างอัดจริง ครั้งต่อไปถึงจะเปิดให้เองได้
      if (byUser) { try { localStorage.setItem(REC_OPENED_KEY, '1'); } catch (e) {} }
      setTimeout(pollStatus, 3000);  // ให้แถบอัปเดตเร็วกว่ารอบปกติ
      return true;
    } catch (e) { swallow(e); return false; }
  }

  /**
   * ลองเปิดให้เองครั้งเดียวตอนที่พนักงานแตะหน้าจอครั้งแรก
   *
   * ต้องผูกกับการกดจริง เพราะ window.open นอก user gesture โดนบล็อกเกือบทุกเบราว์เซอร์
   * การสแกนบาร์โค้ดคือการกดคีย์บอร์ด จึงนับเป็น gesture อยู่แล้วโดยไม่ต้องขออะไรเพิ่ม
   */
  function armAutoOpen() {
    function once(ev) {
      if (autoOpenTried) return cleanup();
      // ครั้งแรกของเครื่องต้องให้คนกดเอง — ป๊อปอัปที่โผล่มาเองบนเครื่องที่ไม่ได้ตั้งใจ
      // ใช้ระบบวิดีโอคือการรบกวนงานเขา ไม่ใช่การช่วย · ครั้งต่อๆ ไปค่อยเปิดให้เอง
      if (!openedBefore()) return;
      // การกดที่แถบมีตัวจัดการของมันเองแล้ว ถ้าไม่ข้ามจะเปิดสองครั้งต่อการกดหนึ่งที
      if (ev && ev.target && ev.target.closest && ev.target.closest('#' + PILL_ID)) return;
      if (!lastStatus || lastStatus.connected !== false) return;   // ยังไม่รู้สถานะ หรือเปิดอยู่แล้ว
      // เครื่องที่ recorder หลุดจริง (ปิดเครื่อง/ปิดแท็บ) จะเจอเงื่อนไขนี้เป็น true ทุกหน้า
      // ถ้าไม่กันไว้ ทุกครั้งที่พนักงานสแกนแล้วหน้าเปลี่ยน (redirect ไปใบปะหน้าแล้วกลับมา)
      // จะเด้งหน้าต่างอัด/โฟกัสมันซ้ำอีก — พนักงานเห็นเป็น "เด้งหน้า rec ตลอด"
      if (autoOpenOnCooldown()) return cleanup();
      autoOpenTried = true;
      openRecorder();
      cleanup();
    }
    function cleanup() {
      try {
        document.removeEventListener('keydown', once, true);
        document.removeEventListener('click', once, true);
      } catch (e) {}
    }
    try {
      document.addEventListener('keydown', once, true);
      document.addEventListener('click', once, true);
    } catch (e) { swallow(e); }
  }

  function renderPill(st) {
    if (!UI_ENABLED) return;
    ensureStyle();
    var el = document.getElementById(PILL_ID);
    if (!el) {
      el = document.createElement('button');
      el.id = PILL_ID;
      el.type = 'button';
      el.onclick = function () { if (lastStatus && !lastStatus.connected) openRecorder(true); };
      // สร้างลูกครั้งเดียวแล้วอัปเดตแค่ข้อความ — ถ้าเขียน innerHTML ทับทุกรอบ จุดจะถูก
      // สร้างใหม่ทุก 15 วินาที แล้ว animation เริ่มนับหนึ่งใหม่ตลอด กะพริบไม่เป็นจังหวะ
      el.appendChild(document.createElement('span')).className = 'pv-live';
      el.appendChild(document.createElement('span')).className = 'pv-text';
      document.body.appendChild(el);
    }

    var cls = '', text;
    if (!st) {
      cls = 'pv-warn';
      text = 'ติดต่อระบบวิดีโอไม่ได้';
    } else if (!st.connected) {
      cls = 'pv-bad';
      text = 'หน้าต่างอัดไม่ได้เปิด — กดตรงนี้เพื่อเปิด';
    } else if (!st.recording_allowed) {
      cls = 'pv-warn';
      text = 'ดิสก์เต็ม หยุดบันทึกชั่วคราว · ' + st.station_id;
    } else {
      // แยก "เปิดหน้าต่างไว้เฉยๆ" กับ "กล้องกำลังบันทึกจริง" — สองอันนี้ไม่เหมือนกัน
      // และเขียนให้ตรงกับที่หน้าต่างอัดเขียนอยู่ พนักงานจะได้ไม่ต้องแปลสองภาษา
      cls = st.recording ? 'pv-rec' : '';
      text = (st.recording ? 'กำลังบันทึก · ' : 'พร้อม · ') + st.station_id
        + (st.disk_level && st.disk_level !== 'normal' ? ' · ดิสก์เหลือ ' + st.disk_free_gb + ' GB' : '')
        + (st.queue_depth > 0 ? ' · คิว ' + st.queue_depth : '');
    }
    if (el.className !== cls) el.className = cls;
    var t = el.querySelector('.pv-text');
    if (t.textContent !== text) t.textContent = text;
  }

  /**
   * เดาสถานะทันทีจากสิ่งที่เรารู้เอง แล้วให้ของจริงตามมายืนยัน
   *
   * เราเป็นคนยิงสัญญาณ start/commit เอง จึงรู้ตั้งแต่วินาทีที่พนักงานกด Enter ว่า
   * กำลังจะเริ่มหรือจบคลิป ถ้ารอรอบถามสถานะ (15 วินาที) แถบจะขึ้นช้ากว่าความจริงมาก
   * จนดูเหมือนค้าง — ที่หน้างานคือ "สแกนแล้วไม่เห็นมีอะไรเกิดขึ้น"
   *
   * เดาแล้วถามซ้ำเร็วๆ สองจังหวะ ถ้าเดาผิด (เช่นกล้องเปิดไม่ได้จริง) ของจริงจะมาทับ
   * ให้เองภายในไม่กี่วินาที ไม่ค้างผิดยาว
   */
  var guess = null;          // { on: bool, at: number }
  var GUESS_HOLD_MS = 4000;

  function guessRecording(on) {
    try {
      if (!lastStatus || !lastStatus.connected) return;   // ยังไม่รู้สถานะ อย่าเดามั่ว
      guess = { on: on, at: Date.now() };
      lastStatus.recording = on;
      renderPill(lastStatus);
      setTimeout(pollStatus, 1500);
      setTimeout(pollStatus, 5000);
    } catch (e) { swallow(e); }
  }

  /**
   * ให้ค่าที่เราเดายืนหยัดสักครู่ก่อนยอมให้ของจริงทับ
   *
   * ไม่งั้นจะกระพริบไปกลับ — เราพลิกแถบทันทีที่สแกน แล้วรอบยืนยันที่ 1.5 วินาที
   * ไปถามตอนที่หน้าต่างอัดยังรายงานค่าใหม่มาไม่ถึง เซิร์ฟเวอร์จึงตอบค่าเก่า
   * แถบก็เด้งกลับ แล้วอีก 3.5 วินาทีค่อยถูกอีกครั้ง — พนักงานเห็นแล้วสับสนกว่าเดิม
   *
   * ถือไว้แค่ 4 วินาที ถ้าเดาผิดจริง (กล้องเปิดไม่ได้) ของจริงก็ยังชนะในที่สุด
   */
  function reconcile(d) {
    if (!d || !guess) return d;
    if (Date.now() - guess.at > GUESS_HOLD_MS) { guess = null; return d; }
    if (d.recording === guess.on) { guess = null; return d; }
    d.recording = guess.on;
    return d;
  }

  function pollStatus() {
    try {
      if (!window.fetch) return;
      fetch(deskUrl(), { credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          lastStatus = d && d.ok ? reconcile(d) : null;
          renderPill(lastStatus);
        })
        .catch(function () { lastStatus = null; renderPill(null); });
    } catch (e) { swallow(e); }
  }

  function startStatus() {
    if (!UI_ENABLED || statusTimer) return;
    pollStatus();
    statusTimer = setInterval(pollStatus, STATUS_POLL_MS);
    // กลับมาที่แท็บนี้แล้วต้องเห็นของจริงทันที ไม่ใช่ค่าค้างจากเมื่อกี้
    try {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) pollStatus();
      });
    } catch (e) { swallow(e); }
    armAutoOpen();
  }

  function showWaiting(info) {
    ensureStyle();
    var bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = BAR_ID;
      bar.innerHTML =
        '<span class="pv-rec"><span class="pv-dot"></span>กำลังอัดวิดีโอ</span>' +
        '<span class="pv-msg">ยิงบาร์โค้ด<u>เลขพัสดุบนกล่อง</u>เพื่อปิดคลิป</span>' +
        '<span class="pv-no"></span><span class="pv-left"></span>';
      document.body.appendChild(bar);
    }
    bar.querySelector('.pv-no').textContent = info.v;

    var secs = Math.max(0, Math.round((info.at + EXPECT_TTL_MS - Date.now()) / 1000));
    bar.querySelector('.pv-left').textContent =
      'เลิกรอใน ' + Math.floor(secs / 60) + ':' + ('0' + (secs % 60)).slice(-2);

    if (!saved) {
      saved = { padding: document.body.style.paddingTop, ph: null, label: null, labelEl: null };
      var el = inputEl();
      if (el) {
        saved.ph = el.getAttribute('placeholder');
        el.setAttribute('placeholder', 'ยิงเลขพัสดุบนกล่อง');
        var lb = findLabel(el);
        if (lb) {
          // เก็บ innerHTML ไม่ใช่ textContent — ป้ายอาจมีลูกอยู่ข้างใน (<b>Imei</b> <span>*</span>)
          // ถ้าเก็บแค่ข้อความแล้วคืนด้วยข้อความ โครงสร้างเดิมจะหายไปถาวร
          saved.labelEl = lb;
          saved.label = lb.innerHTML;
          lb.textContent = 'เลขพัสดุ';
        } else {
          reportDegraded('label_not_found');
        }
      }
      document.body.classList.add('packvideo-waiting');
    }
    pushContentDown(bar);
    if (inputEl()) { try { inputEl().focus(); } catch (e) {} }
  }

  /**
   * ดันเนื้อหาของหน้าลงมาเท่าความสูงแถบ เพื่อไม่ให้แถบไปทับหัวหน้าเดิม
   *
   * ต้องวัดหลังเบราว์เซอร์จัดหน้าเสร็จ — วัดทันทีที่เพิ่งใส่ลง DOM จะได้ค่าที่
   * ยังไม่นิ่ง (เคยได้ 365px จากแถบที่จริงๆ สูง 49px) แล้วหน้าจะกระตุกให้เห็น
   * หนึ่งจังหวะก่อนรอบถัดไปจะแก้ให้ · ตัดค่าที่เพี้ยนทิ้งอีกชั้นด้วย
   */
  function pushContentDown(bar) {
    var apply = function () {
      var h = bar.offsetHeight;
      if (h > 0 && h < 200) document.body.style.paddingTop = h + 'px';
    };
    if (window.requestAnimationFrame) requestAnimationFrame(apply);
    else apply();
  }

  function hideWaiting() {
    var bar = document.getElementById(BAR_ID);
    if (bar) bar.parentNode.removeChild(bar);
    if (saved) {
      document.body.style.paddingTop = saved.padding || '';
      document.body.classList.remove('packvideo-waiting');
      var el = inputEl();
      if (el) {
        if (saved.ph === null) el.removeAttribute('placeholder');
        else el.setAttribute('placeholder', saved.ph);
      }
      if (saved.labelEl && saved.label !== null) saved.labelEl.innerHTML = saved.label;
      saved = null;
    }
  }

  /** ให้หน้าจอตรงกับสถานะจริงเสมอ — เรียกได้บ่อยเท่าไหร่ก็ได้ */
  function syncUi() {
    try {
      if (!UI_ENABLED || !started || !inputEl()) return;
      var info = expectedInfo();
      if (info) showWaiting(info);
      else hideWaiting();
    } catch (e) { swallow(e); }
  }

  function startUi() {
    if (!UI_ENABLED || uiTimer) return;
    syncUi();
    // เดินทุกวินาทีเพื่อให้เวลาถอยหลังเดินจริง และแถบหายเองเมื่อครบ 10 นาที
    uiTimer = setInterval(syncUi, 1000);
  }

  /**
   * ค่านี้คือเลขพัสดุที่เรากำลังรอให้สแกนปิดคลิปหรือเปล่า
   *
   * **ดักเฉพาะค่าที่ตรงกับที่รออยู่เท่านั้น** ไม่ดักตามรูปแบบ
   *
   * เดิมดักทุกค่าที่มีตัวอักษรและยาว >= 8 ซึ่งกว้างเกินไป — ค่าอื่นที่หน้าเดิม
   * ต้องใช้ (เช่นเลขออเดอร์ที่มีตัวอักษร) จะถูกกลืนไปด้วย แล้วพนักงานสแกนแล้ว
   * ไม่มีอะไรเกิดขึ้น · การเทียบกับค่าที่รออยู่จริงทำให้ผิดพลาดไม่ได้เลย
   */
  function isExpectedTracking(v) {
    var want = expectedTracking();
    return !!want && normalise(v) === want;
  }

  /** เลขพัสดุแบบหยาบๆ — ใช้แค่ตัดสินว่าจะยิงสัญญาณ scan ไหม ไม่ใช้ตัดสินว่าจะดักไหม */
  function looksLikeTracking(v) {
    var cleaned = normalise(v);
    if (/^\d+$/.test(cleaned)) return false;             // ตัวเลขล้วน = IMEI หรือของระบบเดิม
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
      // 1) ป้ายที่ระบุไว้ตรงๆ — หน้าที่ไม่มี arr_tracking หรือบาร์โค้ด svg ใช้ทางนี้
      //    (`printed` กับ `airways_hot_large` พิมพ์เลขพัสดุเป็นข้อความในตารางเฉยๆ)
      //    เอาไว้ลำดับแรกเพราะเป็นค่าที่ประกาศไว้ให้เราโดยเฉพาะ ไม่ใช่การเดาจากโครงหน้า
      var marks = document.querySelectorAll('[data-packvideo-tracking]');
      if (marks.length) {
        var v = (marks[marks.length - 1].getAttribute('data-packvideo-tracking') || '').trim();
        if (v) return v;
      }
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
    // จำไว้ว่ากำลังรอเลขนี้ เพื่อให้ดักได้ตอนพนักงานสแกนปิดหลังหน้าเด้งกลับ
    rememberExpected(tracking);
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
      return !!(
        document.querySelector('[data-packvideo-tracking]') ||
        window.arr_tracking ||
        document.querySelector('[id^="svg_"]')
      );
    } catch (e) { return false; }
  }

  // ── เริ่มทำงาน ──────────────────────────────────────────────
  /**
   * ปิดการดักค่าที่ไม่ใช่ IMEI ได้ทันทีโดยไม่ต้อง deploy อะไรเลย
   *
   *   localStorage.setItem('packvideo.intercept','off')   แล้วรีเฟรช
   *
   * นี่เป็นสิ่งเดียวที่ hook ทำแล้ว **หยุดการทำงานของหน้าเดิม** ถ้าตัดสินผิด
   * พนักงานจะสแกนแล้วไม่มีอะไรเกิดขึ้น จึงต้องปิดได้ทันทีที่หน้างาน
   */
  var INTERCEPT_TRACKING = readFlag('packvideo.intercept') !== 'off';

  /** เปิดดูว่า hook ตัดสินอะไร:  localStorage.setItem('packvideo.debug','1') */
  var DEBUG = readFlag('packvideo.debug') === '1';

  function readFlag(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }

  function debug() {
    if (!DEBUG) return;
    try { console.log.apply(console, ['[packvideo]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  var hasJquery = false;

  /**
   * เครื่องนี้เริ่มทำงานจริงแล้วหรือยัง
   *
   * คลังมีเครื่องที่ไม่ได้ต่อกล้อง และเครื่องเหล่านั้นก็โหลด hook.js ตัวเดียวกัน
   * เพราะ script tag อยู่ในหน้าแพ็คที่ใช้ร่วมกันทุกเครื่อง
   *
   * **เครื่องที่ยังไม่ได้ตั้งค่าต้องไม่ถูกแตะเลยแม้แต่นิดเดียว** — ไม่ผูกตัวรับ
   * ไม่ดัก Enter ไม่แตะ DOM ไม่ยิงอะไรทั้งนั้น เพราะการดัก Enter บนเครื่อง
   * ที่ไม่มี station จะกลืนการสแกนไปเฉยๆ แล้วพนักงานจะสแกนแล้วไม่มีอะไรเกิดขึ้น
   *
   * ข้อนี้ยังคงอยู่ครบหลังเปลี่ยนมารอค่าจาก bridge — ระหว่างรอเราแค่ฟังเงียบๆ
   * (message · storage · poll) ไม่มีอะไรที่หน้าเดิมรู้สึกได้ และการผูกตัวดักทั้งหมด
   * ยังเกิดใน start() ซึ่งเรียกเฉพาะตอนที่มี station กับ token ครบแล้วเท่านั้น
   */
  var started = false;

  /** ผูกทุกอย่างและเริ่มทำงานจริง — เรียกซ้ำได้ ทำงานแค่ครั้งเดียว */
  function start() {
    if (started) return;
    started = true;
    try {
      hasJquery = bindAjax();
      bindKey();
      if (isLabelPage()) onLabelPage();
      startUi();
      startStatus();
      debug('ทำงานที่โต๊ะ', station, '· ดักเลขพัสดุ:', INTERCEPT_TRACKING ? 'เปิด' : 'ปิด');
    } catch (err) { swallow(err); }
  }

  var CONFIG_WAIT_MS = 10000;   // รอ bridge นานสุดเท่านี้แล้วเลิกรอ
  var CONFIG_POLL_MS = 250;

  /**
   * รอค่าจาก bridge.html โดย **ไม่แตะหน้าเดิมเลยระหว่างรอ**
   *
   * ระหว่างรอเราไม่ผูกตัวดัก ไม่แตะ DOM ไม่ยิงอะไร — เครื่องที่ไม่ได้ใช้ระบบวิดีโอ
   * จะรอเงียบๆ ครบ 10 วินาทีแล้วเลิก เหมือนเดิมทุกอย่างจากมุมของหน้าเดิม
   *
   * ฟังสามทางเพราะแต่ละทางพลาดได้คนละแบบ:
   *   1. postMessage จาก bridge ตรงๆ — เร็วที่สุด และเขียนค่าลง localStorage ให้เลย
   *      ฝั่ง sellcenter จึงเหลือแค่ฝัง iframe ไม่ต้องเขียน listener เอง
   *   2. storage event — กรณีที่แท็บอื่นหรือโค้ดอื่นเป็นคนเขียนค่า
   *   3. poll — กันกรณีที่ทั้งสองทางบนไม่เกิด (เช่น ค่าถูกเขียนก่อนเราผูก listener ทัน)
   */
  function waitForConfig() {
    var timer = null, deadline = null;

    function stop() {
      if (timer) clearInterval(timer);
      try { window.removeEventListener('message', onMessage); } catch (e) {}
      try { window.removeEventListener('storage', onStorage); } catch (e) {}
      if (deadline) clearTimeout(deadline);
    }

    function tryStart() {
      if (!refreshConfig()) return false;
      stop();
      debug('ได้ค่าประจำเครื่องแล้ว — เริ่มทำงาน');
      start();
      return true;
    }

    function onMessage(ev) {
      try {
        // ต้องมาจาก origin ของเซิร์ฟเวอร์ packvideo เท่านั้น — ห้ามเชื่อ message จากใครก็ได้
        // ที่ส่งเข้ามา เพราะนั่นเท่ากับให้หน้าอื่นตั้ง station/token ให้เครื่องนี้ได้
        if (!BASE || ev.origin !== new URL(BASE, location.href).origin) return;
        var d = ev.data;
        if (!d || d.source !== 'packvideo-bridge') return;
        if (d.station_id) localStorage.setItem('packvideo.station_id', d.station_id);
        if (d.token) localStorage.setItem('packvideo.token', d.token);
        tryStart();
      } catch (e) { swallow(e); }
    }

    function onStorage() { tryStart(); }

    try {
      window.addEventListener('message', onMessage);
      window.addEventListener('storage', onStorage);
      timer = setInterval(tryStart, CONFIG_POLL_MS);
      deadline = setTimeout(function () {
        stop();
        debug('เครื่องนี้ไม่ได้ตั้งค่าใช้ระบบวิดีโอ — hook ไม่ทำงานอะไรเลย');
      }, CONFIG_WAIT_MS);
    } catch (e) { swallow(e); }
  }

  function boot() {
    try {
      // ประกาศไว้แล้วว่าเครื่องนี้ไม่ใช้ระบบกล้อง — ต่างจาก "ยังไม่ได้ตั้งค่า" ตรงที่
      // อันนั้นคือยังไม่ได้ตอบ จึงรอค่าจาก bridge ต่อได้ ส่วนอันนี้คือตอบแล้วว่าไม่
      // ต้องไม่รอ ไม่ผูกอะไร ไม่แตะหน้าเดิมเลยแม้แต่นิดเดียว
      if (readFlag('packvideo.optout') === '1') {
        debug('เครื่องนี้ประกาศว่าไม่ใช้ระบบกล้อง — hook ไม่ทำงานอะไรเลย');
        return;
      }
      if (refreshConfig()) return start();
      waitForConfig();
    } catch (err) { swallow(err); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
