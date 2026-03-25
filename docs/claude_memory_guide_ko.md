# Claude Code 메모리 관리 가이드

> 자동 메모리 시스템을 구조화하고 압축하여 정보 손실 없이 토큰 사용을 최소화하는 방법.

---

## 1. 문제 — 왜 메모리가 비대해지는가

Claude Code의 자동 메모리 시스템(`~/.claude/projects/.../memory/`)은 교훈과 프로젝트 컨텍스트를 세션 간에 저장한다. 시간이 지나면서 두 가지 구조적 문제가 발생한다.

### 문제 1: MEMORY.md가 인덱스 역할 대신 내용을 담는다

`MEMORY.md`는 **매 세션마다 자동으로 로드**된다. 여기에 교훈 요약을 담으면, 관련 없는 내용도 매번 토큰을 소모한다.

**안티패턴 예시 (개선 전):**
```markdown
- feedback_session_lessons.md — git reset 위험, mojibake 처리, **faq 필드 제거(교훈14)**,
  **SKILL.md 100줄 이상(교훈15)**, **gateway closed 즉시 reject 금지(교훈16)**,
  **sessions.json 삭제 필수(교훈17)**, ... [60개 이상 교훈 나열]
```

이 단 한 줄이 ~2,000 characters — 해당 교훈이 필요 없는 세션에서도 매번 로드됨.

### 문제 2: 단일 모놀리스 교훈 파일

모든 교훈을 하나의 파일에 담으면 교훈 하나를 확인하기 위해 28,959 토큰을 읽어야 한다. 교훈이 필요한 모든 세션이 전체 비용을 지불한다.

---

## 2. 해결책 — 세 가지 압축 기법

### 기법 1: MEMORY.md = 순수 인덱스

`MEMORY.md`는 **파일 경로와 5~10단어 설명만** 담는다. 교훈 내용 절대 나열 금지.

**최적화된 형식:**
```markdown
# Memory Index
> 관련 도메인 파일만 선택적으로 읽어라.

| 파일 | 내용 |
|------|------|
| lessons_pipeline.md | 교훈: 수집·전처리·ingestion·RAG·severity (L4,9-11,18) |
| lessons_build_git.md | 교훈: 빌드·타입에러·git·배포 (L1,7,27,31) |
| feedback_telegram_notify.md | **[필수]** 작업 완료 시 텔레그램 전송 필수 |
```

- 교훈 번호는 `(L4,9-11,18)` 괄호 표기법만 사용 — 내용 풀어쓰기 금지
- **목표: 전체 12줄 이내**

### 기법 2: 도메인별 분리

단일 모놀리스 대신, 도메인별 파일로 분리한다. 세션은 현재 작업과 관련된 파일만 읽는다.

| 도메인 | 파일 | 읽어야 할 때 |
|--------|------|------------|
| 수집·전처리·ingestion·RAG·severity | `lessons_pipeline.md` | 파이프라인 변경, 수집기 버그 |
| 빌드·타입에러·git·배포·nginx | `lessons_build_git.md` | 빌드 실패, git 작업 |
| UI·CSS·i18n·다크모드 | `lessons_ui.md` | 프론트엔드 변경 |
| Prisma·DB·upsert·deleteMany | `lessons_db.md` | 스키마 변경, DB 쿼리 |
| 신규 제품 추가·SKILL.md·openclaw | `lessons_product.md` | 제품 추가, openclaw 이슈 |

### 기법 3: 압축된 교훈 형식

각 교훈은 3가지 필드로 구성된 간결한 형식을 따른다:

```markdown
## L{N} 제목 (3~5 단어)
규칙: [1줄 핵심 규칙]
Why: [1줄 이유 — 명백하면 생략 가능]
Apply: [1~3줄 + 핵심 코드 스니펫만]
```

**개선 전 (~250 단어):**
```markdown
## 교훈 17: openclaw sessions.json 미삭제 → 이전 세션 오염으로 AI 출력 불량

openclaw는 `--session-id` 플래그와 무관하게 `sessions.json['agent:main:main']`에서
현재 세션을 로드한다. 기존 cleanup 코드가 `.lock`·`.jsonl` 파일만 삭제하고
`sessions.json`을 남겨두었기 때문에, 이전 파이프라인 실행의 오염된 세션 컨텍스트로
AI가 응답하여 invalid JSON 출력 → retry 반복 발생. 실증: `--session-id test_gw_probe`로
호출했을 때 `meta.agentMeta.sessionId: "sqlserver_6_batch_1_2"`(이전 세션)가 반환됨.

**Why:** [긴 설명]
**How to apply:** [긴 코드 블록]
```

**개선 후 (~60 단어):**
```markdown
## L17 sessions.json 삭제 필수
규칙: 배치 attempt 전 cleanup 시 .lock·.jsonl 뿐 아니라 sessions.json도 반드시 삭제
Why: sessions.json 잔류 시 이전 세션(다른 제품 포함) 컨텍스트로 AI 응답 → invalid JSON 반복
Apply:
```typescript
const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
if (fs.existsSync(sessionsJsonPath)) fs.rmSync(sessionsJsonPath, { force: true });
```
```

---

## 3. 토큰 절감 효과 — 개선 전후 비교

| 항목 | 개선 전 | 개선 후 | 절감 |
|------|---------|---------|------|
| MEMORY.md 자동 로드 | ~3,500 chars | ~600 chars | **-83%** |
| 교훈 파일 읽기 (세션당) | 28,959 토큰 (전체) | 2,000~5,000 토큰 (1~2개 도메인 파일) | **-80~93%** |
| 교훈 1개 평균 크기 | ~250 단어 | ~80 단어 | **-68%** |

---

## 4. 최적화 후 파일 구조

```
memory/
├── MEMORY.md                    ← 자동 로드 인덱스 (12줄 이내)
├── project_*.md                 ← 프로젝트별 컨텍스트
├── lessons_pipeline.md          ← 도메인별 교훈
├── lessons_build_git.md
├── lessons_ui.md
├── lessons_db.md
├── lessons_product.md
├── feedback_quarterly_archive.md
├── feedback_plan_docs.md
├── feedback_telegram_notify.md
└── feedback_memory_format.md    ← 이 가이드 (메모리 작성 규칙)
```

---

## 5. 새 교훈 추가 절차

**Step 1:** 도메인 파악 → 해당 `lessons_*.md` 파일 열기

**Step 2:** 압축 형식으로 파일 끝에 추가:
```markdown
## L67 [짧은 제목]
규칙: [1줄 핵심 규칙]
Why: [1줄 원인]
Apply: [적용 방법 1~3줄]
```

**Step 3:** MEMORY.md에서 해당 행의 교훈 번호 범위만 업데이트:
```markdown
| lessons_pipeline.md | 교훈: 수집·전처리·... (L4,9-11,18,67) |
```

MEMORY.md에 교훈 내용을 **절대 직접 쓰지 말 것.**

---

## 6. MEMORY.md 작성 규칙 상세

```markdown
# Memory Index
> [선택적 읽기 지침 1줄]

| 파일 | 내용 |
|------|------|
| file.md | 도메인 설명 + 교훈 번호 (L1,2,3) |
```

규칙:
- **파일당 1행**, 설명 최대 ~60자
- 교훈 번호는 `(L{번호})` 형식만 — 내용 풀어쓰기 금지
- 매 세션 필수 파일에는 `**[필수]**` 마커 (예: 텔레그램 알림 규칙)
- MEMORY.md 전체 본문: **200자 이하** 권장

---

## 7. 도메인 배정 우선순위

새 교훈이 어느 도메인인지 명확하지 않을 때:

1. **Python 스크립트 또는 데이터 파일** → `lessons_pipeline.md`
2. **TypeScript 빌드 에러 또는 git 작업** → `lessons_build_git.md`
3. **React 컴포넌트, Tailwind, i18n** → `lessons_ui.md`
4. **Prisma 스키마 또는 raw SQL** → `lessons_db.md`
5. **신규 제품 추가 또는 openclaw 설정** → `lessons_product.md`
6. **위 어느 것도 아닌 경우** → 새 도메인 파일 생성 후 MEMORY.md에 추가

---

## 8. 저장하면 안 되는 것들

다음은 메모리에 저장하지 않는다:

- **현재 소스에서 직접 읽을 수 있는 코드 패턴** (예: "async/await 사용")
- **git 히스토리** — `git log`/`git blame`이 더 정확함
- **이미 코드에 반영된 디버깅 해결책**
- **CLAUDE.md에 이미 문서화된 내용**
- **일시적 상태**: 현재 작업, 진행 중인 작업, 대화 컨텍스트

"최근 변경사항 요약을 저장해줘"라는 요청을 받으면 — 무엇이 *놀랍거나 비자명한지*를 물어봐라. 그게 진짜 저장할 가치가 있는 부분이다.

---

## 9. 선택적 읽기 전략

세션 시작 시:

1. MEMORY.md 확인 (자동 로드됨 — 별도 행동 불필요)
2. 작업 도메인 파악
3. **해당 도메인 파일만** 읽기

예시:
- "빌드 에러 수정" → `lessons_build_git.md`만 읽기
- "대시보드에 신규 제품 추가" → `lessons_product.md` + `~/ADDING_NEW_PRODUCT.md`
- "DB의 severity가 NULL" → `lessons_db.md` + `lessons_pipeline.md`
- "다크 모드 버튼 색상 문제" → `lessons_ui.md`만 읽기

기본으로 모든 파일을 읽지 않는다. MEMORY.md 설명이 어느 파일을 열어야 하는지 결정하기에 충분하다.

---

## 10. 다른 프로젝트에 적용하는 법

이 접근법은 Claude Code 자동 메모리를 사용하는 **모든 프로젝트**에 적용 가능하다.

### 새 프로젝트 시작 시 권장 초기 구조

```
memory/
├── MEMORY.md              ← 인덱스 (테이블 형식, 12줄 이내)
├── project_overview.md    ← 프로젝트 아키텍처·기술 스택
├── feedback_general.md    ← 일반 피드백·선호도
└── feedback_memory_format.md  ← 이 가이드 복사
```

교훈이 쌓이면서 도메인별로 분리한다. **분리 기준: 하나의 파일이 ~5,000 토큰을 초과하면** 도메인 분리를 고려하라.

### 기존 비대한 메모리 구조 개선 절차

1. 모놀리스 파일 전체를 청크로 읽어 모든 교훈 파악
2. 도메인별로 분류 → 각 도메인 파일 생성 (압축 형식 사용)
3. MEMORY.md를 순수 인덱스로 재작성
4. 기존 모놀리스 파일 삭제

### 교훈 형식 체크리스트

새 교훈 작성 시 다음을 확인:
- [ ] `## L{N}` 헤더 + 3~5 단어 제목
- [ ] `규칙:` 1줄 — 핵심 행동 지침
- [ ] `Why:` 1줄 — 실제로 발생한 문제 (생략 가능)
- [ ] `Apply:` 1~3줄 + 코드 스니펫 (핵심만)
- [ ] 전체 80단어 이내
- [ ] **bold**, 긴 서술 없음

---

## 11. 이 프로젝트 적용 이력

이 가이드는 `feedback_session_lessons.md` 모놀리스(28,959 토큰, 66개 교훈)를 2026-03-25에 5개 도메인 파일로 압축한 후 작성됨.

`feedback_session_lessons.md` 파일은 **더 이상 존재하지 않는다** — 재생성 금지. 모든 교훈은 위 5개 도메인 파일에 분산 저장됨.
