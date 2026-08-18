import { Router } from 'express';
import { config } from '../config.js';

export const bridgeRouter = Router();

/**
 * /bridge.html — ให้หน้าแพ็คของ sellcenter (คนละ origin) อ่านค่า station_id/token
 * ที่ setup.html เก็บไว้ใน localStorage ของ origin นี้ได้
 *
 * ใช้ยังไง (ฝั่ง sellcenter):
 *   <iframe hidden src="https://pack.digital.in.th/bridge.html"></iframe>
 *   window.addEventListener('message', function (ev) {
 *     if (ev.origin !== 'https://pack.digital.in.th') return;
 *     if (!ev.data || ev.data.source !== 'packvideo-bridge') return;
 *     // ev.data.station_id, ev.data.token
 *   });
 *
 * **ทำไมถึงเป็น route ไม่ใช่ไฟล์นิ่งใน public/**
 * ตอนแรกไฟล์นี้ hardcode รายชื่อ origin ไว้ในตัวเอง 16 อัน พร้อมคอมเมนต์ว่า
 * "ต้องแก้ให้ตรงกับ ALLOWED_ORIGINS ใน .env เสมอ" — ซึ่งตอนตรวจพบว่า**ไม่ตรงอยู่แล้ว**
 * (.env มี digital.in.th อันเดียว ไฟล์มี 16 อัน) แปลว่ามันยื่น token ให้ 15 origin
 * ที่เซิร์ฟเวอร์เองไม่ยอมรับ และไม่มีอันไหนเป็นหน้าแพ็คด้วยซ้ำ
 *
 * แหล่งความจริงจึงต้องมีที่เดียวคือ ALLOWED_ORIGINS แก้ .env แล้วรีสตาร์ทจบ
 * ไม่มีรายชื่อให้ดริฟต์อีก
 */
bridgeRouter.get('/bridge.html', (_req, res) => {
  const origins = config.allowedOrigins;

  // ต้องประกาศให้ชัดว่าใครฝังหน้านี้ได้บ้าง — ทั้งระบบตั้ง frame-ancestors 'none' ไว้
  // หน้านี้เป็นข้อยกเว้นเดียว และต้องถอน X-Frame-Options ที่ตั้งไว้ก่อนหน้าออกด้วย
  // เพราะ DENY ไม่มีรูปแบบ allowlist และเบราว์เซอร์เก่าจะบล็อก iframe ทิ้ง
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    `frame-ancestors ${origins.length ? origins.join(' ') : "'none'"}`,
  );
  // แก้ ALLOWED_ORIGINS แล้วต้องมีผลทันทีที่รีสตาร์ท ไม่ใช่รอแคชหมดอายุ
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(page(origins));
});

function page(origins) {
  return `<!doctype html>
<html lang="th">
<head><meta charset="utf-8"><title>packvideo bridge</title></head>
<body>
<script>
(function () {
  'use strict';

  var K = { station: 'packvideo.station_id', token: 'packvideo.token' };

  // ฉีดจาก ALLOWED_ORIGINS ตอนเสิร์ฟ — ห้ามแก้ที่นี่ ให้ไปแก้ .env
  var ALLOWED_TARGETS = ${JSON.stringify(origins)};

  function send() {
    var target = null;
    try {
      // referrer คือ URL เต็มของหน้าที่ฝัง iframe นี้ — ใช้หา origin ของผู้ฝัง
      // ต้องเทียบกับ allowlist ก่อนเสมอ ห้ามเชื่อ document.referrer เฉยๆ แล้วยิงกลับไป
      // เพราะนั่นเท่ากับส่ง token ให้ origin ไหนก็ได้ที่ดันมาฝัง iframe นี้
      var ref = document.referrer ? new URL(document.referrer).origin : null;
      if (ref && ALLOWED_TARGETS.indexOf(ref) !== -1) target = ref;
    } catch (e) { /* referrer อ่านไม่ได้ — ไม่ส่งอะไรทั้งนั้น ปลอดภัยไว้ก่อน */ }

    if (!target) return;   // ผู้ฝังไม่อยู่ใน allowlist — เงียบไปเฉยๆ

    var stationId = null, token = null;
    try {
      stationId = localStorage.getItem(K.station);
      token = localStorage.getItem(K.token);
    } catch (e) { /* localStorage ปิด — ส่งค่าว่างไป ฝั่ง sellcenter จะ fallback เอง */ }

    if (window.parent && window.parent !== window) {
      // ระบุ target origin ตรงๆ ห้ามใช้ '*' — ด่านจริงอยู่ตรงนี้ เบราว์เซอร์จะไม่ส่ง
      // ให้ frame ที่ origin ไม่ตรง ต่อให้ตรรกะหา origin ข้างบนพลาด
      window.parent.postMessage(
        { source: 'packvideo-bridge', station_id: stationId, token: token },
        target,
      );
    }
  }

  send();
})();
</script>
</body>
</html>
`;
}
