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
    dbName: str('MONGO_DB', 'packvideo'),
  },

  storage: {
    // ล้อ convention FILESTORE_PATH ของระบบเดิม แต่คนละ path คนละดิสก์
    path: str('PACK_VIDEO_PATH', './data/pack_video'),
    // ระดับการใช้ดิสก์ตาม design §9.2
    warnPct: int('DISK_WARN_PCT', 75),
    squeezePct: int('DISK_SQUEEZE_PCT', 85),
    stopPct: int('DISK_STOP_PCT', 90),
  },

  retentionDays: int('RETENTION_DAYS', 30),

  // origin ของระบบเดิมที่อนุญาตให้ยิงสัญญาณเข้ามา — ระบุตรงๆ ไม่ใช้ '*'
  allowedOrigins: list('ALLOWED_ORIGINS'),

  telegram: {
    botToken: str('TELEGRAM_BOT_TOKEN'),
    chatId: str('TELEGRAM_CHAT_ID'),
  },
};

/**
 * ตรวจค่าที่ขาดไม่ได้บน production — ล้มตั้งแต่ตอน boot ดีกว่าไปพังตอนมีคนใช้งาน
 * @returns {string[]} รายการปัญหา — ว่างแปลว่าผ่าน
 */
export function validateConfig() {
  const problems = [];
  if (config.env !== 'production') return problems;

  if (!process.env.MONGO_URL) problems.push('MONGO_URL ไม่ได้ตั้ง');
  if (!process.env.PACK_VIDEO_PATH) problems.push('PACK_VIDEO_PATH ไม่ได้ตั้ง');
  if (!config.allowedOrigins.length) {
    problems.push('ALLOWED_ORIGINS ไม่ได้ตั้ง — หน้าเดิมจะยิงสัญญาณเข้ามาไม่ได้');
  }
  if (config.storage.warnPct >= config.storage.stopPct) {
    problems.push('DISK_WARN_PCT ต้องน้อยกว่า DISK_STOP_PCT');
  }
  return problems;
}
