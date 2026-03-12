# Patch Review Board Dashboard - 기술 문서

## 1. 개요 (Overview)
Patch Review Board Dashboard는 분기별 권고 패치 검토 작업을 중앙에서 관제하고 자동화하는 프리미엄 통합 커맨드 센터입니다.

## 2. 배포 환경 (Deployment Environment)
- **실제 구동 서버**: `tom26` 리눅스 서버 (`citec@<SERVER_IP>`, `~/.openclaw/workspace/patch-review-dashboard/`)
- **버전 관리 및 로컬 연동**: `Patch-Review/patch-review-dashboard/`

## 3. 주요 기능 (Features)
- **분류 체계(Taxonomy) UI**: OS, Middleware, Database, Network, Storage, Virtualization
- **제한적 실행 (Execution Scope)**: 모든 카테고리가 뷰에 표시되나, 실제 동작 스크립트는 **Linux (OS)** 카테고리에 한정하여 작동됩니다.
- **스테이지 드릴다운 (Drill-down)**: 수집, 전처리, AI 분석 각 단계의 `raw JSON` 데이터를 모달로 디버깅 및 확인 가능.
- **CSV 내보내기 (Export)**: 최종 검토 대상인 패치의 요약 내역을 CSV로 즉시 다운로드 가능.

## 4. 로컬/원격 동기화 (Sync)
- 주요 컴포넌트 스냅샷 및 설정 정보 메타데이터는 이곳 로컬 저장소에 연동하여 기록됩니다.
