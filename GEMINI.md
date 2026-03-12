# Patch Review Dashboard v2 — Project GEMINI.md

> **이 파일은 세션 시작 시 자동으로 로드됩니다. 반드시 정독 후 작업을 시작하세요.**

---

## 📍 기본 정보

| 항목 | 값 |
|---|---|
| **서버** | `tom26` / `<SERVER_IP>` |
| **SSH** | `citec@<SERVER_IP>` |
| **서버 앱 경로** | `/home/citec/patch-review-dashboard-v2/` |
| **스크립트 경로 (서버)** | `/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/` |
| **로컬 경로** | `C:\Users\jooksan.park\Patch-Review\patch-review-dashboard-v2\` |
| **GitHub** | `https://github.com/pjhwa/patch-review-dashboard-v2` |
| **대시보드 URL** | `http://<SERVER_IP>:3000` |
| **Node.js** | v22.22.0 (nvm) |
| **Next.js** | 16.1.6 (App Router, React 19, TypeScript strict) |
| **PM2** | `patch-dashboard` (fork mode, port 3000) |
| **DB** | SQLite `prisma/patch-review.db` (Prisma ORM) |
| **Queue** | BullMQ + Redis |
| **AI** | OpenClaw 2026.3.x |

---

## ⚠️ 세션 시작 시 반드시 할 일

1. **`LEARNED.md` 읽기** — 프로젝트 루트의 `LEARNED.md`를 반드시 먼저 읽고 시작할 것.
2. **코드 먼저** — 파일 경로, URL, 동작 방식은 반드시 `cat`/`ssh`로 실제 코드 확인 후 기술. 추측 금지.

---

## 🔴 [최우선 강제 규칙] 서버 우선 작업 + GitHub 자동 업데이트

> **이 규칙은 모든 세션에서 0순위로 적용되는 코어 명령이다. 예외 없음.**

### 규칙 1: 서버 우선 수정 워크플로우

모든 코드 수정·검증·테스트는 **반드시 서버(`tom26`, `<SERVER_IP>`)에서 수행**한다.
로컬 파일을 직접 수정한 뒤 서버에 올리는 방식은 **금지**. 순서는 다음과 같다:

```
① 서버에서 코드 수정  (ssh + 에디터 또는 scp로 스크립트 전송 후 실행)
② 서버에서 검증       (node test.js, npm run build, pm2 restart 등)
③ 검증 완료 후 로컬 동기화 (scp 서버→로컬)
④ GitHub 즉시 반영   (git add ; git commit ; git push)
```

### 규칙 2: 코드 변경 시 GitHub 자동 업데이트 의무화

코드가 수정·검증된 직후, **사용자의 별도 요청 없이** 즉시 GitHub에 푸시한다:

```bash
# 로컬에서 실행 (PowerShell이므로 ; 로 분리)
cd C:\Users\jooksan.park\Patch-Review\patch-review-dashboard-v2
git add .
git commit -m "feat: [변경 내용 요약]"
git push origin master
```

### 규칙 2.5: 보안 - 코드 푸시 전 민감정보 마스킹 필수 (IP 등)
**매우 중요**: GitHub 등 외부에 코드를 푸시하거나 문서를 업데이트할 때, **절대 실제 운영 서버의 IP 주소(예: `<SERVER_IP>`), 패스워드, API 키**를 있는 그대로 올리지 않는다. 
모든 IP 주소와 민감한 정보는 `tom26` 혹은 `<SERVER_IP>` 등으로 **반드시 마스킹(Masking)** 처리한 후 커밋해야 한다.

### 규칙 3: 수집기 스크립트 동기화 위치

수집기 스크립트(`rhba_collector.js`, `rhsa_collector.js` 등)는 서버의 다음 경로가 **원본(Source of Truth)**:
- 서버: `/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/redhat/`
- 로컬 동기화 경로: `C:\Users\jooksan.park\Patch-Review\patch-review-dashboard-v2\scripts\`

---

## 🏗️ 핵심 아키텍처 (2가지 실행 축)

### 축 1: 데이터 수집 (Linux CRON — 파이프라인과 완전 분리)

```
run_collectors_cron.sh (분기별, 수동 실행 불가)
  ├── redhat/rhsa_collector.js   → redhat_data/{id}.json  (CSAF changes.csv Incremental)
  ├── redhat/rhba_collector.js   → redhat_data/{id}.json
  ├── oracle/oracle_collector.sh → oracle_data/{id}.json  (yum updateinfo.xml.gz)
  │   + oracle_parser.py
  └── ubuntu/ubuntu_collector.sh → ubuntu_data/{id}.json  (git clone + jq)
```

**중요**: `RawPatch` DB 테이블은 미사용. 수집된 데이터는 JSON 파일로만 존재.
**수집 카운트**: `/api/products` 에서 JSON 파일 수를 OS level에서 카운트해 반환.

### 축 2: AI 리뷰 파이프라인 (Dashboard 수동 트리거 → BullMQ)

```
① /api/pipeline/run  →  PreprocessedPatch + ReviewedPatch DB 전체 삭제
② BullMQ Job 등록  →  src/lib/queue.ts 워커 실행
③ patch_preprocessing.py --days 90
     벤더별 JSON 읽기 → Core Component 필터링 → PreprocessedPatch DB upsert
     → patches_for_llm_review.json 생성
     → job.log('[PREPROCESS_DONE] count=N')  ← 대시보드 실시간 카운터 갱신 트리거
④ query_rag.py  →  UserFeedback RAG 주입
⑤ rm -f ~/.openclaw/agents/main/sessions/*.lock  (stale lock 자동 제거)
   openclaw agent --agent main --json -m "[프롬프트]"
   → patch_review_ai_report.json 생성
⑥ AI 결과 검증:
     - PreprocessedPatch 맵 구성 (모든 issueId)
     - AI IssueID가 맵에 없으면 스킵 (환각 방지)
     - url, releaseDate, osVersion 은 PreprocessedPatch 에서 복사
⑦ Passthrough:
     - AI가 처리 안 한 PreprocessedPatch 항목을 ReviewedPatch에 직접 upsert
     - criticality: 'Important', decision: 'Pending'
     - 모든 벤더(RedHat/Oracle/Ubuntu)의 전처리 패치가 반드시 ReviewedPatch에 존재하도록 보장
```

---

## 📂 소스 파일 맵 (핵심 파일만)

### Backend / Queue
| 파일 | 역할 |
|---|---|
| `src/lib/queue.ts` | **핵심**: BullMQ 워커 전체 파이프라인 로직. AI 프롬프트, Passthrough, lock 제거 모두 여기 |
| `src/lib/db.ts` | Prisma 클라이언트 싱글톤 |
| `src/lib/i18n.ts` | 한국어/영어 다국어 문자열 |

### API Routes
| 경로 | 파일 | 역할 |
|---|---|---|
| `POST /api/pipeline/run` | `src/app/api/pipeline/run/route.ts` | DB 초기화 후 BullMQ Job 등록 |
| `GET /api/pipeline/stream` | `src/app/api/pipeline/stream/route.ts` | SSE 실시간 로그 스트림 |
| `GET /api/pipeline` | `src/app/api/pipeline/route.ts` | 최근 PipelineRun 상태 조회 |
| `GET /api/pipeline/stage/[stageId]` | `src/app/api/pipeline/stage/[stageId]/route.ts` | preprocessed/reviewed 패치 목록 (reviewed는 PreprocessedPatch join으로 url/releaseDate 보완) |
| `GET/POST /api/pipeline/feedback` | `src/app/api/pipeline/feedback/route.ts` | UserFeedback CRUD |
| `POST /api/pipeline/finalize` | `src/app/api/pipeline/finalize/route.ts` | 관리자 Approve/Exclude 최종 처리 |
| `GET /api/products` | `src/app/api/products/route.ts` | 벤더별 collected/preprocessed/reviewed/approved 카운트 |

### Frontend Components
| 파일 | 역할 |
|---|---|
| `src/components/ProductGrid.tsx` | 메인 대시보드: 파이프라인 실행 버튼, SSE 수신, 상태 표시, 에러 패널 |
| `src/components/PremiumCard.tsx` | 벤더별 통계 카드 (4단계 카운트) |
| `src/components/StageJSONViewer.tsx` | 파이프라인 단계별 JSON 뷰어 |
| `src/app/category/[categoryId]/[productId]/ClientPage.tsx` | 제품 상세: 전처리 탭 + AI 리뷰 탭, Approve/Exclude UI |

---

## 🗄️ DB 스키마 요약 (`prisma/schema.prisma`)

```
PreprocessedPatch: id, vendor, issueId, osVersion, component, version,
                   severity, releaseDate, description, url, isReviewed, ...

ReviewedPatch:     id, vendor, issueId, osVersion, component, version,
                   criticality, description, koreanDescription, decision,
                   reason, pipelineRunId
                   ※ url, releaseDate 컬럼 없음
                     → /api/pipeline/stage/reviewed 에서 PreprocessedPatch join으로 보완

UserFeedback:      issueId, vendor, component, version, userReason

PipelineRun:       status, message, logs (로깅 전용)

RawPatch:          현재 미사용 (이력 보존용)
```

---

## 🔑 중요 코드 패턴

### 1. ProductGrid.tsx — SSE 수신 및 로그 감지
```typescript
// [PREPROCESS_DONE] 감지 시 카운터 즉시 갱신
if (line.includes('[PREPROCESS_DONE]')) {
    router.refresh();
}
// AI_REVIEW_FAILED: 감지 시 에러 패널 표시
if (line.includes('AI_REVIEW_FAILED:')) {
    setAiError(line.replace('AI_REVIEW_FAILED:', '').trim());
}
```

### 2. queue.ts — AI 환각 방지 + Passthrough 패턴
```typescript
// PreprocessedPatch 전체 로드 후 맵 구성
const allPreprocessed = await prisma.preprocessedPatch.findMany({...});
const preprocessedMap = new Map<string, any>();
allPreprocessed.forEach(pp => preprocessedMap.set(pp.issueId, pp));

// AI 결과 인서트 시 검증
for (const item of aiResults) {
    if (!preprocessedMap.has(item.IssueID)) continue; // 환각 스킵
    const meta = preprocessedMap.get(item.IssueID);
    // meta.url, meta.releaseDate, meta.osVersion 을 ReviewedPatch에 복사
}

// Passthrough: AI가 처리 안 한 항목
const aiCovered = new Set(aiResults.map(d => d.IssueID));
const missed = allPreprocessed.filter(pp => !aiCovered.has(pp.issueId));
for (const pp of missed) {
    await prisma.reviewedPatch.upsert({
        where: { issueId: pp.issueId },
        create: { criticality: 'Important', decision: 'Pending', ... }
    });
}
```

### 3. queue.ts — OpenClaw 실행 전 lock 제거
```typescript
const lockFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.lock'));
for (const lf of lockFiles) fs.unlinkSync(path.join(sessionsDir, lf));
```

### 4. /api/pipeline/stage/[stageId] — reviewed에서 url/releaseDate join
```typescript
// ReviewedPatch에는 url/releaseDate 없음 → PreprocessedPatch에서 조회
const preProcessedData = await prisma.preprocessedPatch.findMany({
    where: { issueId: { in: issueIds } },
    select: { issueId: true, url: true, releaseDate: true }
});
// 응답에서 Date: meta.releaseDate, Url: meta.url 로 제공
```

---

## 🛠️ 운영 명령어

```bash
# 서버 로그 확인
ssh citec@<SERVER_IP> "cat ~/.pm2/logs/patch-dashboard-out.log | tail -50"

# PM2 재시작 (서버에서)
cd /home/citec/patch-review-dashboard-v2 && npm run build && npx pm2 restart all

# 로컬 → 서버 배포 (로컬에서)
scp src\lib\queue.ts citec@<SERVER_IP>:/home/citec/patch-review-dashboard-v2/src/lib/
ssh citec@<SERVER_IP> "source ~/.nvm/nvm.sh && cd /home/citec/patch-review-dashboard-v2 && npm run build && npx pm2 restart all"

# OpenClaw lock 제거
ssh citec@<SERVER_IP> "rm -f ~/.openclaw/agents/main/sessions/*.lock"

# CRON 확인
ssh citec@<SERVER_IP> "crontab -l"

# DB 직접 확인
ssh citec@<SERVER_IP> "cd /home/citec/patch-review-dashboard-v2 && npx prisma studio"

# 수집기 수동 실행 (서버에서)
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2
bash run_collectors_cron.sh

# ubuntu-security-notices 최초 세팅 (서버, 최초 1회만)
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/ubuntu
git clone https://github.com/canonical/ubuntu-security-notices.git
```

---

## ⚠️ 자주 발생하는 문제 & 해결법

| 증상 | 원인 | 해결 |
|---|---|---|
| PM2 반복 재시작 / Next.js 빌드 실패 | `/home/citec/package-lock.json` 이 워크스페이스 루트를 오염 | `rm /home/citec/package-lock.json` 후 재빌드 |
| `session file locked (timeout)` | stale `.lock` 파일 잔존 | `rm -f ~/.openclaw/agents/main/sessions/*.lock` |
| Pipeline "waiting" 상태 고착 | `job.updateProgress()` 를 스크립트 실행 후에만 호출 | 스크립트 실행 **전**에 `updateProgress(10)` + `job.log()` 먼저 호출 |
| RedHat/Oracle AI 리뷰 카운트 0 | SKILL.md 필터로 AI가 Ubuntu만 출력 | Passthrough가 자동 보완 — Passthrough 로직이 queue.ts에 있는지 확인 |
| URL/배포일이 N/A로 표시 | ReviewedPatch에 url 컬럼 없음 | stage API의 PreprocessedPatch join 코드 확인 |
| PowerShell `&&` 오류 | Windows PowerShell은 `&&` 미지원 | 명령을 별도 `run_command`로 분리 실행 |

---

## 📌 주요 설계 결정 (변경 시 검토 필요)

1. **수집/AI리뷰 분리**: 수집기를 queue.ts에서 직접 호출하면 안 됨. CRON 전용.
2. **ReviewedPatch의 url/releaseDate 부재**: 의도적. stage API가 PreprocessedPatch를 join해 반환.
3. **Passthrough 필수**: SKILL.md의 Impact 필터는 매우 엄격. 없으면 RedHat/Oracle 항목이 ReviewedPatch에 0개가 됨.
4. **AI 환각 방지**: AI 리포트의 IssueID는 반드시 PreprocessedPatch와 교차 검증 후 인서트.
5. **수집 카운트 소스**: `RawPatch` DB가 아닌 디스크 JSON 파일 수 (`redhat_data/`, `oracle_data/`, `ubuntu_data/`).
