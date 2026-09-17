import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';

/**
 * ล็อกอินด้วยบัญชี sellcenter (R3 · มติเจ้าของ 17 ก.ย. 2026: ทุกบัญชี sellcenter ใช้ได้ทุกอย่าง)
 *
 * ไม่ต้องมีหน้าล็อกอินของเราเอง — sellcenter ตั้ง cookie `token` (JWT HS256) ให้ทั้งโดเมน
 * `.digital.in.th` อยู่แล้ว (AuthenController) เบราว์เซอร์จึงส่งมันมาที่ pack.digital.in.th ทุก request
 * เราแค่ตรวจลายเซ็นด้วย secret ตัวเดียวกับ sellcenter (api/lib/JwtSecret.js)
 *
 * **ทำไมต้องออก session ของเราเองต่อ (`pv_session`)** — token ของ sellcenter หมดอายุ 9 ชั่วโมง
 * แต่หน้าต่างอัดเปิดค้างทั้งกะและอาจยาวกว่านั้น ถ้าพึ่ง token อย่างเดียว ชิ้นวิดีโอจะโดน 401
 * กลางกะแล้วคลิปว่างทั้งบ่าย (R3.4) · session ของเรายืดอายุเองทุกครั้งที่ถูกใช้ (heartbeat
 * ทุก 30 วินาทีของหน้าต่างอัดพอให้ไม่หมดตลอดกะ) และหมดเองถ้าไม่มีใครใช้เกิน SESSION_IDLE_HOURS
 *
 * ไม่ต้องพึ่ง library — ตรวจ HS256 ด้วย crypto ตรงๆ รับเฉพาะ alg HS256 เท่านั้น
 * (กันช่องโหว่ alg=none / สลับ alg ที่ library รุ่นเก่าเคยมี)
 */

const COOKIE = 'pv_session';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** ตรวจ JWT ของ sellcenter · คืน payload หรือ null */
export function verifySellcenterToken(token, secret = config.auth.jwtSecret, now = Date.now()) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256') return null;
  const sig = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!safeEqual(sig, parts[2])) return null;
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) return null;
  if (!payload.name && !payload.emp_id) return null;
  return payload;
}

function sessionKey() {
  // แยก key ของ session ออกจาก secret ของ sellcenter — ถ้าหลุดอันหนึ่งจะปลอมอีกอันไม่ได้โดยตรง
  return crypto.createHmac('sha256', config.auth.jwtSecret ?? '').update('packvideo-session-v1').digest();
}

export function signSession(user, now = Date.now()) {
  const body = b64url(JSON.stringify({
    emp_id: user.emp_id ?? null,
    name: user.name ?? null,
    iat: now,
    exp: now + config.auth.sessionIdleHours * 3600_000,
  }));
  const sig = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(value, now = Date.now()) {
  if (!value || !config.auth.jwtSecret) return null;
  const [body, sig] = String(value).split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  if (!safeEqual(want, sig)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return s.exp > now ? s : null;
  } catch {
    return null;
  }
}

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function setSessionCookie(req, res, user) {
  const secure = req.secure || config.env === 'production';
  res.append('Set-Cookie', [
    `${COOKIE}=${signSession(user)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.auth.sessionIdleHours * 3600}`,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; '));
}

/**
 * หาว่าใครเรียก — ไม่บังคับ แค่ติด req.user ไว้ถ้ารู้
 *
 * ใช้ทุก request รวมถึง /signal เพื่อให้ชื่อพนักงานในคลิปมาจากบัญชีที่ล็อกอินจริง
 * แทนข้อความบนหน้าเว็บที่แก้ได้ (F11)
 */
export function identify(req, res, next) {
  req.user = null;
  if (!config.auth.jwtSecret) return next();

  const cookies = readCookies(req);
  const token = verifySellcenterToken(cookies.token);
  const session = verifySession(cookies[COOKIE]);

  if (token) {
    req.user = { emp_id: token.emp_id ?? null, name: token.name ?? null, via: 'sellcenter' };
  } else if (session) {
    req.user = { emp_id: session.emp_id, name: session.name, via: 'session' };
  }

  // ยืดอายุ session เมื่อผ่านไปเกิน 10 นาทีจากครั้งก่อน — ไม่ต้องเขียน cookie ทุก request
  // (ชิ้นวิดีโอวิ่งเข้ามาทุกวินาที) แต่ถี่พอที่หน้าต่างอัดเปิดค้างจะไม่มีวันหมด
  if (req.user && (!session || Date.now() - session.iat > 10 * 60_000 || session.name !== req.user.name)) {
    try { setSessionCookie(req, res, req.user); } catch (err) { log.warn({ err: err.message }, 'ตั้ง session ไม่สำเร็จ'); }
  }
  next();
}

/**
 * เส้นทางที่ไม่ต้องล็อกอิน
 *
 * - `/signal` `/hook.js` `/bridge.html` `/api/desk/*` `GET /api/stations` — หน้าแพ็คของ sellcenter
 *   เรียกข้าม origin ผ่าน sendBeacon/fetch แบบ credentials:'omit' · ถ้าบังคับล็อกอินตรงนี้
 *   งานแพ็คจะไม่มีคลิปเลย ซึ่งขัดหลัก "ระบบวิดีโอพังได้ งานแพ็คห้ามหยุด" · ไม่มีข้อมูลคลิปรั่วจากตรงนี้
 * - `/s/*` — ลิงก์ส่งคนนอก ตรวจสิทธิ์ด้วย token ของลิงก์เอง (NFR-3)
 * - `/api/health*` — ตัวเฝ้าระบบภายนอก
 * - `/api/video-health` — sellcenter ดึงจากฝั่งเซิร์ฟเวอร์ ใช้กุญแจ PACKVIDEO_API_KEY แทน
 * - ไฟล์ .js/.css/รูป — ตัวโค้ดหน้าเว็บไม่มีข้อมูล
 */
const PUBLIC = [
  /^\/signal$/,
  /^\/hook\.js$/,
  /^\/bridge\.html$/,
  /^\/api\/desk\//,
  /^\/api\/health(\/|$)/,
  /^\/s\//,
  /^\/login\.html$/,
  /^\/api\/me$/,
  /^\/dev(\/|$)/,
  /\.(js|css|png|jpg|svg|ico|woff2?|map)$/,
];

function isPublic(req) {
  const p = req.path;
  if (req.method === 'GET' && p === '/api/stations') return true;
  return PUBLIC.some((re) => re.test(p));
}

function apiKeyOk(req) {
  const key = config.auth.apiKey;
  const got = req.headers['x-packvideo-key'];
  return !!(key && got && safeEqual(String(got), key));
}

export function requireLogin(req, res, next) {
  if (!config.auth.enforce) return next();
  if (isPublic(req)) return next();
  if (req.path === '/api/video-health' && apiKeyOk(req)) return next();
  if (req.user) return next();

  const wantsHtml = req.method === 'GET' &&
    (req.path === '/' || req.path.endsWith('.html')) &&
    !req.path.startsWith('/api/') && !req.path.startsWith('/media/');
  if (wantsHtml) {
    const next_ = encodeURIComponent(req.originalUrl || req.url);
    return res.redirect(302, `/login.html?next=${next_}`);
  }
  return res.status(401).json({ ok: false, error: 'กรุณาเข้าสู่ระบบ sellcenter ก่อน', login_url: config.auth.loginUrl });
}

/** ชื่อผู้ทำรายการ — บัญชีที่ล็อกอินชนะค่าที่หน้าเว็บส่งมาเสมอ (R3.3) */
export function actorOf(req, fallback) {
  return req.user?.name ?? (config.auth.enforce ? null : fallback ?? null);
}
