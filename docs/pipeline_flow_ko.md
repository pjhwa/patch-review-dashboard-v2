# 데이터 파이프라인 흐름

Patch Review Dashboard V2는 각 제품에 대해 구조화된 자율 워크플로우를 실행합니다. 이 문서는 사용자가 "파이프라인 실행"을 클릭한 순간부터 최종 CSV 내보내기까지의 전체 흐름을 추적합니다.

---

## 전체 흐름

```
[사용자가 "파이프라인 실행" 클릭]
         │
         ▼
  POST /api/pipeline/{product}/run
         │  BullMQ 작업 큐 추가
         ▼
  BullMQ Queue (Redis)
         │  Worker가 작업 수신
         ▼
  runProductPipeline(job, productCfg)
    │
    ├─ 1단계: 전처리
    ├─ 2단계: RAG 배제 설정
    ├─ 3단계: AI 리뷰 루프 (5개씩 배치)
    ├─ 4단계: 데이터베이스 적재
    └─ 5단계: 패스스루 안전망
         │
         ▼
  사용자가 대시보드에서 검토 후 "완료" 클릭
         │
         ▼
  POST /api/pipeline/{product}/finalize
  → final_approved_patches_{product}.csv 파일 생성
```

---

## 0단계: 작업 디스패치

### 웹 대시보드 트리거
사용자가 `ProductGrid` 컴포넌트에서 **"파이프라인 실행"** (또는 **"AI만 실행"** / **"재시도"**) 클릭 → 확인 다이얼로그 → 확인 시 제품별 run 엔드포인트 호출:

```
POST /api/pipeline/run             (Red Hat / Oracle / Ubuntu)
POST /api/pipeline/windows/run     (Windows Server)
POST /api/pipeline/ceph/run        (Ceph)
POST /api/pipeline/mariadb/run     (MariaDB)
POST /api/pipeline/sqlserver/run   (SQL Server)
POST /api/pipeline/pgsql/run       (PostgreSQL)
POST /api/pipeline/vsphere/run     (VMware vSphere)
```

요청 본문:
```json
{ "providers": ["redhat"], "isRetry": false, "isAiOnly": false }
```

### BullMQ 큐 추가
run API가 `patch-pipeline` BullMQ 큐에 이름이 지정된 작업 추가:
```typescript
await pipelineQueue.add('run-redhat-pipeline', { isRetry, isAiOnly, category: 'os' });
```

응답으로 `{ jobId: "..." }` 반환 → 클라이언트가 SSE 스트림 연결에 사용.

### SSE 연결
`ProductGrid.tsx`가 즉시 연결:
```
GET /api/pipeline/stream?jobId=<jobId>
```
워커의 모든 `job.log()` 호출이 이 스트림으로 `data: {...}` 이벤트 형식으로 전달됩니다.

---

## 1단계: 전처리

`isAiOnly = true`가 아닌 경우 워커가 `runPreprocessing()` 호출.

### 수행 내용
1. 스킬 디렉터리 해석: `~/.openclaw/workspace/skills/patch-review/<skillDirRelative>`
2. 제품별 Python 전처리 스크립트 실행:
   ```bash
   python3 patch_preprocessing.py --vendor redhat --days 90
   ```
   버전 그룹핑 제품 (Windows, SQL Server):
   ```bash
   python3 windows_preprocessing.py --days 180 --days_end 90
   ```
3. 스크립트가 `<dataSubDir>/` (예: `redhat_data/`)에서 원시 데이터 파일을 읽어 날짜 필터링, SQLite DB의 `PreprocessedPatch`와 중복 제거 후 다음 파일 생성:
   - `patches_for_llm_review_<vendor>.json` — AI 리뷰 준비 완료 패치 목록

### 발생 로그 태그
```
[REDHAT-PREPROCESS_DONE] count=42
```
대시보드에서 `router.refresh()`를 트리거하여 단계별 카운트 업데이트.

---

## 2단계: RAG 배제 설정

AI 리뷰 전에 이전에 배제된 패치가 재검토되지 않도록 제품별 RAG 배제 전략 적용.

### 전략 1: 프롬프트 주입 (Linux 제품)
적용 대상: Red Hat, Oracle Linux, Ubuntu

1. 스킬 디렉터리의 `query_rag.py`를 현재 패치 입력으로 호출
2. 유사도 기반으로 `UserFeedback` 레코드 (과거 관리자 배제 사유) 검색
3. 모든 AI 배치 프롬프트에 `CRITICAL INSTRUCTION: ... 배제된 패치 목록 ...` 블록 주입

### 전략 2: 파일 숨김 (Windows, Ceph, MariaDB, SQL Server, PostgreSQL)
대부분의 비Linux 제품에 적용

1. `<dataSubDir>/normalized/` → `<dataSubDir>/normalized_hidden/`로 이름 변경
2. `patches_for_llm_review_<vendor>.json` → `..._hidden`으로 이름 변경
3. AI 리뷰 완료 후 두 파일/디렉터리를 원래 이름으로 복원

OpenClaw 에이전트가 워크스페이스 도구를 통해 이전에 리뷰된 파일에 접근하여 편향이 발생하는 것을 방지합니다.

### RAG 없음 (VMware vSphere)
vSphere는 `ragExclusion` 설정 없음 — 매 실행마다 전처리된 패치 전체를 새로 검토.

---

## 3단계: AI 리뷰 루프

`runAiReviewLoop()`가 5개씩 배치로 모든 패치 처리.

### 배치 실행

각 배치에 대해:
1. **세션 정리**: `~/.openclaw/agents/main/sessions/sessions.json` 삭제 — 이전 배치로부터의 컨텍스트 오염 방지
2. **프롬프트 생성**: `productCfg.buildPrompt(skillDir, batchSize, prunedBatch)`
3. **OpenClaw 실행**:
   ```bash
   openclaw agent:main --json-mode --message "<prompt>"
   ```
4. **JSON 추출**: `extractJsonArray()`로 AI 출력 파싱 — 마크다운 코드 펜스 및 부분 JSON 처리
5. **Zod 검증**: `ReviewSchema`에 대해 검증
   - 필수 필드: `IssueID`, `Component`, `Version`, `Vendor`, `Date`, `Criticality`, `Description`, `KoreanDescription`
   - 선택 필드: `Decision`, `Reason`, `OsVersion`

### 자가 치유 재시도

Zod 검증 실패 시:
```
시도 1: 초기 프롬프트
  → 실패: "3번째 항목에 IssueID 누락"
시도 2: 동일 프롬프트 + "\n이전 응답 실패. Zod 에러: [정확한 에러 메시지]"
  → 실패: 잘못된 JSON
시도 3: 동일 프롬프트 + 업데이트된 에러
  → 성공 또는 포기 (패스스루가 미처리 패치 처리)
```
재시도 지연: 3초 → 9초 (지수 백오프).

### 버전 그룹핑 제품 (Windows Server, SQL Server)

`aiVersionGrouped: true` 제품:
- 배치 전에 OS 버전별로 패치를 사전 그룹화
- 각 배치 항목은 해당 Windows Server 버전의 월별 누적 업데이트 배열을 포함하는 버전 그룹
- AI가 그룹당 가장 최근의 중요 패치 1개 선택
- 검증: `aiBatchValidation: 'nonEmpty'` (≥1 결과 허용)

---

## 4단계: 데이터베이스 적재

`ingestToDb()`가 Prisma를 통해 SQLite에 결과 저장.

- `PreprocessedPatch`: `patches_for_llm_review_<vendor>.json`의 모든 패치 upsert
- `ReviewedPatch`: AI 리뷰된 모든 패치 upsert (`issueId`로 고유)
- `isResumeMode = true` (AI 전용 재실행): 기존 레코드만 업데이트, 신규 삽입 없음

---

## 5단계: 패스스루 안전망

`passthrough.enabled = true`인 모든 제품(Windows Server, SQL Server 제외)에 대해 `ingestToDb()` 이후 `runPassthrough()` 호출.

### 수행 내용
1. 해당 벤더의 모든 `PreprocessedPatch` 레코드 조회
2. AI 리뷰된 `issueId` 집합에 없는 레코드 탐색
3. 각 미처리 패치에 대해:
   ```
   ReviewedPatch.upsert({
     issueId, criticality: 'Important', decision: 'Pending', ...기타 필드
   })
   ```

대시보드에서 "Pending" 상태로 표시 → 담당자가 직접 검토 필요.

---

## 6단계: 완료 처리 (사용자 액션)

파이프라인 완료 후 사용자가 대시보드에서 패치 검토:

1. `/category/<categoryId>/<productId>`로 이동
2. DB에서 로드된 `ReviewedPatch` 레코드 검토
3. 필요 시 결정 수정 (승인 / 배제)
4. **"완료"** 클릭 → `POST /api/pipeline/<product>/finalize`

완료 처리 수행:
1. `decision: 'Approve'`인 `ReviewedPatch` 레코드 읽기
2. CSV 행으로 포맷
3. Excel 호환성을 위한 UTF-8 BOM(`\uFEFF`) 추가
4. 스킬 디렉터리에 `final_approved_patches_<vendor>.csv` 저장

---

## 7단계: CSV 내보내기

완료 처리 후 언제든지 최종 CSV 다운로드:

```
GET /api/pipeline/export?categoryId=os
```

Linux 제품의 경우 활성 Linux 벤더 전체(redhat + oracle + ubuntu)의 CSV를 하나의 파일로 병합하여 다운로드. 다른 카테고리는 단일 제품 CSV 반환.

---

## 재개(Resume) 모드

파이프라인 실행 중 중단(예: 서버 재시작)된 경우, 다음 트리거 시 워커가 `patches_for_llm_review_<vendor>.json`에 이미 AI 리뷰된 데이터가 있음을 감지하고 **재개 모드** 진입:

- 전처리 건너뜀
- `ReviewedPatch`에 없는 패치에 대해서만 AI 재실행
- 이미 리뷰된 패치 건너뜀 (DB 중복 쓰기 방지)

이는 UI의 **"AI만 실행"** 버튼과 동일하며, 해당 버튼은 작업 페이로드에 `isAiOnly: true`를 명시적으로 설정합니다.
