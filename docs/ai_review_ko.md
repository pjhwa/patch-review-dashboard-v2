# AI 아키텍처: OpenClaw 기반 패치 리뷰 보드 (PRB) 작동 원리

패치 리뷰 대시보드 V2는 파이프라인 깊숙한 곳에서 AI 자율 검토 프로세스를 구동합니다. 이 시스템은 구글 리서치 내부의 `openclaw` AI 오케스트레이션 CLI를 활용하여 Google Gemini 엔진과 통신하며, 사이버 보안 조직의 패치 리뷰 보드(PRB) 역할을 자율 수행합니다.

---

## 1. 에이전트 환경 구성
AI 검토 파이프라인은 Node.js 프로세스가 운영체제 레벨에서 아래의 shell 명령어를 백그라운드로 실행하며 시작됩니다:
```bash
openclaw agent --agent main --json-mode --message "{currentPrompt}"
```
이러한 명령어 구조는 AI가 서술형 답변이 아닌 엄격한 `JSON` 포맷으로만 응답하도록 강제합니다. 

AI의 성격과 임무를 규정하는 프롬프트 맥락(Context)은 `~/.openclaw/workspace/skills/patch-review` 환경 내 `SKILL.md` 문서에 정의되어 있습니다. 에이전트 `main`은 이 지침에 따라 사전에 통합된 `patches_for_llm_review.json` 데이터들을 분석하고 영향도를 산출합니다.

## 2. 동적 RAG 프롬프트 주입 (Dynamic RAG)
단순한 고정형 프롬프트가 아닌 유기적인 판단을 위해 Next.js 실행 엔진은 사전에 `query_rag.py`를 가동합니다. 관리자가 과거에 입력해 둔 Prisma 데이터베이스의 `UserFeedback` 배제(Exclusion) 사유들을 검색엔진으로 대조하여 가져옵니다.

만약 과거 담당자가 시스템에 다음과 같이 기록했다면:
> "Excluded Issue: CVE-2025-XXXX, Reason: 내부 MariaDB는 해당 모듈을 사용하지 않아 영향 없음."
RAG 시스템은 위 구문을 런타임에 즉시 AI의 프롬프트 마지막에 연결(Append)합니다. AI는 새로운 CVE 패치 목록을 읽다가 위와 일치하거나 유사도가 90% 이상인 패키지를 발견할 경우, 담당자가 일일히 배제하지 않아도 자율적으로 최종 목록에서 제거하여 불필요한 휴먼 에러 및 반복 검토 리소스를 절약합니다.

## 3. 3-Tier 자가 치유(Self-Healing) 검증 루프 설계

LLM 시스템은 본질적으로 비결정적(non-deterministic) 성향을 지니지만, 대시보드의 관계형(RDB) 데이터베이스는 결정적인 스키마 구조를 필수로 요구합니다. 
이러한 간극을 극복하기 위해 V2 대시보드는 코드 레벨의 엄격한 "자가 치유(Self-Healing)" 검증 루프를 탑재했습니다:

1. **최초 시도:** AI가 자신이 판단한 리뷰 결과를 `patch_review_ai_report.json` 포맷으로 작성합니다.
2. **스키마 검증 (Zod):** Next.js API 엔진이 해당 JSON을 가로채어 `zod` 라이브러리의 `ReviewSchema` 객체와 대조합니다. (필수 요구 키: `'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription'`).
3. **핑퐁(Ping-Pong) 피드백:** 하나의 Key라도 누락되거나 타입이 맞지 않으면 Zod 엔진이 해당 JSON Path의 위치와 에러 사유를 TypeScript Error 객체로 던집니다.
4. **자율 재시도 루프 (Auto-Retry):** 시스템이 이 Zod 에러를 삼킨 뒤, 지수 백오프 (Exponential backoff: 3초 -> 9초 -> 27초) 방식으로 딜레이를 부여한 후, 아래와 같은 메시지로 AI의 실수를 지적하며 API를 재호출합니다:
   *"이전 응답이 실패했습니다. 다음 Zod 구조적 에러를 해결하여 다시 제출하세요: [Zod Error Message]"*
5. **안전망 (Fallback):** 3회 이상 자가 치유에 실패할 경우, DB 붕괴를 막기 위해 파이프라인을 완전히 정지하고 담당자가 UX 화면에서 수동으로 `AI 단독 재시도(AI Only Retry)` 버튼을 누를 수 있도록 안전 구역으로 책임을 이관합니다.
