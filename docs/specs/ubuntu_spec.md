# Product Spec — Ubuntu Linux

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `ubuntu` |
| name | `Ubuntu Linux` |
| vendorString | `Ubuntu` |
| category | `os` |
| skillDirRelative | `os/linux` |
| active | `true` |

---

## 2. Raw Data Format

- **Source system**: Canonical GitHub ubuntu-security-notices 저장소 (ubuntu_collector.sh + jq)
- **File prefix(es)**: `USN-`
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "id": "USN-5376-4",
  "vendor": "Canonical / Ubuntu",
  "type": "Ubuntu Security Notice (USN)",
  "title": "git regression",
  "issuedDate": "2026-02-25T13:35:46Z",
  "dateStr": "2026-02-25",
  "url": "https://ubuntu.com/security/notices/USN-5376-4",
  "severity": "None",
  "overview": "git regression",
  "description": "USN-5376-1 fixed a vulnerability in Git...",
  "affected_products": ["Ubuntu 22.04 LTS"],
  "cves": [],
  "packages": ["git-1:2.34.1-1ubuntu1.16"]
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `id` | 패치 식별자 (USN-) | IssueID에 사용 |
| `severity` | 심각도 | Critical/High/Medium/Low/None |
| `dateStr` | 발표일 | YYYY-MM-DD |
| `description` | 설명 | 4000자 이내로 잘라내기 |
| `overview` | 요약 | summary로 사용 |
| `affected_products` | 영향받는 Ubuntu 버전 | os_version 추출 |
| `cves` | CVE 목록 | 배열 |
| `packages` | 패키지 및 버전 목록 | component/version 추출 |
| `url` | 원본 USN URL | reference로 사용 |

---

## 3. Filtering Requirements

- **Days window**: 90일 (`--days 90`, 컬렉터는 180일 lookback)
- **KEEP 조건**:
  - severity가 Critical 또는 High인 항목
  - SYSTEM_CORE_COMPONENTS whitelist에 해당하는 컴포넌트
  - **LTS 버전 필터**: Ubuntu 20.04 LTS, 22.04 LTS, 24.04 LTS만 대상
- **DROP 조건**:
  - 90일 이상 된 항목
  - **비-LTS 버전만 영향받는 항목** (25.10, 24.10 등 non-LTS only는 제외)
  - whitelist에 없는 비핵심 패키지
- **데이터 전처리 특이사항**:
  - 특정 커널 variant(FIPS, GCP, NVIDIA, Tegra) 전용 USN은 `full_text`의 Releases 섹션 확인 필요
  - `specific_version` 필드 활용 (추측 금지)

---

## 4. Grouping / Output Structure

- **방식**: Individual (개별)
- 버전그룹 없음. 각 USN이 개별 패치 레코드로 처리됨
- 동일 패치가 여러 USN 번호로 발행되는 경우(e.g., USN-5376-1, USN-5376-2 등) 개별 처리

---

## 5. Criticality Determination

- **방법**: severity 필드 직접 사용

| 조건 | Criticality 분류 |
|------|----------------|
| severity = 'Critical' | Critical |
| severity = 'High' 또는 CVSS ≥ 7.0 | High |
| severity = 'Medium' 또는 'Moderate' | Moderate |
| severity = 'Low' 또는 'None' | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 수시 (Canonical에서 취약점 발견 즉시 발표)
- **누적 vs 증분**: 증분 (GitHub 저장소에서 신규 파일만 수집)
- **복수 데이터 소스**: No (단일 — Canonical ubuntu-security-notices GitHub)

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'Ubuntu'`
- **Component 예시 목록**: `kernel`, `linux-hwe`, `linux-gcp`, `openssl`, `glibc`, `systemd`
- **설명에 포함/제외할 내용**:
  - 포함: 취약점 유형, 영향받는 Ubuntu LTS 버전, CVE 번호
  - 제외: 패키지 파일명 목록, 원본 USN 복붙, 비-LTS 버전 정보
- **Hallucination risk 영역**:
  - 비-LTS 버전(25.10)만 해당되는 USN을 포함하는 오류
  - 커널 variant(FIPS용 USN)를 일반 커널 패치로 혼동
  - `specific_version` 무시 후 임의 버전 출력
- **제거할 raw 필드**: 해당 없음 (preprocessing에서 필요 필드만 추출)
- **Passthrough 필요 여부**: Yes
  - fallback criticality: `'Important'`
  - fallback decision: `'Pending'`
- **RAG exclusion 방식**: `prompt-injection`
  - queryScript: `query_rag.py`
  - queryTextSampleSize: 3
- **SKILL.md 경로**: `os/linux/ubuntu/SKILL.md` (Ubuntu 전용 — redhat/oracle와 분리됨)
  - 평가 규칙은 해당 파일의 **섹션 3** 참조
  - `buildPrompt`에서 `path.join(skillDir, 'ubuntu', 'SKILL.md')`로 참조
- **특이사항**:
  - `OsVersion`은 `os_version` 필드 사용 (예: "22.04 LTS, 24.04 LTS")
  - `distVersion`은 `dist_version` 필드 사용 (primary 버전)
  - 한 USN에 대해 여러 JSON 객체 생성 금지 (LTS별로 분리하지 않음)

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: Ubuntu LTS는 클라우드 및 컨테이너 호스트로 광범위하게 사용됨. 커널 및 컨테이너 런타임 취약점은 전체 워크로드 노출 위험. Canonical의 빠른 패치 주기가 장점이나 non-LTS 혼재로 관리 복잡성 존재.
- **주목해야 할 취약점 유형 TOP 3**:
  1. 커널 컨테이너 탈출(Container Escape) 취약점
  2. Remote Code Execution (네트워크 스택, OpenSSL)
  3. Privilege Escalation (sudo, polkit, systemd)
- **AI 오판 false-positive 패턴**: non-LTS(25.10) 전용 USN 포함; 커널 FIPS/NVIDIA variant USN을 모든 시스템에 적용 가능한 것으로 오판
- **제외 조건**: non-LTS Ubuntu 버전만 영향받는 USN; severity=Low/None; whitelist 외 패키지

---

## 9. registry 항목

```typescript
{
    id: 'ubuntu',
    name: 'Ubuntu Linux',
    vendorString: 'Ubuntu',
    category: 'os',
    active: true,
    skillDirRelative: 'os/linux',
    dataSubDir: 'ubuntu_data',
    rawDataFilePrefix: ['USN-'],
    preprocessingScript: 'patch_preprocessing.py',
    preprocessingArgs: ['--vendor', 'ubuntu', '--days', '90'],
    patchesForReviewFile: 'patches_for_llm_review_ubuntu.json',
    aiReportFile: 'patch_review_ai_report_ubuntu.json',
    finalCsvFile: 'final_approved_patches_ubuntu.csv',
    jobName: 'run-ubuntu-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_ubuntu',
    logTag: 'UBUNTU',
    aiEntityName: 'Ubuntu Linux patches',
    aiVendorFieldValue: 'Ubuntu',
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
        filename.startsWith('USN-') && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.id || p.issueId,
        vendor: 'Ubuntu',
        component: p.component || 'kernel',
        version: p.specific_version || p.version || '',
        osVersion: p.os_version || null,
        description: (p.summary || p.description || '').slice(0, 4000),
        releaseDate: p.date || null,
    }),
    csvBOM: false,
    buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
        `Read the rules explicitly from ${path.join(skillDir, 'ubuntu', 'SKILL.md')}. Evaluate the following ${batchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 3 of that file.\nCRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.\nDo NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${batchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`,
}
```
