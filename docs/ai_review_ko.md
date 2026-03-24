# AI 리뷰 시스템

Patch Review Dashboard V2는 보안 패치를 평가하기 위한 자율 AI 리뷰 루프를 사용합니다. 이 문서는 AI 호출 방법, 과거 배제 사유 주입 방법, 출력 유효성 보장 방법을 설명합니다.

---

## 1. 전체 흐름

```
patches_for_llm_review_<vendor>.json
          │
          ▼
  RAG 배제 설정 (제품별)
          │
          ▼
  배치 루프 (5개씩)
    │
    ├─ cleanupSessions()        ← sessions.json 삭제
    ├─ buildPrompt()            ← 제품별 프롬프트 템플릿
    ├─ openclaw agent:main      ← openclaw CLI로 외부 AI 모델 호출
    ├─ extractJsonArray()       ← AI 출력 파싱
    ├─ Zod 검증                 ← 스키마 강제
    └─ 재시도 (최대 2회)        ← Zod 에러를 프롬프트에 주입
          │
          ▼
  aiReviewedPatches[]  +  aiReviewedIds (Set)
          │
          ▼
  ingestToDb() + runPassthrough()
```

---

## 2. 세션 격리

**v1 문제**: OpenClaw 세션이 배치 간에 컨텍스트를 누적했습니다. 10번째 배치에서 AI가 1~9번째 배치의 요약에 영향을 받아 환각(hallucination) 및 잘못된 결정 전이가 발생했습니다.

**v2 해결책**: 모든 배치 실행 전 `cleanupSessions()`가 다음 파일을 삭제합니다:
```
~/.openclaw/agents/main/sessions/sessions.json
```

이를 통해 OpenClaw가 완전히 새로운 컨텍스트로 각 배치를 시작합니다. AI가 받는 컨텍스트는 다음 두 가지뿐:
1. `SKILL.md` 파일 (스킬 디렉터리에서 `--json-mode`로 읽음)
2. 현재 배치 프롬프트 (해당하는 경우 RAG 주입 포함)

---

## 3. RAG 배제

### 전략 1: 프롬프트 주입 (Red Hat, Oracle, Ubuntu, VMware vSphere)

첫 번째 배치 실행 전:

1. `query_rag.py`가 현재 세션의 패치 요약을 입력으로 호출됨 (cwd: `os/linux/` 공유 디렉토리)
2. `UserFeedback` 테이블에서 유사한 과거 배제 결정 조회
3. 배제 컨텍스트 블록 반환: 패치 ID와 관리자 사유 목록

이 블록이 모든 배치 프롬프트에 추가됩니다:
```
CRITICAL INSTRUCTION: 다음 패치들은 보안 관리자에 의해 이전 검토 주기에서
EXCLUDED 처리되었습니다. 어떤 경우에도 출력에 포함하지 마십시오:
- RHSA-2024:1234 | Component: openssl | Reason: 내부 시스템이 TLS 1.0을 사용하지 않음
- ELSA-2024:5678 | Component: dbus | Reason: 컨테이너화된 워크로드에 미적용
```

**이 제품들에서 파일 숨김 대신 프롬프트 주입을 사용하는 이유**: Linux/vSphere는 `normalized/` 디렉터리 구조가 없습니다. `query_rag.py`가 단순한 파일 숨김보다 더 세밀한 유사도 기반 배제를 제공합니다.

### 전략 2: 두 방식 병용 (Windows, Ceph, MariaDB, SQL Server, PostgreSQL, MySQL, JBoss EAP, Tomcat, WildFly)

이 제품들은 **파일 숨김 + 프롬프트 주입**을 모두 사용합니다.

**파일 숨김** — AI 실행 전:
```python
os.rename(normalized_dir, normalized_dir + "_hidden")
os.rename(patches_file, patches_file + ".hidden")
```

AI 실행 후:
```python
os.rename(normalized_dir + "_hidden", normalized_dir)
os.rename(patches_file + ".hidden", patches_file)
```

**프롬프트 주입** — 각 배치 전 `query_rag.py` (cwd: `os/linux/`)도 실행하여 과거 배제 이력을 주입합니다.

**두 방식을 모두 사용하는 이유**: 파일 숨김은 OpenClaw 에이전트가 워크스페이스 파일 도구로 이전 처리 파일을 읽는 것을 방지하고, 프롬프트 주입은 추가로 과거 관리자 피드백을 AI 판단에 반영합니다.

---

## 4. 배치 프롬프트 구성

각 제품은 `products-registry.ts`에 고유한 `buildPrompt()` 함수를 정의합니다. 프롬프트 템플릿에는:

1. **SKILL.md 읽기 지시** — `Read the rules explicitly from <skillDir>/SKILL.md`
2. **과거 메모리 무시 명령** — `CRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES`
3. **출력 형식 계약** — 필수 필드가 있는 정확한 JSON 배열 구조
4. **배치 데이터** — 현재 5개 패치의 `JSON.stringify(prunedBatch)`

**표준 제품** (Linux, Ceph, MariaDB, PostgreSQL):
```
Return ONLY a pure JSON array containing EXACTLY {batchSize} objects.
Each object MUST contain: 'IssueID', 'Component', 'Version', 'Vendor', 'Date',
'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'.
```

**버전 그룹핑 제품** (Windows Server, SQL Server):
```
INPUT FORMAT: 각 항목은 'patches' 배열을 포함하는 VERSION GROUP입니다.
SELECTION RULE: 그룹당 가장 최근의 중요 월별 패치 1개 선택.
OUTPUT RULE: 입력 VERSION GROUP 수와 정확히 일치하는 {batchSize}개 객체 반환.
IssueID = 그룹의 patch_id (예: 'WINDOWS-GROUP-Windows_Server_2025').
Version = 선택된 월별 패치의 KB 번호.
```

---

## 5. OpenClaw 호출

```bash
openclaw agent:main --json-mode --message "<prompt>"
```

- `--json-mode`: 구조화된 JSON 출력 지시
- `--message`: SKILL.md 경로와 배치 데이터를 포함한 완전한 프롬프트
- 에이전트가 스킬 디렉터리의 `SKILL.md`를 읽어 평가 기준 파악
- 출력은 stdout에서 캡처

---

## 6. Zod 검증 및 자가 치유

### 스키마
```typescript
const ReviewSchema = z.array(z.object({
  IssueID:            z.string(),
  Component:          z.string(),
  Version:            z.string(),
  Vendor:             z.string(),
  Date:               z.string(),
  Criticality:        z.string(),
  Description:        z.string(),
  KoreanDescription:  z.string(),
  Decision:           z.string().optional(),
  Reason:             z.string().optional(),
  OsVersion:          z.string().optional(),
}));
```

### 출력 추출

`extractJsonArray()`가 일반적인 AI 출력 포맷 문제 처리:
1. 마크다운 코드 펜스(` ```json ... ``` `) 제거
2. 응답에서 첫 번째 `[...]` JSON 배열 추출
3. 배열 파싱 및 반환, 유효한 JSON이 없으면 예외 발생

### 배치 카운트 검증

Zod 검증 후:
- `aiBatchValidation: 'exact'` → 출력 배열 길이가 입력 배치 크기와 정확히 일치해야 함
- `aiBatchValidation: 'nonEmpty'` → 출력 배열에 최소 1개 항목 필요 (버전 그룹핑)

### 자가 치유 루프

```
시도 1: buildPrompt(skillDir, batchSize, prunedBatch)
          → AI 출력
          → Zod 실패: "[2].IssueID에서 필수값 누락"
          → 3초 대기

시도 2: 동일 프롬프트 + "\n\n이전 응답이 실패했습니다. 다음 Zod 구조적 에러를
          해결하여 다시 제출하세요: [정확한 Zod 에러 메시지]"
          → AI 출력
          → Zod 실패: 잘못된 JSON
          → 9초 대기

시도 3: 동일 프롬프트 + 업데이트된 에러
          → 성공 또는 배치 건너뜀 (패스스루가 미처리 패치 처리)
```

---

## 7. Gateway Closed 처리

**문제**: `openclaw agent:main`이 AI 엔드포인트로의 네트워크 연결이 응답 중에 끊길 때 "gateway closed" 응답을 반환할 수 있습니다. v1에서는 이것이 즉각적인 배치 실패와 재시도를 유발했습니다.

**v2 해결책**: Gateway closed 오류는 즉각 거부되지 않습니다. 워커가:
1. 스트림 출력에서 "gateway closed" 상태 감지
2. 전체 응답이 도착할 때까지 대기 (연결이 자가 치유될 수 있음)
3. 완전한 응답이 유효하지 않은 경우에만 Zod 재시도 루프 트리거

이를 통해 일시적인 네트워크 문제로 인한 불필요한 재시도를 방지합니다.

---

## 8. 속도 제한 처리

AI API가 429 속도 제한 응답을 반환할 때:

1. 속도 제한 플래그 파일 생성: `/tmp/.rate_limit_<productId>`
2. 워커가 재시도 전 지수 백오프로 대기
3. 각 배치 시작 시 플래그 파일 확인 — 존재하고 최근 것이면 추가 지연 적용

---

## 9. 패스스루 (건너뛴 패치 복구)

AI 루프 완료 후 `runPassthrough()`가 패치 손실을 방지합니다.

**패스스루 적용 대상**: 버전 그룹핑을 사용하는 Windows Server와 SQL Server를 제외한 모든 제품 (redhat, oracle, ubuntu, ceph, mariadb, pgsql, mysql, vsphere, jboss_eap, tomcat, wildfly).

**수행 내용**:
1. 해당 벤더의 `PreprocessedPatch`(전처리된 모든 패치)와 `aiReviewedIds`(이번 실행에서 AI가 실제로 검토한 패치) 비교
2. 전처리되었지만 검토되지 않은 각 패치에 대해:
   ```
   ReviewedPatch.upsert({
     issueId: patch.issueId,
     criticality: 'Important',
     decision: 'Pending'
   })
   ```
3. 대시보드에서 "Pending"으로 표시 — 사람의 검토 필요

**'Important' + 'Pending'으로 설정하는 이유**: 건너뛴 패치가 중요할 수 있다는 보수적 가정. 검토자가 다운그레이드하거나 배제할 수 있습니다.

---

## 10. SKILL.md 기준

각 제품의 스킬 디렉터리는 다음을 포함하는 `SKILL.md`를 가져야 합니다:
- **100줄 이상** 내용
- **`## 4.`** 섹션 "Strict LLM Evaluation Rules" 포함:
  - `### 4.1` 포함 기준
  - `### 4.2` 배제 기준
  - `### 4.3` 출력 형식 (JSON 스키마)
  - `### 4.4` 일반 규칙
  - `### 4.5` 환각 방지 규칙

검증기(`scripts/validate-registry.js`)가 이 요구 사항을 강제합니다.
