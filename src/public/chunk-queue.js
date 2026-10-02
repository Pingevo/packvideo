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

  /**
   * key กำหนดลำดับการส่ง (next() หยิบ key น้อยสุด) — ต้องเรียงตามเวลาที่คลิปเริ่ม แล้วตามลำดับชิ้น
   *
   * เดิมเป็น clipId#seq ซึ่งเรียงตามรหัสคลิปที่เป็นตัวสุ่ม พอเน็ตช้าจนคิวสะสม คลิปใหม่ที่รหัสน้อยกว่า
   * แซงคลิปเก่าที่ยังส่งไม่ครบ คลิปเก่ารอจนเซิร์ฟเวอร์หมดเวลาแล้วโดน 409 (2026-10-01 13:26–14:11 · 9 คลิป)
   * ขึ้นต้นด้วย 't' ให้ key รุ่นเก่าที่ยังค้างในเครื่อง ('c_…') เรียงก่อนและถูกส่งก่อน ซึ่งถูกเพราะเก่ากว่า
   */
  function keyOf(order, clipId, seq) {
    // ชิ้นแรกคือหัวไฟล์ ~760 ไบต์ ไม่มีภาพ แต่เป็นหลักฐานว่าหน้าต่างอัดเริ่มอัดคลิปนี้แล้ว — ให้ลัดคิวไปก่อน
    // ถ้ารอต่อท้ายคิวที่ค้าง เซิร์ฟเวอร์ไม่เห็นอะไรเกิน 8 วินาทีแล้วเตือน "ไม่ได้บันทึก" ทั้งที่อัดอยู่
    // แถบแดงบอกให้กดเปิดหน้าต่างอัดใหม่ ซึ่งปิดคลิปที่กำลังอัดแล้วทำให้วิดีโอหายจริง · ส่งแทบไม่เสียเวลา
    var lane = seq === 0 ? 'a' : 't';
    return lane + String(order).padStart(15, '0') + '|' + clipId + '#' + String(seq).padStart(6, '0');
  }

  /**
   * สองช่องทางที่ส่งพร้อมกันได้ — หัวไฟล์ (ชิ้นที่ 0 · key 'a…') กับชิ้นภาพ (key 't…' และ 'c_…' รุ่นเก่า)
   * ช่องเดียวส่งทีละชิ้น ตอนเน็ตช้าชิ้นภาพที่กำลังส่งค้างได้ 10 วินาทีขึ้นไป ลัดคิวอย่างเดียวไม่พอ
   * หัวไฟล์ของคลิปใหม่ยังต้องรอชิ้นนั้นส่งจบ (ทดสอบแล้วยังเตือนผิด) จึงต้องมีช่องของตัวเอง
   */
  var LANES = {
    header: function () { return IDBKeyRange.bound('a', 'a\uffff'); },
    media: function () { return IDBKeyRange.lowerBound('b'); },
  };

  function ChunkQueue(opts) {
    opts = opts || {};
    this.endpoint = opts.endpoint || '/api/clip';
    this.onchange = opts.onchange || function () {};
    this.onlog = opts.onlog || function () {};
    this.db = null;
    this.lanes = {
      header: { sending: false, backoff: 0, timer: null },
      media: { sending: false, backoff: 0, timer: null },
    };
    this.stopped = false;
    this.order = {};      // clipId → เวลาที่ได้ชิ้นแรกของคลิปนั้น (คลิปของโต๊ะหนึ่งเริ่มทีละคลิป จึงเท่ากับลำดับเริ่มอัด)
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
    var order = this.order[clipId] || (this.order[clipId] = Date.now());
    return tx(this.db, 'readwrite', function (store) {
      store.put({ id: keyOf(order, clipId, seq), clip_id: clipId, seq: seq, blob: blob, at: Date.now() });
    }).then(function () {
      self.notify();
      self.pump();
    });
  };

  ChunkQueue.prototype.count = function () {
    if (!this.db) return Promise.resolve(0);
    return tx(this.db, 'readonly', function (store) { return store.count(); });
  };

  /** นับจำนวนชิ้นที่ค้างอยู่ของคลิปหนึ่งตัว */
  ChunkQueue.prototype.countClip = function (clipId) {
    if (!this.db) return Promise.resolve(0);
    var self = this;
    return new Promise(function (resolve, reject) {
      var count = 0;
      var t = self.db.transaction(STORE, 'readonly');
      var store = t.objectStore(STORE);
      var req = store.openCursor();
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return;
        if (cur.value.clip_id === clipId) count++;
        cur.continue();
      };
      t.oncomplete = function () { resolve(count); };
      t.onerror = function () { reject(t.error); };
    });
  };

  /** รอให้ทุกชิ้นของ clipId ถูกส่งสำเร็จหรือถูกนำออกจากคิว */
  ChunkQueue.prototype.flush = function (clipId, timeoutMs) {
    var self = this;
    timeoutMs = timeoutMs || 10000;
    var t0 = Date.now();
    return new Promise(function (resolve) {
      function check() {
        self.countClip(clipId).then(function (n) {
          if (n === 0 && !self.busy()) {
            resolve();
          } else if (Date.now() - t0 > timeoutMs) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        }).catch(function () { resolve(); });
      }
      self.pump();
      check();
    });
  };

  ChunkQueue.prototype.busy = function () {
    return this.lanes.header.sending || this.lanes.media.sending;
  };

  /** ชิ้นที่ต้องส่งถัดไปของช่องทางนั้น — เรียงตาม key จึงได้ตามลำดับที่อัดมา */
  ChunkQueue.prototype.next = function (lane) {
    if (!this.db) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      var t = this.db.transaction(STORE, 'readonly');
      var req = t.objectStore(STORE).openCursor(LANES[lane]());
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
    this.pumpLane('header');
    this.pumpLane('media');
  };

  ChunkQueue.prototype.pumpLane = function (name) {
    var self = this;
    var lane = this.lanes[name];
    if (lane.sending || this.stopped || !this.db) return;
    lane.sending = true;

    this.next(name).then(function (item) {
      if (!item) { lane.sending = false; return; }

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
        lane.sending = false;
        lane.backoff = 0;
        self.notify();
        if (outcome) self.pumpLane(name);   // ส่งชิ้นถัดไปทันที
      });
    }).catch(function (err) {
      lane.sending = false;
      // ถอยเป็นขั้น กัน retry ถี่จนกินแบตและกวน log ตอนเน็ตขาดยาว
      lane.backoff = Math.min(lane.backoff ? lane.backoff * 2 : 2000, MAX_BACKOFF_MS);
      self.onlog('ส่งไม่สำเร็จ (' + err.message + ') — ลองใหม่ใน ' + (lane.backoff / 1000) + ' วินาที');
      clearTimeout(lane.timer);
      lane.timer = setTimeout(function () { self.pumpLane(name); }, lane.backoff);
    });
  };

  ChunkQueue.prototype.stop = function () {
    this.stopped = true;
    clearTimeout(this.lanes.header.timer);
    clearTimeout(this.lanes.media.timer);
  };

  ChunkQueue.prototype.resume = function () {
    this.stopped = false;
    this.lanes.header.backoff = 0;
    this.lanes.media.backoff = 0;
    this.pump();
  };

  global.ChunkQueue = ChunkQueue;
})(window);
