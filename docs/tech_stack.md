# 🚀 Technology Stack

> **Last Updated**: 2026-03-11 | **Version**: v2

---

## 💻 Frontend Dashboard

| 기술 | 버전 | 용도 |
|---|---|---|
| **Next.js** | 16.1.6 | App Router, RSC, API Routes |
| **React** | 19.x | UI 컴포넌트 |
| **TypeScript** | strict mode | 전체 코드베이스 |
| **Tailwind CSS** | v4 | 유틸리티 CSS |
| **shadcn/ui** | (Radix UI 기반) | 헤드리스 UI 컴포넌트 |
| **Lucide React** | latest | 아이콘 |
| **Turbopack** | Next.js 16 내장 | 프로덕션 빌드 (`npm run build`) |

### 주요 컴포넌트
- **`ProductGrid.tsx`**: 대시보드 메인 — 파이프라인 실행, SSE 수신, 상태 표시
- **`PremiumCard.tsx`**: 벤더별 통계 카드 (수집/전처리/AI리뷰/승인 카운트)
- **`ClientPage.tsx`**: 제품 상세 페이지 — 전처리 데이터 탭 + AI 리뷰 결과 탭

---

## ⚙️ Backend Services

| 기술 | 버전 | 용도 |
|---|---|---|
| **Prisma ORM** | latest | SQLite 타입세이프 쿼리 |
| **SQLite** | — | 운영 DB (`prisma/patch-review.db`) |
| **BullMQ** | latest | 비동기 파이프라인 작업 큐 |
| **Redis** | — | BullMQ 브로커 |
| **Server-Sent Events** | Next.js 내장 | 실시간 파이프라인 로그 스트리밍 |

### 주요 API 엔드포인트

| 경로 | 기능 |
|---|---|
| `POST /api/pipeline/run` | 파이프라인 실행 — DB 초기화 후 BullMQ Job 등록 |
| `GET /api/pipeline/stream` | SSE — Job 진행 상태 및 로그 실시간 Push |
| `GET /api/pipeline/stage/preprocessed?product=X` | 전처리 패치 목록 조회 |
| `GET /api/pipeline/stage/reviewed?product=X` | AI 리뷰 패치 목록 조회 (PreprocessedPatch join) |
| `GET /api/products?category=os` | 벤더별 수집/전처리/AI리뷰/승인 카운트 |
| `POST /api/pipeline/feedback` | 관리자 Exclude 피드백 저장 |

---

## 🐍 Data Pipeline Scripts

### 데이터 수집 (CRON — 분기별)

| 스크립트 | 언어 | 대상 |
|---|---|---|
| `redhat/rhsa_collector.js` | Node.js | Red Hat CSAF API — RHSA |
| `redhat/rhba_collector.js` | Node.js | Red Hat CSAF API — RHBA |
| `oracle/oracle_collector.sh` | Bash | Oracle Linux Errata 웹 스크래핑 |
| `oracle/oracle_parser.py` | Python 3 | Oracle HTML 파싱 → JSON |
| `ubuntu/ubuntu_collector.sh` | Bash | Ubuntu Security Notices git 동기화 |
| `run_collectors_cron.sh` | Bash | 전체 수집기 순차 실행 CRON 래퍼 |

### 전처리 & 필터링 (Dashboard 트리거)

- **`patch_preprocessing.py`** (Python 3): 날짜 필터링, Core Component 화이트리스트, CVE 중복 제거, PreprocessedPatch DB 저장
- **`query_rag.py`** (Python 3): 사용자 피드백 유사도 검색 후 AI 프롬프트 주입
- **`sync_rag.py`** (Python 3): RAG 벡터 인덱스 동기화

### AI 리뷰 (Dashboard 트리거)

- **OpenClaw** (`openclaw agent --agent main`): SKILL.md 기반 Impact Analysis → JSON 리포트 생성
- **작업 큐**: BullMQ + Redis로 Job 상태 관리 (`src/lib/queue.ts`)

---

## 🖥️ Infrastructure

| 항목 | 상세 |
|---|---|
| **서버** | `tom26` / `172.16.10.237` |
| **Node.js** | v22.22.0 (nvm) |
| **Process Manager** | PM2 (`npx pm2 start`) |
| **AI Agent** | OpenClaw 2026.3.x |
| **DB** | SQLite (`prisma/patch-review.db`) |
| **Queue** | BullMQ + Redis |

---

> [!NOTE]
> **개발 표준**: TypeScript strict mode 적용. 모든 함수에 JSDoc + 타입 명시.
> API 키 등 민감 정보는 `.env` 파일로 관리 (하드코딩 금지).
