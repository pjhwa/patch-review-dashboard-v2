# 기술 스택

Patch Review Dashboard V2는 현대적이고 분리된 아키텍처를 기반으로 합니다. 이 문서는 각 기술 선택과 시스템에서의 역할을 설명합니다.

---

## 1. 프론트엔드 & API 계층

### 프레임워크: Next.js 16 (App Router)
- **선택 이유**: React UI와 API 라우트를 단일 배포로 제공. App Router가 데이터 페칭을 위한 서버 컴포넌트와 인터랙티브 파이프라인 제어를 위한 클라이언트 컴포넌트를 지원.
- **주요 사용처**: `app/category/[categoryId]/[productId]/ClientPage.tsx` (클라이언트 컴포넌트, 패치 리뷰 상태 관리), `app/api/pipeline/*/route.ts` (API 핸들러)
- **개발 서버**: Turbopack 사용 (`next dev --turbo`) — 초고속 핫 리로드
- **포트**: 3001 (`package.json` 설정)

### 언어: TypeScript 5
- 모든 API 라우트, 큐 워커, 레지스트리 정의에 걸친 엄격한 타입 안전성
- `products-registry.ts`의 `ProductConfig` 인터페이스가 핵심 타입 계약

### 스타일링: Tailwind CSS v4 + shadcn/ui
- CSS 네이티브 설정을 사용하는 새 v4 유틸리티 퍼스트 CSS (`tailwind.config.js` 불필요)
- shadcn/ui 컴포넌트: `Table`, `Badge`, `Button`, `Dialog`, `Accordion`, `Sheet`, `ScrollArea`

### 실시간 스트리밍: Server-Sent Events (SSE)
- `GET /api/pipeline/stream?jobId=X`가 지속적인 SSE 연결 유지
- BullMQ 워커의 `job.log(message)` 호출이 연결된 SSE 클라이언트로 전달
- `ProductGrid.tsx`가 `[REDHAT-PREPROCESS_DONE]`, `[MARIADB-PIPELINE]` 등의 로그 태그를 제네릭 정규식으로 파싱 — 새 제품 추가 시 코드 변경 불필요

### 패키지 매니저: pnpm

---

## 2. 작업 큐: BullMQ + Redis

### BullMQ v5
- **선택 이유**: v1의 `child_process.spawn()` + `pipeline_status.json` 파일 잠금 방식을 대체. 신뢰성 있는 작업 큐잉, 동시성 제어, 재시작 후 작업 유지, 로그 스트리밍 제공.
- **큐 이름**: `patch-pipeline`
- **작업 이름**: 제품당 1개 — `run-redhat-pipeline`, `run-oracle-pipeline`, `run-ubuntu-pipeline`, `run-windows-pipeline`, `run-ceph-pipeline`, `run-mariadb-pipeline`, `run-sqlserver-pipeline`, `run-pgsql-pipeline`, `run-vsphere-pipeline`
- **워커**: `src/lib/queue.ts`의 단일 워커가 `PRODUCT_MAP` 조회를 통해 모든 작업 처리

### ioredis v5
- BullMQ가 작업 지속성을 위해 사용하는 Redis 클라이언트
- `REDIS_URL` 환경 변수로 연결 설정

### Redis 6+
- Next.js 애플리케이션 시작 전에 반드시 실행 중이어야 함
- 기본값: `redis://127.0.0.1:6379`

---

## 3. 데이터베이스 계층

### SQLite (Prisma ORM)
- **DB 파일**: `prisma/patch-review.db`
- **선택 이유**: 단일 파일 DB로 외부 시스템과의 동시 쓰기 경합이 없는 전용 컴플라이언스 운영 서버에 적합
- **ORM**: Prisma 5 — 타입 안전 쿼리, 스키마 마이그레이션 (`prisma db push`), 스키마 인트로스펙션

### 스키마 모델

| 모델 | 용도 |
|------|------|
| `RawPatch` | 벤더 API 원시 JSON (캐싱 레이어, `vendor + originalId` 인덱스) |
| `PreprocessedPatch` | AI 리뷰 준비 완료된 정규화 패치, `vendor + issueId` 인덱스 |
| `ReviewedPatch` | 최종 AI/관리자 승인 패치 (`issueId` `@unique` — 중복 없음) |
| `UserFeedback` | RAG 컨텍스트용 관리자 배제 이력 |
| `PipelineRun` | 실행 메타데이터 (상태, 타임스탬프, 로그) |

---

## 4. 파이프라인 실행

### Python 3 (전처리)
- 벤더별 스크립트: `patch_preprocessing.py`, `windows_preprocessing.py`, `mariadb_preprocessing.py` 등
- 모든 스크립트가 개별 제품 처리를 위한 `--vendor` 또는 동등한 플래그 지원
- 표준 라이브러리만 사용: `json`, `sqlite3`, `argparse`, `datetime`, `uuid`
- 출력: `patches_for_llm_review_<vendor>.json`

### Node.js (수집기)
- `rhsa_collector.js`, `rhba_collector.js` — Red Hat Errata API
- `oracle_collector.sh` + `oracle_parser.py` — Oracle Linux 권고문
- `ubuntu_collector.sh` — Ubuntu Security Notices
- 각 제품 스킬 디렉터리의 벤더별 수집 스크립트

### OpenClaw CLI (AI 에이전트)
- Google Gemini를 래핑한 내부 AI 오케스트레이션 도구
- 실행 방법: `openclaw agent:main --json-mode --message "<prompt>"`
- `--json-mode`: 구조화된 JSON 출력 강제
- 컨텍스트 지침: 스킬 디렉터리의 `SKILL.md`에서 읽음
- 배치 간 컨텍스트 오염 방지: 각 호출 전 `~/.openclaw/agents/main/sessions/sessions.json` 삭제

---

## 5. AI & 검증 계층

### Google Gemini (openclaw를 통해)
- 내부 openclaw 라우터 네트워크를 통해 접근
- `ProductConfig.buildPrompt()`로 제품별 구성 — 각 제품이 고유한 프롬프트 템플릿 보유

### Zod v3 (스키마 검증)
- `ReviewSchema`가 AI 출력 JSON 배열 검증
- 필수 필드: `IssueID`, `Component`, `Version`, `Vendor`, `Date`, `Criticality`, `Description`, `KoreanDescription`
- 선택 필드: `Decision`, `Reason`, `OsVersion`
- 검증 실패 시 자가 치유 재시도 (배치당 최대 2회)

### RAG (검색 증강 생성)
두 가지 전략:
- **프롬프트 주입** (Linux 제품): `query_rag.py`가 `UserFeedback`을 조회하여 배제 컨텍스트를 AI 프롬프트에 주입
- **파일 숨김** (Windows, Ceph, 데이터베이스): AI 실행 전 정규화 데이터 디렉터리를 임시로 이름 변경

---

## 6. 인프라

### 프로세스 매니저: pm2
- 프로덕션 프로세스: `pm2 start "pnpm start" --name patch-dashboard`
- 부팅 시 자동 시작: `pm2-citec.service` systemd 유닛

### CRON
- `update_cron.sh`가 분기별 수집 일정 설치
- 매년 3, 6, 9, 12월의 세 번째 일요일 06:00 실행
- 벤더별 데이터 수집기 트리거 (Next.js 애플리케이션과 독립적)

---

## 버전 요약

| 패키지 | 버전 |
|--------|------|
| next | 16.1.6 |
| react | 19.2.3 |
| typescript | ^5 |
| tailwindcss | ^4 |
| @prisma/client | ^5.22.0 |
| bullmq | ^5.70.4 |
| ioredis | ^5.10.0 |
| zod | ^3.25.76 |
| framer-motion | ^12.34.3 |
| radix-ui | ^1.4.3 |
| lucide-react | ^0.575.0 |
| papaparse | ^5.5.3 |
