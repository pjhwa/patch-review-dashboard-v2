# 패치 리뷰 대시보드 V2 아키텍처

본 문서는 패치 리뷰 대시보드(Patch Review Dashboard) V2의 기본 아키텍처를 설명하며, 주요 구성요소, 데이터 저장소 및 백엔드 파이프라인의 핵심 구조를 다룹니다. **이 문서의 모든 정보는 추정이나 mock-up 데이터 없이 현재 운영 서버에서 실제로 구동 중인 코드를 기반으로 작성되었습니다.**

---

## 1. 하이레벨 아키텍처 개요

시스템은 크게 세 가지 기본 계층으로 분리되어 있습니다:

1. **프론트엔드 프레젠테이션 계층** (Next.js App Router)
2. **백엔드 API & 오케스트레이션 계층** (Next.js APIs + Local Shell 실행 로직)
3. **데이터 수집 및 AI 처리 파이프라인** (Node.js, Bash, Python, openclaw 연동)

이러한 모듈식 접근 방식을 통해 무거운 데이터 파싱, RAG 필터링 및 AI 평가 과정이 Web UI를 차단하지 않도록 보장합니다. 대시보드는 단순히 Server-Sent Events(SSE)나 폴링을 통해 백그라운드 OS 파이프라인을 트리거하고 진행률을 모니터링합니다.

```mermaid
graph TD
    UI["Web Dashboard (Client)"] -- "파이프라인 실행 및 SSE 스트리밍" --> API["Next.js Backend API"]
    
    API -- "데이터 읽기 / 쓰기" --> DB[("SQLite DB (Prisma)")]
    API -- "독립된 자식 프로세스 스폰" --> PL["파이프라인 실행 엔진"]
    
    subgraph 파이프라인 프로세스 (Pipeline Execution)
        PL --> C1["데이터 수집기 (Bash/Node)"]
        C1 --> C2["전처리 및 정제 (Python)"]
        C2 -- "DB와 대조하여 중복 제거" --> DB
        C2 --> C3["RAG 배제 사유 검색 (query_rag.py)"]
        C3 --> AI["AI 에이전트 (openclaw:main)"]
        AI -- "Zod 스키마 검증 및 자가 치유" --> AI
    end
    
    AI -- "100% 검증된 JSON 산출" --> JSON["patch_review_ai_report.json"]
    JSON -- "사용자 최종 승인 (Finalize)" --> API
```

---

## 2. 상세 구성요소

### 2.1 웹 대시보드 (Next.js)
- **역할:** 사용자가 확인하는 메인 인터페이스.
- **기능:** 
  - OS(Linux) 및 애플리케이션(MariaDB, Ceph 등) 제품 매트릭스 화면 제공.
  - `/api/pipeline/execute` 엔드포인트를 통한 파이프라인 수동 트리거.
  - 백그라운드 작업 상태를 시각화하기 위한 `/api/pipeline/status` 관리.
  - AI 출력을 SQLite 데이터베이스(`ReviewedPatch`)로 반영하기 위한 API 제공.

### 2.2 관계형 데이터베이스 (Prisma + SQLite)
이 시스템은 Prisma ORM을 사용하여 SQLite(`prisma/patch-review.db`)를 관리하며 총 5개의 핵심 테이블 모델로 작동합니다:

- `PipelineRun`: 현재 실행 중인 파이프라인 작업 메타데이터 추적.
- `RawPatch`: 벤더사 서버에서 수집된 그대로의 원시 JSON 응답 캐싱.
- `PreprocessedPatch`: `patch_preprocessing.py`에 의해 정규화되어 AI가 즉시 읽고 분석할 수 있는 중간 데이터.
- `ReviewedPatch`: AI 검토 프로세스나 관리자에 의해 최종 승인된 패치 데이터 및 한글/영문 권고문.
- `UserFeedback`: 향후 AI의 RAG 분석 기준치를 학습시키기 위해 저장된 관리자의 과거 배제(Exclusion) 피드백 내역.

### 2.3 실행 파이프라인 (`patch-review` Skill)
모든 무거운 파이프라인 작업은 `~/.openclaw/workspace/skills/patch-review` 환경 내부에 위임되어 있습니다.
`/api/pipeline/execute` 호출 시 다음과 같이 진행됩니다:
1. 백그라운드의 Node 하위 프로세스(Child Process) 생성을 통해 `os/linux-v2` 환경 실행.
2. 벤더사의 데이터 수집 스크립트 실행 (예: `rhsa_collector.js`, `oracle_collector.sh`).
3. `patch_preprocessing.py`를 활용하여 모든 벤더사의 데이터를 통일된 포맷으로 병합.
4. `query_rag.py`를 호출하여 과거 동일/유사한 패치에 대해 관리자가 남긴 `UserFeedback` 배제 사유를 가져옵니다. (불필요한 반복 검토 방지)
5. `SKILL.md` 명령어에 따라 `openclaw agent:main`을 호출하여 RAG 데이터와 전처리 데이터를 토대로 LLM 영향도 분석 평가 진행.
6. AI의 결과물을 Zod 스키마(`ReviewSchema`)로 엄격하게 검증합니다. 스키마를 위반한 경우, 핑퐁(Ping-pong) 로직을 통해 에러 메시지와 함께 최대 2회의 자가 치유(Self-healing) 재시도를 자동 수행합니다.

---

## 3. 자동화 및 트리거 로직

- **대시보드 UI:** 수동 실행 및 재시도.
- **REST APIs:** 내부의 `trigger.sh` 스크립트를 통한 `http://localhost:3001/api/pipeline/execute` 직접 호출.
- **CRON 스케줄:** 사용자 개입 없는 완전 무인 운영을 위해 시스템 CRON(`run_collectors_cron.sh`)이 **매년 3, 6, 9, 12월의 세번째 일요일 오전 6시**(`0 6 15-21 3,6,9,12 * test $(date +\%w) -eq 0`)에 자율 실행되도록 구성되어 있습니다.

---

## 4. 파일 입출력 로직
AI 엔진이 데이터베이스와 직접 결합되어 DB 손상을 일으키는 것을 막기 위해 철저히 "파일 입출력(File Output)" 기반으로 설계되었습니다. 파이프라인의 최종 출력물은 단 하나의 파일: `patch_review_ai_report.json`으로 떨어집니다. 이 파일이 완벽한 JSON 배열 구조를 갖추었을 때만 대시보드의 `/api/pipeline/finalize`를 통해 비로소 트랜잭션 DB 반영이 이루어집니다.
