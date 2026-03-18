# Product Spec — MariaDB

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `mariadb` |
| name | `MariaDB` |
| vendorString | `MariaDB` |
| category | `database` |
| skillDirRelative | `database/mariadb` |
| active | `true` |

---

## 2. Raw Data Format

- **Source system**: Red Hat Security Advisory (RHSA/RHBA) — MariaDB 관련 항목 필터링 (mariadb_preprocessing.py)
- **File prefix(es)**: `RHSA-`, `RHBA-`
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "id": "RHSA-2025:19572",
  "vendor": "Red Hat",
  "type": "Security Advisory (RHSA)",
  "title": "Important: mariadb:10.5 security update",
  "mariadbVersion": "10.5.27",
  "issuedDate": "2025-11-12T00:00:00Z",
  "updatedDate": "2025-11-12T00:00:00Z",
  "pubDate": "2025-11-12T00:00:00Z",
  "dateStr": "2025-11-12",
  "url": "https://access.redhat.com/errata/RHSA-2025:19572",
  "severity": "Important",
  "overview": "Updated mariadb packages that fix several security issues.",
  "description": "...",
  "affected_products": ["Red Hat Enterprise Linux AppStream (v. 8)"],
  "cves": ["CVE-2025-12345"],
  "packages": ["mariadb-10.5.27-1.module+el8.10.0+21234+abc.x86_64"],
  "all_packages_count": 12,
  "full_text": "..."
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `id` | 패치 식별자 (RHSA-/RHBA- prefix) | 전처리 후 `id`/`patch_id` 동시 사용 |
| `vendor` | 벤더 | raw 파일에서 `Red Hat` (전처리에서 `MariaDB`로 변환) |
| `type` | Advisory 유형 | Security Advisory (RHSA) / Bug Fix Advisory (RHBA) |
| `mariadbVersion` | MariaDB 버전 | 전처리에서 `version` 필드로 사용 |
| `severity` | 심각도 | Critical/Important/Moderate/Low |
| `description` | 상세 설명 | 4000자 이내로 잘라내기 |
| `dateStr` | 발표일 | YYYY-MM-DD (전처리에서 `issued_date`로 변환) |
| `affected_products` | 영향받는 RHEL 버전 | 전처리에서 `os_version` 추출에 사용 |

---

## 3. Filtering Requirements

- **Days window**: 180일 (`--days 180`)
- **KEEP 조건**:
  - severity가 Critical 또는 High인 항목 (CVSS ≥ 7.0)
  - SQL Injection, Auth Bypass, RCE, InnoDB 데이터 손상 관련 항목
  - 서비스 크래시(mysqld hang/crash) 관련 항목
- **DROP 조건**:
  - 180일 이상 된 항목
  - severity Moderate/Low이고 데이터 손실·인증 우려 없는 항목
  - GUI 업데이트, 문서 업데이트만 포함
- **데이터 전처리 특이사항**:
  - RHSA/RHBA 원본 데이터에서 MariaDB 관련 Advisory만 필터링
  - `description` 필드에 패치 파일명(`.patch`) 또는 RPM 파일명 목록이 포함되어 있을 수 있음 → AI에게 추상화 요약 지시 필수
  - `description` 4000자 truncate

---

## 4. Grouping / Output Structure

- **방식**: Individual (개별)
- 버전그룹 없음. 각 RHSA/RHBA Advisory가 개별 패치 레코드로 처리됨
- MariaDB 버전(10.4, 10.5, 10.6, 10.11)별 별도 Advisory로 발행됨

---

## 5. Criticality Determination

- **방법**: severity 필드 + CVSS 점수 기반

| 조건 | Criticality 분류 |
|------|----------------|
| RCE, Auth Bypass, 데이터 손실 | Critical |
| Privilege Escalation, CVSS ≥ 8.0 | High |
| SQL Injection, CVSS 7.0–8.0 | High |
| CVSS 4.0–7.0, 서비스 영향 | Medium |
| CVSS < 4.0, 문서만 | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 수시 (Red Hat Errata 릴리즈 기준, MariaDB는 분기별 릴리즈 주기)
- **누적 vs 증분**: 증분 (신규 Advisory만 수집)
- **복수 데이터 소스**: No (단일 — Red Hat Errata에서 MariaDB 항목 필터링)

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'MariaDB'`
- **Component 예시 목록**: `mariadb`, `mariadb-server`, `mariadb-galera`, `mariadb-common`
- **설명에 포함/제외할 내용**:
  - 포함: 취약점 유형(SQL injection, RCE 등), 영향받는 MariaDB 버전, CVE 번호
  - 제외: `.patch` 파일명 목록, RPM 패키지명 나열, 원본 changelog 복붙
- **Hallucination risk 영역**:
  - `.patch` 파일명을 취약점 ID로 혼동
  - MariaDB 버전과 MySQL 버전 혼동
  - InnoDB와 MyISAM 엔진 구분 오류
- **제거할 raw 필드**: 해당 없음 (preprocessing에서 추출)
- **Passthrough 필요 여부**: Yes
  - fallback criticality: `'Important'`
  - fallback decision: `'Pending'`
- **RAG exclusion 방식**: `file-hiding`
  - normalizedDirName: `mariadb_data/normalized`
- **특이사항**:
  - Description/KoreanDescription에 `.patch` 파일명 또는 raw changelog 삽입 금지 (SKILL.md 명시)
  - `Decision`은 `Include` 또는 `Exclude`
  - `csvBOM: true` (Excel 한글 호환)

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: MariaDB는 핵심 RDBMS로 다수의 비즈니스 애플리케이션 데이터를 관리. SQL Injection이나 인증 우회는 민감 데이터 유출로 직결. InnoDB 데이터 손상은 복구 불가능한 데이터 손실을 야기할 수 있음.
- **주목해야 할 취약점 유형 TOP 3**:
  1. SQL Injection / Authentication Bypass (비인가 데이터 접근)
  2. Remote Code Execution (mysqld 프로세스 침해)
  3. InnoDB 데이터 손상 / Galera Cluster 복제 실패
- **AI 오판 false-positive 패턴**: `.patch` 파일명을 CVE 번호로 오인; MariaDB 버전별 동일 픽스를 중복 포함
- **제외 조건**: severity Moderate/Low이고 데이터 손실·인증 우려 없는 항목; 문서/GUI 업데이트만 포함; 이미 적용된 이전 버전 픽스

---

## 9. registry 항목

```typescript
{
    id: 'mariadb',
    name: 'MariaDB',
    vendorString: 'MariaDB',
    category: 'database',
    active: true,
    skillDirRelative: 'database/mariadb',
    dataSubDir: 'mariadb_data',
    rawDataFilePrefix: ['RHSA-', 'RHBA-'],
    preprocessingScript: 'mariadb_preprocessing.py',
    preprocessingArgs: ['--days', '180'],
    patchesForReviewFile: 'patches_for_llm_review_mariadb.json',
    aiReportFile: 'patch_review_ai_report_mariadb.json',
    finalCsvFile: 'final_approved_patches_mariadb.csv',
    jobName: 'run-mariadb-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_mariadb',
    logTag: 'MARIADB',
    aiEntityName: 'MariaDB database patches',
    aiVendorFieldValue: 'MariaDB',
    aiComponentDefault: 'mariadb',
    aiVersionGrouped: false,
    aiBatchValidation: 'exact',
    ragExclusion: {
        type: 'file-hiding',
        normalizedDirName: 'mariadb_data/normalized',
    },
    passthrough: {
        enabled: true,
        fallbackCriticality: 'Important',
        fallbackDecision: 'Pending',
    },
    collectedFileFilter: (filename: string) =>
        (filename.startsWith('RHSA-') || filename.startsWith('RHBA-')) && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.patch_id,
        vendor: 'MariaDB',
        component: p.component || 'mariadb',
        version: p.version || '',
        osVersion: p.os_version || null,
        description: (p.description || '').slice(0, 4000),
        releaseDate: p.issued_date || null,
    }),
    csvBOM: true,
}
```
