# Patch Review Dashboard v2 Documentation Tasks

- [ ] Create `docs/architecture.md` with Mermaid diagrams for overall architecture.
- [ ] Create `docs/pipeline.md` covering Data Collection, Preprocessing, AI/Manager review.
- [ ] Create `docs/tech_stack.md` detailing Next.js, Prisma, Tailwind, and pipeline technologies.
- [ ] Push to `citec-antigravity` repository.

## V2 추가 배포 리뷰 검토 항목
- [x] RAG ChromaDB 임베딩 동기화/조회 탑재 (OOM 예외처리 포함)
- [x] LLM Zod 자가 치유 파이프라인 탑재
- [x] Prisma SQLite WAL 모드 주입
- [x] Frontend 큐 스팸 방지 Debounce (`isQueueing`) 확인
- [x] V2 파이프라인 0% 무한 펜딩 버그 수정 (queue.ts 오케스트레이터 및 파라미터 유실 방지)
