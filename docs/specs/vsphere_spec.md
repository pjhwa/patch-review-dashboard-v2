# Product Spec — VMware vSphere

---

## 1. Identity

| 필드 | 값 |
|------|----|
| productId | `vsphere` |
| name | `VMware vSphere` |
| vendorString | `VMware vSphere` |
| category | `virtualization` |
| skillDirRelative | `virtualization/vsphere` |
| active | `true` |

---

## 2. Raw Data Format

- **Source system**: VMware Security Advisories (VMSA) 및 Update/Patch 릴리즈 (vsphere_preprocessing.py)
- **File prefix(es)**: `VSPH-`
- **Sample JSON** (실제 원본 데이터 구조 예시):

```json
{
  "patch_id": "VSPH-VMSA-2025-0016_ESXi_7.0",
  "vendor": "VMware vSphere",
  "product": "ESXi 7.0 U3w",
  "published": "2025-09-29",
  "severity": "Critical",
  "description": "Top Critical CVEs: [CVE-2025-22234 (CVSS 9.8) - ESXi heap overflow RCE]. Known Issues: None. Key Bug Fixes: [vMotion stability improvement]",
  "component": "ESXi",
  "version": "7.0 U3w"
}
```

- **Field mapping table**:

| Raw Field | 의미 | 비고 |
|-----------|------|------|
| `patch_id` | 패치 식별자 (VSPH- prefix) | IssueID에 사용 |
| `vendor` | 벤더 | 항상 `VMware vSphere` |
| `product` | 컴포넌트 + 버전 | "ESXi 7.0 U3w", "vCenter Server 8.0 U3d" 등 |
| `published` | 발표일 | YYYY-MM-DD |
| `severity` | 심각도 | Critical/High/Medium/Low |
| `description` | 합성된 설명 | Top CVEs + Known Issues + Key Bug Fixes 포함 |
| `component` | vSphere 컴포넌트 | ESXi, vCenter Server, vSAN, NSX 등 |
| `version` | 패치 버전 | e.g., "7.0 U3w" |

---

## 3. Filtering Requirements

- **Days window**: 180일 lookback, 90일 이전까지 (`--days 180`, quarterly lookback)
  - 예: Q1 3월 리뷰 시 전년도 9월~12월 Advisory 대상
- **KEEP 조건**:
  - CVSS ≥ 8.5인 Critical CVE 포함 Advisory
  - 활발히 악용되는 RCE, Privilege Escalation 포함 항목
  - ESXi HA, vMotion, Storage 가용성 실패 관련 항목
- **DROP 조건**:
  - 180일 이전 또는 90일 이내 항목 (quarterly lookback)
  - CVSS < 7.0이고 HA/데이터 손실 위험 없는 항목
  - 단순 기능 업데이트 또는 문서 업데이트만 포함
- **데이터 전처리 특이사항**:
  - `security_advisory` (VMSA-*) 타입과 `update_release` 타입 구분
  - preprocessing에서 Top CVEs + Known Issues + Key Bug Fixes로 압축
  - `description` 필드에 합성 텍스트 제공

---

## 4. Grouping / Output Structure

- **방식**: Individual (개별) — 각 Advisory가 개별 레코드로 처리됨
- 버전그룹 없음. 단, 동일 VMSA가 여러 컴포넌트(ESXi, vCenter)에 영향을 줄 경우 컴포넌트별로 별도 레코드 가능
- `preprocessedPatchMapper`에서 `product` 필드를 `component`와 `version` 양쪽에 사용

---

## 5. Criticality Determination

- **방법**: CVSS 점수 + Advisory 타입 기반

| 조건 | Criticality 분류 |
|------|----------------|
| 데이터 손실, 하이퍼바이저 크래시, RCE | Critical |
| DoS on ESXi/vCenter, Auth Bypass, CVSS ≥ 8.5 | High |
| HA/vMotion 실패, CVSS 7.0–8.5 | High |
| 소규모 성능 저하, CVSS 4.0–7.0 | Medium |
| CVSS < 4.0, 문서만 | Low |

---

## 6. Data Release Pattern

- **발표 주기**: 수시 (취약점 발견 즉시 VMSA 발표; 정기 패치는 분기별)
- **누적 vs 증분**: 증분 (각 VMSA는 독립적 Advisory)
- **복수 데이터 소스**: Yes
  - VMSA (Security Advisory): VMware Security Response Center
  - Update/Patch Release: VMware Product Patches 포털

---

## 7. AI Review Special Instructions

- **Vendor 필드 정확한 값**: `'VMware vSphere'`
- **Component 예시 목록**: `ESXi`, `vCenter Server`, `vSAN`, `NSX`
- **설명에 포함/제외할 내용**:
  - 포함: 가장 심각한 CVE 요약(RCE/권한상승), 영향받는 vSphere 버전, 데이터 손실/HA 위험
  - 제외: 모든 CVE 번호 나열, raw VMSA 텍스트 복붙
- **Hallucination risk 영역**:
  - ESXi 버전(6.7, 7.0, 8.0) 혼동
  - `update_release` 타입을 보안 취약점으로 오분류
  - VMSA 번호와 CVE 번호 혼용
- **제거할 raw 필드**: 해당 없음 (preprocessing에서 이미 압축됨)
- **Passthrough 필요 여부**: Yes
  - fallback criticality: `'Important'`
  - fallback decision: `'Pending'`
- **RAG exclusion 방식**: 없음 (`ragExclusion` 미설정)
- **특이사항**:
  - `update_release` 타입은 HA/vMotion/Storage 실패 해결 시에만 포함
  - `Decision`은 `Done` 또는 `Exclude`
  - `Component`는 구체적인 vSphere 컴포넌트명 사용 (단순 `vsphere` 대신 `ESXi`, `vCenter Server` 등)
  - `csvBOM: false`

---

## 8. SKILL.md Context (100줄+ 필수)

- **이 제품이 조직에 중요한 이유**: VMware vSphere는 서버 가상화 플랫폼으로 모든 VM 워크로드의 기반. ESXi 하이퍼바이저 침해는 상위의 모든 VM에 영향. vCenter 침해는 전체 가상화 인프라 관리 권한 탈취 위험. 규정 준수(CC인증, ISMS) 대상 가상환경에 적용됨.
- **주목해야 할 취약점 유형 TOP 3**:
  1. ESXi 하이퍼바이저 RCE (VM 탈출/호스트 침해)
  2. vCenter Server 인증 우회 (전체 인프라 관리 권한 탈취)
  3. vSAN 데이터 무결성 오류 / vMotion 실패 (서비스 가용성)
- **AI 오판 false-positive 패턴**: `update_release` 타입을 보안 취약점으로 과잉 분류; CVSS 4.x 항목을 High로 상향
- **제외 조건**: CVSS < 7.0이고 HA/데이터 손실 없는 항목; 단순 기능 추가/문서 업데이트; Known Issue가 보안 위험보다 심각하여 설치 불가 판단 시

---

## 9. registry 항목

```typescript
{
    id: 'vsphere',
    name: 'VMware vSphere',
    vendorString: 'VMware vSphere',
    category: 'virtualization',
    active: true,
    skillDirRelative: 'virtualization/vsphere',
    dataSubDir: 'vsphere_data',
    rawDataFilePrefix: ['VSPH-'],
    preprocessingScript: 'vsphere_preprocessing.py',
    preprocessingArgs: ['--days', '180'],
    patchesForReviewFile: 'patches_for_llm_review_vsphere.json',
    aiReportFile: 'patch_review_ai_report_vsphere.json',
    finalCsvFile: 'final_approved_patches_vsphere.csv',
    jobName: 'run-vsphere-pipeline',
    rateLimitFlag: '/tmp/.rate_limit_vsphere',
    logTag: 'VSPHERE',
    aiEntityName: 'VMware vSphere patches',
    aiVendorFieldValue: 'VMware vSphere',
    aiComponentDefault: 'vsphere',
    aiVersionGrouped: false,
    aiBatchValidation: 'exact',
    passthrough: {
        enabled: true,
        fallbackCriticality: 'Important',
        fallbackDecision: 'Pending',
    },
    collectedFileFilter: (filename: string) =>
        filename.startsWith('VSPH-') && filename.endsWith('.json'),
    preprocessedPatchMapper: (p: any) => ({
        issueId: p.patch_id,
        vendor: 'VMware vSphere',
        component: p.product || 'vsphere',
        version: p.product || '',
        osVersion: null,
        description: (p.description || '').slice(0, 4000),
        releaseDate: p.published || null,
    }),
    csvBOM: false,
}
```
