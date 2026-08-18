/**
 * แผงตั้งค่า/คู่มือ ที่ใช้ร่วมกันทุกหน้าของ packvideo (FR-10 · FR-11)
 *
 * ทำไมต้องเป็นแผงลอย ไม่ใช่ลิงก์ไปหน้าตั้งค่า
 *   `rec.html` เปลี่ยนหน้าไม่ได้เลยระหว่างกะ — `MediaRecorder` กับ stream กล้อง
 *   ตายทันทีที่ออกจากหน้า คลิปที่กำลังอัดจะขาด แผงจึงต้องเปิดทับหน้าเดิมโดยไม่
 *   เปลี่ยน URL และไม่รีโหลด
 *
 * ทำไมต้องมีเลย
 *   ก่อนหน้านี้ `/setup.html` เข้าไม่ถึงเลยหลังตั้งค่าเสร็จ — มีที่เดียวในระบบที่
 *   ลิงก์ไปหน้านั้น และมันโชว์เฉพาะตอนเครื่องยังไม่ได้ตั้งค่า พอตั้งเสร็จลิงก์หายไป
 *   ถาวร อยากเปลี่ยนกล้องต้องพิมพ์ URL เอง ซึ่งคนหน้างานไม่ทำ
 *
 * วิธีใช้ — วาง <span data-packvideo-panel></span> ตรงที่อยากให้ปุ่มอยู่ แล้ว
 *   PackvideoPanel.mount({ role: 'packer', hooks: { ... } })
 */
(function () {
  'use strict';

  var K = {
    station: 'packvideo.station_id',
    token: 'packvideo.token',
    client: 'packvideo.client_id',
    device: 'packvideo.device_name',
    camera: 'packvideo.camera_id',
  };

  var HELP = { packer: '#tab-packer', lead: '#tab-lead', cs: '#tab-cs' };

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function el(id) { return document.getElementById(id); }

  var opts = null;
  var open = false;
  var lockTimer = null;
  var locked = false;      // กำลังบันทึกอยู่หรือเปล่า
  var lockInfo = null;
  var camStream = null;

  // ── หน้าตา ────────────────────────────────────────────────
  function css() {
    if (el('pv-panel-style')) return;
    var s = document.createElement('style');
    s.id = 'pv-panel-style';
    s.textContent = [
      '#pv-panel-btn{font:inherit;font-size:13px;display:inline-flex;align-items:center;gap:6px;',
      'padding:5px 11px;border-radius:18px;border:1px solid rgba(128,128,128,.35);',
      'background:transparent;color:inherit;cursor:pointer;white-space:nowrap;opacity:.85}',
      '#pv-panel-btn:hover{opacity:1;border-color:rgba(128,128,128,.7)}',
      '#pv-scrim{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147482000;display:none}',
      '#pv-scrim.show{display:block}',
      '#pv-panel{position:fixed;top:0;right:0;bottom:0;width:min(380px,100vw);z-index:2147483000;',
      'background:#161b22;color:#e6edf3;box-shadow:-6px 0 24px rgba(0,0,0,.4);overflow-y:auto;',
      'font:14px system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Thai",sans-serif;',
      'display:none;padding:16px 18px 28px}',
      '#pv-panel.show{display:block}',
      '#pv-panel h3{margin:0 0 2px;font-size:16px}',
      '#pv-panel h4{margin:20px 0 7px;font-size:12px;text-transform:uppercase;opacity:.55;letter-spacing:.04em}',
      '#pv-panel .pv-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px}',
      '#pv-panel .pv-row span:first-child{opacity:.6}',
      '#pv-panel .pv-row span:last-child{font-family:ui-monospace,Menlo,monospace;text-align:right;word-break:break-all}',
      '#pv-panel input,#pv-panel select{width:100%;padding:8px;border-radius:7px;font:inherit;',
      'background:#0d1117;color:#e6edf3;border:1px solid rgba(255,255,255,.16)}',
      '#pv-panel button.pv-act{width:100%;margin-top:8px;padding:9px;border-radius:7px;font:inherit;',
      'font-weight:700;cursor:pointer;border:1px solid rgba(255,255,255,.16);background:transparent;color:inherit}',
      '#pv-panel button.pv-primary{background:#2563eb;border-color:#2563eb;color:#fff}',
      '#pv-panel button.pv-danger{color:#f85149;border-color:rgba(248,81,73,.5)}',
      '#pv-panel .pv-locked{opacity:.45;pointer-events:none}',
      '#pv-panel .pv-why{font-size:12px;background:rgba(154,103,0,.16);border:1px solid rgba(154,103,0,.45);',
      'padding:8px 10px;border-radius:7px;margin-top:8px;display:none}',
      '#pv-panel .pv-why.show{display:block}',
      '#pv-panel .pv-msg{font-size:12px;margin-top:8px;padding:8px 10px;border-radius:7px;display:none}',
      '#pv-panel .pv-msg.show{display:block}',
      '#pv-panel .pv-msg.ok{background:rgba(26,127,55,.16);border:1px solid rgba(26,127,55,.45)}',
      '#pv-panel .pv-msg.bad{background:rgba(182,35,36,.16);border:1px solid rgba(182,35,36,.45)}',
      '#pv-close{position:absolute;top:12px;right:14px;background:transparent;border:0;color:#8b949e;',
      'font-size:22px;line-height:1;cursor:pointer}',
      '#pv-panel a{color:#58a6ff}',
    ].join('');
    document.head.appendChild(s);
  }

  function build() {
    css();
    var scrim = document.createElement('div');
    scrim.id = 'pv-scrim';
    scrim.onclick = close;
    document.body.appendChild(scrim);

    var p = document.createElement('div');
    p.id = 'pv-panel';
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'ตั้งค่าและคู่มือ');
    p.innerHTML =
      '<button id="pv-close" type="button" aria-label="ปิด">×</button>' +
      '<h3>เครื่องนี้</h3>' +
      '<div id="pv-current"></div>' +
      '<div class="pv-why" id="pv-why"></div>' +

      '<h4>ชื่อเครื่อง</h4>' +
      '<input id="pv-device" type="text" maxlength="60" placeholder="เช่น คอมโต๊ะ 3 ริมหน้าต่าง">' +
      '<button class="pv-act" id="pv-save-device" type="button">บันทึกชื่อเครื่อง</button>' +

      '<div id="pv-danger-zone">' +
      '<h4>โต๊ะ</h4>' +
      '<select id="pv-station"><option value="">กำลังโหลด…</option></select>' +
      '<button class="pv-act pv-primary" id="pv-save-station" type="button">ย้ายเครื่องนี้ไปโต๊ะที่เลือก</button>' +

      '<h4>กล้อง</h4>' +
      '<select id="pv-camera"><option value="">— ยังไม่ได้ขออนุญาต —</option></select>' +
      '<button class="pv-act" id="pv-ask-cam" type="button">ขออนุญาตใช้กล้องเพื่อดูรายชื่อ</button>' +
      '<button class="pv-act pv-primary" id="pv-save-cam" type="button">ใช้กล้องที่เลือก</button>' +

      '<h4>ล้างค่า</h4>' +
      '<button class="pv-act pv-danger" id="pv-release" type="button">ล้างค่าเครื่องนี้</button>' +
      '</div>' +

      '<div class="pv-msg" id="pv-msg"></div>' +
      '<h4>คู่มือ</h4>' +
      '<p><a id="pv-help" href="/help.html" target="_blank" rel="noopener">เปิดคู่มือของงานนี้</a></p>';
    document.body.appendChild(p);

    el('pv-close').onclick = close;
    el('pv-save-device').onclick = saveDevice;
    el('pv-save-station').onclick = saveStation;
    el('pv-ask-cam').onclick = askCamera;
    el('pv-save-cam').onclick = saveCamera;
    el('pv-release').onclick = release;
    el('pv-help').href = '/help.html' + (HELP[opts.role] || '');

    document.addEventListener('keydown', function (e) {
      if (open && (e.key === 'Escape' || e.keyCode === 27)) close();
    });
  }

  // ── ข้อมูลปัจจุบัน ────────────────────────────────────────
  function renderCurrent() {
    var rows = [
      ['โต๊ะ', get(K.station) || '— ยังไม่ได้ตั้ง —'],
      ['ชื่อเครื่อง', get(K.device) || '—'],
      ['กล้อง', get(K.camera) ? camLabel(get(K.camera)) : '— ใช้ตัวปริยาย —'],
    ];
    el('pv-current').innerHTML = rows.map(function (r) {
      return '<div class="pv-row"><span>' + r[0] + '</span><span>' + esc(r[1]) + '</span></div>';
    }).join('');
  }

  var camNames = {};
  function camLabel(id) { return camNames[id] || id; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function msg(kind, text) {
    var m = el('pv-msg');
    m.className = 'pv-msg show ' + kind;
    m.textContent = text;
  }

  // ── การล็อกระหว่างอัด (FR-11) ─────────────────────────────
  /**
   * ล็อกถ้า**ฝั่งใดฝั่งหนึ่ง**บอกว่ากำลังอัด
   *
   * เซิร์ฟเวอร์เป็นตัวจริงเพราะค่ามาจาก heartbeat ของหน้าต่างอัด แต่ยอมให้หน้าที่
   * โฮสต์แผงอยู่บอกได้ด้วย (rec.html รู้ก่อนเซิร์ฟเวอร์เสมอ) — เอียงไปทางล็อกไว้ก่อน
   * เพราะพลาดด้านล็อกเกินแค่ต้องรอ ส่วนพลาดอีกด้านคือคลิปที่กำลังอัดขาด
   */
  function refreshLock() {
    var localSaysRecording = false;
    try {
      if (opts.hooks && typeof opts.hooks.isRecording === 'function') {
        localSaysRecording = !!opts.hooks.isRecording();
      }
    } catch (e) {}

    var st = get(K.station);
    if (!st) return applyLock(localSaysRecording, null);

    fetch('/api/desk/' + encodeURIComponent(st))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        applyLock(localSaysRecording || !!(d && d.recording), d);
      })
      .catch(function () { applyLock(localSaysRecording, null); });
  }

  function applyLock(isRecording, info) {
    locked = isRecording;
    lockInfo = info;
    var zone = el('pv-danger-zone');
    if (!zone) return;
    zone.className = isRecording ? 'pv-locked' : '';
    var why = el('pv-why');
    if (isRecording) {
      why.className = 'pv-why show';
      why.textContent = 'กำลังบันทึกอยู่ — เปลี่ยนโต๊ะ เปลี่ยนกล้อง และล้างค่า ทำไม่ได้ตอนนี้ '
        + 'เพราะจะทำให้คลิปที่กำลังอัดขาดหรือผูกกับโต๊ะผิด · ปุ่มจะกลับมากดได้เองเมื่อคลิปนี้ปิด';
    } else {
      why.className = 'pv-why';
    }
  }

  // ── การกระทำ ──────────────────────────────────────────────
  function clientId() {
    var c = get(K.client);
    if (!c) {
      c = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
      set(K.client, c);
    }
    return c;
  }

  function saveDevice() {
    var name = (el('pv-device').value || '').trim();
    if (!name) return msg('bad', 'ตั้งชื่อเครื่องก่อน — ใช้ตอนที่ต้องไล่หาว่าเครื่องไหนตั้งซ้ำ');
    set(K.device, name);
    renderCurrent();
    // ชื่อเครื่องเป็นแค่ป้ายชื่อ ไม่กระทบคลิปที่กำลังอัด (บันทึกคนแพ็คไปตั้งแต่ตอนเริ่มแล้ว)
    msg('ok', 'บันทึกชื่อเครื่องแล้ว — มีผลกับคลิปถัดไป');
  }

  function loadStations() {
    return fetch('/api/stations')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var cur = get(K.station);
        var list = (d && d.stations) || [];
        el('pv-station').innerHTML = '<option value="">— เลือกโต๊ะ —</option>' + list.map(function (s) {
          var mine = s.station_id === cur;
          var busy = s.connected && !mine;
          return '<option value="' + esc(s.station_id) + '"' + (mine ? ' selected' : '') +
            (busy ? ' disabled' : '') + '>' + esc(s.station_id) +
            (mine ? ' (เครื่องนี้)' : busy ? ' — ใช้อยู่โดย ' + esc(s.device_name || 'เครื่องที่ไม่ทราบชื่อ') : '') +
            '</option>';
        }).join('');
      })
      .catch(function () { el('pv-station').innerHTML = '<option value="">โหลดรายชื่อโต๊ะไม่สำเร็จ</option>'; });
  }

  function saveStation() {
    if (locked) return;
    var id = el('pv-station').value;
    if (!id) return msg('bad', 'เลือกโต๊ะก่อน');
    if (id === get(K.station)) return msg('ok', 'เครื่องนี้อยู่โต๊ะนี้อยู่แล้ว');
    var name = (el('pv-device').value || get(K.device) || '').trim();

    fetch('/api/stations/' + encodeURIComponent(id) + '/claim', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId(), device_name: name }),
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .then(function (res) {
        if (res.status === 409) {
          var h = res.d.held_by || {};
          return msg('bad', 'โต๊ะนี้มีเครื่องอื่นใช้อยู่: ' + (h.device_name || 'ไม่ทราบชื่อ') +
            ' (' + (h.ip || '-') + ') — ไปปิดหน้าที่เครื่องนั้นก่อน หรือเลือกโต๊ะอื่น');
        }
        if (!res.d.ok) return msg('bad', res.d.error || 'ย้ายโต๊ะไม่สำเร็จ');
        set(K.station, id);
        if (name) set(K.device, name);
        if (!get(K.token)) set(K.token, 'dev-token');
        renderCurrent();
        msg('ok', 'ย้ายมาโต๊ะ ' + id + ' แล้ว');
        hook('onStationChange', id);
      })
      .catch(function (e) { msg('bad', 'ติดต่อเซิร์ฟเวอร์ไม่ได้: ' + (e && e.message)); });
  }

  function askCamera() {
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then(function (s) {
        // ขอสิทธิ์เพื่อให้เห็นชื่อกล้อง แล้วปิดทันที ไม่ถือ stream ค้างไว้แย่งกับหน้าต่างอัด
        s.getTracks().forEach(function (t) { t.stop(); });
        return navigator.mediaDevices.enumerateDevices();
      })
      .then(function (devices) {
        var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
        var cur = get(K.camera);
        camNames = {};
        el('pv-camera').innerHTML = cams.map(function (c, i) {
          camNames[c.deviceId] = c.label || ('กล้องตัวที่ ' + (i + 1));
          return '<option value="' + esc(c.deviceId) + '"' + (c.deviceId === cur ? ' selected' : '') + '>' +
            esc(camNames[c.deviceId]) + '</option>';
        }).join('') || '<option value="">ไม่พบกล้องบนเครื่องนี้</option>';
        renderCurrent();
      })
      .catch(function (e) { msg('bad', 'ขอใช้กล้องไม่สำเร็จ: ' + (e && e.message)); });
  }

  function saveCamera() {
    if (locked) return;
    var id = el('pv-camera').value;
    if (!id) return msg('bad', 'กดขออนุญาตใช้กล้องก่อน แล้วเลือกกล้อง');
    set(K.camera, id);
    renderCurrent();
    msg('ok', 'เปลี่ยนกล้องแล้ว');
    hook('onCameraChange', id);
  }

  function release() {
    if (locked) return;
    if (!confirm('ล้างค่าเครื่องนี้? เครื่องจะหลุดจากโต๊ะและหยุดบันทึกจนกว่าจะตั้งใหม่')) return;
    var st = get(K.station);
    var done = function () {
      del(K.station); del(K.device); del(K.camera);
      renderCurrent();
      msg('ok', 'ล้างค่าแล้ว — เครื่องนี้ยังไม่ได้ตั้งเป็นโต๊ะไหน');
      hook('onRelease');
    };
    if (!st) return done();
    fetch('/api/stations/' + encodeURIComponent(st) + '/release', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId() }),
    }).catch(function () {}).then(done);
  }

  /** หน้าที่โฮสต์แผงจัดการเองได้ ถ้าไม่รับช่วงก็รีโหลดให้ค่าใหม่มีผล */
  function hook(name, arg) {
    var fn = opts.hooks && opts.hooks[name];
    if (typeof fn === 'function') { try { return fn(arg); } catch (e) {} }
    setTimeout(function () { location.reload(); }, 900);
  }

  // ── เปิด/ปิด ──────────────────────────────────────────────
  function show() {
    open = true;
    el('pv-scrim').classList.add('show');
    el('pv-panel').classList.add('show');
    el('pv-msg').className = 'pv-msg';
    el('pv-device').value = get(K.device) || '';
    renderCurrent();
    loadStations();
    refreshLock();
    // FR-11.3 — ปลดล็อกเองเมื่อคลิปปิด ไม่ต้องปิด-เปิดแผงใหม่
    lockTimer = setInterval(refreshLock, 3000);
  }

  function close() {
    open = false;
    el('pv-scrim').classList.remove('show');
    el('pv-panel').classList.remove('show');
    if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
    if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
  }

  window.PackvideoPanel = {
    mount: function (o) {
      opts = o || {};
      var slot = document.querySelector('[data-packvideo-panel]');
      if (!slot) return;
      build();
      var b = document.createElement('button');
      b.id = 'pv-panel-btn';
      b.type = 'button';
      b.setAttribute('aria-label', 'ตั้งค่าและคู่มือ');
      // ไม่ใช้ icon เปล่า — คนหน้างานไม่ควรต้องเดาว่ากดแล้วเจออะไร
      b.innerHTML = '<span aria-hidden="true">⚙</span> ตั้งค่า · คู่มือ';
      b.onclick = show;
      slot.appendChild(b);
    },
    close: close,
  };
})();
