# 🚀 대시보드 V2 - 추가 보완 개발 및 고도화 계획서 (Post-Deployment Enhancement Plan)

본 문서는 `deep_implementation_plan.md.resolved`의 초기 설계안 중, V2 릴리즈 버전에 누락되었거나 레거시 방식으로 구현된 **3대 핵심 누락 기능**을 완벽하게 구현하기 위한 **심층 보완 개발 가이드**입니다. 

이 문서의 절차(Action Plan)를 그대로 복사-붙여넣기(Copy-Paste) 하거나 순서대로 실행만 해도 오류 없이 즉시 프로덕션 수준의 기술 스택을 완성할 수 있도록, 3단계 교차 검증 및 예외 상황(Edge Cases)에 대한 회피 기동 전략을 포함하여 작성되었습니다.

---

## 🎯 1. 완전한 형태의 RAG(검색 증강 생성) 시스템 구축 (Local Vector Store)

**현재 상태 (AS-IS)**: 관리자가 피드백한 `user_exclusion_feedback.json`의 전체 데이터를 단순 텍스트(`aiPrompt += ... \n${exclusionRules}`)로 결합하여 LLM에 전송(Stuffing) 중. 데이터가 쌓이면 토큰 한계(Context Window) 초과 확률 100%.
**목표 상태 (TO-BE)**: 가벼운 로컬 Vector DB (`ChromaDB`)를 내장하여, 새로 들어온 패치 설명과 코사인 유사도(Cosine Similarity)가 높은 과거 피드백 상위 3건만 동적 추출(Retrieval)하여 프롬프트에 주입.

### 📝 Action Plan (실행 절차)

1. **의존성 설치 (Python 환경)**
   파이프라인 서버(`openclaw_scripts` 구동 환경)에 Python 의존성을 추가합니다.
   ```bash
   pip install chromadb sentence-transformers
   ```
2. **Vector DB 초기화 스크립트 작성 (`pipeline_scripts/init_rag.py`)**
   - `user_exclusion_feedback.json`을 읽어 로컬 디렉터리(`./chroma_db`)에 `all-MiniLM-L6-v2` 임베딩을 구성합니다.
   - *검증 전략*: DB가 생성되지 않거나 JSON 형식이 깨진 경우 `try/except` 블록으로 로깅 후 Graceful Degradation(기존 Stuffing 방식으로 전환) 하도록 Fallback 설계.
3. **OpenClaw `route.ts` 호출부 수정**
   - 기존의 `execute/route.ts` 내 프롬프트 결합 로직을 삭제합니다.
   - 대신 Node.js 단에서 `python3 query_rag.py <현재 패치 설명 텍스트>` 와 같은 로컬 스크립트를 `spawnSync` 로 호출해, 리턴된 "유사도 높은 Top 3 사유" 문자열만 `aiPrompt` 변수에 주입합니다.

### 🛡️ 예외 대책 (Troubleshooting)
- **차원 및 메모리 에러 (Memory Overflow)**: 임베딩 모델 `all-MiniLM-L6-v2`는 약 80MB로 가볍지만, 만약 서버 RAM 부족으로 다운되는 경우 HuggingFace 서버리스 API를 타는 구조로 네트워크 통신 코드로 스왑합니다.
- **빈 검색 결과 (Zero Hits)**: Vector DB에 데이터가 0건일 때도 프롬프트는 "빈 참조(Empty Context)"를 허용하고 정상 진행하도록 안전 코딩합니다.

---

## 🎯 2. LLM JSON 모드 강제 및 Zod/Pydantic 스키마 검증 (Validation)

**현재 상태 (AS-IS)**: "반드시 JSON 배열로만 응답하라"고 자연어 프롬프트로만 경고. LLM이 마크다운(```json)이나 불필요한 서술어를 섞을 여지 높음.
**목표 상태 (TO-BE)**: TypeScript 서버에서 `Zod` 스키마(또는 JSON.parse 후 강형 검사) 기반으로 검증하며, 실패 시 2회 자가 수정을 지시하는 메타-루프(Meta-Loop) 가동.

### 📝 Action Plan (실행 절차)

1. **Zod 설치 및 Schema 스펙 정의**
   ```bash
   npm install zod
   ```
   - `src/lib/schema.ts` 파일 생성:
     ```typescript
     import { z } from 'zod';
     export const ReviewSchema = z.array(z.object({
         issueId: z.string(),
         component: z.string(),
         version: z.string(),
         // ...
     }));
     ```
2. **OpenClaw (LLM) 호출 시 플래그 강제**
   - `execute/route.ts` 내의 OpenClaw 스크립트 호출 인자에 `--json-mode` 또는 모델의 강제 JSON 생성 포맷 인자를 리터럴로 명시하여 LLM 환각(Hallucination) 원천 차단.
3. **Retry-Validation Loop 로직 작성 (3-Tier)**
   - 1차 파싱: `fs.readFileSync(patch_review_ai_report.json)` 결과에 대해 `ReviewSchema.parse()` 실행.
   - 2차 자가수정 (Self-Correction): 에러 발생 시 Catch 블록이 가동되어, Zod가 리턴한 `e.errors` (어떤 key가 어떻게 틀렸는지) 메시지 그대로를 "다음 구조 에러를 수정해 다시 제출하라"는 프롬프트로 덧붙여 OpenClaw에 재전송. (최대 2회 반복)

### 🛡️ 예외 대책 (Troubleshooting)
- **영구 실패 (Infinite Loop)**: 2번의 자가 수정 요청에도 스키마를 못 지키면 무한 루프를 도는 대신, 해당 Job을 `Failed`로 폐기 처리하고 BullMQ Queue에서 `status: error`를 송출해 관리자가 UI에서 "AI 리뷰만 재시도" 버튼을 직접 1회씩 누를 수 있도록 UI 피드백을 강화합니다.

---

## 🎯 3. Prisma SQLite의 동시성 트랜잭션 (WAL 모드) 적용 및 수동 버튼 UI 연동

**현재 상태 (AS-IS)**: 파이프라인의 Python 스크립트와 Next.js 서버(Prisma)가 동시에 패치 데이터를 읽고 쓸 때 SQLite 기본 모드로 인해 `SQLITE_BUSY` (Database locked) 에러 가능. 관리자 UI엔 "수동 리뷰 큐(Manual AI Review)" 버튼 없음.
**목표 상태 (TO-BE)**: Write-Ahead Logging(WAL)을 Prisma 기동 시 무조건 켜주고 프론트엔드 버튼 컴포넌트를 연결.

### 📝 Action Plan (실행 절차)

1. **Prisma WAL 설정 주입**
   - `schema.prisma` 및 `src/lib/db.ts` 내의 데이터베이스 URL 설정을 오버라이드.
   ```typescript
   // lib/db.ts
   import { PrismaClient } from '@prisma/client'
   export const prisma = new PrismaClient()
   // Next.js 서버 시작 시 SQLite PRAGMA 강제 쿼리
   prisma.$executeRaw`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`
   ```
2. **프론트엔드 (UI) 구현: AI 수동 리뷰 버튼**
   - `src/components/ProductGrid.tsx` 또는 `PatchList.tsx` 에 조건부 버튼 추가.
   - 조건 로직: `patch.isReviewed === false` 인 패키지 뷰 우측 상단에 "✨ 수동 AI 리뷰 촉발" 버튼을 위치시킴.
   - onClick Handler: 
     ```javascript
     fetch('/api/pipeline/review-manual', { 
         method: 'POST', 
         body: JSON.stringify({ issueIds: [patch.issueId] }) 
     });
     ```

### 🛡️ 예외 대책 (Troubleshooting)
- **WAL 파일 비대화 (Disk Full)**: WAL 모드는 시스템 충돌과 비동기 처리에 강하지만, 오래동안 `sqlite-wal` 파일 크기가 커질 수 있습니다. 이를 방지하기 위해 매일 자정에 `PRAGMA wal_checkpoint(TRUNCATE);` 를 스크립트로 날리거나 Node 서버 로직 내 Cron Job으로 비워냅니다. 
- **버튼 연타 방어 (Debouncing)**: 관리자가 수동 리뷰 버튼을 마우스로 여러 번 연타(Click Spam)할 경우 BullMQ에 동일한 Job이 수십 개 중복 적재됩니다. React 단에서 클릭 후 즉시 UI 버튼을 `disabled: isLoading` 상태로 3초간 잠그고 API 응답을 대기합니다.

---

## 💡 특별 지침: 안티그라비티(Antigravity) 운영 및 오류 방지 가이드 (LEARNED.md 기반)

이 보완 개발을 수행하는 에이전트 또는 개발자는 `GEMINI.md` 마스터 가이드라인과 과거 수많은 오류를 기록해 둔 `LEARNED.md` 의 전철을 밟지 않기 위해 다음 규칙을 **절대적으로 준수**해야 합니다.

1. **PowerShell 인라인 SSH 스크립트 전송 절대 금지 (Error Type 17, 6)**
   - Windows 터미널에서 `ssh user@host "python3 -c \"...\""` 처럼 복잡한 Python/Node 스크립트나 다중 인용부호가 들어가는 명령을 절대 전송하지 마세요. PowerShell의 이중 탈출(Escape) 파서가 파일 형태를 파괴합니다.
   - **올바른 방법**: 로컬에 완전한 스크립트 파일(`.py`, `.ts`)을 만들고 `scp`로 넘긴 뒤, `ssh`로는 대상 파일을 순수하게 "호출(Call)"만 하십시오.
2. **명령어 체이닝 호환성 (Error Type 18)**
   - 로컬 구버전 PowerShell 환경을 고려하여, 명령어 여러 개를 이을 때 `&&` 사용을 금지하고 무조건 **세미콜론(`;`)** 을 사용하세요.
3. **원격 Node 생태계(pm2, npm) 환경변수 확보 (Error Type 19)**
   - 원격으로 `npm run build` 나 `pm2` 관련 작업을 시킬 때는 비대화형 쉘 환경 특성 상 경로를 못 찾습니다. 반드시 명령어 제일 앞에 `source ~/.nvm/nvm.sh ; `를 명시하거나 바이너리의 절대 경로를 기입하세요.
4. **파괴적 명령어 지양 и 단일 진실 진단 (Master Principle)**
   - 문제가 있더라도 임시방편 수정은 금지됩니다. 테스트 실패나 버그 발견 즉시 스스로 로그를 파악하고 자율 수정하되, `LEARNED.md`를 단일 진실 공급원(Single Source of Truth)으로 삼아 에지 케이스를 기록하여 두 번 다시 겪지 않게 대비하십시오.
   - Prisma DB Push 및 스키마(`schema.prisma`) 버전 충돌(P1012 등)에 유의하여 환경 내 엔진 버전을 사전에 `grep_search` 점검하십시오.

---

## 🤖 AI 서브 에이전트 인수인계 가이드 (Sub-Agent Handover Guide)

맥락(Context)이 초기화된 완전히 새로운 AI 에이전트 (또는 서브 에이전트)에게 작업을 인계할 때, **한 치의 오차나 환각(Hallucination) 없이 완벽하게 이 계획서를 따르게 하려면 아래의 프롬프트를 복사하여 그대로 주입(Injection) 하십시오.**

### 📋 프롬프트 복사 블록 (Copy & Paste to New Agent)

```text
[임무 하달: 안티그라비티 V2 보완 개발]
당신은 지금부터 Patch-Review-Dashboard V2의 핵심 누락 기능들을 보완하는 스태프(Staff) 엔지니어 역할을 수행합니다.

1. 가장 먼저, 현재 작업 디렉토리의 `docs/post_deployment_enhancement_plan.md` 파일을 `view_file` 도구를 이용해 끝까지 정독하십시오.
2. 문서 내의 [1. RAG 시스템 구축], [2. Zod 스키마 검증], [3. Prisma WAL 및 수동 UI 연결]이라는 3가지 핵심 목표와 '📝 Action Plan(실행 절차)'를 완벽히 숙지하십시오.
3. 특히 문서 하단의 **[💡 특별 지침: 안티그라비티 운영 및 오류 방지 가이드]**는 절대적인 법률(Constraint)입니다. PowerShell 인라인 SSH 스크립트 전송을 금지하고, 로컬 스크립트 생성 후 scp 전송 방식을 반드시 따르십시오.
4. 모든 코딩과 명령어 실행 전 생각(Thought) 프로세스에서 "안티그라비티 4대 금지 규칙을 위반하지 않았는가?" 자문하는 사전 점검(Pre-Flight Check)을 수행하십시오.
5. 숙지를 완료했다면, 즉시 계획서(Action Plan)의 1번 단계부터 Step-by-Step으로 타겟 파일(`route.ts`, `schema.prisma` 등)을 찾아 코딩(Execution) 모드로 돌입하십시오. 하나의 스텝이 완벽히 검증되기 전에는 다음 스텝으로 넘어가지 마십시오. 작업이 완료되면 `walkthrough.md`를 작성하고 나에게 보고하십시오.
```
