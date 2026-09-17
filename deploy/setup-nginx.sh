#!/usr/bin/env bash
# ต่อ pack.digital.in.th เข้ากับ nginx ที่มีอยู่แล้ว (ตาม pattern ของ dtclean.digital.in.th
# ใน /etc/nginx/nginx.conf) แล้วขอ SSL cert ด้วย certbot
#
# ก่อนรัน: DNS ของ pack.digital.in.th ต้องชี้มาที่เซิร์ฟเวอร์นี้แล้ว (ยืนยันแล้ว)
# รันด้วย: sudo bash deploy/setup-nginx.sh
set -euo pipefail

DOMAIN="pack.digital.in.th"
APP_PORT=1339   # host port ที่ map ไว้ใน docker-compose.yml (packvideo -> 127.0.0.1:1339:1338)
NGINX_CONF="/etc/nginx/nginx.conf"
CERT_DIR="/etc/nginx/certs/$DOMAIN"
ACME_ROOT="/var/www/acme-challenge"

if grep -q "server_name $DOMAIN;" "$NGINX_CONF"; then
  echo "$DOMAIN มี server block อยู่แล้วใน $NGINX_CONF — ข้ามการแก้ config"
else
  echo "=== [1/5] เพิ่ม $DOMAIN เข้ารายชื่อ server_name ของ block พอร์ต 80 (redirect + acme-challenge) ==="
  # เพิ่มต่อท้ายบรรทัด "digital.in.th" แรกในรายชื่อ server_name ของ block พอร์ต 80
  sed -i "0,/server_name /{s/server_name \$/server_name\n            ${DOMAIN}/}" "$NGINX_CONF"

  echo "=== [2/5] เติม server block พอร์ต 443 ต่อท้ายไฟล์ (ก่อน '}' ปิด http block บรรทัดสุดท้าย) ==="
  # ตัด '}' ปิดท้ายไฟล์ออกก่อน แล้วค่อยเติม block ใหม่ + ปิดกลับ
  head -n -1 "$NGINX_CONF" > "${NGINX_CONF}.tmp"
  cat >> "${NGINX_CONF}.tmp" <<EOF

    ### [$APP_PORT] - $DOMAIN — packvideo (บันทึกวิดีโอตอนแพ็คสินค้า) ###
    server {
        listen 443 ssl;
        server_name $DOMAIN;

        ssl_certificate     $CERT_DIR/fullchain.pem;
        ssl_certificate_key $CERT_DIR/privkey.pem;

        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;

        # คลิปเป็นหลักฐาน ห้ามที่ไหนฝังหรือ index
        add_header X-Content-Type-Options nosniff always;
        add_header X-Frame-Options SAMEORIGIN always;
        add_header Referrer-Policy no-referrer always;

        client_max_body_size 8m;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # SSE ไปหน้าต่างอัด — ห้าม buffer ไม่งั้นสัญญาณค้างจนกว่า buffer เต็ม
        location /api/stream/ {
            proxy_pass http://127.0.0.1:$APP_PORT;
            proxy_http_version 1.1;
            proxy_buffering off;
            proxy_cache off;
            proxy_read_timeout 1h;
            proxy_set_header Connection '';
            chunked_transfer_encoding off;
        }

        # สตรีมคลิป — ต้องส่ง Range ผ่านตรงๆ ให้เลื่อนดูกลางคลิปได้ (206)
        location /media/ {
            proxy_pass http://127.0.0.1:$APP_PORT;
            proxy_http_version 1.1;
            proxy_buffering off;
            proxy_read_timeout 300s;
        }

        location / {
            proxy_pass http://127.0.0.1:$APP_PORT;
            proxy_http_version 1.1;
            proxy_read_timeout 60s;
        }

        access_log /var/log/nginx/pack.access.log;
        error_log  /var/log/nginx/pack.error.log;
    }
}
EOF
  mv "${NGINX_CONF}.tmp" "$NGINX_CONF"
fi

echo "=== [3/5] ตรวจ syntax (คาดว่า cert ยังไม่มี — จะ error เรื่อง ssl_certificate ก่อน จุดนี้ปกติ) ==="
nginx -t || echo "(ผ่านได้เมื่อ cert มีแล้วในขั้นต่อไป)"

echo "=== [4/5] ขอ cert ด้วย certbot (webroot เดียวกับโดเมนอื่น) ==="
mkdir -p "$ACME_ROOT"
# ต้อง reload nginx ครั้งแรกแบบไม่มี cert ไม่ได้ (จะ error) — เลี่ยงด้วยการรัน certbot ก่อนแล้วค่อย reload
# ถ้า nginx -t ข้างบน fail เพราะไม่มี cert ให้สร้าง self-signed ชั่วคราวก่อนเพื่อให้ reload ผ่าน แล้ว certbot จะทับด้วยของจริง
if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "$CERT_DIR/privkey.pem" -out "$CERT_DIR/fullchain.pem" \
    -subj "/CN=$DOMAIN" >/dev/null 2>&1
  echo "สร้าง self-signed ชั่วคราวแล้ว เพื่อให้ nginx reload ผ่านก่อนขอ cert จริง"
fi

nginx -t && systemctl reload nginx

certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" \
  --non-interactive --agree-tos -m admin@digital.in.th

cp "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$CERT_DIR/fullchain.pem"
cp "/etc/letsencrypt/live/$DOMAIN/privkey.pem"   "$CERT_DIR/privkey.pem"

echo "=== [5/5] nginx -t + reload ด้วย cert จริง ==="
nginx -t
systemctl reload nginx

echo
echo "--- cert ที่ใช้อยู่จริง ---"
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -subject -dates
echo
echo "เสร็จแล้ว — https://$DOMAIN ควรใช้งานได้ (certbot ต่ออายุอัตโนมัติผ่าน renewal-hooks/deploy ที่มีอยู่แล้ว)"
