/**
 * คิวชิ้นวิดีโอที่ทนเน็ตขาดและทนหน้าปิด (NFR-1.4)
 *
 * เก็บทุกชิ้นลง IndexedDB ทันทีที่ MediaRecorder ปล่อยออกมา แล้วค่อยทยอยส่ง
 * ถ้าเก็บไว้ในหน่วยความจำอย่างเดียว เน็ตขาดตอนเลิกกะแล้วพนักงานปิดหน้าต่าง
 * = คลิปหายทั้งกอง โดยไม่มีใครรู้จนกว่าจะถึงวันที่ต้องใช้
 *
 * ใช้เป็น window.ChunkQueue — แยกไฟล์จาก rec.html เพื่อให้ทดสอบเองได้โดยไม่ต้องมีกล้อง
 */
(function (global) {
  'use strict';

  var DB_NAME = 'packvideo';
  var DB_VERSION = 1;
  var STORE = 'chunks';
  var MAX_BACKOFF_MS = 30000;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // key เรียงตาม clip แล้วตามลำดับชิ้น — ส่งตามลำดับที่อัดมาโดยไม่ต้องมี index เพิ่ม
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, mode);
      var store = t.objectStore(STORE);
      var out = fn(store);
      t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error); };
    });
  }

  function keyOf(clipId, seq) {
    return clipId + '#' + String(seq).padStart(6, '0');
  }

  function ChunkQueue(opts) {
    opts = opts || {};
    this.endpoint = opts.endpoint || '/api/clip';
    this.onchange = opts.onchange || function () {};
    this.onlog = opts.onlog || function () {};
    this.db = null;
    this.sending = false;
    this.backoff = 0;
    this.timer = null;
    this.stopped = false;
  }

  ChunkQueue.prototype.init = function () {
    var self = this;
    return openDb().then(function (db) {
      self.db = db;
      // มีชิ้นค้างจากรอบก่อนไหม — หน้าถูกปิดหรือเบราว์เซอร์แครชกลางกะ
      return self.count();
    }).then(function (n) {
      if (n > 0) self.onlog('พบชิ้นวิดีโอค้างจากรอบก่อน ' + n + ' ชิ้น — กำลังส่งต่อ');
      self.notify();
      self.pump();
      return n;
    });
  };

  ChunkQueue.prototype.push = function (clipId, seq, blob) {
    var self = this;
    if (!this.db) return Promise.reject(new Error('คิวยังไม่พร้อม'));
    return tx(this.db, 'readwrite', function (store) {
      store.put({ id: keyOf(clipId, seq), clip_id: clipId, seq: seq, blob: blob, at: Date.now() });
    }).then(function () {
      self.notify();
      self.pump();
    });
  };

  ChunkQueue.prototype.count = function () {
    if (!this.db) return Promise.resolve(0);
    return tx(this.db, 'readonly', function (store) { return store.count(); });
  };

  /** ชิ้นที่ต้องส่งถัดไป — เรียงตาม key จึงได้ตามลำดับที่อัดมา */
  ChunkQueue.prototype.next = function () {
    if (!this.db) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      var t = this.db.transaction(STORE, 'readonly');
      var req = t.objectStore(STORE).openCursor();
      req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
      req.onerror = function () { reject(req.error); };
    }.bind(this));
  };

  ChunkQueue.prototype.remove = function (id) {
    return tx(this.db, 'readwrite', function (store) { store.delete(id); });
  };

  /** ทิ้งทุกชิ้นของคลิปที่ถูก abort — ไม่ต้องเสียแบนด์วิดท์ส่งของที่ไม่มีใครเก็บ */
  ChunkQueue.prototype.dropClip = function (clipId) {
    var self = this;
    if (!this.db) return Promise.resolve(0);
    return new Promise(function (resolve, reject) {
      var removed = 0;
      var t = self.db.transaction(STORE, 'readwrite');
      var store = t.objectStore(STORE);
      var req = store.openCursor();
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        if (cur.value.clip_id === clipId) { cur.delete(); removed++; }
        cur.continue();
      };
      t.oncomplete = function () { self.notify(); resolve(removed); };
      t.onerror = function () { reject(t.error); };
    });
  };

  ChunkQueue.prototype.notify = function () {
    var self = this;
    this.count().then(function (n) { self.onchange(n); }).catch(function () {});
  };

  ChunkQueue.prototype.pump = function () {
    var self = this;
    if (this.sending || this.stopped || !this.db) return;
    this.sending = true;

    this.next().then(function (item) {
      if (!item) { self.sending = false; return; }

      return fetch(self.endpoint + '/' + encodeURIComponent(item.clip_id) + '/chunk/' + item.seq, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: item.blob,
      }).then(function (res) {
        if (res.ok) return self.remove(item.id).then(function () { return 'sent'; });
        if (res.status === 409) {
          // เซิร์ฟเวอร์บอกว่าไม่ต้องส่งแล้ว (คลิปถูกทิ้งหรือปิดไปแล้ว) — ทิ้งชิ้นนี้
          self.onlog('เซิร์ฟเวอร์ไม่รับชิ้นของ ' + item.clip_id + ' แล้ว — ทิ้งทั้งคลิป');
          return self.dropClip(item.clip_id).then(function () { return 'dropped'; });
        }
        // 5xx หรืออื่นๆ = ปัญหาชั่วคราว เก็บไว้ส่งใหม่
        throw new Error('HTTP ' + res.status);
      }).then(function (outcome) {
        self.sending = false;
        self.backoff = 0;
        self.notify();
        if (outcome) self.pump();   // ส่งชิ้นถัดไปทันที
      });
    }).catch(function (err) {
      self.sending = false;
      // ถอยเป็นขั้น กัน retry ถี่จนกินแบตและกวน log ตอนเน็ตขาดยาว
      self.backoff = Math.min(self.backoff ? self.backoff * 2 : 2000, MAX_BACKOFF_MS);
      self.onlog('ส่งไม่สำเร็จ (' + err.message + ') — ลองใหม่ใน ' + (self.backoff / 1000) + ' วินาที');
      clearTimeout(self.timer);
      self.timer = setTimeout(function () { self.pump(); }, self.backoff);
    });
  };

  ChunkQueue.prototype.stop = function () {
    this.stopped = true;
    clearTimeout(this.timer);
  };

  ChunkQueue.prototype.resume = function () {
    this.stopped = false;
    this.backoff = 0;
    this.pump();
  };

  global.ChunkQueue = ChunkQueue;
})(window);
