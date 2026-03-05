# 🏗️ Patch Review Dashboard Architecture

본 문서는 **Patch Review Dashboard v2**의 전체 아키텍처와 통합 시스템 구조를 설명합니다. 시스템은 크게 **데이터 수집 파이프라인(Data Pipeline)**과 **웹 대시보드(Web Dashboard)**의 두 축으로 구성되며, 이를 통해 전 세계 주요 OS 벤더의 패치 정보를 실시간으로 수집, 필터링, AI 분석, 그리고 관리자 검증까지 원스톱으로 처리합니다.

---

## 🧭 System Overview (시스템 총괄도)

전체 시스템은 다음과 같은 주요 라이프사이클을 갖습니다.

```mermaid
graph TD
    %% 외부 데이터 소스
    subgraph External Sources
        RH[Red Hat CSAF API]
        UB[Ubuntu Web/OVAL]
        OR[Oracle Mailing List]
    end

    %% 데이터 수집 및 전처리 (Pipeline Scripts)
    subgraph Data Pipeline
        Collector[Data Collector\nNode.js/Playwright]
        Preprocessor[Data Preprocessor\nPython]
        AI[AI Reviewer\nLLM Prompting]
    end

    %% 백엔드 및 DB (Next.js + Prisma)
    subgraph Backend Services
        API[Next.js API Routes]
        Prisma[Prisma ORM]
        DB[(SQL Database)]
    end

    %% 프론트엔드 (Next.js App Router)
    subgraph Frontend Dashboard
        UI[Next.js React UI]
        Dash(Dashboard Client View)
    end

    %% Flow 연결
    RH -.-\>|JSON/Scraping| Collector
    UB -.-\>|Scraping| Collector
    OR -.-\>|Scraping| Collector

    Collector --\>|Raw JSON Data| Preprocessor
    Preprocessor --\>|Filtered Data| AI
    AI --\>|AI Assessment Result| API

    API --\>|CRUD Operations| Prisma
    Prisma \<--\> DB

    UI \<--\>|REST API / Server Actions| API
    UI --\> Dash

    %% 스타일링
    classDef source fill:#f9f2f4,stroke:#d1a3a4,stroke-width:2px;
    classDef pipe fill:#eef2fa,stroke:#a3b8d1,stroke-width:2px;
    classDef back fill:#f2faee,stroke:#b1d1a3,stroke-width:2px;
    classDef front fill:#faf8ee,stroke:#d1c8a3,stroke-width:2px;

    class RH,UB,OR source;
    class Collector,Preprocessor,AI pipe;
    class API,Prisma,DB back;
    class UI,Dash front;
```

---

## 🧱 Component Breakdown (주요 구성 요소)

### 1. Data Pipeline (`pipeline_scripts/`)
파이프라인은 주로 스크립트 형태로 주기적(또는 수동 트리거)으로 동작하며 가장 무겁고 복잡한 데이터를 처리합니다.

- **Collector (`batch_collector.js`)**:
  - `Playwright` 기반의 브라우저 자동화 및 `https` 모듈을 통한 REST/CSAF API 호출
  - Red Hat, Ubuntu, Oracle 데이터 병렬 수집 및 로컬 파일(`batch_data/`) 형태(또는 DB)로 원시 데이터 확보
  - **Error Handling**: 비정상 종료를 방지하기 위한 Anti-Hang, Retry Queue, 재시도 모드 내장

- **Preprocessor (`patch_preprocessing.py`)**:
  - 수집된 거대한 원시 데이터를 정제합니다. 
  - 정규표현식을 활용한 OS 버전/소프트웨어 컴포넌트 정보 추출
  - **Pruning Rules**: 시스템 핵심 컴포넌트(System Core Components - Kernel, Bootloader 등) 화이트리스트 필터링 및 EOL(수명 종료) 버전 제외 로직 적용
  - 최종적으로 AI에게 질의할 알짜배기 JSON(`patches_for_llm_review.json`) 생성

- **AI Reviewer**:
  - (추후 확장) 로컬 스크립트 또는 Next.js API 단에서 LLM과 통신하여 CESA/DSA/RHSA 정보 및 변경된 `diff` 텍스트를 분석해 심각도 및 영향도를 결정

### 2. Database \u0026 ORM (`prisma/`)
Prisma 스키마를 통해 데이터의 정확성과 일관성을 체계적으로 관리합니다.

- **`RawPatch`**: 수집된 JSON 원본 데이터 보관 (이력 추적 목적)
- **`PreprocessedPatch`**: 전처리를 거쳐 정제된 패치 항목들 (AI Review 대상)
- **`ReviewedPatch`**: AI 및 관리자(Manager) 검증을 마친 최종 패치 상세 데이터 (국문 번역 결과, 결정 상태 포함)
- **`PipelineRun`**: 각 배치 파이프라인의 실행 상태(Started, Completed, Error)와 로그 추적 테이블

### 3. Web Dashboard (`src/app/`, `src/components/`)
사용자 및 릴리즈 매니저가 결과를 확인, 승인하거나 파이프라인 진행 상태를 관제하는 곳입니다.

- **Framework**: `Next.js 15+`의 최신 App Router 설계
- **Styling UI**: `Tailwind CSS v4` 적용 및 `shadcn/ui` 기반 하이퀄리티 컴포넌트 파편화 (Framer Motion 다이내믹 애니메이션)
- **Features**:
  - **분석 대시보드**: 제조사별, 인프라 플랫폼별 취약점/업데이트 패치 현황 (ProductGrid 등)
  - **파이프라인 관제**: 수집 -> 전처리 -> AI 분석 단계를 실시간 스트리밍 모니터링 (`StageJSONViewer`, `/api/pipeline/...`)
  - **관리자 검증(Manager Review)**: AI가 도출한 최종 결과를 검증하고 결재(Approve/Exclude)하여 운영 반영 여부 결정

---

## 🛠️ Infrastructure \u0026 Network
이 시스템은 단순한 웹 어플리케이션이 아닌 **서버 인프라 파이프라인**을 내장한 형태입니다.

1. **Host Server (`tom26` / `172.16.10.237`)**:
  - 백그라운드 스케줄러(cron 등)를 통한 `batch_collector`, `patch_preprocessing` 실행
  - 로컬 AI 모델 API (`OpenClaw` 등) 연동
2. **Web Server**:
  - 터보팩(Turbopack)을 통한 로컬 Next.js 서버 구동 (포트 3001 기본 타게팅)
  - Prisma 기반 백엔드 API 서비스

> [!TIP]
> **모던 아키텍처 권장 사항**:
> 향후 파이프라인 확장을 고려하여 Data Pipeline 부분을 Event-Driven 아키텍처 형태(RabbitMQ 또는 AWS SQS 등)로 마이크로서비스화 하면 서버리스 환경에서도 무한한 확장이 가능합니다.
