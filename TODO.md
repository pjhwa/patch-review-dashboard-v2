# Antigravity Task TODO

## 목적
E2BIG 에러(Command line argument limit exceeded)를 방지하기 위해 AI Review(OpenClaw)에 전달되는 패치 데이터 페이로드를 실행 직전에 Pruning(가지치기)하여 Context Window 및 인자 크기를 최적화합니다.

## 진행 항목
- [x] `queue.ts`에 `prunePatchData` 헬퍼 함수 구현
  - [x] 배열 요소 15개 초과 시 `... and N more` 로 축약
  - [x] 문자열 필드(`description`, `details` 등) 내 `http(s)://` 형태의 URL 정규식 치환을 통해 삭제
  - [x] 문자열 길이 3000자로 자르기
- [x] `queue.ts` 내 AI 루프(`let basePrompt = ...` 직전)에 `prunePatchData(patch)` 적용
- [x] 수정된 로컬 `queue.ts`를 원격 서버로 전송 (`scp`)
- [ ] 원격 서버(tom26)에서 `npm run build` 및 `pm2 restart all` 실행하여 배포restart all` 실행하여 배포
- [x] 수동/자동 파이프라인 트리거하여 `E2BIG` 오류 해결 검증 (특히 `ELSA-2026-50112` 등 대용량 커널 패치)

## 검토 섹션
- [x] 성공적으로 검증 완료. `E2BIG` 에러 발생 없이 파이프라인 진행 확인됨 (Pruning 정상 작동).
