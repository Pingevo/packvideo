#!/usr/bin/env bash
# เตรียม /dev/sda ให้ packvideo ใช้เก็บวิดีโอ — กันพื้นที่ไว้ 1TB จากทั้งหมด 3.6TB
# ที่เหลือของดิสก์ตั้งใจปล่อยว่างไว้ใช้งานอื่นทีหลัง (ไม่ยุ่งกับพาร์ทิชันอื่น)
#
# ⚠️ ตรวจสอบก่อนรัน: /dev/sda ต้องไม่มีพาร์ทิชัน/ข้อมูลอยู่ก่อน (สคริปต์นี้เขียนพาร์ทิชันเทเบิลใหม่)
#    รันด้วย: sudo bash deploy/setup-disk.sh
set -euo pipefail

DISK=/dev/sda
PART="${DISK}1"
MOUNT_POINT=/mnt/packvideo
SIZE=1TiB

echo "=== [0/6] ตรวจสถานะดิสก์ปัจจุบัน ==="
lsblk "$DISK"
if lsblk -no MOUNTPOINT "$DISK" | grep -q .; then
  echo "ERROR: $DISK มีพาร์ทิชัน mount อยู่แล้ว — หยุดเพื่อความปลอดภัย" >&2
  exit 1
fi

read -rp "จะสร้างตาราง GPT + พาร์ทิชัน ${SIZE} บน ${DISK} — พิมพ์ 'yes' เพื่อยืนยัน: " confirm
[ "$confirm" = "yes" ] || { echo "ยกเลิก"; exit 1; }

echo "=== [1/6] สร้าง GPT partition table + พาร์ทิชัน ${SIZE} ==="
parted -s "$DISK" mklabel gpt
parted -s "$DISK" mkpart packvideo ext4 1MiB "$SIZE"
partprobe "$DISK"
sleep 2

echo "=== [2/6] format ext4 พร้อม label ==="
mkfs.ext4 -L packvideo "$PART"

echo "=== [3/6] mount ==="
mkdir -p "$MOUNT_POINT"
mount "$PART" "$MOUNT_POINT"

echo "=== [4/6] ตั้ง mount ถาวรใน /etc/fstab (nofail กันบูตไม่ขึ้นถ้าดิสก์เสีย) ==="
if ! grep -q "$MOUNT_POINT" /etc/fstab; then
  echo "LABEL=packvideo $MOUNT_POINT ext4 defaults,nofail 0 2" >> /etc/fstab
fi

echo "=== [5/6] ให้สิทธิ์ uid 1000 (ผู้ใช้ node ใน container) ==="
chown -R 1000:1000 "$MOUNT_POINT"

echo "=== [6/6] ตรวจว่าเขียนได้ ==="
df -h "$MOUNT_POINT"
sudo -u '#1000' touch "$MOUNT_POINT/.probe" && rm "$MOUNT_POINT/.probe" && echo "เขียนได้ ✓"

echo
echo "เสร็จแล้ว — เนื้อที่ที่เหลือของ $DISK (นอก ${SIZE} นี้) ยังว่างอยู่ ไม่ได้ถูกจัดสรร"
parted -s "$DISK" print free
