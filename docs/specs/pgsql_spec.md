# Product Spec — PostgreSQL

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `pgsql` |
| name | `PostgreSQL` |
| vendorString | `PostgreSQL` |
| category | `database` |
| skillDirRelative | `database/pgsql` |
| active | `true` |

---

## 2. Raw Data Format

- **Source system**: PostgreSQL 공식 릴리즈 페이지 (pgsql_preprocessing.py)
- **File prefix(es)**: `PGSL-`
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "id": "PGSL-2025-Nov-PostgreSQL_14",
  "vendor": "PostgreSQL Global Development Group",
  "product": "PostgreSQL 14",
  "month": "2025-Nov",
  "type": "Security Update",
  "release_version": "14.14",
  "release_date": "2025-11-21",
  "release_url": "https://www.postgresql.org/about/news/postgresql-1414-released/",
  "vulnerabilities": [
    {
      "cve": "CVE-2025-24455",
      "severity": "High",
      "cvss_base_score": 8.8,
      "description": "Privilege escalation via ..."
    }
  ],
  "non_cve_fixes": [
    "Fix bug in query plan cache invalidation"
  ],
  "stats": {
    "total_cves": 3,
    "critical_count": 0,
    "high_count": 3,
    "max_cvss_base": 8.8
  }
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `id` | 패치 식별자 (PGSL- prefix) | 전처리 후 `id`/`patch_id` 동시 사용 |
| `vendor` | 벤더 | raw 파일에서 `PostgreSQL Global Development Group` (전처리에서 `PostgreSQL`로 변환) |
| `product` | 제품명 + 메이저 버전 | "PostgreSQL 14" 등 |
| `month` | 패치 발표 월 | "2025-Nov" 형식 |
| `release_version` | 패치 버전 | e.g., "14.14" (전처리에서 `version`으로 사용) |
| `release_date` | 발표일 | YYYY-MM-DD (전처리에서 `issued_date`/`date`로 변환) |
| `vulnerabilities` | CVE 목록 배열 | cve, severity, cvss_base_score, description 포함 |
| `non_cve_fixes` | 비-CVE 버그픽스 목록 | 전처리에서 description에 포함 |
| `stats` | 통계 요약 | total_cves, high_count, max_cvss_base 등 |

---

## 3. Filtering Requirements

- **Days window**: 180일 (`--days 180`)
- **KEEP 조건**:
  - severity가 Critical 또는 High인 항목 (max_cvss ≥ 7.0)
  - SQL Injection, Auth Bypass, RCE, WAL 손상, 인덱스 손상 관련 항목
  - 복제 실패(streaming replication, logical replication) 관련 항목
- **DROP 조건**:
  - 180일 이상 된 항목
  - severity Medium/Low이고 데이터 손실·인증 우려 없는 항목
  - 소규모 성능 개선이나 문서 업데이트만 포함
- **데이터 전처리 특이사항**:
  - PostgreSQL은 마이너 릴리즈(14.x, 15.x, 16.x)별로 별도 파일 생성
  - `patch_id` 형식: `PGSL-{year}-{month}-PostgreSQL_{majorVersion}`
  - `description`에 CVE 정보와 버그픽스가 혼합됨 → AI에게 추상화 요약 지시
  - `description` 4000자 truncate

---

## 4. Grouping / Output Structure

- **방식**: Individual (개별)
- 버전그룹 없음. 각 PostgreSQL 마이너 릴리즈가 개별 패치 레코드로 처리됨
- PostgreSQL은 모든 지원 버전(예: 12, 13, 14, 15, 16, 17)을 동시에 릴리즈하므로 여러 레코드 생성

---

## 5. Criticality Determination

- **방법**: severity 필드 + CVSS 점수 기반

| 조건 | Criticality 분류 |
|------|----------------|
| RCE, Auth Bypass, WAL 손상 | Critical |
| Privilege Escalation, CVSS ≥ 8.0 | High |
| SQL Injection, 인덱스 손상, CVSS 7.0–8.0 | High |
| 복제 실패, CVSS 4.0–7.0 | Medium |
| CVSS < 4.0, 소규모 픽스 | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 분기별 (보통 2월, 5월, 8월, 11월 둘째 주 목요일)
- **누적 vs 증분**: 누적 (마이너 릴리즈는 이전 모든 픽스 포함)
- **복수 데이터 소스**: No (단일 — PostgreSQL 공식 릴리즈 발표)

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'PostgreSQL'`
- **Component 예시 목록**: `postgresql`, `postgresql-server`, `postgresql-contrib`
- **설명에 포함/제외할 내용**:
  - 포함: CVE 번호(있을 경우), 취약점 유형(privilege escalation, WAL corruption 등), 영향받는 버전
  - 제외: `.patch` 파일명 목록, raw commit 내용 복붙, 패키지 목록 나열
- **Hallucination risk 영역**:
  - PostgreSQL 메이저 버전(14 vs 15) 혼동
  - PGSL ID를 임의 CVE 번호로 대체
  - `version` 필드에 "Unknown" 또는 "14.x" 형태의 플레이스홀더 사용 (실제 마이너 버전 사용 필수)
- **제거할 raw 필드**: 해당 없음 (preprocessing에서 추출)
- **Passthrough 필요 여부**: Yes
  - fallback criticality: `'Important'`
  - fallback decision: `'Pending'`
- **RAG exclusion 방식**: `file-hiding`
  - normalizedDirName: `pgsql_data/normalized`
- **특이사항**:
  - `Version`은 반드시 실제 PostgreSQL 버전 (e.g., `14.14`, `16.6`) — "Unknown" 금지
  - `patch_id`가 `PGSL-2025-Nov-PostgreSQL_14`이면 Version = 해당 릴리즈의 마이너 버전
  - `Decision`은 `Include` 또는 `Exclude`
  - `csvBOM: false`

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: PostgreSQL은 오픈소스 RDBMS의 표준으로 금융, 공공, 빅데이터 시스템에 광범위하게 사용됨. WAL(Write-Ahead Logging) 손상은 복구 불가능한 데이터 손실을 야기하며, 복제 실패는 읽기 전용 HA 구성 전체를 위협. EOL 버전(12 이하) 사용 시 취약점 미패치 위험.
- **주목해야 할 취약점 유형 TOP 3**:
  1. Privilege Escalation (superuser 권한 획득)
  2. SQL Injection / Authentication Bypass (비인가 데이터 접근)
  3. WAL 손상 / 복제 실패 (데이터 손실)
- **AI 오판 false-positive 패턴**: 마이너 버전별 동일 픽스를 별개 취약점으로 오인; PGSL ID를 CVE 번호로 혼용; Version 필드에 플레이스홀더 사용
- **제외 조건**: severity Medium/Low이고 데이터 손실·인증 우려 없는 항목; 문서/주석 변경만 포함; EOL 버전(12 이하)만 영향받는 항목 (단, 조직 내 사용 버전 확인 필요)

---

## 9. registry 항목

```typescript
{
    id: 'pgsql',
    name: 'PostgreSQL',
    vendorString: 'PostgreSQL',
    category: 'database',
    active: true,
    skillDirRelative: 'database/pgsql',
    dataSubDir: 'pgsql_data',
    rawDataFilePrefix: ['PGSL-'],
    preprocessingScript: 'pgsql_preprocessing.py',
    preprocessingArgs: ['--days', '180'],
    patchesForReviewFile: 'patches_for_llm_review_pgsql.json',
    aiReportFile: 'patch_review_ai_report_pgsql.json',
    finalCsvFile: 'final_approved_patches_pgsql.csv',
    jobName: 'run-pgsql-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_pgsql',
    logTag: 'PGSQL',
    aiEntityName: 'PostgreSQL database patches',
    aiVendorFieldValue: 'PostgreSQL',
    aiComponentDefault: 'postgresql',
    aiVersionGrouped: false,
    aiBatchValidation: 'exact',
    ragExclusion: {
        type: 'file-hiding',
        normalizedDirName: 'pgsql_data/normalized',
    },
    passthrough: {
        enabled: true,
        fallbackCriticality: 'Important',
        fallbackDecision: 'Pending',
    },
    collectedFileFilter: (filename: string) =>
        filename.startsWith('PGSL-') && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.patch_id,
        vendor: 'PostgreSQL',
        component: p.component || 'postgresql',
        version: p.version || '',
        osVersion: p.os_version || null,
        description: (p.description || '').slice(0, 4000),
        releaseDate: p.issued_date || null,
    }),
    csvBOM: false,
}
```
