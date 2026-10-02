#!/bin/sh
# deploy packvideo อย่างปลอดภัย: build → รอจนไม่มีโต๊ะอัดหรือรอชิ้นค้าง → สร้าง container ใหม่ → รอ healthy
#
#   packvideo/deploy/deploy-packvideo.sh              รอว่างสูงสุด 15 นาที (ว่างต่อเนื่อง 15 วินาที)
#   packvideo/deploy/deploy-packvideo.sh --skip-gate  ข้ามด่าน (เซิร์ฟเวอร์ที่รันอยู่เป็นรุ่นก่อนที่ไม่บอกงานค้าง)
#   packvideo/deploy/deploy-packvideo.sh --dry-run    แค่ตัดสินว่าจะผ่านด่านไหม ไม่ build ไม่สร้าง container ใหม่
#
# 2026-10-01 รีสตาร์ทกลางกะ 3 ครั้ง วิดีโอของคลิปที่กำลังอัดเสียทุกครั้ง — ตัวนี้กันไม่ให้เกิดซ้ำ
# เซิร์ฟเวอร์รุ่นใหม่รับคลิปค้างกลับมาทำต่อได้แล้ว แต่ช่วงที่ดับ หน้าแพ็คยิงสัญญาณไม่ถึง (สแกนช่วงนั้นหาย)
set -eu
cd "$(dirname "$0")/../.."     # โฟลเดอร์ที่มี docker-compose.yml

CONTAINER="${PV_CONTAINER:-packvideo_app}"
MODE="${1:-}"

[ "$MODE" = "--dry-run" ] || docker compose build packvideo

if [ "$MODE" = "--skip-gate" ]; then
  echo "ข้ามด่านรอว่างตามที่สั่ง"
elif [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
  # ไม่มีเซิร์ฟเวอร์รันอยู่ = ไม่มีคลิปให้เสีย และถามสถานะไม่ได้อยู่แล้ว — ห้ามให้ด่านขวางการกู้ระบบที่ล่ม
  echo "$CONTAINER ไม่ได้รันอยู่ — ข้ามด่าน"
else
  # รันด่านใน network ของ container ที่กำลังรันอยู่ ถาม 127.0.0.1:1338 ตรงๆ ไม่ผ่าน nginx
  docker run --rm --network "container:$CONTAINER" -v "$PWD/packvideo/scripts:/gate:ro" \
    --entrypoint node new_system-packvideo /gate/wait-idle.mjs --quiet 15 --timeout 900
fi

if [ "$MODE" = "--dry-run" ]; then
  echo "dry-run: ผ่านด่าน — ไม่ได้ build และไม่ได้สร้าง container ใหม่"
  exit 0
fi

docker compose up -d --no-deps packvideo
i=0
while [ $i -lt 60 ]; do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER")" = healthy ]; then
    echo "packvideo healthy"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done
echo "packvideo ไม่ healthy ภายใน 2 นาที — ดู docker logs $CONTAINER" >&2
exit 1
