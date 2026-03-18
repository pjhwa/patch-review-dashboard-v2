# Product Spec — Ceph

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `ceph` |
| name | `Ceph` |
| vendorString | `Ceph` |
| category | `storage` |
| skillDirRelative | `storage/ceph` |
| active | `true` |

---

## 2. Raw Data Format

- **Source system**: GitHub Security Advisories (GHSA) + Ceph Redmine 이슈 트래커 (ceph_collector.py)
- **File prefix(es)**: `GHSA-`, `REDMINE-`
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "patch_id": "GHSA-mgrm-g92q-f8h8",
  "vendor": "Ceph",
  "component": "ceph-rgw",
  "version": "18.2.x",
  "severity": "High",
  "cvss_score": 8.1,
  "cve_id": "CVE-2025-23456",
  "category": "Security (Critical)",
  "title": "RGW object storage unauthorized access via crafted request",
  "description": "An attacker can exploit this vulnerability to access objects without proper authentication.",
  "issued_date": "2025-11-11"
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `patch_id` | 패치 식별자 (GHSA-/REDMINE-) | IssueID에 사용 |
| `vendor` | 벤더 | 항상 `Ceph` |
| `component` | Ceph 컴포넌트 | ceph-rgw, ceph-osd, ceph-mon 등 |
| `version` | 영향받는 버전 | e.g., "18.2.x" |
| `severity` | 심각도 | Critical/High/Medium/Low |
| `cvss_score` | CVSS 점수 | 숫자 |
| `cve_id` | CVE 번호 | 선택적 |
| `category` | 이슈 카테고리 | Security/Data Integrity/Performance 등 |
| `title` | 제목 | 짧은 설명 |
| `description` | 상세 설명 | 4000자 이내로 잘라내기 |
| `issued_date` | 발표일 | YYYY-MM-DD |

---

## 3. Filtering Requirements

- **Days window**: 180일 (`--days 180`)
- **KEEP 조건**:
  - severity가 Critical 또는 High인 항목 (CVSS ≥ 7.0)
  - DoS 가능 취약점 (rgw, mon, osd 대상)
  - 데이터 무결성 위험 (osd corruption, 복제 실패)
- **DROP 조건**:
  - 180일 이상 된 항목
  - severity Medium/Low이고 데이터 손실·인증 우회 없는 항목
  - 문서 업데이트, 소규모 성능 개선만 포함
- **데이터 전처리 특이사항**:
  - GHSA는 GitHub Advisory API에서 수집 (Ceph 저장소 기준)
  - REDMINE은 tracker.ceph.com에서 수집
  - `description`은 4000자로 truncate

---

## 4. Grouping / Output Structure

- **방식**: Individual (개별)
- 버전그룹 없음. 각 GHSA/REDMINE 이슈가 개별 패치 레코드로 처리됨
- 동일 CVE가 여러 Ceph 버전에 영향을 주더라도 단일 레코드로 처리

---

## 5. Criticality Determination

- **방법**: severity 필드 + CVSS 점수 + 카테고리 기반

| 조건 | Criticality 분류 |
|------|----------------|
| 데이터 손실, 클러스터 크래시, RCE | Critical |
| DoS on major daemon, Auth Bypass, CVSS ≥ 8.0 | High |
| 복제 불일치, CVSS 7.0–8.0 | High |
| 소규모 서비스 저하, CVSS 4.0–7.0 | Medium |
| CVSS < 4.0, 문서만 | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 수시 (취약점 발견 즉시, Ceph 릴리즈 주기와 별개)
- **누적 vs 증분**: 증분 (신규 Advisory/이슈만 수집)
- **복수 데이터 소스**: Yes
  - GitHub Security Advisories (GHSA): 공식 CVE 발표
  - Ceph Redmine (REDMINE): 버그 픽스 릴리즈 노트

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'Ceph'`
- **Component 예시 목록**: `ceph`, `ceph-osd`, `ceph-mon`, `ceph-mds`, `ceph-mgr`, `ceph-rgw` (= Rados Gateway)
- **설명에 포함/제외할 내용**:
  - 포함: 영향받는 Ceph 데몬, 취약점 유형, 데이터 손실/인증 우회 여부
  - 제외: Ceph 내부 diff 내용, raw Git commit 복붙
- **Hallucination risk 영역**: Ceph 버전 번호 혼동 (Quincy=17.x, Reef=18.x, Squid=19.x); GHSA와 CVE ID 혼용
- **제거할 raw 필드**: 해당 없음 (preprocessing에서 필요 필드만 추출)
- **Passthrough 필요 여부**: Yes
  - fallback criticality: `'Important'`
  - fallback decision: `'Pending'`
- **RAG exclusion 방식**: `file-hiding`
  - normalizedDirName: `ceph_data/normalized`
- **특이사항**:
  - `Decision`은 `Include` 또는 `Exclude`
  - Component는 반드시 구체적인 Ceph 데몬명 사용 (단순 `ceph` 대신 `ceph-osd` 등)

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: Ceph는 블록·오브젝트·파일시스템 스토리지를 통합 제공하는 분산 스토리지 플랫폼. 모든 상위 워크로드(VM, 컨테이너, 백업)의 데이터 저장소로 사용됨. OSD 장애 또는 MON quorum 손실 시 전체 스토리지 클러스터 불가용.
- **주목해야 할 취약점 유형 TOP 3**:
  1. Rados Gateway(RGW) 인증 우회 — 객체 스토리지 무단 접근
  2. OSD 데이터 손상 — 블록 레벨 I/O 오류 및 복제 실패
  3. MON quorum 손실 — 클러스터 전체 읽기/쓰기 불가
- **AI 오판 false-positive 패턴**: 성능 최적화 패치를 데이터 무결성 이슈로 오분류; CVSS 4.x 항목을 High로 상향 분류
- **제외 조건**: CVSS < 7.0이고 데이터 손실/인증 우려 없는 항목; 문서 업데이트만 포함; 이미 적용된 이전 버전 픽스

---

## 9. registry 항목

```typescript
{
    id: 'ceph',
    name: 'Ceph',
    vendorString: 'Ceph',
    category: 'storage',
    active: true,
    skillDirRelative: 'storage/ceph',
    dataSubDir: 'ceph_data',
    rawDataFilePrefix: ['GHSA-', 'REDMINE-'],
    preprocessingScript: 'ceph_preprocessing.py',
    preprocessingArgs: ['--days', '180'],
    patchesForReviewFile: 'patches_for_llm_review_ceph.json',
    aiReportFile: 'patch_review_ai_report_ceph.json',
    finalCsvFile: 'final_approved_patches_ceph.csv',
    jobName: 'run-ceph-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_ceph',
    logTag: 'CEPH',
    aiEntityName: 'Ceph storage patches',
    aiVendorFieldValue: 'Ceph',
    aiComponentDefault: 'ceph',
    aiVersionGrouped: false,
    aiBatchValidation: 'exact',
    ragExclusion: {
        type: 'file-hiding',
        normalizedDirName: 'ceph_data/normalized',
    },
    passthrough: {
        enabled: true,
        fallbackCriticality: 'Important',
        fallbackDecision: 'Pending',
    },
    collectedFileFilter: (filename: string) =>
        (filename.startsWith('GHSA-') || filename.startsWith('REDMINE-')) && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.patch_id,
        vendor: 'Ceph',
        component: p.component || 'ceph',
        version: p.version || '',
        osVersion: p.os_version || null,
        description: (p.description || '').slice(0, 4000),
        releaseDate: p.issued_date || null,
    }),
    csvBOM: false,
}
```
