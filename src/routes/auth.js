import { Router } from 'express';
import { config } from '../config.js';

export const authRouter = Router();

/** GET /api/me — ใครล็อกอินอยู่ · หน้าเว็บใช้แสดงชื่อแทนการถามด้วย prompt() (R3.3) */
authRouter.get('/me', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    user: req.user ? { name: req.user.name, emp_id: req.user.emp_id } : null,
    auth_enforced: config.auth.enforce,
    login_url: config.auth.loginUrl,
  });
});

/** POST /api/logout — ลบ session ของเรา (ออกจาก sellcenter ต้องทำที่ sellcenter) */
authRouter.post('/logout', (req, res) => {
  res.append('Set-Cookie', 'pv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true, login_url: config.auth.loginUrl });
});
