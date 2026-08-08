import { Router } from 'express';
import express from 'express';

/**
 * จำลอง API ของ sellcenter ไว้ทดสอบ hook.js เท่านั้น — ไม่ถูกเสิร์ฟบน production
 *
 * คำตอบทั้ง 6 แบบคัดมาจากพฤติกรรมจริงของ GetOrderByImeiNew
 * (ordersn · imei_complete · is_booking · is_cancelled · is_low_price · is_clearance_low_price)
 * โดยเฉพาะข้อที่ว่า **ไม่มี tracking_no ในคำตอบ** ซึ่งเป็นเหตุผลที่การผูกคลิป
 * ต้องทำสองจังหวะ ไม่ใช่จังหวะเดียว
 */
export const devRouter = Router();

const CASES = {
  111111111111111: { ordersn: null },
  222222222222222: { ordersn: '250808LOWPRICE', imei_complete: true, is_low_price: true },
  333333333333333: { ordersn: '250808CANCELLED', imei_complete: true, is_cancelled: true },
  444444444444444: { ordersn: '250808PARTIAL', imei_complete: false },
};

devRouter.post(
  '/shopee/imei/get_order_new',
  express.urlencoded({ extended: false }),
  (req, res) => {
    const imei = String(req.body?.imei ?? '').trim();
    const preset = CASES[imei];
    // หน่วงนิดหน่อยให้เหมือนของจริงที่ตอบ 0.3–1 วินาที
    setTimeout(() => {
      res.json(preset ?? { ordersn: '250808' + imei.slice(-6), imei_complete: true });
    }, 250);
  },
);
