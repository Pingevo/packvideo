/**
 * ทดสอบกล้องแบบครบทาง — ใช้ทั้งหน้าตั้งค่าและหน้าต่างอัด (R5.2 · R5.3)
 *
 *   PackvideoCamTest.run(stream, { seconds: 3, station: 'desk-01' })
 *     .then(function (result) { ... })   // { ok, problems[], duration_sec, url }
 *
 * ใช้ตัวเลือก mime/bitrate เดียวกับการอัดจริง ไม่งั้นผ่านทดสอบแต่คลิปจริงพังได้
 */
(function (global) {
  'use strict';

  function pickMime() {
    var list = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    for (var i = 0; i < list.length; i++) {
      if (global.MediaRecorder && MediaRecorder.isTypeSupported(list[i])) return list[i];
    }
    return '';
  }

  function run(stream, opts) {
    opts = opts || {};
    var seconds = opts.seconds || 3;
    return new Promise(function (resolve, reject) {
      if (!stream) return reject(new Error('ยังไม่มีภาพจากกล้อง'));
      var track = stream.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') return reject(new Error('กล้องไม่ส่งภาพ (หลุดหรือถูกใช้โดยโปรแกรมอื่น)'));
      if (track.muted) return reject(new Error('กล้องเชื่อมต่ออยู่แต่ไม่มีภาพ (muted)'));

      var rec;
      try {
        rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: 1000000 });
      } catch (e) {
        return reject(new Error('เบราว์เซอร์อัดวิดีโอไม่ได้: ' + e.message));
      }
      var parts = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) parts.push(e.data); };
      rec.onerror = function (e) { reject(new Error('อัดไม่สำเร็จ: ' + (e.error ? e.error.message : 'error'))); };
      rec.onstop = function () {
        var blob = new Blob(parts, { type: rec.mimeType || 'video/mp4' });
        fetch('/api/camera-test' + (opts.station ? '?station=' + encodeURIComponent(opts.station) : ''), {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob,
        }).then(function (r) {
          return r.json().catch(function () { return { ok: false, problems: ['เซิร์ฟเวอร์ตอบผิดรูปแบบ (HTTP ' + r.status + ')'] }; });
        }).then(function (d) {
          if (d.error) d.problems = [d.error];
          resolve(d);
        }).catch(function (e) { reject(new Error('ส่งไฟล์ขึ้นเซิร์ฟเวอร์ไม่ได้: ' + e.message)); });
      };
      rec.start(1000);
      setTimeout(function () { try { rec.stop(); } catch (e) {} }, seconds * 1000);
    });
  }

  /** แสดงผลทดสอบในกล่องที่ให้มา พร้อมเล่นไฟล์ที่เซิร์ฟเวอร์เก็บไว้จริง */
  function render(box, result) {
    var ok = result && result.ok;
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    box.className = 'msg ' + (ok ? 'ok' : 'bad');
    box.innerHTML = (ok
      ? '<b>✅ กล้องใช้งานได้</b> — อัด ส่งขึ้นเซิร์ฟเวอร์ และเปิดไฟล์กลับมาได้ครบ'
      : '<b>❌ ทดสอบไม่ผ่าน</b><br>' + (result.problems || []).map(esc).join('<br>')) +
      (result.duration_sec != null ? '<br>ได้ภาพ ' + Number(result.duration_sec).toFixed(1) + ' วินาที · ' + (result.bytes / 1024).toFixed(0) + ' KB' : '') +
      (result.url ? '<video controls autoplay muted playsinline style="width:100%;max-width:360px;margin-top:8px;border-radius:8px;display:block" src="' + esc(result.url) + '"></video>' +
        '<div style="font-size:12px;opacity:.7;margin-top:4px">นี่คือไฟล์ที่เซิร์ฟเวอร์เก็บได้จริง — ตรวจว่าเห็นโต๊ะแพ็คชัด อ่านเลขบนกล่องออก</div>' : '');
  }

  global.PackvideoCamTest = { run: run, render: render };
})(window);
