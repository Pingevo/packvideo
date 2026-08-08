import { config } from '../config.js';
import { log } from '../log.js';

/**
 * แจ้งเตือนออก Telegram
 *
 * token มาจาก env เท่านั้น — sellcenter ฝัง bot token ไว้ในซอร์สที่
 * api/services/NotifyService.js ซึ่งเป็นสิ่งที่โปรเจกต์นี้จะไม่ทำตาม
 *
 * ถ้ายังไม่ได้ตั้ง token จะบันทึกลง log แทนการส่ง — ทดสอบตรรกะการเตือนได้
 * โดยไม่ต้องมี bot จริง และ **ไม่เงียบหายไปเฉยๆ**
 */

/** กันเตือนซ้ำ: เรื่องเดิมส่งได้ครั้งเดียวต่อ 30 นาที ไม่งั้นกลุ่มจะถูกสแปมจนไม่มีใครอ่าน */
const REPEAT_MS = 30 * 60 * 1000;
const lastSent = new Map();

const sent = [];   // เก็บไว้ให้หน้า monitor แสดงว่าเตือนอะไรไปแล้วบ้าง

export function alertHistory(limit = 20) {
  return sent.slice(-limit).reverse();
}

/**
 * @param {string} key เรื่องเดียวกันต้องใช้ key เดียวกัน เพื่อให้การกันซ้ำทำงาน
 * @param {string} text ข้อความที่คนอ่านแล้วรู้ว่าต้องทำอะไรต่อ
 * @param {{force?: boolean}} [opts]
 */
export async function alert(key, text, opts = {}) {
  const now = Date.now();
  const previous = lastSent.get(key);
  if (!opts.force && previous && now - previous < REPEAT_MS) return { skipped: 'ส่งไปแล้วเมื่อไม่นานนี้' };
  lastSent.set(key, now);

  const entry = { key, text, at: new Date().toISOString(), delivered: false };
  sent.push(entry);
  if (sent.length > 100) sent.shift();

  if (!config.telegram.botToken || !config.telegram.chatId) {
    log.warn({ alert_key: key }, `[แจ้งเตือน ยังไม่ได้ตั้ง Telegram] ${text}`);
    return { skipped: 'ยังไม่ได้ตั้ง TELEGRAM_BOT_TOKEN หรือ TELEGRAM_CHAT_ID' };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: `[packvideo] ${text}`,
        disable_notification: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    entry.delivered = res.ok;
    if (!res.ok) log.error({ status: res.status, alert_key: key }, 'ส่ง Telegram ไม่สำเร็จ');
    return { delivered: res.ok };
  } catch (err) {
    // การแจ้งเตือนล้มเหลวต้องไม่ทำให้งานที่เรียกมันล้มตาม
    log.error({ err: err.message, alert_key: key }, 'ส่ง Telegram ไม่สำเร็จ');
    return { delivered: false, error: err.message };
  }
}
