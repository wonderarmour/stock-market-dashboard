#!/usr/bin/env bash
# GCP(우분투 VM) 최초 설정 스크립트 — README 12장 참고.
# 사용: curl -fsSL https://raw.githubusercontent.com/wonderarmour/stock-market-dashboard/main/deploy/gcp-setup.sh | bash
#   또는 저장소를 clone 한 뒤: bash deploy/gcp-setup.sh
# 하는 일: Node.js LTS + Caddy 설치, 저장소 clone(~/side_prj), .env 템플릿 생성, systemd 서비스 등록, Caddy 리버스 프록시(HTTPS) 설정.
set -euo pipefail

REPO="${REPO:-https://github.com/wonderarmour/stock-market-dashboard.git}"
APP_DIR="${APP_DIR:-$HOME/side_prj}"
PUBLIC_IP="$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || curl -fsS https://api.ipify.org)"
HOSTNAME_DEFAULT="$(echo "$PUBLIC_IP" | tr . -).sslip.io"
PUBLIC_HOST="${PUBLIC_HOST:-$HOSTNAME_DEFAULT}"

echo "== 1/5 패키지 설치 (Node.js LTS, Caddy)"
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y caddy
fi
node -v; caddy version

echo "== 2/5 저장소 준비: $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR"
mkdir -p data

echo "== 3/5 .env"
if [ ! -f .env ]; then
  cp .env.example .env
  {
    echo ""
    echo "# --- 배포 설정 (gcp-setup.sh 가 추가) ---"
    echo "PUBLIC_URL=https://$PUBLIC_HOST"
    echo "APP_PASSWORD=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"
    echo "SESSION_SECRET=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
  } >> .env
  echo ".env 를 만들었어요. OPENAI_API_KEY 와 카카오 키를 채워 주세요: nano $APP_DIR/.env"
fi

echo "== 4/5 systemd 서비스"
sudo tee /etc/systemd/system/market-dashboard.service >/dev/null <<EOF
[Unit]
Description=Market dashboard (Node.js)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/env node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now market-dashboard

echo "== 5/5 Caddy (HTTPS 리버스 프록시): https://$PUBLIC_HOST"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$PUBLIC_HOST {
    reverse_proxy 127.0.0.1:3000
    encode gzip
}
EOF
sudo systemctl reload caddy || sudo systemctl restart caddy

cat <<EOF

완료! 다음을 확인하세요.
  주소:        https://$PUBLIC_HOST
  비밀번호:    grep APP_PASSWORD $APP_DIR/.env
  키 입력:     nano $APP_DIR/.env  (OPENAI_API_KEY, KAKAO_REST_KEY, KAKAO_CLIENT_SECRET) 후
               sudo systemctl restart market-dashboard
  카카오 콘솔: 리다이렉트 URI에 https://$PUBLIC_HOST/auth/kakao/callback, 웹 도메인에 https://$PUBLIC_HOST 추가
  로그:        journalctl -u market-dashboard -f
EOF
