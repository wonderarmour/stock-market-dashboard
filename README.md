# 마켓 대시보드 — 실행·관리 가이드

환율 · 해외/국내 지수 · 오늘의 뉴스 · 과거 이벤트 분석 · 개인 포트폴리오를 한 화면에서 보는 로컬 웹앱이에요.
Node.js 내장 모듈만 사용해서 **npm install 이 필요 없고**, 폴더를 통째로 옮기면 어느 컴퓨터에서든 바로 실행돼요.

- 공통 요구사항: **Node.js 20.12 이상**, 인터넷 연결(시세·뉴스·AI 모두 외부 API), OpenAI API 키
- 실행 후 브라우저에서 **http://localhost:3000**

---

## 1. Windows 에서 실행하기

### 1-1. Node.js 설치
```powershell
winget install OpenJS.NodeJS.LTS
```
또는 https://nodejs.org 에서 LTS 설치. 새 터미널을 열고 `node -v` 로 20.12 이상인지 확인해요.

### 1-2. 폴더 준비와 .env
1. `side_prj` 폴더를 원하는 위치에 복사 (예: `C:\apps\side_prj`).
2. `.env.example` 을 복사해 `.env` 로 이름을 바꾸고 `OPENAI_API_KEY` 를 채워요.
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

### 1-3. 실행
- 가장 쉬운 방법: **`start.bat` 더블클릭** (Node 설치·.env 존재를 확인하고 서버를 띄워요)
- 터미널(PowerShell/cmd)에서:
  ```powershell
  cd C:\apps\side_prj
  npm start          # 또는 node server.js
  ```
- 종료: 터미널에서 `Ctrl+C`

### 1-4. 백그라운드 실행 / 로그인 시 자동 실행
- 터미널을 닫아도 유지하려면 (로그는 `server.log` 에 쌓여요):
  ```powershell
  Start-Process -WindowStyle Hidden -FilePath node -ArgumentList server.js -WorkingDirectory C:\apps\side_prj -RedirectStandardOutput server.log -RedirectStandardError server.err.log
  ```
- 로그인할 때 자동 실행: `Win+R` → `shell:startup` 폴더에 `start.bat` 의 바로가기를 넣어요.
  (창 없이 돌리려면 작업 스케줄러에서 "프로그램 시작: node.exe, 인수: server.js, 시작 위치: 폴더 경로" 로 트리거 "로그온 시" 작업을 만들어요.)

### 1-5. 중지·포트 확인
```powershell
netstat -ano | findstr :3000        # 3000 포트를 잡고 있는 PID 확인
taskkill /PID <PID> /F              # 해당 프로세스 종료
Get-Process node                    # 떠 있는 node 프로세스 목록
```

### 1-6. Windows 에서 자주 나는 문제
- **`EADDRINUSE`(포트 사용 중)**: 이전 서버가 살아 있어요. 위 명령으로 종료하거나 `.env` 의 `PORT` 를 바꿔요.
- **터미널 한글 깨짐**: `chcp 65001` 실행 후 다시 시작. (웹 화면은 영향 없어요.)
- **`start.bat` 이 바로 닫힘**: Node 미설치이거나 PATH 미반영. 새 터미널을 열거나 재로그인 후 다시 시도.
- **방화벽 알림**: localhost 만 쓰면 허용하지 않아도 돼요. 같은 네트워크 다른 기기에서 열려면 허용이 필요하지만, 이 서버는 인증이 없으니 권장하지 않아요.

---

## 2. Linux(우분투 등)·macOS 에서 실행하기

### 2-1. Node.js 설치
- Ubuntu/Debian (NodeSource LTS):
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- 배포판 무관 (nvm):
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  source ~/.bashrc && nvm install --lts
  ```
- macOS: `brew install node`
- 확인: `node -v` (20.12 이상). apt 기본 저장소의 node 는 구버전일 수 있으니 위 방법을 권장해요.

### 2-2. 폴더 준비와 .env
```bash
cp -r side_prj ~/apps/side_prj && cd ~/apps/side_prj
cp .env.example .env
nano .env                 # OPENAI_API_KEY 입력
chmod +x start.sh
```

### 2-3. 실행
```bash
./start.sh                # 또는 npm start / node server.js
```
종료는 `Ctrl+C`. 다른 포트로 띄우려면 `PORT=3001 node server.js` 또는 `.env` 의 `PORT` 수정.

### 2-4. 백그라운드 실행
- 간단히 (세션 종료 후에도 유지):
  ```bash
  nohup node server.js > server.log 2>&1 &
  echo $! > server.pid
  ```
  중지: `kill $(cat server.pid)`
- **systemd 서비스로 상시 운영 (권장)** — 재부팅·크래시 시 자동 재시작:
  ```bash
  sudo cp market-dashboard.service /etc/systemd/system/
  sudo nano /etc/systemd/system/market-dashboard.service   # User= 와 WorkingDirectory= 를 본인 환경에 맞게 수정
  sudo systemctl daemon-reload
  sudo systemctl enable --now market-dashboard
  ```
  ```bash
  systemctl status market-dashboard        # 상태
  journalctl -u market-dashboard -f        # 실시간 로그
  sudo systemctl restart market-dashboard  # .env 나 코드 수정 후 재시작
  sudo systemctl stop market-dashboard     # 중지
  ```
  동봉된 `market-dashboard.service` 는 `EnvironmentFile=.env` 로 키를 읽고, 서버가 죽으면 5초 뒤 다시 띄워요.

### 2-5. 중지·포트 확인
```bash
lsof -i :3000            # 또는 ss -ltnp | grep 3000
kill <PID>               # 안 죽으면 kill -9 <PID>
pgrep -af "node server.js"
```

### 2-6. Linux 에서 자주 나는 문제
- **`EADDRINUSE`**: 위 명령으로 이전 프로세스 종료 또는 `PORT` 변경.
- **`process.loadEnvFile is not a function`**: Node 가 20.12 미만이에요. `node -v` 확인 후 업그레이드.
- **`Permission denied: ./start.sh`**: `chmod +x start.sh`.
- **서버(VM)에서 띄우고 노트북에서 보고 싶을 때**: 인증이 없으니 포트를 공개하지 말고 SSH 터널을 쓰세요.
  `ssh -L 3000:localhost:3000 user@서버주소` 후 노트북 브라우저에서 http://localhost:3000.
- **방화벽(ufw)**: localhost 만 쓰면 규칙이 필요 없어요.

---

## 3. 폴더 구조

```
side_prj/
├─ server.js                # Node HTTP 서버: 정적 파일 + API 프록시 + AI 호출 + 캐시
├─ public/
│  ├─ index.html            # 화면 골격 + 전체 CSS (design.md 의 토스 TDS 토큰 적용)
│  ├─ app.js                # 시장 탭: 시세 로드, 카드/차트, 기간 선택, 시장 요약 텍스트
│  ├─ chat.js               # AI 채팅 위젯 + "삼성전자 AI 대응 시나리오"
│  ├─ news.js               # 오늘 탭: 브리핑, 텔레그램 스크랩, 국내/해외 뉴스, 탭 전환 공용 로직
│  ├─ drawdown.js           # 과거 탭: 조정/상승 이벤트, 사건명 매칭, 유사 사례, 당시 뉴스 모달
│  └─ portfolio.js          # 포트폴리오 탭: 종목 관리, 개별/비교/비중합산, 조합 비교, 롤링 분석
├─ design.md                # 토스 디자인 시스템 스펙 — 스타일 변경 시 기준
├─ package.json             # npm start / npm run check
├─ .env.example             # 환경변수 템플릿 (실제 값은 .env 에)
├─ .env                     # ★ 비밀 키. git 에 올리지 않기 (.gitignore 포함)
├─ start.bat                # Windows 실행 스크립트
├─ start.sh                 # Linux/macOS 실행 스크립트
├─ market-dashboard.service # Linux systemd 서비스 예시
├─ deploy/gcp-setup.sh      # GCP/우분투 VM 원클릭 설정 (12장)
├─ deploy/Caddyfile         # HTTPS 리버스 프록시 예시
└─ server.log               # 백그라운드 실행 시 로그
```

---

## 4. 환경변수 (`.env`)

| 키 | 필수 | 설명 |
|---|---|---|
| `PORT` | 아니오 | 서버 포트. 기본 3000 |
| `OPENAI_API_KEY` | **예** | AI 채팅 · 대응 시나리오 · 뉴스 브리핑 · 과거 뉴스 요약에 사용. 없으면 해당 기능만 오류가 나고 나머지는 동작해요 |
| `TELEGRAM_CHANNELS` | 아니오 | 텔레그램 스크랩 기본 채널(쉼표 구분). 기본 `wowtv_official,FastStockNews` |
| `TELEGRAM_BOT_TOKEN` | 아니오 | 리밸런싱 알림용 봇 토큰 (10장). 없으면 앱 내 배지만 동작 |
| `TELEGRAM_CHAT_ID` | 아니오 | 알림을 받을 채팅 ID (10장) |
| `KAKAO_REST_KEY` | 아니오 | 카카오톡 "나에게 보내기" 알림용 REST API 키 (11장) |
| `KAKAO_CLIENT_SECRET` | 아니오 | 카카오 앱에서 Client Secret 을 켠 경우에만 |
| `KAKAO_LINK_URL` | 아니오 | 카카오 메시지 버튼 링크. 기본은 `PUBLIC_URL` → GitHub 저장소 순 |
| `APP_PASSWORD` | 외부 공개 시 **예** | 설정하면 모든 화면·API에 비밀번호 로그인이 걸려요 (`/login`, `/logout`). 로컬 전용이면 비워 두기 |
| `SESSION_SECRET` | 아니오 | 로그인 쿠키 서명 키. 없으면 `APP_PASSWORD` 로 대체 |
| `PUBLIC_URL` | 외부 공개 시 **예** | `https://…` 공개 주소. 카카오 리다이렉트 URI·메시지 링크·Secure 쿠키에 사용 |

AI 모델명은 `server.js` 상단 `OPENAI_MODEL` 상수예요 (현재 `gpt-5.6-luna`). `.env` 를 바꾸면 서버를 재시작해야 반영돼요.

---

## 5. 화면별 기능

### 시장
- 환율(원/달러·엔/달러), 해외 지수(VIX·나스닥·S&P500·다우·SOX), 국내 지수(코스피·코스닥) 카드.
- 기간 선택(1개월~30년): 등락률은 **선택 기간 시작 대비**, 전일 대비, **기간 가중평균(거래량 있으면 VWAP, 없으면 단순평균) 대비**를 함께 표시.
- **삼성전자 AI 대응 시나리오**: 오늘 시세 + 오늘 뉴스 헤드라인 + 나스닥 과거 유사 사례를 모아 기본/상방/하방 시나리오를 생성 (채팅창에 출력).
- 색 규칙: 상승 빨강, 하락 파랑 (국내 증권 관례).

### 오늘
- **오늘의 브리핑**: 국내·해외 최신 기사 60건을 AI가 5꼭지로 요약 (10분 캐시).
- **텔레그램 이미지 스크랩**: `t.me/s/채널` 공개 미리보기에서 이미지 포스트만 날짜별로. 채널 입력값은 브라우저에 저장.
- **오늘의 경제 뉴스**: 국내(한국경제·연합뉴스) / 해외(CNBC·MarketWatch·WSJ) 탭.

### 과거
- **조정 / 상승** 하위 탭. 나스닥 1971년~ 전체 일봉에서 이벤트 탐지 (기준 %와 종료 % 조절 가능).
- 알려진 사건은 이름으로, 확인 안 되는 구간은 낙폭 기준 분류만.
- **유사 사례 상위 10개**: 형태(상관)·수준(DTW)·변동성·진입 흐름 4기준 가중합. 가중치는 상단 "유사도 기준 설정"에서 조절(설명 포함). 무작위 구간 대비 백분위와 상위 5개 앙상블 표시.
- 카드를 누르면 **당시 뉴스 요약** 모달 (위키백과 Current events + AI, 24시간 캐시).

### 포트폴리오
- 티커/영문 종목명으로 검색해 추가 (Yahoo 심볼: `005930.KS`, `NVDA`, `BTC-USD` 등). 목록은 **이 브라우저에만** 저장.
- 뷰: **개별 차트** / **한 그래프에 비교**(기간 시작 0% 정규화, 범례 클릭으로 숨김) / **비중 반영 합산**(슬라이더로 비중, 수익률·MDD·변동성, 조합 저장·비교·이름 인라인 수정, 롤링 창 분석) / **실제 보유·리밸런싱**.
- **실제 보유·리밸런싱**: 종목별 보유 수량과 목표 비중을 저장하면 현재가(달러 자산은 원화 환산)로 평가액·현재 비중·드리프트를 계산하고, **밴드 규칙**(절대 ±%p 또는 목표 대비 상대 %) 혹은 **정기 점검 주기**를 넘기면 조정 신호와 함께 "무엇을 몇 주 사고팔면 목표로 돌아가는지"를 보여줘요. 서버가 **매일 16:30 KST**에 자동 점검해 신호가 있으면 텔레그램으로 알리고(설정 시), 포트폴리오 탭에 빨간 점 배지를 켜요.
- 포트폴리오 상태(종목·비중·조합·보유·규칙)는 **서버 파일 `data/portfolio.json`** 에 저장돼요. 브라우저를 바꿔도 같은 포트폴리오가 보이고, 예전 브라우저 저장값은 처음 접속 때 자동으로 옮겨져요.

---

## 6. 서버 API

| 경로 | 설명 | 캐시 |
|---|---|---|
| `GET /api/quote?symbol=&range=&interval=` 또는 `&period1=&period2=` | Yahoo Finance 차트 프록시 | 없음 |
| `GET /api/search?q=` | Yahoo 심볼 검색 | 1시간 |
| `GET /api/news` | 국내·해외 RSS 취합 (+ 대표 이미지) | 10분 |
| `GET /api/news-brief` | 뉴스 5꼭지 AI 브리핑 | 10분 |
| `GET /api/telegram?channels=` | 텔레그램 공개 채널 이미지 포스트 | 5분 |
| `GET /api/era-news?start=&extreme=&end=&label=&direction=` | 특정 기간 뉴스 요약 (위키 + AI) | 24시간 |
| `POST /api/chat` `{messages:[…]}` | OpenAI 채팅 프록시 | 없음 |
| `GET/PUT /api/portfolio` | 포트폴리오 상태 읽기/부분 갱신 (`data/portfolio.json`) | — |
| `GET /api/rebalance-check[?refresh=1]` | 보유 기준 드리프트·조정 신호·필요 매매 계산 (refresh 없으면 1시간 캐시) | 1시간 |
| `POST /api/rebalance-notify?channel=telegram\|kakao` | 현재 점검 결과를 즉시 전송 | — |
| `GET /auth/kakao` → `/auth/kakao/callback` | 카카오 로그인(한 번) 후 토큰을 `data/kakao.json` 에 저장 | — |
| `GET /api/kakao/status`, `POST /api/kakao/disconnect` | 카카오 연결 상태 / 연결 해제 | — |

환율은 브라우저가 Frankfurter API(`api.frankfurter.dev`)를 직접 호출해요. 캐시는 서버 메모리에만 있어 재시작하면 비워져요.

---

## 7. 저장되는 데이터

| 위치 | 내용 |
|---|---|
| `data/portfolio.json` (서버) | 종목 목록, 비중, 저장 조합, 숨김, 롤링 설정, **보유 수량·목표 비중, 리밸런싱 규칙**, 마지막 점검 결과·알림 날짜 |
| 브라우저 localStorage `tg-channels` | 텔레그램 스크랩 채널 입력값 |

다른 컴퓨터로 옮길 때는 `data/portfolio.json` 을 같이 복사하면 포트폴리오가 그대로 따라가요 (`.gitignore` 에 있어 git 에는 안 올라가요). 처음 접속하는 브라우저에 예전 localStorage 값이 남아 있고 서버가 비어 있으면 자동으로 서버로 옮겨요.

---

## 8. 공통 문제 해결

- **카드에 "데이터를 불러오지 못했어요"**: Yahoo 응답 실패. 잠시 후 새로고침. 계속되면 심볼이 상장폐지·변경됐을 수 있어요.
- **AI 기능만 오류**: `.env` 의 `OPENAI_API_KEY`, 잔액, 모델 접근 권한 확인 후 서버 재시작.
- **해외 뉴스 썸네일 없음**: 일부 언론사(WSJ)는 본문 페이지가 차단돼 이미지가 없어요. 정상.
- **텔레그램 결과 없음**: 채널명 오타이거나 비공개 채널. `https://t.me/s/채널명` 이 브라우저에서 열리는지 확인.
- **코드 문법 점검**: `npm run check`
- **디자인 수정**: 색·라운드·타이포는 `public/index.html` 상단의 CSS 변수(`--blue-500` 등)에서만 바꾸고, 기준은 `design.md` 를 따라요.

---

## 9. 다른 컴퓨터로 옮길 때 체크리스트

- [ ] `side_prj` 폴더 전체 복사 (`node_modules` 없음, 용량 작음). **`.env` 는 빼고** 복사한 뒤 새 컴퓨터에서 새로 만들기
- [ ] 새 컴퓨터에 Node.js 20.12+ 설치 (1-1 / 2-1)
- [ ] `.env` 생성 및 `OPENAI_API_KEY` 입력
- [ ] Windows: `start.bat` / Linux·macOS: `./start.sh` → http://localhost:3000 확인
- [ ] 필요하면 브라우저 localStorage(포트폴리오 설정) 옮기기 (7절)
- [ ] Linux 상시 운영이면 systemd 등록 (2-4)

---

## 10. 리밸런싱 알림 설정 (텔레그램 봇)

1. 텔레그램에서 **@BotFather** 를 열고 `/newbot` → 이름·아이디를 정하면 **토큰**을 줘요.
2. 방금 만든 봇을 열어 아무 메시지나 한 번 보내요.
3. 브라우저에서 `https://api.telegram.org/bot<토큰>/getUpdates` 를 열면 `"chat":{"id":123456789,...}` 가 보여요. 이 숫자가 **chat_id** 예요.
4. `.env` 에 `TELEGRAM_BOT_TOKEN=...`, `TELEGRAM_CHAT_ID=...` 를 넣고 서버를 재시작해요.
5. 포트폴리오 → 실제 보유·리밸런싱에서 **"텔레그램으로 보내기"** 로 테스트 메시지가 오는지 확인해요.

동작 규칙: 서버가 **매일 16:30 KST**(국내 장 마감 후)에 점검하고, 조정 신호가 있을 때 **하루 한 번만** 알려요. 신호가 없으면 조용해요. 서버가 그 시각에 꺼져 있으면 그날은 건너뛰니 상시 운영은 2-4절(systemd)이나 1-4절(작업 스케줄러)을 참고해요. 봇을 설정하지 않아도 앱 내 빨간 점 배지는 동작해요.

## 11. 리밸런싱 알림 설정 (카카오톡 "나에게 보내기")

텔레그램 대신(또는 함께) 내 카카오톡 **"나와의 채팅"** 으로 알림을 받을 수 있어요. 사업자 등록·템플릿 심사 없이 개인 앱으로 되지만, 처음 한 번 카카오 로그인이 필요해요.

콘솔(https://developers.kakao.com/console/app)에서 앱을 고른 뒤, 왼쪽 메뉴 기준으로:

1. **앱 만들기**: 내 애플리케이션 → 애플리케이션 추가 (이름·회사명은 자유).
2. **REST API 키·시크릿**: `[앱] > [플랫폼 키]`(또는 `[앱 설정] > [앱 키]`)에서 **REST API 키**를 복사해 `.env` 의 `KAKAO_REST_KEY` 에 넣어요. 같은 화면의 **REST API 키 > 클라이언트 시크릿**이 "사용" 상태면(새 콘솔은 기본 사용) 그 값도 `KAKAO_CLIENT_SECRET` 에 넣어요. 넣지 않으면 로그인 마지막 단계에서 `invalid_client` 오류가 나요.
3. **리다이렉트 URI**: `[앱] > [플랫폼 키] > [REST API 키] > [리다이렉트 URI]`(구 콘솔: `[카카오 로그인] > [Redirect URI]`)에 `http://localhost:3000/auth/kakao/callback` 을 **한 글자도 다르지 않게** 등록해요 (포트를 바꿨다면 그 포트로).
4. **카카오 로그인 켜기**: `[카카오 로그인] > [사용 설정]`에서 상태를 **ON**.
5. **동의항목**: `[카카오 로그인] > [동의항목]`에서 `[접근권한] > [카카오톡 메시지 전송]`(talk_message)을 **선택 동의**로 설정하고 저장해요. 나에게 보내기는 비즈 앱 전환 없이 돼요.
6. **웹 도메인**: `[앱] > [제품 링크 관리] > [웹 도메인]`(구 콘솔: `[플랫폼] > [Web]`)에 메시지 버튼 링크의 도메인을 등록해요. localhost 는 등록이 안 되므로 기본값인 `https://github.com` 을 등록하거나, `.env` 의 `KAKAO_LINK_URL` 을 원하는 공개 주소로 바꾸고 그 도메인을 등록해요.
7. **연결**: 서버를 재시작하고 포트폴리오 → 실제 보유·리밸런싱에서 **"카카오 연결"** → 카카오 로그인·동의 → "연결됐어요" 화면이 뜨면 끝. **"카카오톡으로 보내기"** 로 테스트해요.

자주 나는 오류: `KOE006`/`redirect_uri mismatch` → 3번 URI 오타(끝 슬래시, http/https, 포트). `invalid_client` → 2번 클라이언트 시크릿 누락. `KOE101`/`invalid scope` → 5번 동의항목 미설정. 전송 시 링크 관련 오류 → 6번 도메인 미등록.

토큰은 `data/kakao.json` 에 저장되고 액세스 토큰(6시간)은 서버가 자동 갱신해요. 리프레시 토큰은 2개월 유효하며 알림이 나갈 때마다 연장되지만, 2개월 넘게 한 번도 알림이 없으면 만료돼 다시 "카카오 연결"이 필요해요. 메시지 본문은 카카오 제한(200자)에 맞춰 요약돼요. 텔레그램과 카카오가 둘 다 설정돼 있으면 두 곳 모두로 보내요.

## 12. 클라우드에 상시 운영하기 (Google Cloud 무료 VM)

집 컴퓨터를 켜 두지 않아도 매일 16:30 점검·알림이 나가게 하려면 항상 켜진 서버가 필요해요. GCP **e2-micro** 는 무료 티어(월 1대, 미국 리전)라 비용 없이 쓸 수 있어요.

### 12-1. VM 만들기 (콘솔, 5분)
1. https://console.cloud.google.com → 프로젝트 만들기(또는 선택) → **Compute Engine → VM 인스턴스 → 인스턴스 만들기**.
2. 설정: 이름 `dashboard`, **리전 `us-west1` / `us-central1` / `us-east1` 중 하나**(무료 티어 조건), 머신 유형 **E2 → e2-micro**, 부팅 디스크 **Ubuntu 24.04 LTS, 표준 영구 디스크 30GB 이하**.
3. **방화벽**: "HTTP 트래픽 허용", "HTTPS 트래픽 허용" 둘 다 체크 → 만들기.
4. 목록에 뜬 **외부 IP** 를 메모해요. (재시작해도 IP 가 바뀌지 않게 하려면 VPC 네트워크 → IP 주소에서 "고정 IP 로 승격" — VM 에 붙어 있는 동안은 무료예요.)

### 12-2. 서버 설정 (SSH, 10분)
VM 목록의 **SSH** 버튼을 누르면 브라우저 터미널이 열려요. 거기서:
```bash
sudo apt-get update -y && sudo apt-get install -y git
git clone https://github.com/wonderarmour/stock-market-dashboard.git ~/side_prj
bash ~/side_prj/deploy/gcp-setup.sh
```
저장소가 **Private** 이면 `git clone` 이 Username 과 Password 를 물어요 — Password 자리에는 GitHub 비밀번호가 아니라 **Personal Access Token** 을 넣어요 (GitHub → Settings → Developer settings → Personal access tokens → Fine-grained → 이 저장소만, Contents: Read-only). 저장소를 Public 으로 바꾸면 토큰 없이 clone 돼요(코드에 키는 없어요).

스크립트가 Node.js·Caddy 설치, `.env` 생성(임의 비밀번호 포함), systemd 등록, HTTPS 프록시까지 한 번에 해요. 도메인이 없어도 **`<외부IP를 -로 바꾼값>.sslip.io`** 주소로 인증서가 자동 발급돼요 (예: IP 34.64.1.2 → `https://34-64-1-2.sslip.io`).

끝나면 안내대로 키를 넣고 재시작해요:
```bash
nano ~/side_prj/.env          # OPENAI_API_KEY, KAKAO_REST_KEY, KAKAO_CLIENT_SECRET 입력. APP_PASSWORD 는 원하는 값으로 바꿔도 됨
sudo systemctl restart market-dashboard
journalctl -u market-dashboard -n 20   # "Server running ... (public: https://...)" 확인
```

### 12-3. 카카오 콘솔 갱신
주소가 localhost 에서 공개 주소로 바뀌었으니 카카오 콘솔에서:
- **리다이렉트 URI** 에 `https://<주소>/auth/kakao/callback` 추가 (11장 3번 위치)
- **웹 도메인** 에 `https://<주소>` 추가 (11장 6번 위치)
그 뒤 브라우저로 `https://<주소>` 접속 → 비밀번호 로그인 → 포트폴리오 → 실제 보유·리밸런싱 → **카카오 연결**(서버가 바뀌었으니 다시 한 번) → **카카오톡으로 보내기** 로 테스트.

### 12-4. 운영
- 코드 업데이트: `cd ~/side_prj && git pull && sudo systemctl restart market-dashboard`
- 포트폴리오 데이터: `~/side_prj/data/` (VM 삭제 시 함께 사라지니 가끔 내려받기: `gcloud compute scp dashboard:~/side_prj/data/portfolio.json .` 또는 SSH 창의 다운로드 기능)
- 로컬 PC 의 포트폴리오를 옮기려면 `data/portfolio.json` 을 VM 의 같은 경로에 올리고 재시작
- 비용: e2-micro 1대·30GB 디스크·월 1GB 송신은 무료. 고정 IP 는 VM 에 붙어 있을 때만 무료(떼어 두면 과금). 결제 알림(예: 1달러)을 걸어 두면 안심이에요.
- 로그인 실패가 5번 넘으면 1분간 잠겨요. 비밀번호를 바꾸면 기존 로그인은 모두 풀려요.

## 13. 보안 메모

- `.env` 에는 API 키가 들어 있어요. `.gitignore` 에 포함돼 있지만, 폴더를 압축해 보낼 때는 **`.env` 를 빼고** 보내 주세요.
- 폴더에 있던 `GPT API key.txt` 는 평문 키 파일이에요. 키는 이미 `.env` 에 있으니 삭제하는 게 안전해요 (`.gitignore` 에도 넣어 뒀어요).
- 외부에 공개할 때는 반드시 `APP_PASSWORD` 를 설정하고 HTTPS(12장 Caddy) 뒤에 두세요. 로컬 전용이면 비밀번호 없이 써도 되지만 포트를 외부에 열지 마세요.
- `data/kakao.json` 에는 카카오 토큰이 들어 있어요. `data/` 는 git 에서 제외되지만, 폴더를 공유할 때 같이 보내지 마세요.
