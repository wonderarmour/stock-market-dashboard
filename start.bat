@echo off
REM 대시보드 실행 (Windows). 더블클릭하거나 터미널에서 start.bat
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 가 필요해요. https://nodejs.org 에서 LTS 버전을 설치해 주세요. & pause & exit /b 1)
if not exist .env (
  echo .env 파일이 없어요. .env.example 을 복사해 .env 를 만들고 OPENAI_API_KEY 를 채워 주세요.
  copy .env.example .env >nul
  notepad .env
)
echo 서버를 시작해요. 브라우저에서 http://localhost:3000 을 열어 주세요. (종료: Ctrl+C)
node server.js
pause
