# Claude Code Memory Management Guide

> How to structure and compress the auto-memory system to minimize token usage while preserving all information.

---

## 1. The Problem — Why Memory Gets Bloated

Claude Code's auto-memory system (`~/.claude/projects/.../memory/`) stores lessons and project context across sessions. Over time it develops two structural problems:

### Problem 1: MEMORY.md duplicates content instead of indexing it

`MEMORY.md` is **loaded into every session automatically**. If it contains lesson summaries, you pay for all of it every session — even when it's irrelevant.

**Example of the anti-pattern (before):**
```markdown
- feedback_session_lessons.md — git reset 위험, mojibake 처리, **faq 필드 제거(교훈14)**,
  **SKILL.md 100줄 이상(교훈15)**, **gateway closed 즉시 reject 금지(교훈16)**,
  **sessions.json 삭제 필수(교훈17)**, ... [60+ lessons enumerated inline]
```

This single line was ~2,000 characters — loaded on every session start regardless of whether those lessons were relevant.

### Problem 2: One monolithic lessons file

Putting all lessons in a single file means reading 28,959 tokens just to check one lesson. Every session that needs any lesson pays the full cost.

---

## 2. The Solution — Three Compression Techniques

### Technique 1: MEMORY.md as a pure index

`MEMORY.md` should contain **only file paths and 5–10 word descriptions**. Zero lesson content.

**Optimized format:**
```markdown
# Memory Index
> 관련 도메인 파일만 선택적으로 읽어라.

| 파일 | 내용 |
|------|------|
| lessons_pipeline.md | 교훈: 수집·전처리·ingestion·RAG·severity (L4,9-11,18) |
| lessons_build_git.md | 교훈: 빌드·타입에러·git·배포 (L1,7,27,31) |
| feedback_telegram_notify.md | **[필수]** 작업 완료 시 텔레그램 전송 필수 |
```

- Lesson numbers in `(L4,9-11,18)` bracket notation — not spelled out
- **Target: 12 lines or fewer total**

### Technique 2: Split by domain

Instead of one monolithic file, split lessons into domain-specific files. A session only reads the files relevant to the current task.

| Domain | File | When to read |
|--------|------|-------------|
| Data collection, preprocessing, ingestion, RAG, severity | `lessons_pipeline.md` | Pipeline changes, collector bugs |
| Build errors, git, deployment, nginx | `lessons_build_git.md` | Build failures, git operations |
| UI, CSS, i18n, dark mode | `lessons_ui.md` | Frontend changes |
| Prisma, DB, upsert, deleteMany | `lessons_db.md` | Schema changes, DB queries |
| New product setup, SKILL.md, openclaw | `lessons_product.md` | Adding products, openclaw issues |

### Technique 3: Compressed lesson format

Each lesson follows a tight 3-field format:

```markdown
## L{N} Title (3–5 words)
규칙: [1-line core rule]
Why: [1-line reason — omit if obvious]
Apply: [1–3 lines + essential code snippet only]
```

**Before (~250 words):**
```markdown
## 교훈 17: openclaw sessions.json 미삭제 → 이전 세션 오염으로 AI 출력 불량

openclaw는 `--session-id` 플래그와 무관하게 `sessions.json['agent:main:main']`에서
현재 세션을 로드한다. 기존 cleanup 코드가 `.lock`·`.jsonl` 파일만 삭제하고
`sessions.json`을 남겨두었기 때문에, 이전 파이프라인 실행의 오염된 세션 컨텍스트로
AI가 응답하여 invalid JSON 출력 → retry 반복 발생. 실증: `--session-id test_gw_probe`로
호출했을 때 `meta.agentMeta.sessionId: "sqlserver_6_batch_1_2"`(이전 세션)가 반환됨.

**Why:** [long explanation]
**How to apply:** [long code block]
```

**After (~60 words):**
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

## 3. Token Savings — Before vs After

| Metric | Before | After | Reduction |
|--------|--------|-------|-----------|
| MEMORY.md auto-load | ~3,500 chars | ~600 chars | **-83%** |
| Lesson file read (per session) | 28,959 tokens (all lessons) | 2,000–5,000 tokens (1–2 domain files) | **-80–93%** |
| Average lesson size | ~250 words | ~80 words | **-68%** |

---

## 4. File Structure After Optimization

```
memory/
├── MEMORY.md                    ← Auto-loaded index (12 lines max)
├── project_*.md                 ← Project-specific context
├── lessons_pipeline.md          ← Domain lessons
├── lessons_build_git.md
├── lessons_ui.md
├── lessons_db.md
├── lessons_product.md
├── feedback_quarterly_archive.md
├── feedback_plan_docs.md
├── feedback_telegram_notify.md
└── feedback_memory_format.md    ← This guide (rules for writing memory)
```

---

## 5. How to Add a New Lesson

**Step 1:** Identify the domain → open the matching `lessons_*.md` file.

**Step 2:** Append using the compressed format:
```markdown
## L67 [Short title]
규칙: [Core rule in 1 line]
Why: [Root cause in 1 line]
Apply: [How to apply, 1–3 lines]
```

**Step 3:** Update MEMORY.md — only the lesson number range in brackets:
```markdown
| lessons_pipeline.md | 교훈: 수집·전처리·... (L4,9-11,18,67) |
```

**Never** write lesson content into MEMORY.md itself.

---

## 6. MEMORY.md Writing Rules

```markdown
# Memory Index
> [1-line instruction on selective reading]

| 파일 | 내용 |
|------|------|
| file.md | Domain description + lesson numbers (L1,2,3) |
```

Rules:
- **One row per file**, max ~60 chars per description
- Lesson numbers in `(L{numbers})` format only — never spell out lessons
- `**[필수]**` marker for files that must be read every session (e.g., telegram notification rules)
- Total MEMORY.md: **200 characters or fewer** for the table body

---

## 7. Domain Assignment Reference

When a new lesson doesn't fit neatly into one domain, use this priority:

1. **If it involves a Python script or data file** → `lessons_pipeline.md`
2. **If it involves TypeScript build errors or git operations** → `lessons_build_git.md`
3. **If it involves React components, Tailwind, or i18n** → `lessons_ui.md`
4. **If it involves Prisma schema or raw SQL** → `lessons_db.md`
5. **If it involves adding a new product or openclaw configuration** → `lessons_product.md`
6. **If it doesn't fit any of the above** → create a new domain file and add it to MEMORY.md

---

## 8. Lessons That Should NOT Be Saved

Avoid storing:
- **Code patterns** derivable by reading the current source (e.g., "use async/await")
- **Git history** — use `git log`/`git blame`
- **Debugging recipes** already fixed in code
- **Anything already in CLAUDE.md**
- **Ephemeral state**: current task, in-progress work, conversation context

If someone asks you to save a "summary of recent changes", ask what was *surprising or non-obvious* — that's the part worth keeping.

---

## 9. Selective Reading Strategy

On each new session:

1. Read MEMORY.md (auto-loaded — no action needed)
2. Identify the task domain
3. Read **only** the matching domain file(s)

Examples:
- "Fix a build error" → read `lessons_build_git.md`
- "Add a new product to the dashboard" → read `lessons_product.md` + `~/ADDING_NEW_PRODUCT.md`
- "Debug severity NULL in DB" → read `lessons_db.md` + `lessons_pipeline.md`
- "Fix dark mode button color" → read `lessons_ui.md`

Avoid reading all files by default. The MEMORY.md descriptions contain enough context to decide which file to open.

---

## 10. Applied Example — This Project

This guide was created after compressing the `feedback_session_lessons.md` monolith (28,959 tokens, 66 lessons) into 5 domain files on 2026-03-25.

The `feedback_session_lessons.md` file **no longer exists** — do not recreate it. All lessons are now in the 5 domain files above.
