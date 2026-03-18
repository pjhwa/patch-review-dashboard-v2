# Product Spec — SQL Server

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `sqlserver` |
| name | `SQL Server` |
| vendorString | `SQL Server` |
| category | `database` |
| skillDirRelative | `database/sqlserver` |
| active | `true` |

---

## 2. Raw Data Format

- **Source system**: Microsoft SQL Server Update Center (sqlserver_preprocessing.py)
- **File prefix(es)**: `SQLU-`
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "patch_id": "SQLS-GROUP-SQL_Server_2022",
  "vendor": "SQL Server",
  "os_version": "SQL Server 2022",
  "component": "SQL Server",
  "issued_date": "2025-11-13",
  "review_window": "2025-09-16 ~ 2025-12-16",
  "candidate_count": 3,
  "patches": [
    {
      "patch_id": "SQLU-SQL_Server_2022-KB5046862",
      "version": "KB5046862",
      "issued_date": "2025-11-13",
      "top_10_cves": [
        {"cve_id": "CVE-2025-21262", "severity": "Critical", "cvss": 9.0, "title": "SQL Server RCE"}
      ],
      "top_5_bug_fixes": [
        {"area": "Always On", "component": "AG", "description": "Fixes sync issue causing data inconsistency"}
      ],
      "known_issues": []
    }
  ]
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `patch_id` | 그룹 식별자 (SQLS-GROUP-) | IssueID에 사용 |
| `os_version` | SQL Server 버전 | "SQL Server 2022" 등 |
| `patches` | 월별 CU 목록 | 최신 → 오래된 순 정렬 |
| `patches[].version` | KB 번호 | 선택된 CU의 KB 번호 |
| `patches[].top_10_cves` | 상위 10개 CVE | CVE ID, severity, CVSS, title |
| `patches[].top_5_bug_fixes` | 상위 5개 버그픽스 | area, component, description |
| `patches[].known_issues` | 알려진 문제 | 설치 후 부작용 |
| `issued_date` | 그룹 내 최신 CU 발표일 | YYYY-MM-DD |

---

## 3. Filtering Requirements

- **Days window**: 180일 lookback, 90일 이전까지 (`--days 180 --days_end 90`)
  - 예: Q1 3월 리뷰 시 전년도 9월~12월 CU 대상
- **KEEP 조건**:
  - SQL Server 2016, 2017, 2019, 2022, 2025 버전별 월별 CU 전체
  - 각 버전에서 Critical/High 기준을 충족하는 최신 CU 1개 선택 (AI가 선택)
- **DROP 조건**:
  - 180일 이전 또는 90일 이내 CU (quarterly lookback)
  - CVSS < 7.5이고 데이터 손실/HA 위험 없는 항목 (AI 판단)
- **데이터 전처리 특이사항**:
  - 각 SQL Server 버전 = 1개 버전 그룹 (VERSION GROUP)
  - preprocessing에서 각 CU를 top 10 CVE + top 5 bug fix로 압축
  - `description` 필드에 압축된 내용을 합성 텍스트로 제공

---

## 4. Grouping / Output Structure

- **방식**: Version-grouped (버전그룹)
  - 그룹 키 필드: `os_version` (SQL Server 버전)
  - 그룹 ID 형식: `SQLS-GROUP-<version>` (예: `SQLS-GROUP-SQL_Server_2022`)
  - 선택 기준: 각 버전 그룹에서 Critical/High CVE 포함된 가장 최신 CU 1개 선택
  - 버전당 정확히 1개 객체 출력 (AI 의무)

---

## 5. Criticality Determination

- **방법**: CVSS 점수 + CVE 유형 기반

| 조건 | Criticality 분류 |
|------|----------------|
| RCE, Auth Bypass, 데이터 손실 | Critical |
| Privilege Escalation (Sysadmin), HA 실패, CVSS ≥ 8.0 | High |
| Important severity CVE, CVSS 7.0–8.0 | Important |
| 저위험 픽스만 | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 월별 (Microsoft SQL Server CU는 매월 발표)
- **누적 vs 증분**: 누적 (CU는 이전 모든 픽스 포함)
- **복수 데이터 소스**: No (단일 — Microsoft SQL Server Update Center)

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'SQL Server'`
- **Component 예시 목록**: `SQL Server` (단일 값, 항상 동일)
- **설명에 포함/제외할 내용**:
  - 포함: 가장 심각한 CVE 요약, Always On/FCI 관련 안정성 이슈, 데이터 손실 위험
  - 제외: 모든 CVE 번호 나열, raw CVE 설명 복붙
- **Hallucination risk 영역**: KB 번호 혼동, SQL Server 버전(2019 vs 2022) 혼동, Always On 대 FCI 혼동
- **제거할 raw 필드**: 해당 없음 (preprocessing에서 이미 압축됨)
- **Passthrough 필요 여부**: No (버전그룹 방식)
- **RAG exclusion 방식**: `file-hiding`
  - normalizedDirName: `sql_data/normalized`
- **특이사항**:
  - `IssueID`는 그룹의 `patch_id` 사용 (e.g., `SQLS-GROUP-SQL_Server_2022`)
  - `Version`은 선택된 CU의 KB 번호 (e.g., `KB5046862`)
  - `OsVersion`은 SQL Server 버전 문자열
  - SQL Server CU는 거의 항상 `Decision: Done` (적용 권장) — 단, 명백히 불안정한 경우만 Exclude
  - `Decision`은 `Done` 또는 `Exclude`
  - `csvBOM: true` (Excel 한글 호환)

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: SQL Server는 핵심 기업 데이터베이스 플랫폼으로 ERP, 금융, 인사 시스템 데이터를 보유. RCE 취약점은 전체 DB 서버 침해로 이어지며, Always On AG 실패는 무중단 서비스 위협. 누적 업데이트(CU) 방식으로 선택적 패치 적용 불가.
- **주목해야 할 취약점 유형 TOP 3**:
  1. Remote Code Execution (SQL Server 엔진)
  2. Privilege Escalation to Sysadmin
  3. Always On Availability Group 동기화 실패 (데이터 불일치)
- **AI 오판 false-positive 패턴**: CVSS < 7.0 기능 업데이트를 Critical로 오판; 동일 CU를 여러 버전 그룹에 중복 출력
- **제외 조건**: 저위험 픽스만 포함(CVSS < 7.0, 데이터 손실·HA 위험 없음); 명확히 불안정한 Known Issue 포함 CU

---

## 9. registry 항목

```typescript
{
    id: 'sqlserver',
    name: 'SQL Server',
    vendorString: 'SQL Server',
    category: 'database',
    active: true,
    skillDirRelative: 'database/sqlserver',
    dataSubDir: 'sql_data',
    rawDataFilePrefix: ['SQLU-'],
    preprocessingScript: 'sqlserver_preprocessing.py',
    preprocessingArgs: ['--days', '180', '--days_end', '90'],
    patchesForReviewFile: 'patches_for_llm_review_sqlserver.json',
    aiReportFile: 'patch_review_ai_report_sqlserver.json',
    finalCsvFile: 'final_approved_patches_sqlserver.csv',
    jobName: 'run-sqlserver-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_sqlserver',
    logTag: 'SQLSERVER',
    aiEntityName: 'Microsoft SQL Server VERSION GROUPS',
    aiVendorFieldValue: 'SQL Server',
    aiComponentDefault: 'SQL Server',
    aiVersionGrouped: true,
    aiBatchValidation: 'nonEmpty',
    ragExclusion: {
        type: 'file-hiding',
        normalizedDirName: 'sql_data/normalized',
    },
    passthrough: {
        enabled: false,
        fallbackCriticality: 'Important',
        fallbackDecision: 'Pending',
    },
    collectedFileFilter: (filename: string) =>
        filename.startsWith('SQLU-') && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.patch_id,
        vendor: 'SQL Server',
        component: p.component || 'SQL Server',
        version: p.version || '',
        osVersion: p.os_version || null,
        description: (p.description || '').slice(0, 4000),
        releaseDate: p.issued_date || null,
    }),
    csvBOM: true,
}
```
