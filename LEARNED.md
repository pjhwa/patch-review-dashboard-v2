# 학습 및 교훈 (Lessons Learned)

---

## 🟣 [2026-03-12] AI API Rate Limit 오류 발생 시 리뷰 재실행(Resume) 기능
- **상황**: AI API Rate Limit 에러로 파이프라인이 중단된 경우, 재실행 시 기존 진행 내역이 DB 및 JSON에서 무자비하게 덮어써져 수 시간의 리뷰 시간이 날아가는 심각한 문제가 존재함. "AI 리뷰 단독실행"이나 "오류 패치 재수집"의 엣지 케이스를 제대로 처리하지 않고 무조건 리셋하는 구조였음.
- **교훈 및 강력한 행동 지침**:
  - 기존의 모든 파이프라인(OS, Ceph, MariaDB `queue.ts`)의 DB 업데이트(Upsert) 및 JSON 파일 출력 위치를 AI 루프의 완전 종료 시점에서 **개별 패치의 평가(Zod Validation 통과) 직후**로 이동시킴으로서 즉각적(Incremental) 상태 보존 메커니즘을 적용.
  - Rate Limit 에러 예외 캐치 시 `fs.writeFileSync`를 활용하여 서버 단(/tmp)에 `.rate_limit_[pipeline_key]` Flag 플래그 파일을 기록하도록 백엔드 처리. 
  - 새 파이프라인 기동 시(isAiOnly 혹은 isRetry 옵션), Rate Limit 플래그가 확인되면 `[RESUME] (이어서 진행 모드)`를 가동하여 대상 파일의 전처리(Preprocessing) 과정을 건너뛰고 기존 저장된 JSON 배열을 읽어와 리뷰 통과된 Patch ID (`IssueID`) 들을 Skip 하는 로직 개발.
  - Frontend 화면 (`ProductGrid.tsx`)의 SSE Stream 수신 측면에 `[RESUME]` 및 `[SKIP-RESUME]` Keyword 로직을 구현하여 사용자에게 "이전에 완료된 건은 건너뛰고 이어서 리뷰를 진행합니다" 따위의 재개 상황을 명확하게 이모지 기반으로 표시.
  - **데이터베이스 보존 원칙 (명심할 것)**: 사용자가 고의적으로 "새로 고침 풀 실행"을 시켜서 새로운 파이프라인으로 덮어쓰겠다는 강한 의도나 지시(isResumeMode !== true)가 없는 이상 무자비하게 `prisma.preprocessedPatch.deleteMany()` 와 `prisma.reviewedPatch.deleteMany()` 를 호출해서는 안됨. 이 사소하지만 공격적인 쿼리 한 줄이 기존 분석 이력을 날려버림.


## 🟣 [2026-03-12] 신규 카테고리 및 제품(Ceph) 파이프라인 전면 구축의 핵심 강제 지침
- **상황**: 대시보드 V2에 기존 OS 외에 새로운 스토리지 카테고리(Storage)와 신규 제품(Ceph)을 추가하는 일련의 과정을 성공적으로 완수함. 앞으로 계속해서 새로운 카테고리와 제품을 추가해야 함.
- **교훈 및 강력한 행동 지침**: 
  - 신규 제품이나 카테고리를 추가하는 일은 단순히 대시보드 UI 카드 하나를 그리는 것이 아니라, **①수집기·전처리기(Python) → ②큐 워커(Node.js) → ③API 엔드포인트(Next.js) → ④프론트엔드 UI 화면 반영까지 이어지는 '풀스택(Full-Stack) 종단(End-to-End) 연동'**임을 명심해야 함.
  - 특히 UI를 그릴 때 `CATEGORIES` 배열 내의 `active: true` 플래그를 깜빡하거나, `queue.ts`에서 Prisma DB를 특정 `vendor`명으로 단일 호출(`where: { vendor: '...' }`)하는 매핑을 누락하는 등의 실수가 치명적인 버그(화면 비활성화, 데이터 오염 등)를 유발함을 이번 작업에서 증명함.
  - **강제 규정**: **앞으로 신규 제품 및 카테고리 추가 요청을 받을 경우, 무작정 코드를 만지지 말고 반드시 `docs/ADDING_NEW_PRODUCT.md` 가이드라인 문서를 제1원칙으로 1독(Read)한 뒤 단계별 체크리스트에 입각하여 누락 없이 작업을 진행할 것.**

---

## 🟣 [2026-03-12] Ceph 데이터 스키마 일원화 파이프라인 대응

### Ceph 데이터 구조체 통합(GHSA/REDMINE)에 따른 전처리 파서 폴백(Fallback) 설계
- **상황**: 데이터를 수집하는 Collector가 기존 `security`, `releases` 디렉토리를 분리하던 방식에서 모든 JSON 파일을 `ceph_data` 단일 디렉토리로 통합하고, JSON 내부 스키마를 `title`, `description`, `issuedDate` 등의 표준 필드로 평탄화(Flattening)하는 재구조화를 단행함.
- **해결 방안**: 
  1. `args.security_dir`와 `args.releases_dir`를 폐기하고 `args.data_dir` 단일 인수로 통합.
  2. `glob.glob()` 패턴을 `GHSA-*.json`과 `REDMINE-*.json`으로 변경하여 단일 폴더 내에서도 보안/일반 릴리스 파이프라인 분리를 유지.
  3. 기존 파서 코드에서 값 추출부를 `.get("summary") or .get("title")` 형태로 변경하여, 구형 스키마와 신형 스키마를 모두 에러 없이 소화하도록 하위 호환성 강건화(Robustness) 처리.
- **교훈**: **외부 데이터 수집기(Collector)의 산출물 스키마가 변경될 때는 기존의 Dictionary Key 파서(`get("old_key")`)를 단순히 삭제·교체하지 말고, 파이썬의 `or` 체이닝을 통해 새로운 Key를 폴백(Fallback)으로 엮어두는 것이 안전하다.** 이렇게 하면 예측 불가능한 과거 데이터 혼재 상황에서도 파이프라인이 붕괴하지 않는다.

---

## 🟣 [2026-03-11] Ceph 파이프라인 구현 - Prisma 스키마 & 빌드 오류 교훈

### stage/[stageId]/route.ts 신규 vendor 매핑 누락 버그
- **문제**: Ceph 파이프라인 실행 후 "전처리 데이터 추출본"에 RedHat 패치가 표시됨.
- **원인**: `stage/[stageId]/route.ts`에 OS 제품(redhat/oracle/ubuntu)의 `productId → vendor` 매핑만 있고, `'ceph' → 'Ceph'` 케이스가 없어 `targetVendor === undefined`가 됨. 결과적으로 `WHERE` 절 없이 모든 벤더 데이터를 전부 반환.
- **해결**: `else if (productId === 'ceph') targetVendor = 'Ceph';` 한 줄 추가.
- **교훈**: **새 카테고리/제품 파이프라인 추가 시 `stage/[stageId]/route.ts`의 productId→vendor 매핑 테이블도 반드시 함께 업데이트해야 한다.** 이를 빠뜨리면 silent data leak(다른 벤더의 데이터가 섞여서 출력됨)이 발생. 체크리스트에 이 항목을 필수 항목으로 추가할 것.

### Prisma upsert Where 절 오류
- **문제**: 새 파이프라인에서 `PreprocessedPatch` 테이블에 upsert를 시도했지만 빌드 에러 발생.
  - 에러: `Type '{ issueId: any; }' is not assignable to type 'PreprocessedPatchWhereUniqueInput'`
- **원인**: `PreprocessedPatch` 모델의 `issueId` 필드에는 `@unique` 애노테이션이 없고, `@@index`만 있음. Prisma `upsert`의 `where` 절에는 `@unique` 또는 `@id` 필드만 가능.
- **해결**: `upsert` 대신 `deleteMany({ where: { vendor: 'Ceph' }})` + `createMany({ data: [...] })` 패턴으로 전환.
- **교훈**: **새 테이블에 upsert 쓰기 전 반드시 `schema.prisma`에서 해당 필드의 `@unique`/`@id` 여부를 먼저 확인할 것.** `@@index`는 upsert where에서 사용 불가.

### Prisma createMany skipDuplicates 호환성
- **문제**: `createMany({ ..., skipDuplicates: true })` 사용 시 타입 에러: `Type 'true' is not assignable to type 'never'`.
- **원인**: 현재 서버에 설치된 Prisma 버전이 `createMany`의 `skipDuplicates` 옵션을 지원하지 않음.
- **해결**: `skipDuplicates` 옵션을 제거. (이미 바로 위에서 `deleteMany`로 초기화했으므로 중복 문제 없음)
- **해결 방안 & 교훈**:
  - Prisma Adapter의 TimeType 규칙에 맞춰 `.strftime("%Y-%m-%d %H:%M:%S")` 로 명시적 포맷팅 적용 필수.
  - Optional `boolean` 컬럼이라도 Prisma 동작에선 에러가 나기 쉬우므로, 0 또는 1을 DB 쿼리에 명시하여 오류 차단.

### 전처리 필터링 원본 보존의 원칙 (Parsing vs Output)
- **상황**: 대시보드의 "상세 설명(Description)"이 너무 길어서 노이즈가 발생하여, 간략한 `overview` 필드 텍스트를 대체 출력해달라는 요구사항 발생.
- **실패 사례**: `patch_data["description"]`을 바꾸는 것 외에도, 상단에서 `combined_text` 키워드 스캐님에 쓰이는 `description` 변수까지 `overview`로 덮어씌움. 그 결과, `CRITICAL` 키워드들이 긴 본문에만 있고 `overview`에는 없는 패치들이 탈락하여 추출 개수가 17개에서 13개로 감소함.
- **해결 방안 & 교훈**: 키워드 판독 시에는 정보량이 많은 원본(full `description`, `body`)을 계속 스캔하도록 유지하되, **최종 UI/JSON 결과물에 매핑하는 Projection 단계(`record` dict 구성)**에서만 `overview`를 대입하여 두 계층(Parsing / Presentation)을 철저히 분리.

### OpenClaw 다중 패치 컨텍스트(세션) 격리 및 동시성 완벽 보장
- **문제**: 파이프라인(`queue.ts`)에서 `openclaw agent --session-id <고유번호>` 옵션을 주어 매 패치마다 격리된 세션을 생성하려 했으나, CLI 기본 동작 상 채널 세션 키(`agent:main:main`)로 동일하게 바인딩되어 단일 `.jsonl` 트랜스크립트 파일에 모든 패치의 기억과 컨텍스트 로그가 12MB 이상 누적(오염)되는 현상 발견.
- **원인 분석**: `--session-id` 플래그는 기본 CLI 채널 환경에서는 기존 세션을 덮어씌워버리는 경우가 발생하며, `/new` 명령어로 하드 리셋을 하거나 이전 `.jsonl` 파일을 물리적으로 삭제하지 않으면 컨텍스트(기억)가 분리되지 않고 연결됨. 그러나 OS 담당자와 스토리지 담당자가 파이프라인을 **동시에 실행할 경우**, 한 프로세스가 `.jsonl`을 삭제하면 다른 프로세스가 쓰기 중에 파일이 유실되는 심각한 **동시성 충돌(Race Condition)**이 발생함.
- **해결 방안 & 교훈**: AI 실행 및 파일 초기화 블록 전체를 **전역 파일시스템 Mutex 락 (`fs.mkdirSync('/tmp/openclaw_execution.lock')`)**으로 감싸서 단일 스레드로 직렬화 처리하도록 `queue.ts`를 개선. 이로써 여러 서버 Worker가 동시에 트리거되더라도 서로의 `.jsonl` 파일 삭제나 생성을 방해하지 않으며, 각 패치가 완벽한 '백지' 상태에서 리뷰를 진행함을 수학적으로 보장함 (할루시네이션 및 OOM 원천 차단).
- **교훈**: 반드시 서버에서 직접 편집하거나, 로컬 파일 → scp → 서버 빌드 검증 → scp 역방향 동기화 순서를 지킬 것. 로컬 편집 후 바로 GitHub 푸시는 절대 금지.

### 서버 우선 워크플로우 실수 반복 방지
- **실수**: 로컬에서 파일을 편집한 뒤 scp로 올리는 방식을 사용했음 (서버 우선 규칙 위반).
- **교훈**: 반드시 서버에서 직접 편집하거나, 로컬 파일 → scp → 서버 빌드 검증 → scp 역방향 동기화 순서를 지킬 것. 로컬 편집 후 바로 GitHub 푸시는 절대 금지.

---


- **배경**: 사용자가 명시적으로 요청. 이 규칙은 새 대화창에서도 0순위로 적용되는 Antigravity 코어 명령임.
- **규칙 1 — 서버 우선 수정 워크플로우**:
  - 모든 **코드 수정·검증·테스트는 서버(`tom26`, `172.16.10.237`)에서 수행**한다.
  - 로컬에서 파일을 직접 편집 후 서버에 올리는 방식은 금지.
  - 올바른 순서: ① 서버에서 코드 수정 → ② 서버에서 검증 (빌드/테스트) → ③ 검증 완료 후 `scp 서버→로컬`로 로컬 동기화 → ④ GitHub 즉시 반영
- **규칙 2 — GitHub 자동 업데이트 의무화**:
  - 코드가 수정·검증된 직후, **사용자의 별도 요청 없이 즉시** `git add . ; git commit -m "..." ; git push origin master` 실행.
  - 이 단계를 건너뛰는 것은 허용되지 않음.
- **규칙 3 — 수집기 스크립트 Source of Truth**:
  - 수집기(`rhba_collector.js` 등) 원본은 서버 `/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/redhat/`.
  - 로컬 동기화 경로: `patch-review-dashboard-v2/scripts/`.

---

### 2026-03-11 실패 사례: 파이프라인 실행 실패 - 스크립트 인수 불일치 및 RAG 경로 오류
- **문제**: 대시보드 UI에서 파이프라인을 실행하니 "[PIPELINE] Starting patch preprocessing & pruning..." 직후 파이프라인이 즉시 실패로 떨어짐.
- **원인 1 (argparse 인수 불일치)**: `queue.ts`에서 `patch_preprocessing.py`를 호출할 때 `--start-days 180 --end-days 90`이라는 존재하지 않는 인수를 전달. 스크립트는 `--days`만 지원하므로 argparse 오류로 즉시 종료. 이전에 날짜 필터링 로직을 바꾸다가 `queue.ts`의 호출부를 원복하는 것을 빠뜨린 **'반쪽 원복(Partial Revert)'** 실수였음.
- **원인 2 (query_rag.py 상대경로 오류)**: `queue.ts`에서 `query_rag.py`를 호출할 때 `../../../../pipeline_scripts/query_rag.py`라는 잘못된 상대경로를 사용. 실제 실행 컨텍스트가 이미 `linuxSkillDir`이므로 그냥 `query_rag.py`만 쓰면 됨.
- **해결 방식**: `--start-days 180 --end-days 90` → `--days 180`으로 수정하고, `query_rag.py` 경로도 단순화. SCP로 서버에 전송 후 npm 빌드 + PM2 재시작 완료.
- **교훈**:
  1. 파이프라인 스크립트와 해당 스크립트를 호출하는 TypeScript 코드(`queue.ts`)는 **항상 인수(argument)가 쌍으로 일치해야 함.** 파이썬 스크립트를 수정하거나 원복할 때는 `queue.ts`의 호출부도 반드시 함께 확인할 것. 한쪽만 바꾸는 것은 치명적이다.
  2. `exec()` 또는 `spawn()` 등으로 외부 스크립트를 호출할 때는 `cwd`(현재 디렉토리) 옵션이 설정되어 있다면, 경로를 다시 상대경로로 조합(`../../../../`)하지 말고 **파일명만 써도 됨**을 명심할 것.

### 2026-03-11 개선 사례: 전처리 스크립트 정확도 검증을 위한 Audit Log 도입 (수동 UI 검증의 안티패턴 탈피)
- **상황**: 사용자는 `patch_preprocessing.py`가 패치를 필터링하는 과정이 정확한지 의구심을 가졌고, 이를 위해 처음에는 제외된 패치를 조회하고 수동으로 추가/복구할 수 있는 거대한 'Preprocessing Verification UI' 웹 페이지를 기획하고 구현함.
- **실패(철회) 이유**: 파이프라인의 본질은 "기계적 자동화"인데, 매번 중간 단계에서 사람이 UI에 접속해 수천 개의 패치를 눈으로 검사하고 버튼을 눌러야만 다음 AI 리뷰 단계로 넘어가는 것은 파이프라인의 흐름을 끊는 병목 현상이자 **인력 낭비형 안티패턴(Anti-Pattern)**이었음. 사용자가 진정 원했던 것은 매번의 수동 개입이 아니라 **"단 한 번이라도 스크립트의 필터링 로직을 100% 신뢰할 수 있다는 확신"**이었음.
- **해결 방식**: 구축했던 수동 Verification UI 기능과 API 코드들을 전부 원복(Revert)함. 대신, 파이썬 스크립트 구동 시 조건문(`if ... continue`)에 의해 **탈락하는 모든 패치들의 ID, Vendor, 원인(Garbage Data, Severity Under Threshold 등), 세부 맥락을 `csv` 파일(`dropped_patches_audit.csv`)로 출력하는 Audit Log 시스템**을 스크립트 내부에 직접 주입함.
- **교훈**: 
  1. 자동화 스크립트의 신뢰도를 검증하기 위해 무거운 프론트엔드 UI를 구축하여 "Human-in-the-loop(사람 개입 보류)" 상태를 강제하는 것은 종종 배보다 배꼽이 더 큰 오버엔지니어링(Over-engineering)이다.
  2. 스크립트가 조용히 데이터를 버리게(Silent Drop) 두지 말고, 엑셀/CSV 형태로 명확한 **탈락 사유 보고서(Audit Log)**를 뱉어내게 만들면 개발자는 단 10초 만에 규칙이 제대로 작동했는지 전수 검사 확신을 얻을 수 있다. 투명성을 높이는 것이 UI를 만드는 것보다 파이프라인 아키텍처에서 훨씬 우아한 접근이다.

### 2026-03-11 개선 사례: 파이썬 파이프라인의 비결정론(Nondeterminism) 버그 해결
- **문제**: 파이프라인을 실행할 때마다 전처리 완료된 패치의 총 개수가 1~2개씩 미세하게 요동치는 비결정론적 증상 발생.
- **원인**: 
  1. **Hash Randomization**: 컴포넌트 이름을 추출할 때 `list(set(names))` 방식으로 중복을 제거했는데, 파이썬 3.3 이상부터 보안을 위해 도입된 해시 무작위화(Hash Randomization) 때문에 문자열의 길이가 같은 (`audit`과 `glibc`) 요소들이 들어왔을 때 추출 순서가 매 실행 시마다 달라졌음. 이 차이가 후속 단계의 병합(Aggregation) 로직에 나비효과를 일으켜 최종 개수를 틀어지게 함.
  2. **Glob Order**: `glob.glob("*.json")`은 디렉토리를 순회할 때 OS 인덱싱 상태에 의존하기 때문에 읽어들이는 파일의 순서가 항상 보장되지 않음.
- **해결 방식**: 무작위성이 개입할 수 있는 모든 배열/집합 평가식에 **`sorted()`** 내장 함수를 감싸주어(예: `sorted(glob.glob(...))`, `sorted(list(set(names)))`), 시스템 레벨에서 100% 알파벳 정렬이라는 결정론(Deterministic) 환경을 강제함.
- **교훈**: **안정적인 데이터 정제(Preprocessing) 파이프라인 구축 시에는, 해시(Set/Dict)와 파일 시스템 순회(Glob)의 순서가 무작위라는 사실을 항상 염두에 두고 철저하게 배열 정렬(Sort)을 사전 적용하여 멱등성(Idempotency)을 확보해야 한다.**

### 2026-03-11 개선 사례: AI 리뷰 결과물의 장황한 버그 픽스 내용 요약 강제
- **상황**: AI가 패치 리뷰를 수행하고 최종 결과(`patch_review_ai_report.json`)를 생성할 때, 원본 데이터에 포함된 너무 상세한 패키지 변경 기록이나 `.patch` 파일명들(`kvm-target-i386-*.patch`)을 `Description`에 원문 그대로 나열하는 문제가 있었음.
- **해결 방식**: AI 에이전트의 메인 프롬프트인 `SKILL.md`와 `PatchReview_MasterPrompt.md`의 제약 조건을 강화함.
  1. "Do NOT include raw lists of `.patch`... snippets." 금지 규칙 명문화.
  2. 프롬프트 내에 해당 패턴(.patch 나열)이 들어간 나쁜 예시(Bad 2)를 추가하여 오답임을 명확히 인지시킴.
- **교훈**: LLM에게 특정 포맷(요약)을 지시할 때는 "요약하라"는 긍정 지시문 외에도, **원치 않는 특정 패턴(로우 로그, 특정 확장자 등)을 명시적으로 금지(Do NOT)**하고 **나쁜 예시(Bad Example)를 시각적으로 직접 주입**하는 네거티브 프롬프팅이 병행되어야만 출력 포맷 붕괴를 확실히 막을 수 있다.

### 2026-03-11 통계 불일치 (캐시 파편화) 사례: 파이프라인 재시도 시 DB 동기화 누락
- **문제**: "Retry Failed" (실패 재시도) 버튼을 눌러 파이프라인을 재개했을 때, Ubuntu 패치의 AI 리뷰 완료 건수가 9건으로, 전처리 완료 건수(4건)보다 비정상적으로 높게 출력됨. 이 9건에는 이전 세션들의 불필요한 패치들이 섞여 있었음.
- **실패 이유**: 기존 `api/pipeline/run/route.ts` API에서 `(!isAiOnly && !isRetry)` 조건을 걸어두는 바람에, 재시도를 할 땐 `ReviewedPatch` 데이터베이스(최종 결과 테이블)가 초기화되지 않고 스킵되었음. 하지만 이후에 실행되는 후속 파이썬 스크립트(`patch_preprocessing.py`)는 **무조건 자체적으로 `PreprocessedPatch` (전처리 테이블)를 비우고 다시 채우도록 작성**되어 있었음. 결국 앞쪽 테이블(전처리)은 리셋되어 4건인데 뒤쪽 테이블(최종 결과)은 리셋되지 않고 5건이 잔류해있다가 새 4건이 누적합산되어 9건으로 뻥튀기 된 것임.
- **교훈**: 
  1. 분산된 스크립트 아키텍처(Next.js 라우터 -> BullMQ 큐 -> Python 스크립트)에서 **상태 (State) 초기화**를 설계할 땐, 한 파츠라도 비우면 연관된 파츠도 무조건 같이 비우는 **All-or-Nothing (원자적) 동기화 원칙**을 지켜야 함.
  2. "재시도(Retry)"라는 논리적 이름에 속지 말고, 그 재시도가 트리거하는 백그라운드 스크립트가 내부적으로 데이터를 덮어쓰는지(upsert) 아니면 통째로 갈아엎는지(delete-all) 반드시 코어 코드를 뜯어보고 흐름을 맞출 것.

### 2026-03-11 실패 사례: SSE 스트림 이벤트 오버라이딩에 의한 UI 멈춤 (진행 상태 숨김)
- **문제**: "Run Pipeline"를 실행 시 "Job queued... Waiting for worker..."라는 메시지만 떠 있고 AI 분석이 진행되는 세부 로그(`[AI Analysis]`)가 메인 메시지 창에 뜨지 않음(멈춘 것처럼 보임). 게다가 BullMQ 큐에 죽은 워커의 Job들이 쌓여 실제로 데드락이 됨.
- **실패 이유**: 
  1. 프론트엔드(`ProductGrid.tsx`)의 SSE 기반 이벤트 리스너가 들어오는 데이터에 `streamData.log`가 존재함에도 불구하고, 무조건 하단의 `streamData.status === 'active'` 분기 조건을 동시에 만족시켜서 `"Pipeline active..."`라는 기본 상태 메시지가 방금 들어온 의미있는 AI 로그를 즉시 덮어씌워버렸기 때문.
  2. 이전 실패 혹은 테스트 등으로 백그라운드 `openclaw` 워커가 끝나지 않고 무한 대기 상태로 고착되어, 신규 파이프라인 Job들이 BullMQ에서 `waiting` 상태로 적체되어 있었음.
- **교훈**: 
  1. 분기 처리가 복잡한 프론트엔드의 실시간 이벤트 스트림 리스너를 설계할 때는, **메시지 출력의 우선순위**를 확실히 하여 특정 조건(`streamData.log` 형태의 구체적 산출물)이 존재할 땐 일반적인 Heartbeat/상태(status) 문자열 업데이트 분기가 실행되지 않도록(`!streamData.log` 조건 추가 등) 철저한 배타적 설계(Mutually Exclusive)를 적용해야 함.
  2. 서버 백그라운드 Job Queue(Redis/BullMQ) 기반 아키텍처에서 알 수 없는 뻗음(Stuck) 현상이 발생하면 프론트엔드 고장만 의심하지 말고 즉각 `redis-cli keys 'bull:*' | xargs -r redis-cli del` (또는 flush)와 `pm2 restart` 콤보를 먹여 서버 자원을 정리하는 훈련을 습관화할 것.

### 2026-03-11 실패 사례: 파이프라인 UI 진행 상태 복구 누락 및 포트 정보 오기
- **문제**: 파이프라인 실행 중 대시보드를 이탈했다가 돌아오면 진행 상태(UI 로그 스트림)가 초기화되어 사라지는 문제 발생. 또한, 서비스 포트를 3000번으로 착각함.
- **원인 및 해결 방식**: 기존에는 프론트엔드가 `/api/pipeline` 엔드포인트에서 단순히 Mock 데이터를 받아왔거나, 상태 관리가 로컬 `useState`에만 머물러 페이지 이동 시 증발함. 서버 측에서 실제 BullMQ 큐(`pipelineQueue.getActive()`, `getWaiting()`)를 조회하여 현재 활성화된 `jobId`를 반환하도록 `/api/pipeline` 수정 후 프론트엔드 마운트 시 체크하도록 보강함.
- **필수 인프라/환경 정보 기록**:
  - **대시보드 V2 포트**: 기존 3000번 대신 **3001번 포트**를 사용하므로 항상 유의할 것. (예: `http://172.16.10.237:3001`)
### 2026-03-11 자기 반성 및 실패 사례: 기존 교훈 반복 누락 (터미널 환경 및 SSH 이스케이프)
- **문제**: 과거에 이미 `LEARNED.md`에 기록했던 터미널/SSH 관련 실수들을 작업 도중 무의식적으로 반복하여 여러 차례 명령어 오류를 유발함.
  1. 원격지 빌드/실행을 담당해야 할 명령을 로컬 윈도우 쉘에서 `npm run build`, `curl.exe` 등으로 바로 시도하여 실패.
  2. SSH 인라인으로 `npx pm2 status`를 NVM 로드(`source ~/.nvm/nvm.sh`) 없이 날려 `command not found` 발생.
  3. 복잡한 JSON 매개변수를 SSH 내부 인라인 `curl -d '{\"key\":\"val\"}'` 스크립트로 욱여넣으려다 윈도우 파이프라인 충돌로 파싱 에러(Bad escaped character) 발생.
- **실패 이유**: 직전 세션들에서 정리된 원칙들을 숙지했으나, 빠른 실행에 집중하다 보니 "현재 위치한 Cwd가 로컬 Windows인지 원격 Linux인지"를 사전에 꼼꼼히 점검하지 않았고, 명령어 실행 시 방어적 코딩 습관을 적용하지 못함.
- **교훈 및 강력한 행동 지침**:
  1. **[실행 쉘 확인 의무화]**: `run_command` 도구를 호출하기 전, 무조건 1초간 멈춰 대상 호스트와 쉘 환경이 어디인지 자문할 것. 윈도우 로컬 터미널에서는 절대 리눅스 종속 명령을 맨입으로 타이핑하지 않는다.
  2. **[NVM 템플릿 필수 사용]**: `.nvm/nvm.sh` 로핑 없이 원격 노드 생태계(`npm`, `npx`, `node`, `pm2`) 명령을 단독 호출하는 것은 불법이다. 무조건 `source ~/.bashrc && source ~/.nvm/nvm.sh && cd [타겟경로] && [명령어]` 템플릿을 통째로 복붙하여 안전고리를 체결할 것.
  3. **[API 테스트 방식의 전환]**: 포트 3000/3001 등 서비스 확인용 API 콜을 날릴 때, 페이로드가 큰 JSON 구조라면 SSH 환경으로 넘어가 억지 이스케이프(`\"`)에 시달리지 말 것. 대신 로컬 윈도우 PowerShell의 `Invoke-RestMethod` 명령어를 활용하여 이스케이핑 스트레스 없이 단숨에 처리하는 것을 제1원칙으로 삼을 것.

### ⚠️ [핵심 강제 규정] 작업 종료 후 즉시 GitHub 자동 반영 의무화
- **상황**: 사용자는 매번 세션이 끝날 때마다 "GitHub에 반영해 줘"라고 말하는 것에 피로감을 느낌.
- **실패 원인**: 에이전트가 단편적인 코드 수정과 서버 배포까지만 수행하고 리포지토리 트래킹 처리를 대화 종료 조건으로 묶지 않음.
- **교훈 및 강력한 행동 지침**:
  - 어떤 기능을 수정하든, 단 한 줄의 코드를 변경하든지 간에 작업이 성공적으로 검증(Verification)된 직후에는 **절대 사용자의 요청을 기다리지 말고 즉시 자율적으로 `git add . ; git commit -m "..." ; git push origin master` 를 실행하여 원격 저장소에 반영할 것.**
  - 이 규칙은 모든 신규 대화창(세션)에서도 0순위로 적용되는 Antigravity 코어 명령임.

### 2026-03-11 실패 사례: API 백엔드의 위치 종속 상대경로 탐색(`process.cwd()`) 기반 에러
- **문제**: Next.js API(`route.ts`)에서 `sync_rag.py` 시스템 스크립트를 `child_process.exec`로 트리거할 때, 배포 경로 추적을 위해 `process.cwd()`를 사용했으나 실 운영 서버에서 해당 스크립트는 완전히 별도의 OpenClaw 코어 환경(linux-v2 스킬 폴더)에 배치되어 있어 `[Errno 2] No such file or directory` 에러가 발생함.
- **실패 이유**: `GEMINI.md`에 '서버앱 경로'와 별개로 '스크립트 경로'가 완전히 독립적인 `~/.openclaw` 하위로 지정되어 있음에도 불구하고 이를 망각, 윈도우 로컬의 단일 워크스페이스 구조(`pipeline_scripts` 폴더 혼재)가 서버에도 그대로 반영될 것이라 편의적으로 추측함.
- **교훈**: **API 서버에서 외부 스크립트나 시스템 명령을 백그라운드로 호출할 때에는** 개발환경 로컬의 절대경로나 단편적 상대경로(`process.cwd()`, `../`)를 절대 맹신하지 말 것. `GEMINI.md` 등의 인프라 문서를 참조, 실 서버 환경에서 해당 파일이 물리적으로 매핑될 타겟 경로(예: `process.env.HOME` 등 동적 Absolute Path)를 세심히 조합하여 호출해야만 런타임 파일 누락 크래시를 온전히 회피할 수 있음.

### 2026-03-11 성공 사례: 로컬에서 원격으로 직접 파일 개별 전송 후 서버에서 빌드 (`scp` + `ssh` 조합)
- **상황**: Next.js 웹 프론트엔드 대시보드에서 신규 기능(전처리 목록 검색)을 추가한 후 서버에 반영함.
- **성공 요인**: 이전 `LEARNED.md`의 교훈들을 정확히 적용하여:
  1. 원격에서 수정하지 않고 로컬 환경에서 코드를 작성한 후, `scp src/.../ClientPage.tsx citec@172.16.10.237:/tmp/...` 로 임시 전송.
  2. `ssh citec@... "mv /tmp/... /home/citec/.../ClientPage.tsx"` 파이프라인으로 안전하게 덮어쓰기.
  3. 로컬 윈도우쉘에서 `npm run build`를 구사하는 우를 범하지 않고, 전송 직후 곧바로 `ssh citec@... "source ~/.bashrc && source ~/.nvm/nvm.sh && cd ... && npm run build && npx pm2 restart all"` 템플릿을 차용하여 단 한 번의 스크립트 에러 없이 배포를 완료함.
- **결론**: 안전한 `scp`를 통한 파일 이동 방식과, 원격 `ssh` 인라인 환경 변수 로딩의 시너지가 입증되었으므로 현재의 배포 Workflow를 변동 없이 유지할 것.

## Google Antigravity 개발 중 주요 교훈 모음

### 2026-03-04 실패 사례: 로컬 Windows 환경에서의 Node.js(npm) 의존성 설치 실패
- **문제**: 로컬 PC의 대시보드 프로젝트 구조에서 `npm install` 실행 시 `'npm' is not recognized as an internal or external command` 에러 발생.
- **실패 이유**: 현재 로컬 Windows 환경에는 Node.js 런타임 및 npm 전역 변수가 설치/설정되어 있지 않음.
- **교훈**: 앞으로 Next.js 프론트엔드 대시보드와 관련된 **모든 패키지 설치(`npm i`) 및 구동(`npm run dev`)은 반드시 로컬 쉘에서 시도하지 말고, 코드를 `tom26` 원격 리눅스 서버로 복사(`scp`)한 뒤 원격 SSH 환경 안의 NVM(Node.js)을 통해 실행**해야 함.
### 2026-02-27 실패 사례: 원격 서버(tom26) 배포 중 Git 연결 부재 처리 방식
- **문제**: 수정된 로컬 코드를 실서버(`tom26`)에 반영하기 위해 `ssh <host> "git pull"`을 시도했으나, 원격 환경에 origin 추적 정보가 설정되어 있지 않아 `fatal: 'origin' does not appear to be a git repository` 오류가 발생함.
- **실패 이유**: 로컬에는 Git 환경이 잘 구축되어 있었지만, 배포 타겟인 원격 서버 디렉토리는 그저 파일만 복사된 상태였으며 Git Tracking이 잡혀있지 않았음.
- **교훈**: 원격 서버의 Git 환경에 대한 100% 확신이 없다면 억지로 SSH 상에서 Git을 구성하려고 낭비하기보다, **`scp -r` 명령어를 활용하여 로컬에서 원격으로 직접 폴더 동기화 전달**하는 것이 빠르고 안전하며 확실한 배포 수단임을 잊지 말 것.

### 2026-02-27 실패 사례: 백엔드 API의 파일 포맷 불일치로 인한 빈 CSV 생성 이슈
- **문제**: 담당자가 패치 리뷰를 승인(DONE) 처리했을 때, 다운로드 가능한 형태의 `final_approved_patches_[prod].csv` 파일이 항목명(헤더)만 존재하고 데이터가 하나도 매칭되지 않은 채 텅 빈 상태로 생성됨.
- **실패 이유**: 기존 API(`api/pipeline/finalize/route.ts`)가 결과 데이터를 만들기 위해 읽어들인 원본 파일이 최종 결과물인 CSV(`patch_review_final_report.csv`)가 아니라, 리뷰 전 단계의 포맷(`patches_for_llm_review.json`)이었음. 이 두 파일은 서로 Object Key 스키마 대소문자 (ex: `Issue ID` vs `id`) 및 데이터 구조가 달랐기 때문에 `filter` 함수에서 조건에 맞는 패치를 찾지 못하고 빈 배열을 반환해버림.
- **교훈**: 
  1. 데이터를 추출 및 가공할 때는 **"가장 정보 손실이 적고 풍부한 최종 원본 소스를 직접 타겟팅(Source of Truth)"**하여 파싱해야 함. 결국 PapaParse 라이브러리를 통해 AI의 최종 아웃풋인 CSV를 통으로 불러와 다시 파싱하는 방향으로 리팩토링함.
  2. 서버에 저장되는 파일명 및 키(`Key`) 값에 대한 확신이 없을 때에는 반드시 사전에 `cat` 또는 `jq` 명령어를 이용해 서버의 실제 데이터 형태를 한 번 들여다보고 코드를 작성할 것. (절대 추측으로 JSON 스키마를 단정짓지 말기)

### 2026-02-28 실패 사례: `git clean`에 의한 로컬 다국어(i18n) 번역 데이터 유실
- **문제**: 폴더명의 오타나 찌꺼기 파일을 지우기 위해 `git clean -fd`와 `git reset --hard`를 무심코 사용했다가, 직업 중이던 `src/lib/i18n.ts` 다국어 딕셔너리에 기입했던 수십 줄의 번역 데이터가 모두 날아감.
- **실패 이유**: Git Tracking에 추가되지 않았거나, 커밋되지 않은 상태의 작업물들이 하드 리셋 대상에 포함되었음을 인지하지 못함.
- **교훈**: **파괴적인 명령어(`reset --hard`, `clean -fd`, `rm -rf`)를 사용할 때에는** 절대 습관적으로 날리지 말고, 먼저 `git status`나 `git diff`를 통해 실수로 날아갈 수 있는 코드가 있는지 **두 번 세 번 검토한 후 실행**할 것.

### 2026-02-28 실패 사례: Next.js App Router 동적 라우팅 폴더 이름 충돌 (`[id]` vs `[categoryId]`)
- **문제**: `/category/[categoryId]/[productId]` 형태의 경로를 설계하는 도중, 실수로 과거에 쓰던 빈 `[id]` 폴더가 `[categoryId]` 폴더 옆에 같이 원격 배포되어 Next.js 빌드가 Crash됨. (`Error: You cannot use different slug names for the same dynamic path.`)
- **실패 이유**: 로컬 워크스페이스 상에서 이름만 바꾼 뒤, `scp`로 단순히 폴더를 덮어씌웠기 때문에 원격 톰캣 서버에는 이전 폴더(`[id]`)가 그대로 남아서 라우팅 로직이 2개가 되어버림.
- **교훈**: 파일질라 수준의 `scp` 복사는 찌꺼기를 지워주지 않는다. 프로젝트 구조가 바뀔 때에는 원격지의 기존 `src` 혹은 타겟 폴더를 **아예 `rm -rf`로 깔끔히 비운 뒤 새로 통째로 전송**하는 것이 가장 깨끗하고 안전한 빌드 보장 방식임.

### 2026-02-28 실패 사례: 백그라운드 파이프라인 재시작 시 과거 결과물 미삭제 (캐시형 버그)
- **문제**: "Run Pipeline(파이프라인 실행)" 버튼을 다시 눌러도 기존의 "Approved(최종 승인됨)" 패치 개수나 UI 배지가 여전히 남아있었음.
- **실패 이유**: 파이프라인을 재시작할 때 중간 데이터들(`batch_data`, `patches_for_llm_review.json`)은 백업 아카이브 폴더로 잘 비워주도록 코딩했으나, 정작 **가장 마지막에 생성되는 `final_approved_patches_[prod].csv` 제품별 승인 파일은 아카이브 대상으로 빼먹었기** 때문.
- **교훈**: 백엔드에서 초기화 로직을 짤 때는, **시스템 파이프라인 워크플로우를 완벽히 처음부터 끝까지 추적**하여 단 하나의 파일이라도 유령처럼 남아있지 않는지 교차 검증해야 함.
### 2026-03-03 실패 사례: 원격 SSH 환경 변수(Path) 누락에 의한 명령어 실행 실패 (npm, node, pm2)
- **문제**: 원격 배포 및 서버 재시작을 위해 `ssh citec@host "npm run build"` 또는 `node`, `pm2` 명령어를 사용했을 때 `command not found` 에러 발생. (사용자 제보 에러 유형 1, 4, 7)
- **실패 이유**: SSH로 원격 서버에 비대화형(non-interactive) 접속 시, 로그인 쉘에 존재하는 환경 변수(`.bashrc`나 NVM 경로)가 로드되지 않기 때문에 전역 명령어를 찾지 못함.
- **교훈**: 원격 머신에서 노드 생태계 명령어를 실행할 때에는 반드시 `source ~/.nvm/nvm.sh`를 체인의 맨 앞에 붙여주거나, 명령어 자체의 **절대 경로**(`/home/citec/.nvm/versions/node/v.../bin/npm`)를 명시적으로 호출할 것.

### 2026-03-03 실패 사례: PowerShell과 `scp` 호환성 문제 (경로 및 특수 기호 파싱 오류)
- **문제**: Next.js App Router의 동적 라우팅 폴더 구조인 `[id]`, `[categoryId]`가 포함된 경로로 `scp` 전송 시, `No such file or directory` (사용자 제보 에러 유형 2, 3) 발생.
- **실패 이유**: Windows PowerShell 환경에서 `scp`를 구동할 때 대괄호(`[]`)를 와일드카드로 자동 해석하려다 원격지 대상 경로를 깨뜨려버림 (`//[id/]/`).
- **교훈**: **PowerShell 단에서 대괄호가 포함된 파일이나 디렉토리를 원격으로 넘길 때는 절대 그대로 보내지 말 것.** 안전한 단일 파일명(예: `route_temp.ts`)으로 1차 전송한 후, `ssh` 접속을 통해 2차적으로 `mv`하여 완벽한 경로로 원상 복구시키는 안정적인 우회 스킬을 습관화할 것.

### 2026-03-03 실패 사례: PowerShell에서의 `ssh` 백틱(`$()`) 명령어 치환 오류
- **문제**: 원격 서버의 프로세스 강제 종료를 위해 `ssh citec@host "kill -9 \$(lsof -t -i:3000)"`을 전송했으나, `lsof`를 찾지 못하거나 엉뚱한 로컬 윈도우 환경에서 실행되려고 시도함. 혹은 따옴표로 감싸 구문 오류가 발생함. (사용자 제보 에러 유형 5, 6)
- **실패 이유**: PowerShell은 겹따옴표(`""`) 내부의 `$()` 구문을 먼저 파싱하려 시도하므로, 원격 서버(리눅스)로 스크립트가 온전히 전달되지 않음. 단일 따옴표(`''`)를 사용하더라도, 포트 점유가 없을 때 `lsof`가 아무것도 반환하지 않으면 `kill -9 ""`이 되어 구문 오류(`kill: usage: ...`) 발생.
- **교훈**: 
  1. 리눅스 외부 명령어 중첩(`$()`)을 포함하는 스크립트를 SSH로 넘길 때는 겹따옴표(`""`) 대신 반드시 **단일 따옴표(`''`)**로 감싸서 로컬 윈도우 쉘의 사전 개입 조작을 원천 차단할 것.
  2. `kill` 등 민감한 파이프라인 명령을 넘길 때는 대상의 반환값이 공백일 수 있음을 유념하여 `kill -9 $(lsof -t -i:3000) 2>/dev/null || true` 와 같이 방어적 파이프라인 코딩을 구성할 것.

### 2026-03-03 실패 사례: PowerShell에서의 명령어 체인 연결자(`&&`) 문법 오류
- **문제**: 일괄적인 Git 조작을 위해 `git add . && git commit -m "..." && git push` 명령어를 실행했으나, `The token '&&' is not a valid statement separator in this version.` 구문 오류(ParserError) 발생. (사용자 제보 에러 유형 8)
- **실패 이유**: 일반적인 Linux Bash, Windows CMD 또는 최신 PowerShell 7버전에서는 `&&`를 명령어 체이닝(앞 스크립트가 성공했을 때 뒤 스크립트를 실행) 용도로 지원하지만, 하위 버전의 기본 Windows PowerShell(V5 등)에서는 `&&` 토큰을 지원하지 않고 구문 분석 오류를 뱉어냄.
- **교훈**: 호환성을 보장해야 하는 로컬 Windows PowerShell 환경에서 여러 명령어를 한 줄에 이어서 실행할 때에는 `&&` 대신 안전하게 **세미콜론(`;`)**을 구분자로 사용할 것. (예: `git add . ; git commit -m "..." ; git push origin master`)

### 2026-03-03 실패 사례: Node.js 구버전(v20) 탑재로 인한 모듈 `SyntaxError` (특정 문법 미지원)
- **문제**: 원격 서버 터미널에서 `openclaw` 명령어를 수행했을 때, `import { enableCompileCache } from "node:module";` 구문에서 `SyntaxError`가 발생하며 스크립트가 크래시 됨. (사용자 제보 에러 유형 9)
- **실패 이유**: `openclaw` 최신 버전(2026.3.1)은 컴파일 속도 최적화를 위해 Node.js **v22.12.0** 이상에서만 지원되는 `enableCompileCache` 시스템 모듈을 사용함. 하지만 접속해 있는 현재 SSH 세션의 활성 Node 버전이 구버전인 **v20.20.0**으로 잡혀있었기 때문에 문법 에러가 터짐. (이전에 NVM 기본 포인터를 `v22`로 업데이트 했더라도, 이미 세션 프로필 로딩이 완료된 **열려있는 기존 터미널**에는 실시간으로 적용되지 않음)
- **교훈**: `nvm alias default` 등으로 로컬 또는 서버의 글로벌 NVM/경로 설정을 업데이트한 뒤에는, 반드시 **새로운 터미널(SSH) 탭을 열어서 다시 접속**하거나 현재 세션 창에서 수동으로 `nvm use v22.22.0`를 명시해 주어야 변경된 노드 엔진이 온전히 적용됨을 기억할 것.

### 2026-03-03 오류 분석 및 추가 교훈 (Error Types 10~19)

#### 1. PowerShell 명령어 체이닝 (`&&`) 불가 에러 (에러 11, 18, 19)
- **문제**: 로컬 터미널에서 `scp ... && ssh ...` 또는 `git add . && git commit ... && git push` 시도 시 `The token '&&' is not a valid statement separator` 오류 발생.
- **교훈**: PowerShell 환경에서는 `&&` 구문이 동작하지 않으므로, 여러 명령어를 순서대로 실행할 때에는 반드시 세미콜론(`;`)을 사용하거나, 성공 여부에 따른 분기가 필요할 경우 `If ($?) { ... }` 제어문을 활용할 것.

#### 2. 원격 SSH 비대화형 쉘 환경 변수 누락 (에러 10, 12)
- **문제**: `ssh citec@... "npm run build"` 또는 `"node batch_collector.js"` 명령을 전송했을 때 `command not found` 에러 발생.
- **교훈**: 비대화형 SSH 세션에서는 `.bashrc`가 자동으로 로딩되지 않음. `node`나 `npm` 생태계 명령어가 필요할 땐 언제나 명령어의 가장 앞에 `source ~/.nvm/nvm.sh && `를 삽입하여 NVM 환경을 명시적으로 로드하는 습관을 들일 것.

#### 3. PowerShell -> SSH 커맨드 인젝션 이스케이핑 충돌 (에러 13, 14, 17)
- **문제**: PowerShell 문자열 파싱과 Bash의 이스케이프 처리가 충돌하여 `grep: Trailing backslash`, `unexpected EOF while looking for matching '"'` 같은 오류가 발생.
- **교훈**: 로컬 PowerShell 터미널 창에서 다수의 따옴표, 파이프라인(`|`), 이스케이프(`\`, `$`) 문자가 얽힌 복잡한 Bash 명령어를 원격 서버로 곧바로 전송(SSH)하는 것은 매우 위험함. 대신 원격 쉘 내부에 스크립트 파일을 만들어서 동작시키거나, 굳이 한 줄로 구사해야 한다면 가장 바깥 문자열을 단일 따옴표(`'`)로 감싸 로컬 쉘의 문자열 변환 개입을 원천 차단해야 함. 또한 파일 확장자 글로빙(`*.json`)이 실패할 수 있으니 `ls` 혹은 `파일 존재 여부`를 사전에 명확히 할 것.

#### 4. API 반환값에 대한 JSON 맹신에 따른 파싱 크래시 (에러 15, 16)
- **문제**: 외부 API 통신(`curl`, `playwright json()`) 후 결과값을 검증 없이 곧바로 `jq .`에 물려주거나 `JSON.parse()`를 시도하다 구문 분석 에러(`Invalid numeric literal`, `Unexpected token 'Q'`) 발생.
- **교훈**: 방화벽 차단이나 잘못된 파라미터로 인해 원격 서버가 온전한 JSON 형태가 아닌 HTML 오류 페이지나 텍스트를 뱉는 상황이 허다함. 즉각적인 파싱 파이프라인으로 엮기 전에 변수에 값을 일단 저장하고 상태 코드를 검사하거나 눈으로 확인하는 "사전 텍스트 검증 로직"을 추가하여 안전을 도모할 것.

#### 5. 로컬 스크립트 생성 시 PowerShell 기본 인코딩(UTF-16LE) 문제 (에러 7, 10)
- **문제**: PowerShell에서 `echo '...' > script.sh` 로컬 명령으로 파일을 만든 뒤 `scp`로 전송하면, 원격 리눅스에서 `cannot execute binary file` 혹은 파이썬 `SyntaxError: Non-UTF-8 code starting with '\xff'` 오류가 발생.
- **교훈**: Windows PowerShell의 기본 출력 파이프 리디렉션(`>`)은 UTF-16LE(BOM 포함) 포맷을 사용하므로 리눅스 스크립트 생태계와 절대 호환되지 않음. 파일 작성은 AI 전용 도구(`write_to_file`)를 사용하거나, 터미널에서 스크립트를 작성해야 한다면 무조건 **원격 SSH 접속 내부에 진입한 뒤 리눅스 자체 쉘에서 `cat << 'EOF' > file.sh`** 방식으로 생성할 것. `dos2unix` 같은 패키지가 실서버에 설치되어 있지 않을 리스크도 회피할 수 있음.

#### 6. 복잡한 페이로드 (JSON / 매개변수) SSH 인라인 전송 금지 (에러 2, 3, 4, 5, 6, 9)
- **문제**: `curl -d '{"category": "os"}'` 나 `python3 -c "{'key': 'val'}"` 처럼 중괄호(`{}`)와 겹따옴표(`"`)를 띄우는 명령을 PowerShell -> SSH 방향으로 인라인(한 줄) 실행 시, JSON 포맷이 깨지거나 `Unexpected token` 구문 오류 발생.
- **교훈**: Windows PowerShell은 문자열 내의 `{}` 기호를 내부 변수 블록으로 해석하려 들며, 따옴표의 중첩 파싱 로직이 Bash와 충돌하여 페이로드를 조작해버림. 복잡한 JSON 데이터가 들어가는 `curl`이나 Python One-liner 코드는 **절대로 `ssh user@host "..."` 문자열 중간에 욱여넣지 말 것.** 앞선 교훈(5)처럼 완전히 분리된 구동 가능한 스크립트(`.sh`, `.js`)를 원격망에 파일로 먼저 안착시킨 뒤 호출(Call)하는 방식으로 우회해야 파싱 훼손을 100% 막을 수 있음.

#### 7. 글로벌 NVM 패키지(pm2) 동적 경로 추적 (에러 1)
- **문제**: `source ~/.bashrc && pm2 restart` 나 하드코딩된 특정 노드 경로(`/v22.22.0/bin/pm2`)를 호출했을 때 `command not found` 발생.
- **교훈**: 비대화형 SSH에서는 `.bashrc` 로드 명령이 기본적으로 무시됨. 게다가 `pm2` 같은 전역(global) 데몬 패키지가 내가 추정한 노드 버전(`v22.22.0`)이 아니라 다른 버전(`v20.20.0`) 환경에만 종속 설치되어 있을 경우 절대경로 하드코딩 기법도 소용없어짐. NVM 생태계 내에서 특정 바이너리를 안전히 찾으려면 `find ~/.nvm -name 'pm2' -type f -executable | head -n 1 | xargs -I {} {} restart ...` 처럼 **동적으로 실행 파일을 찾아 곧바로 파이프라인으로 연결**하는 기법을 활용할 것.

#### 8. Playwright 빈 URL(Empty String) 네비게이션 크래시 방어 (에러 11)
- **문제**: `page.goto("")` 처럼 크롤러가 불량한(비어있는) URL 변수를 물고 접속을 시도할 때 `Protocol error (Page.navigate): Cannot navigate to invalid URL` 예외를 뱉으며 워커가 사망.
- **교훈**: 웹 돔 파서(DOM Parser)나 정규식이 URL을 100% 온전하게 찾아낼 것으로 맹신하지 말 것. Playwright로 `goto()`를 호출하기 전에는 반드시 대상 URL이 `http` 프로토콜을 포함한 유효한 문자열인지 사전에 검사(`if (!url || !url.startsWith("http"))`)하는 입력값 검증(Sanitization) 방어 로직을 필수적으로 장착해야 함.


---
(이하 이전 기록)
### 2026-02-25 실패 사례: 원격 SSH 연속 명령어 실행 실패
- **문제**: `ssh user@host "cd /path && ls"` 형태의 명령어를 실행하려 했으나 `cd` 명령어가 실패함.
- **실패 이유**: 윈도우 환경 구조, 그리고 인용부호(`"`) 처리 미흡으로 인해 서버 측에서 하나의 체인 형태의 명령어로 온전히 전달되지 않았음.
- **교훈**: 복잡한 체인 명령어보다는 **단일 명령어로 분리해서 여러 번 실행**하거나, 서버에 **미리 스크립트를 만들어두고 그것을 호출하는 방식**을 가장 우선적으로 고려할 것.

### 2026-02-25 실패 사례: Git 연동 실패와 설정 누락
- **문제**: GitHub 리모트 연결 전에 `git init` 과정이나 계정 설정(`user.name`, `user.email`)이 누락되어 Commit, Push 명령이 연속적으로 실패함.
- **실패 이유**: 프로젝트가 깃허브에 연결될 준비와 환경변수가 제대로 갖춰져 있는지 기본부터 확인하는 작업을 생략하고 Push를 성급하게 시도함.
- **교훈**: 어떤 리포지토리에 작업을 하든 항상 **최초 `git status`, `git config -l`**를 먼저 날려보고 베이스라인을 확인할 것.

#### 9. Red Hat CSAF API 벌크 재생성 속임수 확인 (최신의 에러 및 데이터 폭증)
- **문제**: Red Hat의 changes.csv 변경 알림 스트림은 timestamp(수정일)만 주는데, Red Hat이 수천 개의 옛날 패치를 일괄로 벌크 재생성하면서 전체 트래픽에 엄청난 과부하가 걸리는 현상이 발생.
- **교훈**: 타사의 업데이트 스트림에서 "파일 수정일" 자체는 언제든 구조만 바뀌면 갱신되므로 신뢰해선 안 된다. changes.csv 타임스탬프만 믿지 말고, CSAF JSON 파싱 직후에 존재하는 document.tracking.initial_release_date (실제 발행일) 기반으로 날짜를 한번 더 필터링해주는 방수로 2중 보완을 설정할 것.

#### 10. PowerShell 로컬 명령어와 원격 파일 시스템 혼동 (에러 타입 1)
- **문제**: 원격 테스트 결과를 보려고 터미널(PowerShell)에서 무심코 `cat /tmp/RHSA-2026-3488.txt`를 실행했으나 `C:\tmp\...` 경로를 찾을 수 없다는 로컬 오류가 발생함.
- **교훈**: 현재 터미널이 로컬 Windows 터미널인지 원격 SSH 터미널인지 명확히 인식해야 함. 윈도우 호스트 쉘에서 리눅스 원격 파일을 열람할 때는 반드시 `ssh citec@host "cat /tmp/... "`처럼 SSH 명령으로 래핑(wrapping)해서 실행할 것.

#### 11. SSH 멀티라인 리디렉션 시 따옴표 탈출(Escape) 증발 현상 (에러 타입 2)
- **문제**: PowerShell을 거쳐 SSH로 파이썬 스크립트를 생성(Heredoc)할 때 파이썬 코드 내부의 `\"MISSING\"` 문자열 이스케이프가 PowerShell 파서에 의해 소실되어, 최종 리눅스 측 파이썬 파일에서는 겹따옴표가 깨진 구문 오류(`unterminated string literal`)가 발생.
- **교훈**: Windows 쉘을 관통하여 멀티라인 코드를 생성할 때는 겹따옴표 탈출(`\"`) 사용을 극도로 피해야 함. 파이썬 코드 원문 내에서는 홑따옴표(`'`)만 쓰거나 포매팅을 우회하고, 근본적으로는 로컬에서 완성된 스크립트 파일을 만들어 `scp`로 안전하게 넘기는 방식이 데이터 무결성에 100% 안전함.

#### 12. PowerShell 인라인 명령 줄 내 대괄호(`[]`) 파서 충돌 (에러 타입 3)
- **문제**: `ssh ... "python3 -c \"... [print(...)] ...\""` 구문 실행 시 리눅스로 가기도 전에 로컬 윈도우 쉘에서 `Array index expression is missing` 등 대규모 에러를 뱉음.
- **교훈**: PowerShell은 큰따옴표(`"..."`) 안에 있는 대괄호 `[]`나 괄호 `$()`를 문자열이 아닌 PowerShell 고유의 문법(배열 인덱스 혹은 서브익스프레션)으로 강제 해석하려 듦. 복잡한 파이썬 List Comprehension이나 인덱싱 코드는 절대 윈도우 터미널에서 인라인 텍스트로 날리지 말 것.

#### 13. 코드 단위 대량 삭제 시 중괄호(`{}`) 쌍 누락에 의한 AST 붕괴 (에러 타입 4)
- **문제**: 불필요한 스크래퍼 코드 블록을 삭제/치환하는 과정에서 끝에 닫혀야 할 `}` 괄호를 통째로 날려먹어, 파일 전체가 `SyntaxError: Unexpected end of input` 상태로 망가짐.
- **교훈**: 여러 Scope(IIFE, 중첩 Callback)가 섞인 컴포넌트에서 수십 줄 단위의 블록을 직접 제거할 때는 들여쓰기와 시작/끝 괄호 카운트를 기계적으로 점검해야 하거나 안전하게 스크립트로 처리해야 함. 거대한 코드 리팩토링 직후에는 반드시 원격 혹은 로컬 환경 모두에서 `node --check`로 AST(구문 트리)의 정상 여부를 최우선으로 검증할 것.

#### 14. SSH 파이프라인 `awk` 명령어 내 달러/역슬래시(`\$`) 파손 (에러 타입 5)
- **문제**: 리눅스에서 흔히 쓰는 `awk '{print \$NF}'`를 윈도우 쉘을 통해 전송했더니, `\$`가 윈도우에 의해 씹히면서 역슬래시 단독으로 전달되어 `awk: cmd. line:1: {print \}` 구문 오류 발생.
- **교훈**: 윈도우 PowerShell에서 달러(`$`) 문자 자체를 이스케이프(`\$`)하여 SSH로 보내려 하면, 역슬래시만 증발하고 엉뚱한 변수로 해석됨. 리눅스 전용 정규식이나 `awk` 문법은 인용부호 충돌이 매우 심하므로 인라인 커맨드로 다루지 말고 미리 Bash 스크립트화 시켜놓고 스크립트 자체를 Call 하는 방식으로 우회할 것.

#### 15. 외부 데이터 소스 전환 시 정규식 패턴(Regex) 파편화 방치 (Red Hat CSAF API 정규식 버그)
- **교훈**: 데이터 소스를 변경(Scraping -> API)할 때는 수집 레이어(`batch_collector.js`)만 고치고 끝낼 것이 아니라, 그 다음 단계에서 데이터를 필터링하는 전처리 및 파싱 레이어(`patch_preprocessing.py`)의 정규식 조건들까지 필연적으로 변동되었음을 인지하고 파이프라인 종단(End-to-End) 테스트를 즉각 수행해야 함. 절대 옛날 정규식을 맹신하지 말 것.

### 2026-03-05 추가 오류 분석 및 통합 교훈 (Error Types 1~22)

#### 16. 호스트 운영체제(Windows)와 타겟 서버(Linux)의 명령어 혼동 금지 (에러 2, 9, 10, 16, 21)
- **문제**: 로컬 Windows 호스트 터미널에서 `grep`, `python`, `node`를 실행하거나, 반대로 원격 서버망에서 의존성이 없는 `sqlite3`를 SSH 인라인으로 무심코 날리다 `CommandNotFoundException` 에러가 대규모로 발생함.
- **교훈**: 내가 현재 상주하고 있는 터미널 환경이 **Windows PowerShell**인지, 아니면 전송 타겟인 **Linux Bash**인지 명확히 구분해야 함. 로컬에는 Linux 유틸리티가 전혀 없음을 명심하고 무조건 특정 환경에 특화된 전용 도구(예: `grep_search` 등) 파이프라인을 먼저 사용하거나, 리눅스 타겟팅 명령어는 온전히 `ssh`로 감싸서 실행할 것. 또한, 원격지에 특정 도구(`sqlite3`)가 당연히 있을 것이라 지레짐작하지 말 것.

#### 17. PowerShell -> SSH 인라인 복합 스크립트 전송 절대 금지 (에러 7, 11, 12, 14, 17, 20)
- **문제**: PowerShell을 거쳐서 `ssh host "python3 -c \"...\""` 또는 `node -e \"...\"` 같은 다중 문자열 스크립트를 한 줄로 욱여넣으려다 괄호(`)`), 겹따옴표(`\"`), 변수(`x.get`) 등이 모조리 깨지면서 `SyntaxError`나 EOF 에러가 연쇄적으로 발생.
- **실패 이유**: Windows PowerShell 특유의 파이프라인 파서와 리눅스 Bash 쉘의 이중 이스케이프(Escape) 체계가 정면 충돌하여 코드의 형태를 반파시킴.
- **교훈 (가장 중요)**: **데이터 파싱(`json.load` 등)이 포함된 복잡한 Python/Node.js 스크립트는 절대로 SSH 문자열 안에 인라인 텍스트로 작성하지 말 것.**
  가장 완벽한 해결책은, 먼저 Antigravity 환경 내 로컬 Windows 공간에 완전한 스크립트 파일(`script.py` 또는 `script.js`)을 `write_to_file` 도구로 예쁘게 생성한 뒤 -> `scp`로 안전하게 원격지로 복사하고 -> `ssh host "python3 /path/script.py"` 형태로 단순히 "호출(Call)"만 하는 우회 루트를 통일된 표준으로 삼아야 함.

#### 18. PowerShell 명령어 체이닝 (`&&`) 및 빈 파이프라인 오류 (에러 8, 22)
- **문제**: `powershell -Command "A | B; | C"` 또는 로컬에서 `cd ... && npx tsc` 실행 시, `An empty pipe element is not allowed` 혹은 `The token '&&' is not a valid statement separator` 파싱 구문 오류 발생.
- **교훈**: 하위 호환성을 유지 중인 기본 PowerShell 5 환경에서는 `&&` 구문자나 연속되지 않은 끊긴 파이프(`|`) 사용이 절대 불가능함. 체인 명령어는 무조건 **세미콜론(`;`)**으로 쪼개서 실행할 것.

#### 19. 비대화형 SSH 환경변수(Path) 누락 심화 (에러 13, 19)
- **문제**: `ssh "node batch_collector.js"` 또는 `ssh "bash -i -c 'pm2 list'"` 등으로 로컬 터미널처럼 원격 명령을 날렸으나, `node`, `pm2` 모두 Command not found 오류로 튕김. 
- **교훈**: `bash -i -c` 같은 트릭을 써도 `.bashrc` 또는 NVM 환경이 완전히 준비되지 않을 확률이 큼. **노드 생태계(`node`, `pm2`, `npm`)** 명령을 원격에서 쏠 때는 필수적으로 `source ~/.nvm/nvm.sh && cd /home/citec/... && npm ...` 와 같이 한 호흡의 세션 안에서 NVM 포인터를 직접 살려놓고 이어나갈 것.

#### 20. Prisma 스키마 v6/v7 호환성 충돌 (에러 15)
- **문제**: 데이터베이스 URL을 동적 할당하기 위해 `npx prisma db push`를 실행했으나, `The datasource property url is no longer supported in schema files` P1012 오류 발생.
- **실패 이유**: 최근 설치된 최신 버전의 Prisma(v7+ 이상)에서는 구조적 보안상의 이유로 `schema.prisma` 내부의 하드코딩된 `url = env("... ")` 구문 파실 및 일부 레거시 문법을 거부함.
- **교훈**: Prisma 구성을 건드릴 거라면 해당 프로젝트에 설치된 Prisma Client 및 CLI 버전을 정확히 먼저 `grep_search` 등으로 파악하거나 `package.json`을 읽고, 버전에 맞는 Prisma 규칙을 따를 것.

#### 21. 파일 시스템 존재 여부(Existence) 단정 및 경로 파편화 (에러 1, 3, 4, 5)
- **교훈**: 파일 복사 시도 전이나, 스크립트 실행 전에는 윈도우든 리눅스 환경이든 해당 타겟 경로(Path)나 폴더가 제대로 `mkdir` 되어있고 존재하는지 `list_dir` 등으로 사전 점검하는 안전 확인(Sanity Check) 과정을 1초라도 반드시 거칠 것.

#### 22. PM2 전역 경로 부재 시 `npx`를 통한 강제 재시작 (에러 23)
- **문제**: 배포 후 화면 이동 시 `Application error` 및 `404 Uncaught ChunkLoadError` 발생. 원인은 앞선 전역 프로세스가 종료되지 않아 충돌함.
- **교훈**: `npx pm2 restart all` 을 실행하여 캐싱 충돌을 막을 것.

#### 23. 파이프라인 전처리 정밀 필터링 및 네거티브 프롬프트 제약 필수화
- **문제**: 특정 DB/Storage 제품 전처리 시 불필요한 OS 환경 버전이 너무 많이 수집되거나, AI가 Description 필드에 원본 파일명(`.patch`)이나 방대한 체인지로그를 구별 없이 그대로 복사·붙여넣기 증상 발생.
- **교훈**: 신규 제품/카테고리를 연동할 때는 반드시 다음 사항을 기본값으로 추가해야 한다:
  1. `metadata.json` 같은 비-패치 파일들은 전처리 파이썬 스크립트에서 명시적으로 제외할 것.
  2. 광범위한 `affected_products` 배열 수집을 지양하고, 해당 제품이 꼭 필요한 환경(예: 특정 RHEL AppStream 등)만 화이트리스트로 하드코딩 필터링할 것.
  3. 백그라운드 AI 프롬프트(`queue.ts`)에 **반드시 강력한 네거티브 지시어 (Negative Constraint)**를 포함하여 "절대 원본 파일명이나 코드를 복붙하지 말고, 임원진 요약본으로 서술하라"고 억제기를 달아둘 것. (MariaDB 통합 사례 참고)

### 2026-03-06 Issue Breakdown
- **Issue**: The 'Retry AI Review' (manual-review or isAiOnly) pipeline hung at 0% progress indefinitely on the dashboard.
- **Root Cause**: The BullMQ worker (queue.ts) was running `openclaw ask` which does not emit the necessary stdout logging patterns (e.g. `[LLM-REVIEW] Starting Batch Evaluation`) expected by the progress scraper. Furthermore, the core fixes (RAG and Zod validation loop) implemented in Action Plans 1 and 2 were previously mistakenly added to `src/app/api/pipeline/execute/route.ts`, which is a legacy/unused endpoint in V2 (the dashboard uses `/api/pipeline/run` to drop jobs into BullMQ instead).
- **Resolution**: Refactored the core execution logic natively into `src/lib/queue.ts`. The worker now sequentially orchestrates data collection, preprocessing, and the 3-tier Zod self-healing loop using pure Node.js spawn promises, explicitly invoking `job.updateProgress()` and `job.log()` to ensure accurate and responsive UI progress tracking for both automated and manual review pipelines.

### 2026-03-11 UI 파이프라인 전처리 추출본 하이라이트 매칭 불일치 해결
- **문제**: 파이프라인 분석 전처리 데이터 추출본 UI에서 AI가 권고하지 않은 모든 패치가 파란색으로 하이라이트되거나, 아무것도 아예 하이라이트되지 않는 증상이 있었음.
- **실패 이유**: `page.tsx` 및 `ClientPage.tsx`에서 `isApproved`를 검사할 때, 단순 ID 존재 여부만 확인했음. 하지만 AI 리뷰 파이프라인의 `queue.ts`에는 **Passthrough** 로직이 있어 AI가 스킵한 패치라도 모두 `ReviewedPatch` 테이블에 삽입됨.
- **교훈**: **단순히 AI 출력 테이블(ReviewedPatch)에 존재한다고 해서 AI가 승인/권고한 것이 아님.** UI에서 특정 필터링/하이라이트를 구현할 때는 반드시 `rPatch.Criticality?.toLowerCase() === 'critical'` 또는 의사 결정 필드까지 **다중 조건(Compound Condition)**으로 검증해야 함. 또한 OS 패치의 경우 UUID(`patch.id`)가 아닌 고유 식별자(`patch.issueId`)를 사용하여 문자열 비교를 해야 매칭 오류를 원천 차단할 수 있음.

### 2026-03-12 MariaDB 스크립트 작성 및 풀스택 연동 배포 성공
- **성공 요인**: `docs/ADDING_NEW_PRODUCT.md` 시스템 문서를 100% 준수하여 Python 데이터 정제부터 Next.js API의 카테고리/벤더 매핑까지 하나도 빠짐없이 체계적으로 구현.
- **Troubleshooting**: `stage/[stageId]/route.ts`에 MariaDB 벤더 매핑을 잊지 않고 추가하여 (이전 Ceph 사태의 교훈 적용) 데이터 누출(Data Leak/Mix)을 사전에 차단함.
- **Troubleshooting 2**: Next.js 15 환경에서 `products/route.ts` 수정 시 `category === 'database'` 조건에서 "types have no overlap" 타입스크립트 에러 발생. 상단의 필터 조건문(`if (category !== 'os' && category !== 'storage' && category !== 'database')`)을 미리 확장해두지 않으면 TS 컴파일러가 강제 추론해버린다는 사실을 학습하고 빠르게 핫픽스 후 실서버 무중단 배포(pm2 restart 0) 완료.


