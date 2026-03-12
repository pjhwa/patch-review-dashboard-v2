# 데이터 파이프라인 흐름 및 워크플로우

Patch Review Dashboard V2는 보안 패치를 수집, 정제, 평가, 저장하는 5단계의 자율 컴플라이언스 워크플로우를 통해 운영됩니다.

---

## 1단계: 파이프라인 실행 시작 (Initiation)
파이프라인 트리거에는 두 가지 주요 경로가 있습니다:
- **수동 트리거:** 웹 대시보드의 `Execute Pipeline` 버튼을 클릭하여 실행.
- **스케줄 트리거:** 서버 내 `run_collectors_cron.sh` (매년 3, 6, 9, 12월 셋째 일요일 실행) 기반.
두 경우 모두 Next.js API의 `/api/pipeline/execute`를 호출하게 되며 카테고리와 타겟 리눅스 제품군을 전달합니다. 서버는 중복 실행에 따른 컨텍스트 충돌을 막기 위해 `pipeline_status.json` 파일 기반의 어플리케이션 락(Lock)을 설정합니다.

## 2단계: 파편화된 원시 데이터 수집
Node.js 백엔드는 `~/.openclaw/workspace/skills/patch-review/os/linux-v2` 디렉토리 내에서 자식 프로세스(Child Process)를 스폰(spawn)하여 벤더 맞춤형 다운로드 스크립트를 독립 실행합니다.
- **Red Hat:** `rhsa_collector.js`와 `rhba_collector.js`를 이용한 Errata API 파싱.
- **Oracle:** `oracle_collector.sh` 구동 후 `oracle_parser.py`를 통해 Eln 데이터베이스 파싱.
- **Ubuntu:** `ubuntu_collector.sh`를 구동하여 CVE 취약점 수집.
- **서드파티 애플리케이션:** `storage/ceph` 나 `database/mariadb` 벤더 디렉토리로 이동하여 데이터를 병렬 수집.

## 3단계: 전처리 로직 및 데이터베이스 중복 제거
모든 원시 데이터 수집이 끝나면 `patch_preprocessing.py`가 작동합니다.
1. 2단계에서 나온 다양한 포맷의 JSON 배열 구조를 하나의 정규화된 마스터 구조로 통합합니다.
2. `--days 90` 옵션을 사용하여 LLM 컨텍스트 한도 초과 오류 방지를 막고 최근 3개월간의 패치만 처리합니다.
3. 시스템의 메인 SQLite 데이터베이스(`prisma/patch-review.db`)에 다이렉트 접근하여 `PreprocessedPatch` 모델과 `IssueID`를 대조 후, 이미 처리된 패치는 중복으로 간주하고 스킵 처리합니다.
4. 최종 대상만을 정리하여 `patches_for_llm_review.json` 파일로 산출합니다.

## 4단계: 역사적 RAG 피드백 주입 및 AI 분석 (자가 치유)
1. **RAG 주입:** `query_rag.py`가 3단계의 타겟 패치들을 데이터베이스 내 과거 관리자 설정값인 `UserFeedback`과 비교합니다. 유사도가 높은 특정 배제(Exclusion) 건이 존재하면, 해당 사유를 AI 프롬프트에 동적 삽입하여 관리자의 기준을 계승합니다.
2. **AI 에이전트 실행:** 시스템은 `openclaw agent:main`을 `--json-mode` 로 호출하여 `SKILL.md` 지침에 따라 영/한 병기 요약 및 영향도 분석을 진행합니다.
3. **Zod 검증 및 자가 치유(Auto-Healing):** AI가 내뱉은 `patch_review_ai_report.json` 은 Zod의 `ReviewSchema`를 거치게 됩니다. 누락된 JSON Key나 타입 위반을 감지하면 Node.js API가 에러 Path를 캡처하여 프롬프트로 재생성한 뒤 백오프(Backoff) 딜레이를 주어 최대 2번까지 재평가를 시도합니다.

## 5단계: DB 반영 및 아카이빙
JSON 100% 구조적 무결성 검증을 완료하고 나면 대시보드 UI가 검토 결과를 렌더링합니다. 담당자가 최종 제출(Submit)을 수행하면 `/api/pipeline/finalize` 가 구동되어 JSON 구조를 바로 Prisma `ReviewedPatch`에 영구 기록 반영합니다. 이후 작업 템포러리 파일들은 `/archive/YYYY-MM-DD` 타임스탬프 폴더로 이관되어 깔끔한 운영 상태를 유지합니다.
