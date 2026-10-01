/**
 * ตัวตนผู้ใช้บนทุกหน้าของ packvideo (R3)
 *
 * - รู้ว่าใครล็อกอินจาก /api/me — ไม่ถามชื่อด้วย prompt() อีกแล้ว (R3.3)
 * - request ไหนโดน 401 (session หมด) → พาไปหน้าล็อกอิน **เว้นแต่หน้ากำลังทำงานสำคัญอยู่**
 *   (หน้าต่างอัดกำลังอัด/ส่งชิ้นค้าง) ซึ่งการเด้งออกคือทำคลิปขาด — กรณีนั้นแค่แจ้งเตือน
 *
 *   <script src="/session.js"></script>
 *   PackvideoSession.me().then(function (u) { ... })     // u = { name, emp_id } หรือ null
 *   PackvideoSession.setBusy(function () { return true; }) // หน้าที่ห้ามเด้งออกกลางคัน
 */
(function (global) {
  'use strict';

  var busy = function () { return false; };
  var mePromise = null;
  var redirecting = false;
  var origFetch = global.fetch ? global.fetch.bind(global) : null;

  function loginUrl() {
    return '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
  }

  function onUnauthorized() {
    if (redirecting) return;
    if (busy()) {
      banner('หมดเวลาเข้าสู่ระบบ — ล็อกอิน sellcenter ใหม่ (ระบบยังอัดต่อให้ ไม่ต้องปิดหน้านี้)');
      return;
    }
    redirecting = true;
    location.href = loginUrl();
  }

  function banner(text) {
    var el = document.getElementById('pv-session-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pv-session-banner';
      el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483600;background:#b3261e;color:#fff;' +
        'padding:10px 14px;font:600 14px system-ui,-apple-system,"Noto Sans Thai",sans-serif;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  if (origFetch) {
    global.fetch = function (input, init) {
      return origFetch(input, init).then(function (res) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var same = url.charAt(0) === '/' || url.indexOf(location.origin) === 0;
          if (res.status === 401 && same && url.indexOf('/api/me') === -1) onUnauthorized();
        } catch (e) {}
        return res;
      });
    };
  }

  global.PackvideoSession = {
    me: function () {
      if (!mePromise) {
        mePromise = (origFetch || global.fetch)('/api/me', { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d.auth_enforced && !d.user && !busy()) onUnauthorized();
            return d.user || null;
          })
          .catch(function () { return null; });
      }
      return mePromise;
    },
    setBusy: function (fn) { busy = fn; },
    loginUrl: loginUrl,
    /** วางชื่อผู้ใช้ลงทุก element ที่มี data-packvideo-user */
    render: function () {
      return this.me().then(function (u) {
        [].forEach.call(document.querySelectorAll('[data-packvideo-user]'), function (el) {
          el.textContent = u ? u.name : '';
          el.title = u ? 'เข้าสู่ระบบด้วยบัญชี sellcenter' : '';
        });
        return u;
      });
    },
  };
})(window);
