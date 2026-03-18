# Product Spec — Windows Server

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `windows` |
| name | `Windows Server` |
| vendorString | `Windows Server` |
| category | `os` |
| skillDirRelative | `os/windows` |
| active | `true` |

---

## 2. Raw Data Format

- **Source system**: Microsoft Update Catalog / MSRC API (windows_collector.py)
- **File prefix(es)**: `WIN-`
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "patch_id": "WIN-Windows_Server_2025-KB5058385",
  "vendor": "Windows Server",
  "os_version": "Windows Server 2025",
  "version": "KB5058385",
  "component": "cumulative-update",
  "issued_date": "2025-12-10",
  "description": "Top 10 Critical CVEs: [...]. Known Issues: [...]. Top 5 Bug Fixes: [...]",
  "top_10_cves": [
    {"cve_id": "CVE-2025-21420", "severity": "Critical", "cvss": 9.8, "title": "Print Spooler RCE"}
  ],
  "known_issues": ["After installing, domain controllers might restart unexpectedly"],
  "top_5_bug_fixes": [
    {"area": "Storage", "component": "NTFS", "description": "Fixes NTFS corruption under high load"}
  ]
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `patch_id` | 패치 식별자 | IssueID에 사용 (WIN- prefix) |
| `os_version` | Windows Server 버전 | "Windows Server 2022" 등 |
| `version` | KB 번호 | 선택된 월별 CU의 KB 번호 |
| `component` | 컴포넌트 | 항상 `cumulative-update` |
| `issued_date` | 발표일 | YYYY-MM-DD |
| `description` | 합성된 설명 | Top CVEs + Known Issues + Bug Fixes 포함 |
| `top_10_cves` | 상위 10개 CVE 목록 | CVE ID, severity, CVSS, title |
| `known_issues` | 알려진 문제 | 설치 후 부작용 |
| `top_5_bug_fixes` | 상위 5개 버그픽스 | 비-CVE 수정사항 |

---

## 3. Filtering Requirements

- **Days window**: 180일 lookback, 90일 이전까지 (`--days 180 --days_end 90`)
  - 예: Q1 3월 리뷰 시 전년도 9월~12월 패치 대상
- **KEEP 조건**:
  - Windows Server 2016, 2019, 2022, 2025 버전별 월별 CU 전체
  - 각 버전에서 Critical/High CVE 포함된 최신 CU 1개 선택 (AI가 선택)
- **DROP 조건**:
  - 180일 이전 또는 90일 이내 패치 (quarterly lookback)
  - CVSS < 7.0이고 HA/데이터 손실 위험 없는 항목 (AI 판단)
- **데이터 전처리 특이사항**:
  - 누적 업데이트(CU)는 수백 개의 CVE 포함 — preprocessing에서 top 10 CVE 및 top 5 bug fix로 압축
  - `description` 필드에 Top CVEs + Known Issues + Bug Fixes를 합성 텍스트로 제공

---

## 4. Grouping / Output Structure

- **방식**: Version-grouped (버전그룹)
  - 그룹 키 필드: `os_version` (Windows Server 버전)
  - 그룹 ID 형식: `WINDOWS-GROUP-<version>` (예: `WINDOWS-GROUP-Windows_Server_2025`)
  - 선택 기준: 각 버전 그룹에서 Critical/High CVE 포함된 가장 최신 월별 CU 1개 선택
  - 버전당 정확히 1개 객체 출력 (AI 의무)

---

## 5. Criticality Determination

- **방법**: CVSS 점수 기반 + CVE 유형 기반

| 조건 | Criticality 분류 |
|------|----------------|
| RCE, Auth Bypass, Data Loss | Critical |
| Privilege Escalation, CVSS ≥ 8.5 | High |
| CVSS 7.0–8.5 | High |
| CVSS < 7.0, 기능 업데이트만 | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 월별 (매월 두 번째 화요일 — Patch Tuesday)
- **누적 vs 증분**: 누적 (CU는 이전 모든 패치 포함)
- **복수 데이터 소스**: No (단일 — Microsoft Update Catalog/MSRC)

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'Windows Server'`
- **Component 예시 목록**: `cumulative-update` (단일 값, 항상 동일)
- **설명에 포함/제외할 내용**:
  - 포함: 가장 심각한 RCE/Privilege Escalation CVE 요약, 데이터 손실 위험, Known Issue 언급
  - 제외: 모든 CVE 번호 나열, raw CVE 설명 복붙
- **Hallucination risk 영역**: KB 번호 혼동, Known Issue를 Exclude 사유로 과도 사용
- **제거할 raw 필드**: 해당 없음 (preprocessing에서 이미 압축됨)
- **Passthrough 필요 여부**: No (버전그룹 방식)
- **RAG exclusion 방식**: `file-hiding`
  - normalizedDirName: `windows_data/normalized`
- **특이사항**:
  - `IssueID`는 그룹의 `patch_id` 사용 (e.g., `WINDOWS-GROUP-Windows_Server_2025`)
  - `Version`은 선택된 월별 CU의 KB 번호 (e.g., `KB5058385`)
  - `OsVersion`은 Windows Server 버전 문자열
  - Known Issue가 심각하더라도 보안 위험과 안정성 위험을 함께 평가하여 결정
  - `Decision`은 `Done` 또는 `Exclude`만 허용
  - `csvBOM: true` (Excel 한글 호환)

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: Windows Server는 AD(Active Directory), IIS, SQL Server 등 핵심 기업 서비스 기반. Patch Tuesday를 통해 매월 다수의 Critical CVE가 발표되므로 신속한 검토 필요. 누적 업데이트(CU) 방식으로 특정 CVE만 선별 적용 불가.
- **주목해야 할 취약점 유형 TOP 3**:
  1. Remote Code Execution (Print Spooler, SMB, IIS, RDP)
  2. Privilege Escalation to SYSTEM (Windows Kernel, Active Directory)
  3. Authentication Bypass (Kerberos, NTLM, Active Directory)
- **AI 오판 false-positive 패턴**: CVSS < 7.0인 기능 업데이트를 Critical로 오판; Known Issue를 과도하게 Exclude 사유로 사용
- **제외 조건**: CVSS < 7.0이고 HA/데이터 손실 없는 CU; Known Issue가 보안 위험보다 심각한 경우 (단, 명확한 근거 제시 필요)

---

## 9. registry 항목

```typescript
{
    id: 'windows',
    name: 'Windows Server',
    vendorString: 'Windows Server',
    category: 'os',
    active: true,
    skillDirRelative: 'os/windows',
    dataSubDir: 'windows_data',
    rawDataFilePrefix: ['WIN-'],
    preprocessingScript: 'windows_preprocessing.py',
    preprocessingArgs: ['--days', '180', '--days_end', '90'],
    patchesForReviewFile: 'patches_for_llm_review_windows.json',
    aiReportFile: 'patch_review_ai_report_windows.json',
    finalCsvFile: 'final_approved_patches_windows.csv',
    jobName: 'run-windows-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_windows',
    logTag: 'WINDOWS',
    aiEntityName: 'Windows Server VERSION GROUPS',
    aiVendorFieldValue: 'Windows Server',
    aiComponentDefault: 'cumulative-update',
    aiVersionGrouped: true,
    aiBatchValidation: 'nonEmpty',
    ragExclusion: {
        type: 'file-hiding',
        normalizedDirName: 'windows_data/normalized',
    },
    passthrough: {
        enabled: false,
        fallbackCriticality: 'Important',
        fallbackDecision: 'Pending',
    },
    collectedFileFilter: (filename: string) =>
        filename.startsWith('WIN-') && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.patch_id,
        vendor: 'Windows Server',
        component: p.component || 'cumulative-update',
        version: p.version || '',
        osVersion: p.os_version || null,
        description: (p.description || '').slice(0, 4000),
        releaseDate: p.issued_date || null,
    }),
    csvBOM: true,
}
```
