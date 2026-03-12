# 적용 기술 스택 (Technology Stack)

Patch Review Dashboard V2는 프론트엔드 UI와 무거운 백엔드 데이터 파이프라인 간의 동적 스케일링을 허용하는 최신 모던 웬/백엔드 아키텍처를 사용하여 구축되었습니다.

## 1. 프론트엔드 및 API 계층
- **프레임워크:** Next.js 15 (App Router 기반)
- **사용 언어:** TypeScript
- **스타일링:** Tailwind CSS (`postcss` 연동) 및 일관된 컴포넌트 디자인을 제공하는 Shadcn/UI (`components.json` 설정).
- **상태 관리 및 데이터 페칭:** React Hooks, 그리고 장시간 동작하는 파이프라인의 실시간 로그 스트리밍을 지원하기 위한 Server-Sent Events (SSE) 기술 접목.
- **패키지 매니저:** `pnpm` (`pnpm-lock.yaml`을 통한 호환성 관리).

## 2. 백엔드 및 데이터베이스
- **데이터베이스:** SQLite (`prisma/patch-review.db`)
- **ORM (데이터 맵핑):** Prisma (`schema.prisma`)를 통한 타입 안정성(Type-safe) 쿼리 보장.
- **API 런타임 환경:** Node.js (v22.22.0)
- **작업 오케스트레이션(Job Orchestration):** Next.js API Routes 내부에서 트리거되는 비동기 `child_process.spawn()`. 자체적인 상태 Lock 핑퐁(`pipeline_status.json`) 시스템을 결합하여 동시성 레이스 조건 장애(Race condition)를 차단.

## 3. 데이터 통합 파이프라인 및 수집기
- **스크립트 구동 환경:** Node.js, Python 3, Bash 스크립트
- **Python 라이브러리 (전처리):** `json`, `sqlite3`, `uuid`, 파서 라이브러리(`argparse`) 내장 사용.
- **데이터 구조화:** 수집된 원시 데이터들(Raw outputs)은 벤더별 제각기 다른 JSON 형식에서 Red Hat, Oracle, Ubuntu, Ceph, MariaDB을 모두 관통하는 표준화된 `PreprocessedPatch` 객체 형태로 정규화.

## 4. 인공지능 (AI) 및 RAG 기술
- **핵심 에이전트 도구:** `openclaw` (내부망 연동 AI 오케스트레이션 CLI 툴)
- **기반 모델:** Google Gemini 
- **RAG (검색 증강 생성):** Prisma 데이터베이스 내부의 `UserFeedback` 제외 이력을 휴리스틱 컨텍스트 매칭으로 검색해 가져오는 Python 기반 구현체(`query_rag.py`).
- **구조 검증(Validation):** `zod` 스키마 툴을 통해 AI의 아웃풋 포맷 형식을 `patch_review_ai_report.json` 포맷의 `ReviewSchema` 구조와 반드시 일치하도록 통제.
