# AI Implementation: OpenClaw Patch Review Board

The Patch Review Dashboard V2 operates an autonomous AI review process embedded deep within its pipeline. The system utilizes the `openclaw` Internal AI Orchestration CLI to connect directly with Google Gemini, simulating a cybersecurity Patch Review Board (PRB).

---

## 1. Agent Configuration
The AI review is kicked off by the backend Node.js executing the following command natively:
```bash
openclaw agent --agent main --json-mode --message "{currentPrompt}"
```
This forces the AI into structured `JSON` generation mode. 

The contextual instructions that mold the AI's behavior are maintained inside the `~/.openclaw/workspace/skills/patch-review` framework under the `SKILL.md` file. It implicitly tells the `main` agent to evaluate items inside `patches_for_llm_review.json` based on OS standards.

## 2. Dynamic RAG Prompt Injection
Instead of static prompts, the Next.js execution engine calls `query_rag.py`. It pulls recent patching histories and operator logic from Prisma's `UserFeedback` table. 
If historical operators have explicitly stated: 
> "Excluded Issue: CVE-2025-XXXX, Reason: Internal DB doesn't use this module."
The RAG system appends this constraint into the AI's prompt at runtime. The AI will cross-reference new incoming CVEs, and automatically drop matching cases from the recommendation list, dramatically reducing redundant manual work.

## 3. The 3-Tier Self-Healing Loop

LLM systems are inherently non-deterministic. However, the dashboard requires deterministic database schemas. 
To bridge this gap, the V2 dashboard implements a strict programmatic "Self-Healing" validation loop:

1. **Attempt Execution:** The AI attempts to format `patch_review_ai_report.json`.
2. **Schema Verification:** The Next.js API parses the output against a `zod` object (`ReviewSchema`) expecting exact string keys: `'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', and 'KoreanDescription'`.
3. **Healing Ping-Pong:** If Zod catches a missing key or broken format, it throws a TypeScript error indicating the exact JSON path that failed. 
4. **Autonomous Retry:** The system catches the Zod error, injects it back to the AI using exponential backoff (3s -> 9s -> 27s), and commands: 
   *"이전 응답이 실패했습니다. 다음 Zod 구조적 에러를 해결하여 다시 제출하세요: [Zod Error Message]"*
5. **Final Fallback:** If it fails 3 consecutive times, the process halts safely asking the user to manually trigger the `AI Only Retry` via the UX.
