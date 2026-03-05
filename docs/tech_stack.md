# 🚀 Technology Stack

**Patch Review Dashboard v2** 프로젝트는 대규모 데이터를 빠르고 견고하게 처리하는 Data Pipeline 기술과, 미려한 인터페이스를 자랑하는 Modern Frontend 기술의 절묘한 결합으로 이루어져 있습니다.

---

## 💻 Frontend Dashboard (V2)

사용자 대상을 위한 시각적 요소와 API 상호작용은 프런트엔드 애플리케이션에서 담당합니다.

### 1. Framework: **Next.js 15.x / React 19** 
- **App Router**: 디렉터리 기반 라우팅을 이용한 직관적인 모듈 구조 (`app/api`, `app/category`)
- **React Server Components (RSC)**: 서버에서 Prisma ORM을 통해 데이터를 직사입하여 페이지 로드 퍼포먼스를 극대화
- **Turbopack (`--turbo`)**: 로컬 개발 시 압도적인 번들링 속도 지원

### 2. Styling \u0026 UI Aesthetics: **Tailwind CSS v4 + Framer Motion**
- **Tailwind v4**: 최신 유틸리티 CSS를 활용하여 마진, 패딩, Color Token들을 모듈화
- **shadcn/ui (Radix UI)**: Headless 컴포넌트를 이용해 완벽한 웹 접근성(A11y) 확보 및 프리미엄 퀄리티 달성
- **Lucide Icons**: 일관되고 미려한 벡터 아이콘 사용
- **Dynamic Animations**: `framer-motion`과 `tw-animate-css`를 결합하여 호버(hover), 페이지 트랜지션, 마이크로 인터랙션 구현

---

## ⚙️ Backend Services \u0026 Database

### 1. ORM \u0026 Database: **Prisma + SQLite/PostgreSQL**
- **Prisma Client**: 타입 세이프(Type-Safe) 방식의 DB 쿼리를 지원하여 런타임 에러 방지. `schema.prisma` 한 곳에서 데이터베이스 진실의 구조(Single Source of Truth) 관리
- 개발 시에는 관리가 쉬운 `SQLite`를, 운영(Production) 환경에서는 확장이 용이한 `PostgreSQL`로 스왑 가능

### 2. API \u0026 실시간 통신 (Next.js Route Handlers)
- RESTful 철학을 따르는 API 엔드포인트 구성 (`app/api/pipeline/route.ts` 등)
- **SSE (Server-Sent Events)**: `/api/pipeline/stream` 엔드포인트를 통해 클라이언트와 지속적인 연결(Keep-Alive)을 맺고 실시간 파이프라인 로그를 푸시합니다.
- **BullMQ**: 내부 작업 큐 매니저로, 비동기 파이프라인 테스크의 상태와 진행률(Progress)을 안전하게 관리합니다.

---

## 🐍 Data Pipeline Scripts

백그라운드로 실행되는 크롤링 및 데이터 전처리 스크립트 영역입니다.

### 1. Automation \u0026 Scraping: **Node.js + Playwright**
- 동적인 DOM 환경(Pagination, Anti-Bot)을 렌더링하기 위한 `Playwright` 브라우저 자동화
- `https` 내장 모듈을 통해 API (Red Hat CSAF) 고속 Fetching
- Concurrency 설정을 통해 다중 CPU 코어로 스크래핑 분산 처리

### 2. Processing \u0026 Filtering: **Python 3**
- 텍스트 정규화, 정규표현식 매칭, 데이터 Pruning에 압도적으로 강력한 파이썬 사용
- `test_db.py`, `debug_logic.py` 형태의 수많은 Mock 테스트 스크립트 작성으로 높은 신뢰성 구축

### 3. AI Interruption \u0026 RAG (Local LLM)
- `OpenClaw`와 같은 로컬 기반 언어 모델 API 호출 구조 채택 (`openclaw_scripts` 내장)
- **RAG (Retrieval-Augmented Generation)**: 사용자 피드백(`user_exclusion_feedback.json`)을 컨텍스트로 주입받아, 과거 관리자가 제외(Exclude) 시킨 유사 패키지의 사유를 학습하고 동일한 실수를 방지하는 지능형 피드백 루프를 갖추고 있습니다. JSON의 Context를 주입받아 Markdown/Korean 형태로 렌더링 된 최종 Result 반환.

---

> [!NOTE]  
> **개발 표준 (GEMINI.md Guidelines)**  
> 1. 모든 코드는 `TypeScript strict mode`로 동작해야 합니다.  
> 2. `console.log` 및 에러 핸들링을 명확히 하고, 장애 발생 시 원인을 `LEARNED.md`에 단일 진실로 기록하여 미래 트러블슈팅을 최적화하고 있습니다.
