# Product Spec — MySQL

> **상태**: `active: false` (플레이스홀더 — 아직 파이프라인 미구축)

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `mysql` |
| name | `MySQL` |
| vendorString | `MySQL` |
| category | `database` |
| skillDirRelative | `database/mysql` |
| active | `false` |

---

## 2. Raw Data Format

- **Source system**: 미정 (향후 구현 예정)
  - 후보: Oracle MySQL Security Advisories, CVE 데이터베이스, MySQL 공식 릴리즈 페이지
- **File prefix(es)**: 미정 (`rawDataFilePrefix: []` 현재 비어 있음)
- **Sample JSON** (예상 구조):

```json
{
  "patch_id": "MYSQL-2025-001",
  "vendor": "MySQL",
  "product": "mysql-server",
  "component": "mysql",
  "version": "8.0.41",
  "severity": "Critical",
  "cvss_score": 9.8,
  "cve_id": "CVE-2025-21234",
  "description": "Oracle Critical Patch Update advisory for MySQL Server...",
  "issued_date": "2025-10-15",
  "os_version": null
}
```

- **Field mapping table** (예상):

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `patch_id` | 패치 식별자 | IssueID에 사용 |
| `vendor` | 벤더 | `MySQL` |
| `component` | 컴포넌트 | mysql, mysql-server 등 |
| `version` | 패치 버전 | e.g., "8.0.41" |
| `severity` | 심각도 | Critical/High/Medium/Low |
| `cvss_score` | CVSS 점수 | Oracle CPU 기준 |
| `cve_id` | CVE 번호 | Oracle CPU에서 제공 |
| `description` | 상세 설명 | 4000자 이내 |
| `issued_date` | 발표일 | YYYY-MM-DD |

---

## 3. Filtering Requirements

- **Days window**: 180일 (`--days 180`, 미구현)
- **KEEP 조건** (예상):
  - severity Critical 또는 High (CVSS ≥ 7.0)
  - SQL Injection, Auth Bypass, RCE, InnoDB 데이터 손상
  - 서비스 크래시(mysqld hang/crash)
- **DROP 조건** (예상):
  - 180일 이상 된 항목
  - severity Medium/Low이고 데이터 손실·인증 우려 없는 항목
- **데이터 전처리 특이사항**:
  - Oracle CPU(Critical Patch Update)는 분기별로 발행 (1/4/7/10월)
  - 전처리 스크립트(`mysql_preprocessing.py`) 아직 미구현

---

## 4. Grouping / Output Structure

- **방식**: Individual (개별) — 예상
- 버전그룹 없음. MySQL 5.7, 8.0, 8.4(LTS), 9.x 각 버전별 개별 Advisory 예상

---

## 5. Criticality Determination

- **방법**: severity 필드 + CVSS 점수 기반 (예상)

| 조건 | Criticality 분류 |
|------|----------------|
| RCE, Auth Bypass, 데이터 손실 | Critical |
| Privilege Escalation, CVSS ≥ 8.0 | High |
| SQL Injection, CVSS 7.0–8.0 | High |
| CVSS 4.0–7.0, 서비스 영향 | Medium |
| CVSS < 4.0 | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 분기별 (Oracle CPU: 1월, 4월, 7월, 10월)
- **누적 vs 증분**: 증분 (각 CPU Advisory는 독립적)
- **복수 데이터 소스**: 미정

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'MySQL'`
- **Component 예시 목록**: `mysql`, `mysql-server`, `mysql-client`, `mysql-router`
- **설명에 포함/제외할 내용**:
  - 포함: CVE 번호, 취약점 유형, 영향받는 MySQL 버전
  - 제외: Oracle CPU 원문 복붙, 관련 없는 Oracle DB 패치 정보
- **Hallucination risk 영역**: MariaDB와 MySQL 혼동; MySQL 5.7 EOL 여부 혼동; Oracle DB(DBMS)와 MySQL 혼동
- **제거할 raw 필드**: 해당 없음 (미구현)
- **Passthrough 필요 여부**: Yes (예상)
  - fallback criticality: `'Important'`
  - fallback decision: `'Pending'`
- **RAG exclusion 방식**: 없음 (미구현)
- **특이사항**:
  - `active: false` — 현재 파이프라인 비활성
  - `rawDataFilePrefix: []` — 컬렉터 미구현으로 빈 배열
  - 활성화 전 컬렉터 및 전처리 스크립트 구현 필요
  - MySQL 5.7은 2023년 10월 EOL → 조직 내 사용 여부 확인 후 필터 설정

---

## 8. SKILL.md Context (100줄+ 필수, 활성화 시 필수)

- **이 제품이 조직에 중요한 이유**: MySQL은 웹 애플리케이션과 CMS(WordPress 등)의 표준 RDBMS. Oracle의 관리를 받으며 분기별 CPU를 통해 보안 패치 발표. MariaDB와 코드베이스 공유 부분이 있어 동일 취약점이 양쪽에 영향을 줄 수 있음.
- **주목해야 할 취약점 유형 TOP 3**:
  1. Remote Code Execution (MySQL 서버 프로세스 침해)
  2. Authentication Bypass / SQL Injection (비인가 데이터 접근)
  3. InnoDB 데이터 손상 (복구 불가능한 데이터 손실)
- **AI 오판 false-positive 패턴**: MariaDB 픽스를 MySQL 픽스로 혼동; MySQL 5.7 EOL 이후 항목을 현재 적용 필요로 오판
- **제외 조건**: EOL 버전(5.7) 전용 Advisory (조직 내 해당 버전 미사용 시); CVSS < 7.0이고 데이터 손실 없는 항목

---

## 9. registry 항목

```typescript
{
    id: 'mysql',
    name: 'MySQL',
    vendorString: 'MySQL',
    category: 'database',
    active: false,  // 활성화 전 컬렉터 및 전처리 스크립트 구현 필요
    skillDirRelative: 'database/mysql',
    dataSubDir: 'mysql_data',
    rawDataFilePrefix: [],  // 컬렉터 미구현
    preprocessingScript: 'mysql_preprocessing.py',
    preprocessingArgs: ['--days', '180'],
    patchesForReviewFile: 'patches_for_llm_review_mysql.json',
    aiReportFile: 'patch_review_ai_report_mysql.json',
    finalCsvFile: 'final_approved_patches_mysql.csv',
    jobName: 'run-mysql-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_mysql',
    logTag: 'MYSQL',
    aiEntityName: 'MySQL patches',
    aiVendorFieldValue: 'MySQL',
    aiComponentDefault: 'mysql',
    aiVersionGrouped: false,
    aiBatchValidation: 'exact',
    passthrough: {
        enabled: true,
        fallbackCriticality: 'Important',
        fallbackDecision: 'Pending',
    },
    collectedFileFilter: (filename: string) => filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.patch_id,
        vendor: 'MySQL',
        component: p.component || 'mysql',
        version: p.version || '',
        osVersion: p.os_version || null,
        description: (p.description || '').slice(0, 4000),
        releaseDate: p.issued_date || null,
    }),
    csvBOM: false,
}
```
