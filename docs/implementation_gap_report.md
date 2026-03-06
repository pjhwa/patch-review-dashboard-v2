# 🕵️‍♂️ V2 Implementation vs. Deep Plan Analysis Report

`deep_implementation_plan.md.resolved` 문서와 현재 로컬에 구현된 `patch-review-dashboard-v2`의 실제 코드를 비교 분석한 결과, 계획 대비 **구현되지 않았거나 누락된 항목**들을 식별했습니다.

---

## 🚨 1. DB 마이그레이션 (Next.js + Prisma + SQLite)
- **구현 상태**: 🟡 부분 구현됨
- **설명**: `schema.prisma` 및 CRUD 연동은 성공적으로 적용되었습니다.
- **누락된 부분 (Discrepancy)**: 
  - `PRAGMA journal_mode=WAL;` 설정: 문서는 다중 트랜잭션 락 방지를 위해 SQLite WAL 모드를 강제로 켤 것을 권고했으나 실제 Prisma 셋업 스크립트나 `.env`에서 WAL 옵션이 확인되지 않습니다. (고부하 환경에서 `SQLITE_BUSY` 에러 발생 가능성 존재)

## 🚨 2. RAG 융합 및 LLM JSON Mode 강제 최적화
- **구현 상태**: 🔴 미구현 (Legacy Mismatch)
- **설명**: 문서 내 3-1, 3-2 항에서는 `chromadb` 혹은 `pgvector`(모델: `all-MiniLM-L6-v2`)를 이용한 **리얼 RAG (Vector Store 임베딩 기반 검색) 파이프라인** 구축을 지시하고 있습니다.
- **실제 코드 (`src/app/api/pipeline/execute/route.ts`)**:
```javascript
const exclusionRules = feedbackList.map((f: any) => `- Issue: ${f.issueId}...`).join('\n');
aiPrompt += `\n\nCRITICAL INSTRUCTION: Reviewers have manually marked the following... \n${exclusionRules}`;
```
  - **누락된 부분 (Discrepancy)**: 실제 구현은 단순히 `user_exclusion_feedback.json`의 전체 항목을 텍스트로 합쳐서 프롬프트(Prompt)에 통째로 쑤셔넣는(Stuffing) 원시적인 방식으로 이뤄졌습니다. 벡터 유사도 기반의 RAG가 아닌, 컨텍스트 윈도우 한계에 부딪힐 수 있는 위험한 레거시 방식입니다. Zod 스키마 검증기도 누락되어 있습니다.

## 🚨 3. UI 수동 AI 리뷰 버튼 및 단건 실행
- **구현 상태**: 🟡 부분 구현됨
- **설명**: 백엔드 API 라우트 (`pipeline_scripts/review_manual_route.ts`) 자체는 BullMQ를 이용해 큐에 태우도록 잘 구현되어 있습니다.
- **누락된 부분 (Discrepancy)**:
  - 프론트엔드 UI: `ProductGrid.tsx`나 `PatchList` 컴포넌트를 확인해 본 결과, 패치 리스트 행마다 들어가야 하는 **"AI 리뷰 요청(수동)" 버튼** 화면 노출이 프론트 쪽에서 누락되었거나 연결되어 있지 않았습니다.

## 🚨 4. Event-Driven Queue 및 SSE 아키텍처 도입 (BullMQ)
- **구현 상태**: 🟡 부분 구현 (혼재)
- **설명**: SSE 엔드포인트(`/api/pipeline/stream`)와 BullMQ 트리거 로직은 확인되었습니다.
- **누락된 부분 (Discrepancy)**:
  - 실행 API(`execute/route.ts`) 일부 코드는 BullMQ 기반 워커로 분리된 것이 아니라, 여전히 서버 라우트 안에서 `spawn` 으로 거대한 파이프라인을 블로킹 없이 돌리도록(`runBackgroundPipeline()`) 원시적인 백그라운드 형태로 혼재되어 있습니다. 이는 완전한 마이크로 워커(Worker Process) 분리라 보기엔 아쉬운 점이 있습니다.

---

> [!CAUTION]
> **결론**: 전체적인 아키텍처 흐름과 V2 기반의 뼈대(SSE, DB 마이그레이션)는 성공적으로 도입되었으나, **1) Vector기반 순수 RAG 2) 구조화된 Zod 검증 3) PRAGMA WAL 동시성 제어** 등 고급 최적화 기능들이 코드 레벨에서 누락되었습니다.
