# Product Spec — Red Hat Enterprise Linux

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `redhat` |
| name | `Red Hat Enterprise Linux` |
| vendorString | `Red Hat` |
| category | `os` |
| skillDirRelative | `os/linux` |
| active | `true` |

---

## 2. Raw Data Format

- **Source system**: Red Hat CSAF API (RHSA) + Hydra API (RHBA)
- **File prefix(es)**: `RHSA-`, `RHBA-`
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "id": "RHBA-2025:14558",
  "vendor": "Red Hat",
  "type": "Bug Fix Advisory (RHBA)",
  "title": "Red Hat Bug Fix Advisory: libxslt bug fix and enhancement update",
  "issuedDate": "2025-12-18T16:13:04Z",
  "dateStr": "2025-12-18",
  "url": "https://access.redhat.com/errata/RHBA-2025:14558",
  "severity": "None",
  "overview": "An update for libxslt is now available...",
  "description": "...",
  "affected_products": ["Red Hat Enterprise Linux for x86_64 10 x86_64"],
  "cves": [],
  "packages": ["libxslt-1.1.32-6.3.el8_10.x86_64"]
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `id` | 패치 식별자 (RHSA-/RHBA-) | IssueID에 사용 |
| `severity` | 심각도 | Critical/Important/Moderate/Low/None |
| `dateStr` | 발표일 | YYYY-MM-DD |
| `description` | 설명 | 4000자 이내로 잘라내기 |
| `overview` | 요약 | summary로 사용 |
| `affected_products` | 영향받는 RHEL 버전 목록 | os_version 추출에 활용 |
| `cves` | CVE 목록 | 배열 |
| `packages` | 패키지 목록 | component 추출에 활용 |

---

## 3. Filtering Requirements

- **Days window**: 90일 (`--days 90`, 컬렉터는 180일 lookback)
- **KEEP 조건**:
  - severity가 Critical 또는 Important(High)인 항목
  - SYSTEM_CORE_COMPONENTS whitelist에 해당하는 컴포넌트 (kernel, filesystem, cluster, systemd, libvirt 등)
- **DROP 조건**:
  - 90일 이상 된 항목
  - whitelist에 없는 비핵심 패키지
- **데이터 전처리 특이사항**:
  - 동일 컴포넌트의 여러 업데이트를 단일 히스토리로 집계
  - `specific_version` 필드를 별도 계산하여 주입 (가장 최신 critical 버전)
  - `summary`와 `description` 필드를 4000자로 truncate

---

## 4. Grouping / Output Structure

- **방식**: Individual (개별)
- 버전그룹 없음. 각 RHSA/RHBA Advisory가 개별 패치 레코드로 처리됨
- 동일 컴포넌트 다중 업데이트 시 히스토리 집계 후 최신 Critical 버전 선택 (Cumulative Recommendation Logic)

---

## 5. Criticality Determination

- **방법**: severity 필드 직접 사용 + 키워드 기반

| 조건 | Criticality 분류 |
|------|----------------|
| severity = 'Critical' | Critical |
| severity = 'Important' 또는 CVSS ≥ 7.0 | High |
| severity = 'Moderate' | Moderate |
| severity = 'Low' 또는 'None' | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 수시 (매주 다수 Advisory 발표)
- **누적 vs 증분**: 증분 (신규 Advisory만 수집, 이미 수집된 ID는 skip)
- **복수 데이터 소스**: Yes
  - RHSA (Security Advisory): CSAF API
  - RHBA (Bug Fix Advisory): Hydra API

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'Red Hat'`
- **Component 예시 목록**: `kernel`, `systemd`, `glibc`, `openssl`, `libvirt`, `pacemaker`
- **설명에 포함/제외할 내용**:
  - 포함: 어떤 취약점이 수정됐는지, 영향 RHEL 버전, CVE 번호
  - 제외: 패키지 파일명 목록, 원본 changelog 복붙, URL
- **Hallucination risk 영역**: specific_version 필드 무시 후 임의 버전 출력, os_version 혼동
- **제거할 raw 필드**: 해당 없음 (preprocessing에서 필요 필드만 추출)
- **Passthrough 필요 여부**: Yes
  - fallback criticality: `'Important'`
  - fallback decision: `'Pending'`
- **RAG exclusion 방식**: `prompt-injection`
  - queryScript: `query_rag.py`
  - queryTextSampleSize: 3
- **SKILL.md 경로**: `os/linux/redhat/SKILL.md` (Red Hat 전용 — oracle/ubuntu와 분리됨)
  - 평가 규칙은 해당 파일의 **섹션 3** 참조
  - `buildPrompt`에서 `path.join(skillDir, 'redhat', 'SKILL.md')`로 참조
- **특이사항**:
  - `specific_version` 필드가 있으면 반드시 그 값을 Version으로 사용 (임의 추측 금지)
  - OsVersion은 `os_version` 필드에서 가져옴 (예: "RHEL 8, RHEL 9")
  - Ubuntu와 달리 LTS 필터 없음 (모든 RHEL 버전 대상)

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: RHEL은 서버 인프라의 핵심 OS. 커널, 인증, 파일시스템 취약점은 전체 서비스 중단 또는 데이터 유출로 이어질 수 있음. 규정 준수(ISMS, CC인증) 대상 시스템에 배포되어 있음.
- **주목해야 할 취약점 유형 TOP 3**:
  1. Remote Code Execution (커널 및 네트워크 스택)
  2. Privilege Escalation (sudo, polkit, dbus 등)
  3. Failover Failure (Pacemaker/Corosync HA 스택)
- **AI 오판 false-positive 패턴**: 문서/도구성 패키지(man-pages, vim, bash-completion)가 whitelist 컴포넌트명과 유사한 경우 잘못 포함
- **제외 조건**: whitelist에 없는 개발도구, 비핵심 라이브러리, severity=None/Low 항목

---

## 9. registry 항목

```typescript
{
    id: 'redhat',
    name: 'Red Hat Enterprise Linux',
    vendorString: 'Red Hat',
    category: 'os',
    active: true,
    skillDirRelative: 'os/linux',
    dataSubDir: 'redhat_data',
    rawDataFilePrefix: ['RHSA-', 'RHBA-'],
    preprocessingScript: 'patch_preprocessing.py',
    preprocessingArgs: ['--vendor', 'redhat', '--days', '90'],
    patchesForReviewFile: 'patches_for_llm_review_redhat.json',
    aiReportFile: 'patch_review_ai_report_redhat.json',
    finalCsvFile: 'final_approved_patches_redhat.csv',
    jobName: 'run-redhat-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_redhat',
    logTag: 'REDHAT',
    aiEntityName: 'Red Hat Linux patches',
    aiVendorFieldValue: 'Red Hat',
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
        (filename.startsWith('RHSA-') || filename.startsWith('RHBA-')) && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.id || p.issueId,
        vendor: 'Red Hat',
        component: p.component || 'kernel',
        version: p.specific_version || p.version || '',
        osVersion: p.os_version || null,
        description: (p.summary || p.description || '').slice(0, 4000),
        releaseDate: p.date || null,
    }),
    csvBOM: false,
    buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
        `Read the rules explicitly from ${path.join(skillDir, 'redhat', 'SKILL.md')}. Evaluate the following ${batchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 3 of that file.\nCRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.\nDo NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${batchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`,
}
```
