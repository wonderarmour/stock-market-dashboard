#!/usr/bin/env bash
# 대시보드 실행 (macOS/Linux): ./start.sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 가 필요해요. https://nodejs.org 에서 LTS 버전을 설치해 주세요."; exit 1
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env 를 만들었어요. OPENAI_API_KEY 를 채운 뒤 다시 실행해 주세요: ${EDITOR:-nano} .env"; exit 1
fi
echo "서버를 시작해요. 브라우저에서 http://localhost:${PORT:-3000} 을 열어 주세요. (종료: Ctrl+C)"
exec node server.js
