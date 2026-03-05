# 🌊 Data Pipeline Flow

본 문서는 전 세계 주요 벤더의 보안 업데이트를 수집하고, 분석하여 담당자가 리뷰할 수 있게 해주는 **Patch Review Data Pipeline**의 처리 흐름을 상세히 다룹니다.

## 🔄 End-to-End Workflow

전체 워크플로우는 자동화된 "수집(Collection)"부터 인간의 최종 "승인(Verification)"까지 이어지는 4단계 구조입니다.

```mermaid
sequenceDiagram
    participant Web as OVAL/CSAF/Mailing List
    participant Collector as Batch Collector (Node.js)
    participant Pre as Preprocessor (Python)
    participant AI as AI Engine (LLM)
    participant DB as Database (Prisma)
    participant Manager as Release Manager (UI)

    %% 1. 파이프라인 수집 시작
    Note over Web, Collector: Stage 1. Data Collection
    Collector-\>\>Web: Request Security Advisories
    Web--\>\>Collector: Responses (JSON/HTML/Emails)
    Collector-\>\>DB: Save to `RawPatch` table (또는 로컬 batch_data/)
    
    %% 2. 전처리 작동
    Note over Collector, Pre: Stage 2. Data Preprocessing
    Pre-\>\>DB: Load Raw Data
    Pre-\>\>Pre: Regex Extraction (Versions, DB)
    Pre-\>\>Pre: Apply Pruning Rules (EOL, Core System Only)
    Pre-\>\>DB: Save to `PreprocessedPatch` table
    
    %% 3. AI 분석
    Note over Pre, AI: Stage 3. AI Review \u0026 Translation
    AI-\>\>DB: Polling / Trigger for `PreprocessedPatch`
    AI-\>\>AI: Analyze Impact \u0026 Extract "diff" specifics
    AI-\>\>AI: Translate Summary to Korean
    AI-\>\>DB: Save to `ReviewedPatch` with Proposed Decision
    
    %% 4. 매니저 리뷰
    Note over AI, Manager: Stage 4. Manager Verification
    Manager-\>\>DB: View AI `ReviewedPatch` via Dashboard
    Manager-\>\>Manager: Confirm or Overwrite Decision
    Manager--\>\>DB: Update Decision (Approve/Exclude)
```

---

## 🔍 Stage Detailed Breakdown

### Stage 1. 🌐 Data Collection (`batch_collector.js`)
주요 서버의 보안 권고(Security Advisory) 텍스트와 원시 데이터를 긁어옵니다. 다중 벤더를 동시에 처리하기 위해 Playwright 컨텍스트를 멀티플렉싱 합니다.

- **Target 1: Red Hat (CSAF API)**
  - 더 이상 브라우저 렌더링에 의존하지 않고 Red Hat의 최신 CSAF API를 사용하여 빠르고 정확하게 데이터를 Fetching 합니다.
- **Target 2: Ubuntu (Web Pagination)**
  - Ubuntu Security Notice 페이지를 `Playwright` 기반 크롤러가 순회합니다. DOM 요소를 Parsing하여 제목과 컴포넌트를 분리합니다.
- **Target 3: Oracle (Mailing List)**
  - 메일링 리스트 기반 과거 형식을 지원하기 위해 메일 텍스트를 스크래핑하고 정규화합니다.
- *생성물*: `batch_data/` 내부의 벤더별 가공 전 JSON 덤프.

### Stage 2. 🧹 Preprocessing \u0026 Filtering (`patch_preprocessing.py`)
수집한 데이터의 노이즈를 제거하여, LLM 요금 소모를 줄이고 처리 속도를 극대화하는 가장 중요한 단계입니다.

- **버전 정규화**:
  - `1.1.2-3.ubuntu0.2` 와 같은 복잡한 패키지 스트링에서 운영체제 버전 추출 (예: 22.04 LTS).
- **Core Component 필터링**:
  - `firefox`, `libreoffice`, `gimp` 같은 데스크톱 응용 소프트웨어 제외
  - `kernel`, `grub`, `shim`, `ssh`, `openssl`, `glibc` 등 "System Critical" 요소만 남김 (Whitelist 방식)
- **EOL(End of Life) 스킵**:
  - Ubuntu 14.04, 16.04 등 지원이 종료된 시스템 버전의 패치는 자동 Drop 처리
- *생성물*: 최종 AI 분석용 큐인 `patches_for_llm_review.json` 적재.

### Stage 3. 🤖 AI Review \u0026 Translation
LLM(OpenClaw 플랫폼 등) 프롬프트 엔지니어링을 이용해 정형화된 리뷰 데이터를 도출합니다.

- 취약성의 본질(Root Cause) 요약
- 코드/설정 변경점(diff) 분석
- 인프라 영향도 판별 기반의 **Action 제안 (Approve, Skip)**
- 한글 요약본 생성을 통한 관리자 가독성 제공

### Stage 4. 👩‍💻 Manager Verification
대시보드 UI를 통한 최종 리뷰입니다. 프리미엄 카드 UI (`PremiumCard.tsx`)와 리스트 뷰를 통해 담당자가 AI의 판정을 시각적으로 비교하고 버튼을 눌러 승인(Approve)을 완료합니다.

> [!IMPORTANT]  
> 비동기 처리에서 발생 가능성이 높은 Hang(응답 없음) 이슈를 방지하기 위해 `batch_collector.js` 내부에는 **Global Retry** 메커니즘과 **uncaughtException** 로깅이 엄격하게 탑재되어 있습니다. 에러 발생 시 시스템이 즉시 종료되지 않고 Failed List를 남기고 다음 사이클로 넘어갑니다.
