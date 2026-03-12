<div align="center">
  <br />
  <h1>🛡️ Patch Review Dashboard V2</h1>
  <p>
    An intelligent, autonomous compliance operation platform powered by Server-Sent Events, Prisma, and the <strong>OpenClaw AI</strong>. Effortlessly orchestrates enterprise security patches across Linux and major application stacks.
  </p>
  <br />

  [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](#)
  [![Next.js](https://img.shields.io/badge/Next.js-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](#)
  [![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](#)
  [![Prisma](https://img.shields.io/badge/Prisma-3982CE?style=for-the-badge&logo=Prisma&logoColor=white)](#)
  [![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](#)
  [![OpenClaw AI](https://img.shields.io/badge/OpenClaw_AI-FF6B6B?style=for-the-badge&logo=robot&logoColor=white)](#)

</div>

---

## ✨ Features

- **🚀 Autonomous Pipeline Executions:** Spawns detached shell collectors sequentially without blocking your UI workflow. Features built-in distributed locking and data integrity mechanisms.
- **🤖 OpenClaw RAG-Powered AI Review:** Utilizes Gemini models locally orchestrated via `openclaw agent:main`. Checks past user exclusions to intelligently drop redundant patches from the final queue.
- **🛡️ Self-Healing Zod Validation:** The AI output is rigorously enforced against deterministic JSON Schemas. Erroneous outputs are auto-redirected back to the LLM agent using an exponential backoff loop for self-repair.
- **📊 Real-Time Server-Sent Events (SSE):** Deep integration with background child processes to stream actual execution logs live to the dashboard without page reloading.
- **📦 Multi-Vendor Support:** Native integration scripts extending beyond raw OS platforms (RedHat, Oracle, Ubuntu) to complex applications like Ceph and MariaDB.

---

## 🏗️ Architecture Stack

For detailed internal documentation generated from operational facts, refer to the `/docs` directory:
- [Architecture (EN/KR)](docs/architecture.md)
- [Pipeline Flow (EN/KR)](docs/pipeline_flow.md)
- [Tech Stack (EN/KR)](docs/tech_stack.md)
- [AI Review Flow (EN/KR)](docs/ai_review.md)

---

## ⚡ Quick Start

### 1. Requirements
Ensure you have the following installed to run the backend processors and Web UI:
- `Node.js` v22+
- `pnpm`
- `Python` 3.x
- `openclaw` globally installed.

### 2. Installation
Clone the active repository onto your control server.

```bash
git clone https://github.com/my-org/patch-review-dashboard-v2.git
cd patch-review-dashboard-v2
```

### 3. Deploy the Pipeline Logic
The server expects the heavy lifting skill logic to reside in the global workspace. Ensure the `patch-review` folder is moved to the OpenClaw directory prior to execution:

```bash
mkdir -p ~/.openclaw/workspace/skills/
cp -r ./patch-review ~/.openclaw/workspace/skills/
```

### 4. Setup Prisma Database
```bash
pnpm install
pnpm prisma generate
pnpm prisma db push
```

### 5. Launch Application
```bash
pnpm run dev
# The application will listen on http://localhost:3001
```
Navigate to your Dashboard. Try manually running a pipeline to test the SSE log streaming!

---

## ⏰ Autonomous CRON Scheduling
To deploy the fully zero-touch operational model, set up the CRON schedule natively using the `update_cron.sh` inside your repository.
It ensures that the entire stack kicks off automatically on the **third Sunday of March, June, September, and December at 06:00** to align with quarterly evaluations.

---

<div align="center">
  <sub>Built with ❤️ by the Cloud & Infrastructure - Technical Expert Center (CI-TEC) </sub>
</div>
