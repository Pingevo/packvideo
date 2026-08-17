# คู่มือติดตั้งบนเซิร์ฟเวอร์จริง

เอกสารนี้สำหรับผู้ดูแลระบบ ติดตั้งครั้งเดียว · สำหรับการใช้งานประจำวันดู [usage.md](usage.md)

---

## 0. ต้องมีอะไรก่อน

ตรวจให้ครบก่อนเริ่ม ถ้าขาดข้อใดข้อหนึ่งจะติดกลางทาง

| # | สิ่งที่ต้องมี | ตรวจยังไง | ถ้าไม่มี |
|---|---|---|---|
| 1 | **subdomain + SSL cert** เช่น `pack.digital.in.th` | `curl -I https://pack.digital.in.th` | ⛔ ติดตั้งไม่ได้เลย — กล้องในเบราว์เซอร์ไม่ทำงานบน http และ `sendBeacon` จากหน้า https ไปยัง http จะถูกบล็อก |
| 2 | **HDD 1 TB** ที่ยังว่าง | `lsblk` | ⛔ ไม่มีที่เก็บคลิป |
| 3 | **Docker + docker compose** | `docker --version` | ⛔ |
| 4 | **nginx** ที่มีอยู่แล้ว | `nginx -v` | ⛔ |
| 5 | **ผู้ใช้ MongoDB** ของ packvideo | ดู §3 | ⛔ |
| 6 | **กล้อง autofocus + ขาจับ** ต่อโต๊ะ | — | อัดไม่ได้ แต่ติดตั้งระบบได้ |
| 7 | Telegram bot token + chat id | — | ไม่มีการแจ้งเตือน ระบบทำงานได้ |

> **ข้อ 1 คือตัวที่บล็อกทุกอย่าง** — ทำก่อนเสมอ

---

## 1. เตรียมดิสก์

```bash
lsblk
```

หา HDD 1 TB ที่ว่าง (สมมติเป็น `/dev/sdb`) แล้วจัดรูปแบบถ้ายังไม่เคยใช้:

```bash
sudo mkfs.ext4 -L packvideo /dev/sdb1
```

```bash
sudo mkdir -p /mnt/packvideo && sudo mount /dev/sdb1 /mnt/packvideo
```

ให้ mount เองทุกครั้งที่บูต:

```bash
echo "LABEL=packvideo /mnt/packvideo ext4 defaults,nofail 0 2" | sudo tee -a /etc/fstab
```

> `nofail` สำคัญ — ถ้าดิสก์เสียแล้วเซิร์ฟเวอร์บูตไม่ขึ้น จะพาระบบขายล่มไปด้วย

ให้สิทธิ์ผู้ใช้ใน container (uid 1000):

```bash
sudo chown -R 1000:1000 /mnt/packvideo
```

ตรวจว่าถูกต้อง:

```bash
df -h /mnt/packvideo && sudo -u '#1000' touch /mnt/packvideo/.probe && sudo rm /mnt/packvideo/.probe && echo "เขียนได้ ✓"
```

> ⚠️ **ห้าม** ชี้ไปที่เดียวกับ `FILESTORE_PATH` ของ sellcenter
> แยกแล้วได้ 3 อย่าง: วิดีโอเต็มไม่กระทบ filestore กับ mongo · ย้ายไป NAS ทีหลังแค่เปลี่ยน mount ·
> สำรองข้อมูลแยกนโยบายได้

---

## 2. ดึงโค้ด

```bash
git clone git@github.com:Pingevo/packvideo.git /opt/packvideo && cd /opt/packvideo
```

---

## 3. สร้างผู้ใช้ MongoDB

ระบบใช้ Mongo เครื่องเดียวกับ sellcenter แต่ **คนละฐานข้อมูล** และควรมีผู้ใช้ของตัวเอง
ที่เข้าได้เฉพาะฐานข้อมูลนั้น ไม่ใช้บัญชีที่แตะฐานข้อมูลอื่นได้

```bash
npm install && npm run setup-mongo
```

สคริปต์จะถามบัญชีผู้ดูแล Mongo แล้วสร้างผู้ใช้ สุ่มรหัสผ่าน ทดสอบ และเขียนลง `.env` ให้เอง

**ถ้าบัญชีที่มีสิทธิ์ไม่พอ** สคริปต์จะพิมพ์ข้อความสำเร็จรูปให้ส่งต่อคนที่ดูแลเครื่อง Mongo
ได้รหัสผ่านมาแล้วรัน `npm run set-mongo`

---

## 4. ตั้งค่า

```bash
cp .env.example .env && chmod 600 .env
```

แก้ค่าเหล่านี้ให้ครบ — บน production ถ้าขาดข้อใด process จะไม่ขึ้นและบอกว่าขาดอะไร

| ตัวแปร | ค่า | หมายเหตุ |
|---|---|---|
| `NODE_ENV` | `production` | |
| `MONGO_URL` | ตั้งโดย `npm run setup-mongo` | ห้ามแก้ด้วยมือ — รหัสผ่านที่มีอักขระพิเศษต้อง percent-encode |
| `MONGO_DB` | ตั้งโดย `npm run setup-mongo` (`packVideo`) | ห้ามแก้ด้วยมือ — **แยกตัวพิมพ์เล็กใหญ่** และต้องตรงกับฐานข้อมูลใน `MONGO_URL` ไม่งั้นต่อได้แต่เขียนไม่ได้ |
| `PACK_VIDEO_PATH` | `/data/pack_video` | path ใน container ไม่ใช่ path บนเครื่อง |
| `ALLOWED_ORIGINS` | `https://digital.in.th` | origin ของ sellcenter ห้ามใส่ `*` |
| `STATION_COUNT` | `6` | จำนวนโต๊ะ |
| `RETENTION_DAYS` | `30` | |
| `TELEGRAM_BOT_TOKEN` | จาก BotFather | |
| `TELEGRAM_CHAT_ID` | ของกลุ่มที่จะรับแจ้งเตือน | |

---

## 5. สร้าง image และรัน

```bash
docker compose build
```

> การ build จะทดสอบ `ffmpeg` ว่ามีฟิลเตอร์ `drawtext` หรือไม่ **ถ้าไม่มี build จะไม่ผ่าน**
> เพราะเบิร์นวันเวลาลงภาพไม่ได้ = ส่งหลักฐานให้แพลตฟอร์มไม่ได้

```bash
docker compose up -d && docker compose logs -f --tail 40
```

ควรเห็น: `ที่เก็บคลิปพร้อมใช้งาน` → `packvideo พร้อมรับงาน` → `mongo เชื่อมต่อแล้ว` → `index พร้อมใช้งาน` → `ffmpeg พร้อมส่งออกหลักฐาน`

---

## 6. ตั้ง nginx

คัดลอกไฟล์ตัวอย่างแล้วแก้ path ของ cert:

```bash
sudo cp deploy/nginx/packvideo.conf /etc/nginx/sites-available/packvideo
```

เพิ่มบรรทัดนี้ใน block `http { }` ของ `/etc/nginx/nginx.conf`:

```
limit_req_zone $binary_remote_addr zone=packvideo_share:10m rate=30r/m;
```

```bash
sudo ln -s /etc/nginx/sites-available/packvideo /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
```

**สามจุดที่พลาดแล้วเจอปัญหาแปลกๆ ทีหลัง:**

| จุด | ถ้าตั้งผิด |
|---|---|
| `proxy_buffering off` ที่ `/api/stream/` | หน้าต่างอัดไม่ได้รับสัญญาณ เหมือนระบบไม่ทำงาน |
| `proxy_read_timeout 1h` ที่ `/api/stream/` | ตัวอัดหลุดทุก 60 วินาที |
| ส่ง `Range` ผ่านที่ `/media/` | เลื่อนดูกลางคลิปไม่ได้ |

---

## 7. ตรวจว่าติดตั้งถูก

```bash
BASE=https://pack.digital.in.th npm run smoke
```

ต้องได้ **9/9 ผ่าน** ถ้าข้อไหนไม่ผ่านให้แก้ก่อนไปต่อ

---

## 8. ตั้งค่าเครื่องโต๊ะแพ็ค (ทำทีละเครื่อง)

เปิด `https://pack.digital.in.th/setup.html` บนเครื่องนั้น

1. เลือกโต๊ะ — โต๊ะที่มีเครื่องอื่นใช้อยู่จะกดไม่ได้และบอกว่าชนกับเครื่องไหน
2. ตั้งชื่อเครื่อง เช่น "คอมโต๊ะ 3 ริมหน้าต่าง"
3. กด **ขออนุญาตใช้กล้อง** แล้วเลือกกล้องที่คร่อมโต๊ะ
4. กด **บันทึกการตั้งค่า**

ตั้งครั้งเดียว เบราว์เซอร์จำไว้เอง

---

## 9. ต่อกับหน้าแพ็คของ sellcenter

บรรทัดนี้ **ใส่ไว้ในซอร์สของ sellcenter แล้ว** ท้ายไฟล์ทั้งสอง — เหลือแค่ deploy

```html
<script async src="https://pack.digital.in.th/hook.js"></script>
```

| ไฟล์ | หน้าอะไร | สถานะ |
|---|---|---|
| `imei_new_api.ejs` | หน้าสแกน IMEI | ✅ |
| `airways_hot_test2.ejs` | ใบปะหน้า — `airway_new` · `airway_booking` | ✅ |
| `airways_hot_test.ejs` | ใบปะหน้า — `airway` (ตัวเก่า) | ✅ |
| `airways_hot_large.ejs` | ใบปะหน้าแบบ large — `GetLargeAirway` · `GetLargeAirwayJT` | ✅ + ป้าย |
| `printed.ejs` | "พิมพ์ใบปะหน้าไปแล้ว" | ✅ + ป้าย |

> ⚠️ **ทุกหน้าที่มีเลขพัสดุต้องมี hook ไม่ใช่แค่หน้าใบปะหน้าหลัก** — `GetSingleAirwayNew`
> เรนเดอร์ได้หลายหน้า ถ้าพนักงานสแกน IMEI ของออเดอร์ที่พิมพ์ใบไปแล้ว จะได้ `printed.ejs`
> ซึ่งถ้าไม่มี hook ระบบจะไม่รู้เลขพัสดุ แล้วการสแกนปิดคลิปจะหลุดไปหาระบบเดิมจนเด้ง
> `not_found` และคลิปจบเป็น `unverified` แทน `verified` (เจอจริงตอน pilot วันแรก)
>
> หน้าที่พิมพ์เลขพัสดุเป็นข้อความเฉยๆ (ไม่มี `arr_tracking` หรือ `<svg id="svg_…">`)
> ต้องเพิ่มป้ายให้ hook อ่านด้วย 1 บรรทัด:
> ```html
> <span data-packvideo-tracking="<%= tracking_no %>" hidden></span>
> ```

ตรวจก่อน deploy:

```bash
grep -rn "pack.digital.in.th/hook.js" views/shopee/pickup/
```

> ⚠️ **ต้องมี `async`** ไม่งั้นถ้าระบบวิดีโอช้าจะหน่วงการเรนเดอร์หน้าแพ็ค
>
> **deploy ข้อนี้เป็นข้อสุดท้าย** — ข้อ 1–8 ต้องเสร็จก่อน ถ้า `pack.digital.in.th`
> ยังไม่ขึ้น สคริปต์จะโหลดไม่ได้ (หน้าแพ็คยังทำงานปกติเพราะ `async` แต่ไม่มีคลิปเลย
> และ console จะมี error ให้พนักงานตกใจเปล่าๆ)
>
> deploy นอกเวลาแพ็คของ และเตรียมวิธีถอยไว้: เอา 2 บรรทัดนี้ออกแล้ว deploy กลับ

---

## 10. ตรวจหลังติดตั้ง

เปิด `https://pack.digital.in.th/monitor.html` แล้วให้พนักงานสแกน 5 ออเดอร์

| ต้องเห็น | ถ้าไม่เห็น |
|---|---|
| โต๊ะขึ้น **ต่ออยู่** | หน้าต่างอัดยังไม่ได้เปิด — เปิด `/rec.html` |
| ตัวเลข **ใบปะหน้า** เพิ่มขึ้น | `hook.js` ไม่ทำงาน — เช็คว่าใส่ script tag แล้วและ `ALLOWED_ORIGINS` ถูก |
| ตัวเลข **คลิป** เพิ่มตาม | สัญญาณมาแต่อัดไม่ได้ — เช็คกล้องและดิสก์ |
| **อัตรา** ใกล้ 100% | ดู [usage.md §แก้ปัญหา](usage.md) |

---

## การอัปเดตภายหลัง

```bash
cd /opt/packvideo && git pull && docker compose build && docker compose up -d
```

คลิปที่กำลังอัดตอนรีสตาร์ทจะถูกปิดเป็น `unverified` และตรึงไว้อัตโนมัติ — ทำนอกเวลาแพ็คของ

## ถอนการติดตั้ง

1. เอา `<script>` 2 บรรทัดออกจาก sellcenter แล้ว deploy — **หน้าแพ็คกลับไปเหมือนเดิมทันที**
2. `docker compose down`
3. คลิปยังอยู่ที่ `/mnt/packvideo` จนกว่าจะลบเอง
