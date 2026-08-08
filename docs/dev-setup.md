# ตั้งเครื่องพัฒนา

## 1 · Node 22

เครื่องพัฒนามี Node 12 ของ sellcenter อยู่ **ระวังหยิบผิดตัว** — `npm` ที่อยู่บน PATH
อาจเป็นของ Node 12 แล้วพังด้วย `Cannot find module 'node:path'`

```bash
nvm use
```

```bash
node -v
```

ต้องได้ `v22.x` ถ้ายังไม่มี: `nvm install 22`

## 2 · ติดตั้ง dependency

```bash
npm install
```

```bash
cp .env.example .env
```

## 3 · ผู้ใช้ MongoDB

ระบบใช้ Mongo เครื่องเดียวกับ sellcenter แต่ **คนละ database** (`packvideo`)
และควรมี **ผู้ใช้ของตัวเอง** ที่เข้าได้เฉพาะ database นี้ ไม่ใช้ผู้ใช้ของ `dbWallet`

### ถ้ายังไม่มีผู้ใช้ `packvideo`

ต้องให้คนที่ดูแลเครื่อง Mongo สร้างให้ — คำสั่งนี้ต้องรันด้วยบัญชีที่มีสิทธิ์ผู้ดูแล

```
db.getSiblingDB("packvideo").createUser({
  user: "packvideo",
  pwd: passwordPrompt(),
  roles: [{ role: "readWrite", db: "packvideo" }]
})
```

ถ้าเครื่องยังไม่มี `mongosh` ติดตั้งด้วย `brew install mongosh`
(เครื่องพัฒนาตอนนี้ยังไม่มี — เป็นสาเหตุที่ตั้งค่ารอบแรกไม่สำเร็จ)

### เมื่อมีผู้ใช้แล้ว

```bash
npm run set-mongo
```

สคริปต์จะถามทีละอย่างแล้วทดสอบการเชื่อมต่อให้ก่อนเขียนลง `.env`

**อย่าแก้บรรทัด `MONGO_URL` ในไฟล์เอง** เพราะมีกับดัก 2 อย่างที่เคยทำให้เสียเวลามาแล้ว:

| กับดัก | อาการ |
|---|---|
| รหัสผ่านมี `@ : / ? # [ ] %` | ต้อง percent-encode ก่อน ไม่งั้นถูกตีความเป็นตัวคั่นแล้ว error ชี้ไปผิดทาง |
| พิมพ์ชื่อคีย์ผิด | ระบบเงียบเหมือนไม่ได้ตั้งค่าเลย (เคยเกิดจริง: `MMONGO_URL`) |

ตอนนี้มีการ์ดดักทั้งสองอย่างตอน boot แล้ว แต่ใช้สคริปต์ยังง่ายกว่า

## 4 · รัน

```bash
npm run dev
```

อีกหน้าต่างหนึ่ง:

```bash
npm run smoke
```

ควรได้ **9/9 ผ่าน** · ถ้า `mongo ต่อได้` ไม่ผ่าน ให้ดูข้อ 3

`npm run smoke` ใช้กับเครื่องอื่นได้ด้วย — เป็นวิธีปิด DoD ของ P1-1
ที่ระบุว่าต้องเปิด `/api/health` จากเครื่องโต๊ะแพ็คได้:

```bash
BASE=https://packvideo.digital.in.th npm run smoke
```

## สิ่งที่ห้ามทำ

- **ห้ามใส่รหัสผ่านหรือ token ลงในซอร์ส** — sellcenter มี connection string ของ Mongo
  ฝังอยู่ใน 148 ไฟล์ และ bot token ของ Telegram ใน `NotifyService.js` โปรเจกต์นี้จะไม่ทำแบบนั้น
- **ห้าม commit `.env`** — ถูก gitignore ไว้แล้วและตั้งสิทธิ์ 600
- **ห้ามชี้ `PACK_VIDEO_PATH` ไปที่เดียวกับ `FILESTORE_PATH`** ของระบบเดิม
