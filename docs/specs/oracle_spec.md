# Product Spec — Oracle Linux

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `oracle` |
| name | `Oracle Linux` |
| vendorString | `Oracle` |
| category | `os` |
| skillDirRelative | `os/linux` |
| active | `true` |

---

## 2. Raw Data Format

- **Source system**: Oracle Linux yum updateinfo.xml (oracle_collector.sh + oracle_parser.py)
- **File prefix(es)**: `ELSA-`, `ELBA-`, `ELEA-`
  - `ELSA-` : Oracle Linux Security Advisory (보안 취약점 수정)
  - `ELBA-` : Oracle Linux Bug Fix Advisory (버그 수정)
  - `ELEA-` : Oracle Linux Enhancement Advisory (기능 개선)
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "id": "ELSA-2025-15875",
  "vendor": "Oracle",
  "type": "Oracle Linux Security Advisory (ELSA)",
  "kernel_type": "RHCK",
  "title": "Oracle Linux Security Advisory: kernel update",
  "issuedDate": "2025-12-10T00:00:00Z",
  "updatedDate": "2025-12-10T00:00:00Z",
  "pubDate": "2025-12-10T00:00:00Z",
  "dateStr": "2025-12-10",
  "url": "https://linux.oracle.com/errata/ELSA-2025-15875.html",
  "severity": "Important",
  "overview": "An update for kernel is now available for Oracle Linux 8.",
  "description": "...",
  "affected_products": ["Oracle Linux 8 for x86_64"],
  "cves": ["CVE-2025-12345"],
  "packages": ["kernel-5.15.0-210.157.7.el8uek.x86_64"],
  "full_text": "..."
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `id` | 패치 식별자 (ELSA-/ELBA-/ELEA-) | IssueID에 사용 |
| `severity` | 심각도 | Critical/Important/Moderate/Low |
| `dateStr` | 발표일 | YYYY-MM-DD |
| `description` | 설명 | 4000자 이내로 잘라내기 |
| `overview` | 요약 | summary로 사용 |
| `affected_products` | 영향받는 Oracle Linux 버전 | os_version 추출 |
| `cves` | CVE 목록 | 배열 |
| `packages` | 패키지 목록 | component 및 version 추출 |

---

## 3. Filtering Requirements

- **Days window**: 90일 (`--days 90`, 컬렉터는 180일 lookback)
- **KEEP 조건**:
  - severity가 Critical 또는 Important인 항목
  - SYSTEM_CORE_COMPONENTS whitelist에 해당하는 컴포넌트 (kernel, UEK 포함)
- **DROP 조건**:
  - 90일 이상 된 항목
  - whitelist에 없는 비핵심 패키지
- **데이터 전처리 특이사항**:
  - ELSA/ELBA/ELEA 번호 체계는 RHSA/RHBA/RHEA와 유사하나 EL- prefix 사용
  - ELBA(버그픽스)/ELEA(개선) 파일도 oracle_data/에 수집되나, 전처리 시 severity=None/Low로 대부분 드롭됨
  - Oracle Unbreakable Enterprise Kernel (UEK) 별도 추적 가능
  - Red Hat과 동일한 `patch_preprocessing.py` 사용 (`--vendor oracle`)

---

## 4. Grouping / Output Structure

- **방식**: Individual (개별)
- 버전그룹 없음. 각 ELSA/ELBA/ELEA Advisory가 개별 패치 레코드로 처리됨 (ELBA/ELEA는 severity 기준으로 대부분 드롭)
- `os/linux/oracle/SKILL.md` — Oracle Linux 전용 SKILL.md 파일 사용

---

## 5. Criticality Determination

- **방법**: severity 필드 직접 사용

| 조건 | Criticality 분류 |
|------|----------------|
| severity = 'Critical' | Critical |
| severity = 'Important' 또는 CVSS ≥ 7.0 | High |
| severity = 'Moderate' | Moderate |
| severity = 'Low' 또는 'None' | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 수시 (Red Hat Errata 발표 직후 Oracle에서 동기화)
- **누적 vs 증분**: 증분 (yum updateinfo.xml에서 신규 항목만 파싱)
- **복수 데이터 소스**: No (단일 — Oracle yum 저장소 updateinfo.xml)

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'Oracle'`
- **Component 예시 목록**: `kernel`, `kernel-uek`, `glibc`, `openssl`, `systemd`
- **설명에 포함/제외할 내용**:
  - 포함: 어떤 취약점이 수정됐는지, 영향 Oracle Linux 버전, CVE 번호
  - 제외: 패키지 파일명 목록, 원본 yum updateinfo 텍스트 복붙
- **Hallucination risk 영역**: RHEL과 ELSA 번호 혼동, UEK 버전과 RHCK(Red Hat Compatible Kernel) 버전 혼동
- **제거할 raw 필드**: 해당 없음 (preprocessing에서 필요 필드만 추출)
- **Passthrough 필요 여부**: Yes
  - fallback criticality: `'Important'`
  - fallback decision: `'Pending'`
- **RAG exclusion 방식**: `prompt-injection`
  - queryScript: `query_rag.py`
  - queryTextSampleSize: 3
- **SKILL.md 경로**: `os/linux/oracle/SKILL.md` (Oracle 전용 — redhat/ubuntu와 분리됨)
  - 평가 규칙은 해당 파일의 **섹션 3** 참조
  - `buildPrompt`에서 `path.join(skillDir, 'oracle', 'SKILL.md')`로 참조

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: Oracle Linux는 RHEL 호환 엔터프라이즈 OS로, Oracle DB 및 미들웨어 서버에 주로 사용됨. UEK(Unbreakable Enterprise Kernel)는 Oracle에서 독자 패치한 커널로 RHEL과 별도 취약점 존재 가능.
- **주목해야 할 취약점 유형 TOP 3**:
  1. UEK(Unbreakable Enterprise Kernel) 전용 커널 취약점
  2. Remote Code Execution (네트워크 스택)
  3. Privilege Escalation (sudo, polkit)
- **AI 오판 false-positive 패턴**: Oracle DB 관련 패키지(oracle-database-*)와 OS 핵심 패키지 혼동; RHEL errata와 ELSA 번호 혼용
- **제외 조건**: severity=Low/None, whitelist 외 패키지, Oracle DB 클라이언트 전용 패키지

---

## 9. registry 항목

```typescript
{
    id: 'oracle',
    name: 'Oracle Linux',
    vendorString: 'Oracle',
    category: 'os',
    active: true,
    skillDirRelative: 'os/linux',
    dataSubDir: 'oracle_data',
    rawDataFilePrefix: ['ELSA-', 'ELBA-', 'ELEA-'],
    preprocessingScript: 'patch_preprocessing.py',
    preprocessingArgs: ['--vendor', 'oracle', '--days', '90'],
    patchesForReviewFile: 'patches_for_llm_review_oracle.json',
    aiReportFile: 'patch_review_ai_report_oracle.json',
    finalCsvFile: 'final_approved_patches_oracle.csv',
    jobName: 'run-oracle-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_oracle',
    logTag: 'ORACLE',
    aiEntityName: 'Oracle Linux patches',
    aiVendorFieldValue: 'Oracle',
    aiComponentDefault: 'kernel',
    aiVersionGrouped: false,
    aiBatchValidation: 'exact',
    ragExclusion: {
        type: 'prompt-injection',
        queryScript: 'query_rag.py',
        queryTextSampleSize: 3,
    },
    passthrough: {
        enabled: true,
        fallbackCriticality: 'Important',
        fallbackDecision: 'Pending',
    },
    collectedFileFilter: (filename: string) =>
        (filename.startsWith('ELSA-') || filename.startsWith('ELBA-') || filename.startsWith('ELEA-')) && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.id || p.issueId,
        vendor: 'Oracle',
        component: p.component || 'kernel',
        version: p.specific_version || p.version || '',
        osVersion: p.os_version || null,
        description: (p.summary || p.description || '').slice(0, 4000),
        releaseDate: p.date || null,
    }),
    csvBOM: false,
    buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
        `Read the rules explicitly from ${path.join(skillDir, 'oracle', 'SKILL.md')}. Evaluate the following ${batchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 3 of that file.\nCRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.\nDo NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${batchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`,
}
```
