# 📋 Post-Deployment Enhancement Plan

> **Last Updated**: 2026-03-11 | **Status**: Partially Complete

현재 운영 중인 시스템에서 발견된 이슈와 향후 개선 계획을 추적합니다.

---

## ✅ 완료된 주요 작업 (Done)

### 아키텍처 개선
- [x] 데이터 수집을 파이프라인에서 분리 → Linux CRON으로 이관
  - `batch_collector.js` (모놀리식) → `rhsa_collector.js`, `rhba_collector.js`, `oracle_collector.sh`, `ubuntu_collector.sh` (벤더별 독립 수집기)
- [x] 분기 스케줄 CRON 설정 (`run_collectors_cron.sh`)
- [x] 수집된 패치 파일 디렉토리 기반 카운트 (`redhat_data/`, `oracle_data/`, `ubuntu_data/`)
  - 기존: `RawPatch` DB 쿼리 → 브라우저 새로고침 시 0 리셋 문제 해결

### 파이프라인 안정성
- [x] BullMQ Job "waiting" 상태 고착 문제 해결
  - 원인: `job.updateProgress()` + `job.log()`를 스크립트 실행 전에 호출하도록 수정
- [x] OpenClaw session `.lock` 파일 자동 제거 (stale lock 방어)
- [x] 파이프라인 실행 시 `PreprocessedPatch` + `ReviewedPatch` DB 즉시 초기화 (카운터 0 리셋)

### AI 데이터 무결성
- [x] AI 환각(Hallucination) 방지: `PreprocessedPatch`에 없는 IssueID 스킵
- [x] AI가 누락한 벤더 자동 보완 (Passthrough)
- [x] AI 리뷰 결과에 `url`, `releaseDate`, `osVersion` 자동 병합 (PreprocessedPatch에서 복사)
- [x] AI 프롬프트에 벤더별 총 패치 수 명시 (선택적 출력 방지)

### UI/UX 개선
- [x] 파이프라인 실행 확인 다이얼로그 문구 업데이트 (수집 제외 안내)
- [x] `[PREPROCESS_DONE]` 로그 감지 시 대시보드 카운터 실시간 갱신
- [x] Pipeline 실패 시 구체적 오류 메시지 표시 (`❌ Pipeline Failed: 오류내용`)
- [x] AI 리뷰 결과 Summary 탭에 URL, OS 버전, 배포일 표시

---

## 🔄 진행 중 / 검토 필요

### P1 — High Priority

- [ ] **AI 리뷰 품질 모니터링**: SKILL.md Impact 기준이 너무 엄격하여 RedHat/Oracle 대부분이 "Important+Pending"으로만 분류됨
  - 방향: SKILL.md Step 3 기준을 완화하거나, AI 프롬프트에서 SKILL.md 필터링을 우회하도록 개선
  - 현재 해결책: Passthrough로 모든 전처리 패치가 표시되도록 보완

- [ ] **AI 한국어 설명 품질**: Passthrough로 채워진 패치는 한국어 설명이 영어 원문과 동일
  - 방향: Passthrough 이후 별도 번역 패스 실행 또는 SKILL.md 필터 완화

### P2 — Medium Priority

- [ ] **수집기 실행 이력 대시보드 표시**: 마지막 CRON 실행 시각 및 수집된 파일 수 표시
- [ ] **패치 승인(Approve) 후 운영 반영 워크플로우**: 현재 DB에서 decision 저장만, 실제 적용 플로우 미구현
- [ ] **배포 자동화**: `deploy.ps1` 스크립트 개선 (SCP + 원격 빌드 + PM2 재시작 원스텝)

### P3 — Low Priority

- [x] **RAG 벡터 인덱스 자동 갱신**: 현재 수동으로 `sync_rag.py` 실행 필요
- [ ] **멀티 카테고리 지원**: middleware, database, network 등 현재 OS만 구현
- [ ] **아카이브 뷰어**: 지난 분기 AI 리뷰 결과 아카이브 탐색 UI

---

## 🐛 알려진 이슈

| 이슈 | 상태 | 설명 |
|---|---|---|
| Ubuntu Preprocessed 카운트 4개 | 확인 필요 | 2025-11 이후 Ubuntu 패치가 거의 없음 — 수집기 재점검 필요 |
| ReviewedPatch Ubuntu 5개 | 해결 | AI 환각 엔트리 스킵 후 PreprocessedPatch 기반으로 교정됨 |
| AI Only 재시도 시 old review 잔존 | 확인 필요 | AI Only 실행은 DB를 초기화하지 않아 이전 결과가 섞일 수 있음 |

---

## 📚 운영 참고

### PM2 재시작 절차
```bash
cd /home/citec/patch-review-dashboard-v2
npm run build
npx pm2 restart all
```

### CRON 등록 확인
```bash
crontab -l   # 현재 등록된 CRON 확인
```

### OpenClaw 상태 점검
```bash
openclaw models status --probe --probe-timeout 30000
```

### Lock 파일 수동 제거
```bash
rm -f ~/.openclaw/agents/main/sessions/*.lock
```
