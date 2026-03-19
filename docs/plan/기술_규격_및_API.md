# 기술 규격 및 API 명세 — patch-review-dashboard-v2

---

## 1. 기술 스택

| 계층 | 기술 | 버전 | 용도 |
|------|------|------|------|
| 프레임워크 | Next.js | 16.1.6 | App Router, SSR, API Routes |
| 언어 | TypeScript | ^5 | 전체 코드베이스 |
| UI | React | 19.2.3 | 컴포넌트 렌더링 |
| CSS | Tailwind CSS | ^4 | 스타일링 |
| 컴포넌트 | shadcn/ui, Radix UI | ^1 | UI 컴포넌트 라이브러리 |
| 애니메이션 | Framer Motion | ^12 | 카드/모달 애니메이션 |
| 아이콘 | Lucide React | ^0.575 | 아이콘 세트 |
| ORM | Prisma | ^5.22 | DB 접근 레이어 |
| DB | SQLite (WAL) | - | 로컬 데이터 저장 |
| 큐 | BullMQ | ^5.70 | 파이프라인 작업 큐 |
| Redis | ioredis | ^5.10 | BullMQ 백엔드 |
| CSV | PapaParse | ^5.5 | CSV 파싱/생성 |
| 검증 | Zod | ^3.25 | AI 응답 스키마 검증 |
| AI CLI | OpenClaw | - | LLM 호출 (외부 CLI) |
| 벡터 DB | ChromaDB | - | RAG 배제 규칙 저장 |
| 전처리 | Python 3 | 3.x | 원시 데이터 정규화 |
| 프로세스 관리 | PM2 | - | 앱 서버 프로세스 관리 |
| 패키지 관리 | pnpm | - | Node.js 패키지 관리 |

---

## 2. 환경 변수

| 변수명 | 기본값 | 설명 |
|--------|--------|------|
| `DATABASE_URL` | `file:./prisma/patch-review.db` | Prisma SQLite 경로 |
| `DB_TYPE` | `sqlite` | DB 타입 (WAL 모드 활성화 조건) |
| `HOME` | `/home/citec` | 스킬 디렉토리 기준 경로 |

---

## 3. Zod 스키마 명세

### 3.1 ReviewItemSchema

AI(OpenClaw)가 반환하는 JSON 배열의 단일 항목 스키마:

```typescript
const ReviewItemSchema = z.object({
    IssueID:            z.string().default("Unknown"),
    Component:          z.string().default("Unknown"),
    Version:            z.string().default("Unknown"),
    Vendor:             z.string().default("Unknown"),
    Date:               z.string().optional().default("Unknown"),
    Criticality:        z.string().default("Unknown"),
    Description:        z.string().default("Unknown"),
    KoreanDescription:  z.string().default("Unknown"),
    Decision:           z.string().optional().default("Done"),
    Reason:             z.string().optional().default(""),
}).passthrough(); // OsVersion 등 추가 필드 허용

const ReviewSchema = z.array(ReviewItemSchema);
```

**필드 설명:**

| 필드 | 타입 | 설명 |
|------|------|------|
| IssueID | string | 패치 고유 식별자 (DB issueId와 매핑) |
| Component | string | 패치 대상 컴포넌트 (예: kernel, mariadb) |
| Version | string | 패치 버전 또는 KB 번호 |
| Vendor | string | 벤더명 (vendorString과 일치해야 함) |
| Date | string | 패치 발행일 (YYYY-MM-DD) |
| Criticality | string | Critical, Important, Moderate, Low, Unknown |
| Description | string | 패치 설명 (영문, 1-2문장 요약) |
| KoreanDescription | string | 패치 설명 (한국어 번역) |
| Decision | string | Done(포함), Exclude(제외), Pending(미결) |
| Reason | string | Exclude 사유 |
| OsVersion | string? | OS 버전 (Linux/Windows 제품에 해당) |

---

## 4. API 상세 명세

### 4.1 파이프라인 상태 조회

**GET /api/pipeline**

응답:
```json
{
  "hasActiveJob": true,
  "jobId": "123",
  "status": "active",    // "active" | "waiting" | "idle"
  "progress": 65
}
```

---

### 4.2 파이프라인 실행 (제품별)

**POST /api/pipeline/{product}/run**

경로 패턴: `/api/pipeline/run` (Linux 3종), `/api/pipeline/{product}/run` (나머지)

요청 본문:
```json
{
  "vendor": "redhat",        // 제품 ID
  "isRetry": false,          // 재시도 여부
  "isAiOnly": false          // 전처리 건너뜀 여부
}
```

응답:
```json
{
  "success": true,
  "jobId": "abc123"
}
```

오류 응답:
```json
{
  "error": "A pipeline job is already in the queue.",
  "jobId": "existing123"
}
```

---

### 4.3 SSE 로그 스트림

**GET /api/pipeline/stream?jobId={jobId}**

응답: `Content-Type: text/event-stream`

이벤트 형식:
```
data: {"status":"active","progress":50,"log":"[REDHAT-AI] Evaluating batch 1/3..."}

data: {"status":"active","progress":75}

data: {"status":"completed","progress":100}
```

상태값: `active` | `waiting` | `completed` | `failed` | `error`

헤더:
```
Content-Type: text/event-stream
Cache-Control: no-cache
X-Accel-Buffering: no
```

---

### 4.4 파이프라인 완료 (Finalize)

**POST /api/pipeline/{product}/finalize**

요청 본문: 없음 (또는 빈 객체)

동작: ReviewedPatch DB → CSV 파일 생성 → skillDir/finalCsvFile에 저장

응답:
```json
{
  "success": true,
  "count": 42,
  "csvPath": "/path/to/final_approved_patches_redhat.csv"
}
```

---

### 4.5 CSV 내보내기

**GET /api/pipeline/export?categoryId={category}&productId={product}**

파라미터:
- `categoryId`: 필수. `os` | `storage` | `database` | `virtualization`
- `productId`: 선택. 특정 제품 ID 또는 `all` (기본: 카테고리 전체)

응답: `Content-Type: text/csv`
```
Content-Disposition: attachment; filename="Final_Approved_Patches_os_redhat.csv"
```

CSV 컬럼: `IssueID, Component, Version, Vendor, Date, Criticality, Description, KoreanDescription, Decision, Reason`

주의: 모든 CSV는 UTF-8 BOM(`\uFEFF`)을 포함한다.

---

### 4.6 제품 목록 및 카운트

**GET /api/products?category={category}**

파라미터: `category` = `os` | `storage` | `database` | `virtualization`

응답:
```json
{
  "products": [
    {
      "id": "redhat",
      "name": "Red Hat Enterprise Linux",
      "stages": {
        "collected": 2288,
        "preprocessed": 96,
        "reviewed": 96,
        "approved": 42
      },
      "active": true,
      "isReviewCompleted": false
    }
  ]
}
```

`stages.collected`: 파일시스템의 `{product}_data/*.json` 파일 수
`stages.preprocessed`: DB `PreprocessedPatch` count (vendor 기준)
`stages.reviewed`: DB `ReviewedPatch` count (vendor 기준)
`stages.approved`: finalCsvFile의 행 수 (파일 존재 시)
`isReviewCompleted`: finalCsvFile 존재 여부

---

### 4.7 단계별 JSON 조회

**GET /api/pipeline/stage/[stageId]?productId={productId}**

`stageId`: `raw` | `preprocessed` | `reviewed`

응답:
```json
{
  "patches": [
    {
      "issueId": "RHSA-2025:1234",
      "vendor": "Red Hat",
      "component": "kernel",
      "version": "5.14.0",
      ...
    }
  ]
}
```

---

### 4.8 피드백 등록

**POST /api/pipeline/feedback**

요청 본문:
```json
{
  "issueId": "RHSA-2025:1234",
  "vendor": "Red Hat",
  "component": "kernel",
  "version": "5.14.0",
  "userReason": "테스트 환경에서는 해당 없음"
}
```

동작:
1. `UserFeedback` DB에 저장
2. ChromaDB(`user_exclusion_feedback.json`)에도 추가 (RAG용)

응답:
```json
{ "success": true }
```

---

### 4.9 파이프라인 상태 초기화

**POST /api/pipeline/reset**

요청 본문:
```json
{
  "vendor": "redhat"   // 선택적 — 미지정 시 전체 초기화
}
```

동작: BullMQ 큐에서 완료/실패된 잡 정리, rateLimitFlag 파일 삭제

응답:
```json
{ "success": true }
```

---

### 4.10 분기 아카이브

**GET /api/archive/quarterly**

응답:
```json
{
  "archives": [
    {
      "quarter": "Q1 2026",
      "dirName": "Q1-2026",
      "totalPatches": 312,
      "createdAt": "2026-03-19T00:00:00Z"
    }
  ]
}
```

**GET /api/archive/quarterly/[quarter]**

`quarter` 형식: `Q1-2026` (하이픈)

응답:
```json
{
  "metadata": { "quarter": "Q1 2026", "totalPatches": 312, ... },
  "patches": [...]
}
```

**POST /api/archive/quarterly/auto-check**

동작: 모든 활성 제품의 finalCsvFile 존재 확인 → 전체 완료 시 createQuarterlyArchive 실행

응답:
```json
{
  "triggered": true,
  "quarter": "Q1 2026",
  "totalPatches": 312
}
```

또는:
```json
{
  "triggered": false,
  "reason": "Incomplete products: ['Windows Server']"
}
```

---

## 5. BullMQ 큐 명세

### 5.1 큐 이름

`patch-pipeline`

### 5.2 잡 이름 (jobName)

| 제품 | jobName |
|------|---------|
| redhat | `run-redhat-pipeline` |
| oracle | `run-oracle-pipeline` |
| ubuntu | `run-ubuntu-pipeline` |
| windows | `run-windows-pipeline` |
| ceph | `run-ceph-pipeline` |
| mariadb | `run-mariadb-pipeline` |
| sqlserver | `run-sqlserver-pipeline` |
| pgsql | `run-pgsql-pipeline` |
| vsphere | `run-vsphere-pipeline` |

### 5.3 잡 데이터

```typescript
{
  isRetry: boolean;   // Rate Limit 재시도 여부
  isAiOnly: boolean;  // 전처리 건너뜀 여부
}
```

### 5.4 잡 진행 상태 (progress)

| 단계 | progress 값 |
|------|------------|
| 파이프라인 시작 | 5 |
| 전처리 완료 | 30 |
| AI 리뷰 시작 | 50 |
| AI 리뷰 진행 중 | 50~90 (배치 비례) |
| DB 반영 완료 | 95 |
| 파이프라인 완료 | 100 |

---

## 6. OpenClaw AI 호출 명세

### 6.1 호출 형식

```bash
openclaw agent:main \
  --json \
  --timeout 1800 \
  --session-id {productId}_{jobId}_batch_{batchIndex} \
  -m "{prompt}"
```

### 6.2 프롬프트 구조

```
Read the rules explicitly from {skillDir}/SKILL.md.
Evaluate the following {batchSize} PATCHES according to the strict LLM evaluation rules in section 4 of that file.

CRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES.
BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.
Do NOT perform any web scraping. Do NOT use tools to write to files.

Return ONLY a pure JSON array containing EXACTLY {batchSize} objects.
Each object MUST contain: IssueID, Component, Version, Vendor, Date, Criticality,
Description, KoreanDescription, and optionally Decision and Reason.

{ragExclusions}  ← prompt-injection RAG 배제 규칙 (선택)

[BATCH DATA TO EVALUATE]:
{JSON.stringify(prunedBatch)}
```

### 6.3 AI 응답 처리

```typescript
// 코드펜스 제거 후 JSON 배열 추출
function extractJsonArray(text: string): any {
    const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    const match = stripped.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (!match) return null;
    return JSON.parse(match[0]);
}
```

### 6.4 글로벌 뮤텍스 (withOpenClawLock)

```
락 경로: /tmp/openclaw_execution.lock (디렉토리)
대기 간격: 2초
구현: mkdirSync (OS 원자적 연산)
```

### 6.5 세션 정리 (cleanupSessions)

각 배치 전 다음 파일 삭제:
- `~/.openclaw/agents/main/sessions/*.lock`
- `~/.openclaw/agents/main/sessions/*.jsonl`
- `~/.openclaw/agents/main/sessions/sessions.json` ← **필수**

---

## 7. Python 전처리 스크립트 명세

### 7.1 공통 인터페이스

모든 전처리 스크립트는 다음 CLI 인터페이스를 구현해야 한다:

```bash
python3 {product}_preprocessing.py --days N [--vendor {vendor}] [--days_end N]
```

| 인수 | 의미 | 예시 |
|------|------|------|
| `--days N` | N일 전부터 현재까지 수집 | `--days 90` |
| `--vendor vendor` | Linux 공통 스크립트용 벤더 지정 | `--vendor redhat` |
| `--days_end N` | N일 전까지만 수집 (최근 N일 제외) | `--days_end 90` |

### 7.2 출력 형식 (공통)

파일: `patches_for_llm_review_{vendor}.json`

```json
[
  {
    "patch_id": "RHSA-2025:1234",
    "vendor": "Red Hat",
    "component": "kernel",
    "version": "5.14.0-503.el9",
    "os_version": "RHEL9",
    "description": "...",
    "issued_date": "2025-01-15"
  },
  ...
]
```

표준 필드:

| 필드 | Linux | Windows/SQL | 기타 |
|------|-------|-------------|------|
| `patch_id` | - | `WINDOWS-GROUP-*`, `SQLS-GROUP-*` | 제품별 고유 |
| `id` | RHSA-xxx 등 | - | - |
| `vendor` | Red Hat / Oracle / Ubuntu | Windows Server / SQL Server | 제품명 |
| `component` | 패키지명 | cumulative-update / SQL Server | 제품 컴포넌트 |
| `os_version` | RHEL8/9/10, OL8/9/10, Ubuntu XX.XX | Windows Server 2025 등 | - |
| `issued_date` | YYYY-MM-DD | YYYY-MM-DD | - |
| `description` | 패치 설명 | 패치 설명 (최대 300자) | - |

### 7.3 로그 출력 필수 형식

```
[{LOGTAG}-PREPROCESS_DONE] count=N
```

대시보드가 이 태그를 파싱해 UI 카운트를 갱신한다.

### 7.4 제품별 전처리 특이사항

**Linux (redhat/oracle/ubuntu) — 공통 스크립트 `patch_preprocessing.py`:**
- `--vendor` 인수로 제품 구분
- 검토 기간: 180일 수집, 90~180일만 리뷰 대상 (커널 제외: 0~180일 전체)
- `os_version` 추출: Red Hat `affected_products` → `RHEL{N}`, Oracle `OL{N}`, Ubuntu `Ubuntu XX.XX`

**Windows Server — `windows_preprocessing.py`:**
- `--days 180 --days_end 90` (최근 90일 제외)
- 개별 패치 레코드 출력 (os_version 기준 정렬)
- `aiBatchSize: 15` (같은 OS 버전 패치가 한 배치에 모이도록)
- CVE `faq` 필드 반드시 제거 (프롬프트 크기 폭발 방지)

**SQL Server — `sqlserver_preprocessing.py`:**
- `--days 180 --days_end 90`
- 버전 그룹 방식: `SQLS-GROUP-{version}` ID로 여러 월별 CU를 하나의 그룹으로 묶음
- `aiVersionGrouped: true`, `aiBatchValidation: 'nonEmpty'`

---

## 8. SKILL.md 명세

각 제품의 `SKILL.md`는 AI 리뷰 가이드라인 파일이다.

### 8.1 필수 요구사항

- **최소 100줄** (OpenClaw embedded 모드 폴백 시 페이지 오프셋 오류 방지)
- `## 4.` 섹션 포함 필수 (프롬프트에서 `section 4`를 참조)

### 8.2 권장 구조

```markdown
# {제품명} Patch Evaluation Rules

## 1. Overview
## 2. Input Format
## 3. Evaluation Criteria
  ### 3.1 Include Criteria
  ### 3.2 Exclude Criteria
  ### 3.3 Review Date Window (CRITICAL)
      - 수집 범위: 최근 180일
      - 검토 범위: 90~180일 (커널 예외: 0~180일)
## 4. Output Format
  ### 4.1 JSON Schema
  ### 4.2 Field Rules
  ### 4.3 Selection Logic (Windows: per-version 선택)
  ### 4.4 Output Validation Rules
## 5. General Rules
  - Hallucination 방지 규칙
  - RAG 금지 규칙
  - Criticality 매핑 표
```

---

## 9. 파일시스템 경로 규약

| 파일 | 경로 패턴 | 예시 |
|------|----------|------|
| 원시 수집 데이터 | `{skillDir}/{dataSubDir}/{PREFIX}-*.json` | `os/linux/redhat_data/RHSA-2025:1234.json` |
| AI 리뷰용 JSON | `{skillDir}/patches_for_llm_review_{vendor}.json` | `os/linux/patches_for_llm_review_redhat.json` |
| AI 리포트 | `{skillDir}/patch_review_ai_report_{vendor}.json` | `os/linux/patch_review_ai_report_redhat.json` |
| 최종 CSV | `{skillDir}/final_approved_patches_{vendor}.csv` | `os/linux/final_approved_patches_redhat.csv` |
| Rate Limit 플래그 | `/tmp/.rate_limit_{productId}` | `/tmp/.rate_limit_redhat` |
| 분기 아카이브 | `~/.openclaw/.../quarterly-archive/{Q}-{YEAR}/` | `quarterly-archive/Q1-2026/` |

---

## 10. GitHub 저장소 관리 규칙

### 10.1 .gitignore 필수 항목

```gitignore
# 원시 수집 데이터 (대용량)
*_data/*
ubuntu-security-notices/

# AI 파이프라인 출력 파일
patch_review_ai_report*.json
dropped_patches_audit*.csv

# 아카이브 디렉토리 (스킬 내)
**/archive

# Next.js API 라우트 예외
!src/app/api/archive
!src/category/*/archive

# Python 환경
**/venv
**/__pycache__
```

### 10.2 서버 ↔ GitHub 동기화

서버의 `~/.openclaw/workspace/skills/patch-review/`와 GitHub의 `patch-review-dashboard-v2/patch-review/`는 pre-push hook + rsync로 자동 동기화된다.

```bash
# .git/hooks/pre-push
rsync -av \
  --exclude='*_data/' \
  --exclude='ubuntu-security-notices/' \
  --exclude='__pycache__/' \
  --exclude='venv/' \
  ~/.openclaw/workspace/skills/patch-review/ \
  ~/patch-review-dashboard-v2/patch-review/
```

**심볼릭 링크 사용 금지**: git은 절대경로 디렉토리 심볼릭 링크를 링크 자체로 추적하므로 GitHub에 파일이 올라가지 않는다.
