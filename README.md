# 🌱 새싹 레이더 (saessak-radar)

[디지털새싹](https://newsac.kosac.re.kr/) 프로그램 목록을 주기적으로 확인해서
**① 감시 조건에 맞는 새 프로그램 등록**, **② "모집 예정 → 모집 중" 상태 전환**을 감지하면
**텔레그램으로 알림**을 보내는 감시 앱입니다.

목록이 JavaScript로 렌더링되기 때문에 **Playwright(headless Chromium)** 로 읽습니다.

---

## 기능

- 10분(설정 가능) 간격으로 프로그램 목록 자동 수집
- 감시 조건(유형/권역/학교급/상태/교육대상) 매칭
- 신규 등록 → 🟡 `[새 프로그램]`, 모집 시작/전환 → 🔴 `[모집 시작]` 텔레그램 알림
- 같은 프로그램+상태로는 중복 알림 없음
- 수집 3회 연속 실패 시 `⚠️ 수집 실패 중` 경보 1회
- 웹 대시보드: 감시 상태 / 조건 일치 수 / 오늘 알림 수 / 최근 감지 로그 20건 / "즉시 확인" 버튼
- 설정 페이지에서 감시 조건 체크박스로 변경 → 다음 주기부터 적용
- **클릭 이동**: 텔레그램 알림에 `🔗 신청 페이지 열기` 인라인 버튼, 브라우저 알림 클릭 시 상세페이지 새 탭, 대시보드 로그 줄 클릭 시 상세페이지 새 탭
- **알림 리허설**: 대시보드 `테스트 알림 보내기` 버튼(`POST /api/test-alert`)으로 가짜 프로그램 1건을 실제 발송 경로(브라우저+텔레그램, 인라인 버튼 포함)에 태워 점검. 로그에 `test`로만 남고 오늘 알림 카운트·조건 일치 수·감시 스냅샷에는 미반영

---

## 기술 스택

Node.js · Express · Playwright(chromium) · node-cron · JSON 파일 저장

---

## 로컬 실행

```bash
npm install
npx playwright install chromium
cp .env.example .env   # 토큰/챗ID 채우기 (없어도 실행은 됨, 콘솔에만 출력)
npm start
```

- 브라우저에서 http://localhost:3000 접속
- **"지금 즉시 확인"** 버튼을 눌러 1회 수집 실행 → 콘솔에 `카드 N개 수집` 로그로 몇 개 잡히는지 확인
- 카드가 0개면 셀렉터/렌더링 문제 (에러 처리되어 diff는 스킵됨)

환경변수:

| 변수 | 설명 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | 텔레그램 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 알림 받을 채팅 ID |
| `DATA_DIR` | 상태 저장 경로 (비우면 `./data`) |

---

## 텔레그램 봇 만들기 (요약)

1. 텔레그램에서 **@BotFather** 검색 → `/newbot` → 이름/username 지정 → **봇 토큰** 발급
2. 방금 만든 봇에게 아무 메시지나 1개 전송 (봇이 나에게 말 걸 수 있게)
3. **@userinfobot** 에게 말 걸어 내 **chat id**(숫자) 확인
   (그룹으로 받으려면 봇을 그룹에 초대 후 그룹 chat id 사용)
4. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` 에 각각 입력

---

## Railway 배포 순서

1. 이 저장소를 GitHub에 push
2. [Railway](https://railway.app) → **New Project → Deploy from GitHub repo** → `saessak-radar` 선택
3. Railway가 **Dockerfile을 자동 인식**해서 빌드 (Playwright 베이스 이미지라 크로뮴 포함)
4. **Variables** 탭에서 환경변수 2개 등록:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. **Volume** 추가 → 마운트 경로를 `/data` 로 설정 → 변수에 `DATA_DIR=/data` 추가
   (재배포/재시작해도 감시 스냅샷과 로그가 유지됨)
6. Deploy 완료 후 도메인 접속 → 대시보드 확인, "즉시 확인"으로 수집 테스트

> Volume을 붙이지 않으면 재시작 때마다 state가 초기화되어, 배포 직후 기존 프로그램들이
> "신규"로 잡혀 알림이 몰려올 수 있습니다. **`/data` Volume 권장.**

---

## 프로젝트 구조

```
saessak-radar/
├─ package.json
├─ Dockerfile
├─ .env.example
├─ src/
│  ├─ server.js    Express 서버 + cron 스케줄 + 대시보드/설정 UI
│  ├─ scraper.js   Playwright 수집 (텍스트 기반 견고 추출)
│  ├─ watcher.js   diff 판정 + 텔레그램 발송
│  └─ storage.js   settings.json / state.json / log.json 읽기쓰기
└─ public/         정적 파일 (선택)
```

## 감시 조건 기본값

```json
{
  "programType": ["방문형"],
  "regions": ["서울·인천권"],
  "schoolLevels": ["초등학교"],
  "statuses": ["모집 예정", "모집 중"],
  "targets": ["일반형", "사회적 배려형(다문화)"],
  "intervalMinutes": 10
}
```

- 유형/권역/학교급: 카드 값이 체크 목록에 **하나라도 포함되면 통과** (복수 표기 권역 지원)
- 교육대상: **OR** — 체크한 대상 중 하나라도 태그에 있으면 통과
- **모집 완료는 항상 제외**
