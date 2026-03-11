# 📊 Implementation Gap Report

> **Last Updated**: 2026-03-11 | **기준**: 현재 운영 코드 vs. 초기 설계

---

## 🔄 아키텍처 변경 이력 (설계 → 현행)

| 항목 | 초기 설계 | 현행 구현 | 상태 |
|---|---|---|---|
| **데이터 수집** | `batch_collector.js` 파이프라인 내 실행 | Linux CRON + 벤더별 독립 수집기 | ✅ 개선 완료 |
| **원시 데이터 저장** | `RawPatch` DB 테이블 | 디스크 JSON 파일 (`redhat_data/`, `oracle_data/`, `ubuntu_data/`) | ✅ 개선 완료 |
| **수집 카운트 표시** | `RawPatch` DB 쿼리 | JSON 파일 수 카운트 | ✅ 수정 완료 |
| **AI 리뷰 실행** | 파이프라인 내 단순 스크립트 호출 | BullMQ 큐 + SSE 실시간 스트리밍 | ✅ 구현 완료 |
| **AI 결과 검증** | 없음 | PreprocessedPatch 교차 검증 + Passthrough | ✅ 추가 완료 |
| **오류 표시** | 단순 "Pipeline Failed." | 구체적 오류 메시지 (`❌ Pipeline Failed: [상세]`) | ✅ 개선 완료 |

---

## 📌 현행 구현 현황

### 완전 구현 ✅

| 기능 | 위치 | 설명 |
|---|---|---|
| 벤더별 독립 수집기 | `pipeline_scripts/redhat/`, `oracle/`, `ubuntu/` | Red Hat CSAF, Oracle 스크래핑, Ubuntu USN |
| CRON 래퍼 | `pipeline_scripts/run_collectors_cron.sh` | 분기별 전체 수집기 순차 실행 |
| 전처리 & 필터링 | `pipeline_scripts/patch_preprocessing.py` | Core Component 화이트리스트, 날짜 필터, CVE 중복 제거 |
| AI 리뷰 (OpenClaw) | `src/lib/queue.ts` | SKILL.md 기반, Passthrough 포함 |
| 실시간 로그 스트리밍 | `src/app/api/pipeline/stream/route.ts` | SSE, [PREPROCESS_DONE] 감지 |
| RAG 피드백 루프 | `pipeline_scripts/query_rag.py` + `sync_rag.py` | 사용자 Exclude 피드백 → AI 프롬프트 주입 |
| 관리자 Approve/Exclude | `ClientPage.tsx` | UserFeedback 저장, 상태 업데이트 |
| 대시보드 카운터 | `src/app/api/products/route.ts` | 수집(파일 수)/전처리/AI리뷰/승인 4단계 |

### 부분 구현 ⚠️

| 기능 | 현황 | Gap |
|---|---|---|
| AI 영향도 분류 | SKILL.md 필터로 Critical만 선별, Passthrough로 나머지 Important 채움 | Passthrough 패치의 한국어 번역 미완성 (영문 원문 사용) |
| 아카이브 기능 | API 존재 (`/api/pipeline/archive`) | UI에서 접근 가능하나 상세 기능 미완성 |
| 수동 리뷰(Manual Review) | API 존재 (`/api/pipeline/manually-review`) | UI 연동 완성도 부족 |

### 미구현 ❌

| 기능 | 우선순위 | 참고 |
|---|---|---|
| middleware/database/network 카테고리 | Low | OS 카테고리만 활성화 |
| 패치 실제 적용 워크플로우 | Medium | 승인 후 실제 적용 절차 없음 |
| 수집 이력 Dashboard 표시 | Medium | 마지막 CRON 실행 시각 미표시 |
| RAG 자동 동기화 | Low | 수동 `sync_rag.py` 실행 필요 |

---

## 🏷️ 데이터 모델 현황 (`prisma/schema.prisma`)

| 테이블 | 상태 | 비고 |
|---|---|---|
| `RawPatch` | ⚠️ 미사용 | 이력 보존용, 실제 수집 데이터는 JSON 파일로 관리 |
| `PreprocessedPatch` | ✅ 운영 중 | `url`, `releaseDate`, `osVersion` 포함 |
| `ReviewedPatch` | ✅ 운영 중 | AI + Passthrough 결과 저장 |
| `UserFeedback` | ✅ 운영 중 | RAG 피드백 루프 활용 |
| `PipelineRun` | ⚠️ 로깅 전용 | UI에서 직접 활용 미완성 |

---

> [!NOTE]
> 이 문서는 코드 변경 시 반드시 업데이트하여 현행 구현과 괴리가 없도록 유지합니다.
