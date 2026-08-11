# Node 22 LTS — ตรงข้ามกับ sellcenter ที่ล็อกอยู่ที่ node:12.22.12-stretch + archive.debian.org
# การแยกโปรเจกต์ทำให้ที่นี่ใช้ ffmpeg รุ่นใหม่ได้โดยไม่ต้องไปยุ่งกับ image เดิม
FROM node:22-bookworm-slim

# ffmpeg ใช้เฉพาะตอนส่งออกหลักฐาน (ตัด 60 วิ · เบิร์นวันเวลา · ดึงเฟรมนิ่ง)
# ไม่ได้ใช้ตอนบันทึก เพราะ S1 ยืนยันแล้วว่าเบราว์เซอร์อัดเป็น MP4/H.264 ได้ตรง
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # ffmpeg บางบิลด์ไม่มีฟิลเตอร์ drawtext (คอมไพล์มาโดยไม่มี libfreetype)
 # ซึ่งแปลว่าเบิร์นวันเวลาลงภาพไม่ได้ และไฟล์ที่ได้จะไม่ผ่านเงื่อนไขหลักฐานข้อ 4
 # เจอมาแล้วกับ ffmpeg ของ homebrew บนเครื่องพัฒนา — ต้องดักตั้งแต่ตอน build
 # ไม่ใช่ไปรู้ตอนทีมเคลมกำลังจะส่งหลักฐาน
 && ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=64x64:d=0.1 \
      -vf "drawtext=text='0':fontcolor=white:fontsize=12" -frames:v 1 -f null - \
 && echo "ffmpeg: drawtext ใช้ได้"

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# ไม่รันด้วย root — image ของ node มีผู้ใช้ `node` มาให้แล้ว
# /data/pack_video เป็น volume ที่ mount มาจากภายนอก สิทธิ์ต้องตั้งที่ host
RUN mkdir -p /data/pack_video && chown -R node:node /data/pack_video /app
USER node

EXPOSE 1338

# tini เป็น PID 1 เพื่อให้ SIGTERM ถึง process จริง — ไม่งั้น graceful shutdown ไม่ทำงาน
ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:1338/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
