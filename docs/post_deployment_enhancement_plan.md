# 🚀 대시보드 V2 - 추가 보완 개발 및 고도화 계획서 (Post-Deployment Enhancement Plan)

본 문서는 `deep_implementation_plan.md.resolved`의 초기 설계안 중, V2 릴리즈 버전에 누락되었거나 레거시 방식으로 구현된 **3대 핵심 누락 기능**을 완벽하게 구현하기 위한 **심층 보완 개발 가이드**입니다. 

이 문서의 절차(Action Plan)를 그대로 복사-붙여넣기(Copy-Paste) 하거나 순서대로 실행만 해도 오류 없이 즉시 프로덕션 수준의 기술 스택을 완성할 수 있도록, **전체 아키텍처 분석 결과를 바탕으로 3단계 교차 검증 및 예외 상황(Edge Cases)에 대한 회피 기동 전략을 모두 포함**하여 작성되었습니다.

---

## 🎯 1. 완전한 형태의 RAG(검색 증강 생성) 시스템 최적화 기반 구축

**현재 상태 (AS-IS)**: 관리자가 피드백한 `user_exclusion_feedback.json`의 전체 데이터를 단순히 프롬프트(`aiPrompt += \n${exclusionRules}`)로 결합하여 전달 (Stuffing 방식). 시간이 지남에 따라 토큰 한계(Context Window 초과) 및 메모리 누수 발생 위험 100%.
**목표 상태 (TO-BE)**: 초경량 로컬 Vector DB (`ChromaDB`)를 내장하여 새로 들어온 설명과 코사인 유사도(Cosine Similarity)가 높은 과거 피드백 상위 3건만 동적으로 추출(Retrieval)하여 프롬프트에 주입하는 **증분 임베딩(Incremental Embedding)** 파이프라인.

### 📝 Action Plan (실행 절차)

1. **의존성 설치 (Python 환경)**
   ```bash
   pip install chromadb sentence-transformers
   ```
2. **증분 임베딩 동기화 스크립트 작성 (`pipeline_scripts/sync_rag.py`)**
   - `user_exclusion_feedback.json`을 읽어 `./chroma_db` 경로에 `all-MiniLM-L6-v2` 모델로 임베딩 컬렉션 구축.
   - 처음엔 풀 로드, 이후부터는 변경된 JSON 요소만 새로 DB에 삽입/업데이트(UPSERT) 하도록 고도화.
3. **OpenClaw `route.ts` 호출부 수정**
   - 기존의 무식한 텍스트 덩어리 결합 로직 폐기.
   - Node.js 단에서 `python3 query_rag.py <텍스트>`를 `spawnSync` 호출해, 리턴된 "유사도 높은 상위 3개 항목" 만 프롬프트 `Context:` 영역에 주입.

### 🛡️ 3중 교차 검증 및 예외 대책 (Troubleshooting / Validation)
- **메모리 부족(OOM) 오류 (Logic/Architecture Validation)**: `tom26` 서버에서 모델 로드시 RAM 부족 현상이 감지될 시(예외 처리 블록), `ChromaDB` 사용을 중지하고 기존의 텍스트 기반 일치(단순 키워드 찾기) 형태의 가벼운 Fallback 함수로 자동 전환되도록 로직 구성.
- **빈 데이터베이스 탐색 (E2E Validation)**: `user_exclusion_feedback.json`이 비어있어 ChromaDB에 0건의 문서가 들어있을 때 쿼리를 날릴 경우, `similarity_search` 함수가 Crash 나지 않고 묵시형 빈 문자열을 리턴하도록 예외(try-except) 처리를 철저히 캡슐화.

---

## 🎯 2. LLM JSON 모드 강제, Zod 스키마 검증 및 자체 치유(Self-Healing) 루프

**현재 상태 (AS-IS)**: 프롬프트에서 "무조건 JSON 배열로 응답할 것"이라고 구두 경고만 함. 어긋나는 순간 파이프라인 시스템 Crash.
**목표 상태 (TO-BE)**: TypeScript 백엔드에서 `Zod`를 통해 형식을 강력히 검증하며, 실패 시 에러 사유를 LLM에게 돌려보내 자체 수정하도록 하는 **메타-루프(Meta-Loop)** 아키텍처 도입.

### 📝 Action Plan (실행 절차)

1. **Zod 설치 및 Schema 스펙 정의 강화**
   ```bash
   npm install zod
   ```
   - `src/lib/schema.ts`: AI 응답 규격(배열 내 `issueId`, `component`, `severity` 등)을 엄격한 타입 체인으로 명시.
2. **OpenClaw Parameter 플래그 강제 적용**
   - `execute/route.ts` 스크립트에 반드시 `--json-mode` 등 리터럴 파라미터를 명시.
3. **자체 치유 자율 검증 (3-Tier 핑퐁 로직)**
   - **1차 파싱**: AI 출력물에 대해 `ReviewSchema.parse()` 실행.
   - **2차 자가 수정 루프**: 파싱 실패 시, Catch 블록에서 `e.errors` (Zod 오류 메시지 스펙)를 모아 "이전 응답이 실패했습니다. 다음 Zod 구조적 에러를 해결하여 다시 제출하세요." 라는 프롬프트로 재전송. (최대 2회 시도 제한).

### 🛡️ 3중 교차 검증 및 예외 대책 (Troubleshooting / Validation)
- **무한 루프 방지망 (Logic Validation)**: 자가 수정을 2번이나 거쳤음에도 스키마를 만족하지 못하면 파이프라인 무한정 대기를 방지하기 위해 강제 탈출. 해당 Job을 `BullMQ`에서 제거하고 Prisma DB의 상태를 `FAILED_AI_REVIEW`로 치환.
- **Rate Limit 및 네트워크 오류 방어 (End-to-End Validation)**: OpenClaw 서버 API 제한에 걸렸을 때 즉각 실패처리하지 않고, **지수 백오프(Exponential Backoff)** 알고리즘을 태워 3초-9초-27초 간격으로 재시도 후 최종 포기하도록 예외 흐름 탑재.

---

## 🎯 3. Prisma SQLite WAL 동시성 제어 및 과부하 방어형 (Debounced) 수동 리뷰 UI

**현재 상태 (AS-IS)**: 배치 스크립트와 웹이 동시에 SQLite 접근 시 `SQLITE_BUSY` (Database locked) 트랜잭션 충돌 심각.
**목표 상태 (TO-BE)**: Write-Ahead Logging(WAL)을 Node 구동 시 주입하여 Non-blocking 트랜잭션을 확보하고, 에러난 패치를 수동으로 돌릴 수 있는 안전한 UI 구축.

### 📝 Action Plan (실행 절차)

1. **Prisma 하이브리드 WAL 모드 설정**
   - `lib/db.ts` 내에 Next.js 시작 시 `prisma.$executeRaw` PRAGMA 쿼리 강제 실행.
   - 향후 PostgreSQL 마이그레이션을 대비해 환경변수(`process.env.DB_TYPE === 'sqlite'`) 의존성에 따른 하이브리드 어댑터 패턴으로 작성.
2. **프론트엔드 수동 리뷰 복구 트리거 UI**
   - `PatchList.tsx`나 `ProductGrid.tsx`에서 개별 컴포넌트 오류 발생 시 `onClick`으로 즉시 Next.js `/api/pipeline/review-manual` 트리거를 쏘는 재시작 버튼 생성.

### 🛡️ 3중 교차 검증 및 예외 대책 (Troubleshooting / Validation)
- **WAL 파일 비대화 누수 (Build/Architecture Validation)**: WAL 모드는 서버 비동기 충돌은 해소하지만 쓰레기 파일이 디스크를 채움. 따라서 매일 자정 혹은 OS `cron` 레벨에서 `PRAGMA wal_checkpoint(TRUNCATE)`를 실행하는 파이프라인 청소부 루틴 보장.
- **버튼 연타에 의한 Job 스팸 (Interaction Validation)**: 관리자가 렌더링 지연 시 수동 리뷰 버튼을 10번 누르면 BullMQ 큐에 10개의 중복 Job이 쌓이는 참사 발생. 리액트 단에 `isLoading` State 기반 억제 로직(Debouncing)을 적용해 최초 클릭 시점부터 서버 응답 완료 시까지 UI 버튼을 강제 잠금 탈취.

---

## 💡 특별 지침: 안티그라비티 운영 및 파이프라인 프로덕션 규칙 (LEARNED.md 기반)

이 보완 계획을 실행하는 모든 에이전트/개발자는 `GEMINI.md`와 `LEARNED.md` 기록에 따라 다음의 치명적 시스템 파괴 행위를 **절대 금지**합니다.

1. **절대 파괴 금지 (No Inline PowerShell SSH)**: Windows 터미널에서 `ssh user@호스트명 "python ..."`과 같이 직렬 명령어 전달 절대 금지. PowerShell 이스케이프 파괴로 코드 변형 일어남. 반드시 `.py`나 `.sh` 형태의 완성형 단일 파일을 만들고 `scp` 로 밀어넣은 직후 순수 킥오프만 진행하세요.
2. **명령어 체이닝 규칙 유지**: `&&` 연산자 대신 Windows 레거시 환경을 막아내기 위해 무조건 세미콜론(`;`) 연계 사용.
3. **PM2 & 환경변수 확보**: 원격으로 구동할 때(node, npm) 로그인 쉘 환경이 아니므로 `NVM`이나 전역 PATH를 못 찾습니다. 반드시 실행 명령어 선두에 `source ~/.nvm/nvm.sh ; `를 기재하고 타겟팅하십시오.
4. **Turbopack은 프로덕션 툴이 아님**: `next dev --turbo`는 배포용이 될 수 없습니다. 서버는 항상 `next build` 후 최적화된 JS 번들을 `next start` (Port 3001) 로 구동하도록 문서화 및 파이프라인 오케스트레이션 해야 합니다.

---

## 🤖 AI 서브 에이전트 인수인계 프로토콜 (Agentic Handover Execution Directive)

수많은 서브 에이전트들의 환각을 막고 이 아키텍처 플랜을 100% 코드로 변환하기 위해서는, 코드 생성 전 다음 프롬프트를 에이전트 시스템 페이로드에 그대로 Injection 하십시오.

### 📋 프롬프트 복사 블록 (Copy & Paste to Next Agent System Prompt)

```text
[Mission Critical System Injection]
당신은 스태프 엔지니어링 롤을 맡아 Patch-Review-Dashboard V2의 누락 기믹(3가지 코어 픽스)을 본 계획서에 적힌 그대로 개발해야 합니다. 작업을 시작하기 전 한 치의 오차도 없도록 아래 지시를 정확히 이행하십시오.

1. **[맥락 파악 및 100% 이해 (Context Sync)]**: 코어 시스템을 완벽히 이해하고 분석하기 전까지는 절대 코드 작성을 시작하지 마시오. 투입 즉시 다음 문서를 `view_file` 도구로 철저히 정독하고, 연관 폴더(`pipeline_scripts/`, `src/app/api/`)를 탐색하여 아키텍처와 기존 코드를 100% 숙지하라.
   - `docs/architecture.md`
   - `docs/pipeline_flow.md`
   - `docs/tech_stack.md`
   - `docs/post_deployment_enhancement_plan.md`

2. 절대 벗어나지 마라: 
   맥락 파악이 끝난 후, `post_deployment_enhancement_plan.md`를 열고 Action Plan 1-1부터 3-2까지 문서에 적힌 대로 하나씩 퀘스트 깨듯 코딩하라.
   
3. 3중 예외 대책 탑재 의무: 
   각 파편을 개발할 때마다, 문서의 [🛡️ 3중 교차 검증 및 예외 대책] 섹션에 명기된 문제점(예: 메모리 부족 발생 시 Fallback 코드, 무한 루프 차단 기능, 버튼 연타 Debounce 제어 기능 등)을 반드시 당신의 코드에 로직(try/catch, if문 등)으로 100% 녹여내야 한다. 방수로가 없는 댐은 짓지 마라.

4. 안티그라비티 특별 지침을 목숨처럼 지켜라:
   파일 생성 전 `Thought` 사고망에서 "내 명령어가 세미콜론(;)을 쓰고 있는가? SSH 인라인을 쓰려는 건 아닌가? 원격에 제대로 파일을 Push 해놓고 타겟팅 했는가?" 자문하여라.

5. 3가지 주제 개발이 모두 끝나 로직 충돌이 없음을 증명해 내면, 
   `walkthrough.md`에 결과를 화려하게 작성하고 나에게 보고하라.
```
