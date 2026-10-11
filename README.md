# cdabot

텔레그램 봇 (counseling-bot과 같은 구조: TypeScript + Telegraf + Neon PostgreSQL + dayjs)

## 시작하기

```bash
npm install
cp .env.example .env   # 값 채우기
npm run dev            # 로컬 실행 (WEBHOOK_URL 비우면 폴링 모드)
```

> ⚠️ 로컬 폴링은 운영 중인 토큰으로 실행하지 마세요 (운영 웹훅이 해제됩니다). 테스트용 봇 토큰을 따로 쓰는 것을 권장합니다.

## 배포

```bash
git pull && npm install && npm run build && npm start   # dist/bot.js 실행
```

- `.env`에 `WEBHOOK_URL=https://도메인/webhook` 설정 → 시작 시 웹훅 자동 등록
- 크론: `/cron-10am`, `/cron-10pm` (`CRON_SECRET` 설정 시 `?key=값` 필요)

## 구조

- `src/bot.ts` — 명령어 핸들러, HTTP 서버(웹훅·크론)
- `src/db.ts` — DB 연결, `cdabot_chats` 테이블 자동 생성, 조회·수정 함수, `members` 조회
- `src/utils.ts` — 날짜/시간 파싱, HTML 이스케이프, 긴 메시지 분할 전송

## 기본 명령어

- `/도움말`, `/내아이디`, `/상태확인`, `/일정 10.8(목) 오후 7시`
- `관리자 점검` (ADMIN_IDS에 등록된 사용자만)
