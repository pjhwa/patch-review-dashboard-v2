# Product Spec Template — Patch Review Dashboard v2

신규 제품을 추가할 때 이 템플릿을 복사하여 `docs/specs/{productId}_spec.md`로 저장하고,
`scripts/generate-product.ts`에 전달하거나 수동으로 registry 항목을 채우는 데 사용하라.

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `(예: mysql, mongodb, almalinux)` |
| name | `(예: MySQL, MongoDB, AlmaLinux)` |
| vendorString | `(DB vendor 필드에 들어갈 정확한 문자열, 예: 'MySQL', 'Oracle')` |
| category | `os` / `storage` / `database` / `virtualization` / `middleware` |
| skillDirRelative | `(예: database/mysql, os/linux)` |
| active | `true` / `false` |

---

## 2. Raw Data Format

- **Source system**: (어디서 데이터가 오는가? 예: vendor API, RSS, scraping)
- **File prefix(es)**: (파일명 prefix, 예: RHSA-, ELSA-, USN-)
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "id": "EXAMPLE-2025-0001",
  "title": "...",
  "severity": "Critical",
  "issued": "2025-01-15",
  "description": "...",
  "affected_versions": ["8.0", "8.4"],
  "cves": ["CVE-2025-12345"]
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `id` | 패치 식별자 | IssueID에 사용 |
| `severity` | 심각도 | Critical/High/Medium/Low |
| `issued` | 발표일 | YYYY-MM-DD 파싱 필요 |
| `description` | 설명 | 4000자 이내로 잘라내기 |

---

## 3. Filtering Requirements

- **Days window**: N일 (`--days N`, `--days_end` 필요 여부: Yes/No)
- **KEEP 조건**:
  - severity가 Critical 또는 High인 항목
  - (추가 조건 기술)
- **DROP 조건**:
  - N일 이상 된 항목
  - (대용량 반복 텍스트 필드 제거: faq, changelog_full 등)
- **데이터 전처리 특이사항**: (예: CVE 배열에서 description을 300자로 truncate)

---

## 4. Grouping / Output Structure

- **방식**: Individual (개별) / Version-grouped (버전그룹)
- (버전그룹인 경우만 작성)
  - 그룹 키 필드: (예: major_version)
  - 그룹 ID 형식: (예: `PROD-GROUP-<version>`)
  - 선택 기준: (예: 가장 최신 CU 중 critical fix 포함된 것 1개)

---

## 5. Criticality Determination

- **방법**: severity 필드 직접 사용 / 키워드 기반 / CVE CVSS 점수 기반

| 조건 | Criticality 분류 |
|------|----------------|
| severity = 'critical' 또는 CVSS ≥ 9.0 | Critical |
| severity = 'high' 또는 CVSS 7.0-8.9 | High |
| severity = 'moderate' | Moderate |
| severity = 'low' | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 월별 / 분기별 / 수시
- **누적 vs 증분**: 누적(전체 재발표) / 증분(신규만)
- **복수 데이터 소스**: Yes / No (있다면 소스 목록)

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'MySQL'` (AI가 Vendor 필드에 출력해야 할 정확한 문자열)
- **Component 예시 목록**: `mysql`, `mysql-server`, `mysql-client`
- **설명에 포함/제외할 내용**:
  - 포함: 어떤 취약점이 수정됐는지, 영향 범위
  - 제외: URL, 패치 파일명, 원본 changelog 복붙
- **Hallucination risk 영역**: (예: CVE 번호 조작, 버전 번호 혼동)
- **제거할 raw 필드**: (예: faq, kb_details, full_changelog → AI 프롬프트 크기 제한)
- **Passthrough 필요 여부**: Yes (모든 제품 권장) / No (버전그룹 제품)
  - fallback criticality: `'Important'`
  - fallback decision: `'Pending'`
- **RAG exclusion 방식**: `file-hiding` / `prompt-injection` / 없음
  - file-hiding이면 normalizedDirName: `(예: mysql_data/normalized)`
  - prompt-injection이면 queryScript: `query_rag.py`

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: (운영 환경, 규정 준수, 데이터 보안 관련)
- **주목해야 할 취약점 유형 TOP 3**:
  1. (예: Remote Code Execution)
  2. (예: Privilege Escalation)
  3. (예: Authentication Bypass)
- **AI 오판 false-positive 패턴**: (실수로 포함되는 낮은 위험 패치 유형)
- **제외 조건**: (예: 이미 패치된 이전 버전, 테스트 환경 전용)

---

## 9. registry 항목 (자동 생성 / 수동 채우기)

위 섹션을 채우면 아래 템플릿을 복사하여 `src/lib/products-registry.ts`의 PRODUCT_REGISTRY 배열에 추가:

```typescript
{
    id: 'PRODUCT_ID',
    name: 'Product Full Name',
    vendorString: 'Vendor String',
    category: 'database',  // os | storage | database | virtualization | middleware
    active: true,
    skillDirRelative: 'database/PRODUCT_ID',
    rawDataFilePrefix: ['PREFIX-'],
    preprocessingScript: 'PRODUCT_ID_preprocessing.py',
    preprocessingArgs: ['--days', '180'],
    patchesForReviewFile: 'patches_for_llm_review_PRODUCT_ID.json',
    aiReportFile: 'patch_review_ai_report_PRODUCT_ID.json',
    finalCsvFile: 'final_approved_patches_PRODUCT_ID.csv',
    jobName: 'run-PRODUCT_ID-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_PRODUCT_ID',
    logTag: 'PRODUCT_ID_UPPER',
    aiEntityName: 'Product Name patches',
    aiVendorFieldValue: 'Vendor String',
    aiComponentDefault: 'component_name',
    aiVersionGrouped: false,
    aiBatchValidation: 'exact',
    ragExclusion: {
        type: 'file-hiding',
        normalizedDirName: 'PRODUCT_ID_data/normalized',
    },
    passthrough: {
        enabled: true,
        fallbackCriticality: 'Important',
        fallbackDecision: 'Pending',
    },
    collectedFileFilter: (filename: string) =>
        filename.startsWith('PREFIX-') && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.patch_id,
        vendor: 'Vendor String',
        component: p.component || 'component_name',
        version: p.version || '',
        osVersion: p.os_version || null,
        description: (p.description || '').slice(0, 4000),
        releaseDate: p.issued_date || null,
    }),
    csvBOM: false,
    buildPrompt: (skillDir: string, batchSize: number, prunedBatch: any[]) =>
        `Read the rules explicitly from ${path.join(skillDir, 'SKILL.md')}. Evaluate the following ${batchSize} Product Name patches according to the strict LLM evaluation rules in section 4 of that file.\nCRITICAL MANDATE: DO NOT USE ANY TOOLS TO READ OR SEARCH THE WORKSPACE JSON FILES. IGNORE ANY PREVIOUS EXAMPLES or RAG retrievals. You must ONLY base your summary on the literal text provided below in [BATCH DATA].\nReturn ONLY a pure JSON array with EXACTLY ${batchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'Vendor String'.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`,
},
```
