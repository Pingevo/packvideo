/**
 * ค่าตั้งทั้งหมดมาจาก environment เท่านั้น
 *
 * ห้าม hardcode ความลับลงซอร์สเด็ดขาด — sellcenter มี bot token ของ Telegram
 * ฝังอยู่ใน api/services/NotifyService.js ซึ่งเป็นสิ่งที่โปรเจกต์นี้จะไม่ทำตาม
 */

function str(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback === undefined) return null;
    return fallback;
  }
  return v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(name) {
  const v = str(name, '');
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  env: str('NODE_ENV', 'development'),
  port: int('PORT', 1338),
  logLevel: str('LOG_LEVEL', str('NODE_ENV', 'development') === 'production' ? 'info' : 'debug'),

  mongo: {
    url: str('MONGO_URL', 'mongodb://127.0.0.1:27017'),
    // คนละ database กับ sellcenter (`wallet`) ตามหลัก "แยกภาระ" ใน design §2
    dbName: str('MONGO_DB', 'packVideo'),
  },

  storage: {
    // ล้อ convention FILESTORE_PATH ของระบบเดิม แต่คนละ path คนละดิสก์
    path: str('PACK_VIDEO_PATH', './data/pack_video'),
    // ระดับการใช้ดิสก์ตาม design §9.2
    warnPct: int('DISK_WARN_PCT', 75),
    squeezePct: int('DISK_SQUEEZE_PCT', 85),
    stopPct: int('DISK_STOP_PCT', 90),
  },

  // path ของ ffmpeg — ปกติอยู่บน PATH อยู่แล้ว (Docker) แต่บนเครื่องพัฒนาบางเครื่อง
  // ตัวที่อยู่บน PATH เป็นบิลด์ย่อที่ไม่มีฟิลเตอร์ drawtext จึงต้องชี้ไปตัวอื่นได้
  ffmpeg: {
    bin: str('FFMPEG_PATH', 'ffmpeg'),
    probe: str('FFPROBE_PATH', 'ffprobe'),
  },

  retentionDays: int('RETENTION_DAYS', 30),

  // เพดานความยาวคลิป — ปรับได้ช่วง pilot โดยไม่ต้องแก้โค้ด ดู clips.js §เพดานความปลอดภัย
  clipMaxMinutes: int('CLIP_MAX_MINUTES', 15),

  // รายชื่อโต๊ะที่เลือกได้ในหน้าตั้งค่า — คลังมี 6 โต๊ะขึ้นไป
  stations: (() => {
    const listed = list('STATIONS');
    if (listed.length) return listed;
    const n = int('STATION_COUNT', 6);
    return Array.from({ length: n }, (_, i) => `desk-${String(i + 1).padStart(2, '0')}`);
  })(),

  // origin ของระบบเดิมที่อนุญาตให้ยิงสัญญาณเข้ามา — ระบุตรงๆ ไม่ใช้ '*'
  allowedOrigins: list('ALLOWED_ORIGINS'),

  telegram: {
    botToken: str('TELEGRAM_BOT_TOKEN'),
    chatId: str('TELEGRAM_CHAT_ID'),
  },
};

// คีย์ทั้งหมดที่ระบบรู้จัก — ใช้ดักคีย์ที่พิมพ์ผิด
const KNOWN_KEYS = new Set([
  'NODE_ENV', 'PORT', 'LOG_LEVEL',
  'MONGO_URL', 'MONGO_DB',
  'PACK_VIDEO_PATH', 'DISK_WARN_PCT', 'DISK_SQUEEZE_PCT', 'DISK_STOP_PCT',
  'RETENTION_DAYS', 'CLIP_MAX_MINUTES', 'ALLOWED_ORIGINS', 'STATIONS', 'STATION_COUNT',
  'FFMPEG_PATH', 'FFPROBE_PATH',
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
]);

/**
 * เตือนเรื่องที่ทำให้เสียเวลาไล่หาสาเหตุ แต่ยังไม่ถึงกับหยุดระบบ
 *
 * สองข้อนี้เคยเกิดจริงตอนตั้งเครื่องพัฒนา: พิมพ์ `MMONGO_URL` เกินมาหนึ่งตัว
 * แล้วระบบเงียบไปเฉยๆ เหมือนไม่ได้ตั้งค่า และวางค่าตัวอย่าง `<รหัสผ่าน>`
 * ทิ้งไว้โดยไม่ได้แทนที่ ซึ่งดูเผินๆ เหมือนตั้งค่าครบแล้ว
 * @returns {string[]}
 */
/** ระยะห่างของการแก้ไข — จำนวนตัวอักษรที่ต้องเพิ่ม/ลบ/เปลี่ยน เพื่อให้สองคำเท่ากัน */
function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99;   // ต่างกันมากเกินกว่าจะเป็นการพิมพ์ผิด
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * ชื่อฐานข้อมูลที่อยู่ใน MONGO_URL — ส่วนหลัง host ก่อนเครื่องหมายคำถาม
 * ตัดเฉพาะส่วนนี้ ไม่แตะ credential ที่อยู่หน้า @ จึงไม่มีทางหลุดออกไปกับข้อความเตือน
 */
function dbNameInUrl(url) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]*)/.exec(url ?? '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]) || null; } catch { return m[1] || null; }
}

export function configWarnings() {
  const warnings = [];

  // ตั้ง MONGO_URL ไว้ฐานข้อมูลหนึ่งแต่ MONGO_DB ชี้อีกฐานข้อมูลหนึ่ง = เชื่อมต่อผ่าน
  // แต่ผู้ใช้ไม่มีสิทธิ์ในฐานข้อมูลที่เปิดจริง แล้วพังตอนเขียนครั้งแรกด้วย "not authorized"
  // ซึ่ง repo.js กลืน error ไว้ไม่ให้ล้ม process — อาการที่เห็นคือระบบเงียบ ไม่มีคลิปโผล่มาเลย
  // เจอง่ายเป็นพิเศษเพราะชื่อฐานข้อมูลแยกตัวพิมพ์เล็กใหญ่: packVideo ไม่เท่ากับ packvideo
  const urlDb = dbNameInUrl(process.env.MONGO_URL);
  if (urlDb && urlDb !== config.mongo.dbName) {
    warnings.push(
      `MONGO_URL ชี้ฐานข้อมูล ${urlDb} แต่ MONGO_DB คือ ${config.mongo.dbName} — ` +
      'ต้องเป็นชื่อเดียวกัน (แยกตัวพิมพ์เล็กใหญ่) ไม่งั้นเขียนฐานข้อมูลไม่ได้',
    );
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (!KNOWN_KEYS.has(key)) {
      // ต้องเป็นการ "พิมพ์ผิด" จริงๆ คือต่างกันไม่เกิน 2 ตัวอักษร
      // การเทียบแบบ substring ใช้ไม่ได้ — PATH ของระบบจะไปเข้าคู่กับ PACK_VIDEO_PATH
      // และ _ จะเข้าคู่กับทุกคีย์ที่มีขีดล่าง
      if (key.length < 4) continue;
      const near = [...KNOWN_KEYS].find((known) => editDistance(key, known) <= 2);
      if (near) warnings.push(`มีคีย์ ${key} ซึ่งต่างจาก ${near} แค่ไม่กี่ตัวอักษร — พิมพ์ผิดหรือเปล่า`);
      continue;
    }
    if (typeof value === 'string' && /<[^>]+>/.test(value)) {
      warnings.push(`${key} ยังมีค่าตัวอย่างในวงเล็บมุมอยู่ — ยังไม่ได้แทนที่ด้วยค่าจริง`);
    }
  }
  return warnings;
}

/**
 * ตรวจค่าที่ขาดไม่ได้บน production — ล้มตั้งแต่ตอน boot ดีกว่าไปพังตอนมีคนใช้งาน
 * @returns {string[]} รายการปัญหา — ว่างแปลว่าผ่าน
 */
export function validateConfig() {
  const problems = [];

  // บนเครื่องพัฒนา ค่าที่ยังไม่ได้ตั้งเป็นเรื่องปกติ — เตือนพอ ไม่หยุดระบบ
  // เพราะบริการต้องขึ้นได้แม้ยังต่อ Mongo ไม่ได้ ไม่งั้นเสียหน้า monitor ไปด้วย
  if (config.env !== 'production') return problems;

  // บน production ค่าตัวอย่างที่ยังไม่ได้แทนที่ = ตั้งค่าไม่เสร็จ ต้องหยุด
  problems.push(...configWarnings().filter((w) => w.includes('วงเล็บมุม')));

  if (!process.env.MONGO_URL) problems.push('MONGO_URL ไม่ได้ตั้ง');
  if (!process.env.PACK_VIDEO_PATH) problems.push('PACK_VIDEO_PATH ไม่ได้ตั้ง');
  if (!config.allowedOrigins.length) {
    problems.push('ALLOWED_ORIGINS ไม่ได้ตั้ง — หน้าเดิมจะยิงสัญญาณเข้ามาไม่ได้');
  }
  if (config.storage.warnPct >= config.storage.stopPct) {
    problems.push('DISK_WARN_PCT ต้องน้อยกว่า DISK_STOP_PCT');
  }
  // ต้องสูงกว่าเพดานเงียบ 4 นาทีของ clips.js พอสมควร ไม่งั้นเพดานนี้จะไปตัดคลิปที่แพ็คนาน
  // ตามปกติทิ้ง แทนที่จะจับเฉพาะคลิปที่ไม่มีการสแกนปิดจริงๆ
  if (config.clipMaxMinutes < 5) {
    problems.push('CLIP_MAX_MINUTES ต้องไม่น้อยกว่า 5 — ต่ำกว่านี้จะตัดคลิปที่แพ็คนานตามปกติทิ้ง');
  }
  return problems;
}
