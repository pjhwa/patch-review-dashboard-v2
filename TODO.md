# Antigravity Task TODO

## 목적
AI API Rate Limit 등 외부 오류로 인해 파이프라인(AI 루프)이 중단된 경우, 재실행 시 기존 진행 상황이 보존되어 이어하기(Resume)가 가능하도록 개선합니다.

## 진행 항목
- [x] `queue.ts`에서 각 패치 평가 완료 즉시 DB(`prisma.reviewedPatch.upsert`) 및 로컬 JSON 보고서에 기록하도록 구조 개선 (점진적 저장)
- [x] AI Rate Limit 에러 발생 시 `/tmp/.rate_limit_[OS|CEPH|MARIADB]` 플래그 파일 생성 로직 추가
- [x] 재실행 시점(`isAiOnly` || `isRetry`) 플래그 파일 존재 여부 확인 후 `isResumeMode` 플래그 활성화
- [x] 재개 모드(isResumeMode) 발동 시 기존 전처리 통과를 무시하고 `alreadyReviewed` Set에 처리완료 패치 등록, AI 검토 단계에서 이를 스킵(Skip)하도록 로직 구현
- [x] `ProductGrid.tsx`에서 SSE 데이터 스트림 수신 시 `[RESUME]` 이모지(🔁) 및 `[SKIP-RESUME]` 이모지(⏭️) 처리 구현

## 검토 섹션
- [ ] 서버리스 검증(서버 전송: scp, 재시작 및 화면/로그 확인) - 사용자가 직접 푸시 및 배포 후 정상동작 여부 확인
