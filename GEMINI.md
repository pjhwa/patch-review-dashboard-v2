# Patch Review Dashboard v2 — Project GEMINI.md

## 프로젝트 개요
- **서버**: `tom26` / `172.16.10.237` (SSH: `citec@172.16.10.237`)
- **프로젝트 경로 (서버)**: `/home/citec/patch-review-dashboard-v2/`
- **스크립트 경로 (서버)**: `/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/`
- **로컬 경로**: `C:\Users\jooksan.park\Patch-Review\patch-review-dashboard-v2\`
- **GitHub**: `https://github.com/pjhwa/patch-review-dashboard-v2`

## ⚠️ 세션 시작 시 반드시 할 일

1. **`LEARNED.md` 읽기** — 프로젝트 루트의 `LEARNED.md`를 반드시 먼저 읽고 시작할 것.
   과거 실패 사례와 교훈이 기록되어 있으며, 같은 실수를 반복하면 안 됨.

2. **코드 먼저, 문서는 나중** — 스크립트의 출력 경로, 동작 방식, URL 등은 반드시
   `cat` / `ssh` 로 실제 코드를 확인한 후에 기술할 것. 추측 금지.

## 핵심 아키텍처

### 데이터 수집 (CRON — 파이프라인과 분리)
```
run_collectors_cron.sh (분기별 CRON)
  ├── redhat/rhsa_collector.js   → redhat_data/{id}.json
  ├── redhat/rhba_collector.js   → redhat_data/{id}.json
  ├── oracle/oracle_collector.sh → oracle_data/{id}.json  (yum updateinfo.xml.gz)
  └── ubuntu/ubuntu_collector.sh → ubuntu_data/{id}.json  (git clone + jq)
```

### AI 리뷰 파이프라인 (Dashboard 수동 트리거)
```
① DB 초기화 (PreprocessedPatch + ReviewedPatch 삭제)
② patch_preprocessing.py --days 90 → PreprocessedPatch DB
③ query_rag.py → UserFeedback RAG 주입
④ openclaw agent --agent main (stale .lock 자동 삭제)
⑤ AI 결과 검증 (환각 스킵, url/osVersion/releaseDate 복사)
⑥ Passthrough: AI 누락 항목 → ReviewedPatch 직접 채움
```

### 운영 명령어
```bash
# PM2 재시작
cd /home/citec/patch-review-dashboard-v2 && npm run build && npx pm2 restart all

# Lock 파일 정리
rm -f ~/.openclaw/agents/main/sessions/*.lock

# CRON 확인
crontab -l

# ubuntu-security-notices 최초 세팅 (서버)
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/ubuntu
git clone https://github.com/canonical/ubuntu-security-notices.git
```

## 기술 스택
- **Next.js**: 16.1.6 (App Router, React 19)
- **Node.js**: v22.22.0 (nvm)
- **DB**: SQLite (`prisma/patch-review.db`)
- **Queue**: BullMQ + Redis
- **AI**: OpenClaw 2026.3.x
- **PM2**: `patch-dashboard` (fork, port 3000)
- **TypeScript**: strict mode 필수

## 주의사항
- PowerShell에서 `&&` 문법 사용 불가 → 명령을 별도로 실행
- `schema.prisma`의 `PreprocessedPatch`에는 `url`, `releaseDate`, `osVersion` 포함
- `ReviewedPatch`에는 `url`, `releaseDate` 컬럼 없음 → stage API에서 join으로 보완
- `RawPatch` 테이블은 현재 미사용 (이력용, 실제 수집은 JSON 파일)
