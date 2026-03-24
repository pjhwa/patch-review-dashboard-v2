import { NextResponse } from 'next/server';
import { pipelineQueue } from '@/lib/queue';
import { prisma } from '@/lib/db';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

// Map provider names to their job names
const PROVIDER_TO_JOB: Record<string, string> = {
    redhat: 'run-redhat-pipeline',
    oracle: 'run-oracle-pipeline',
    ubuntu: 'run-ubuntu-pipeline',
    // windows has its own run route at /api/pipeline/windows/run
};

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { providers, isRetry, isAiOnly } = body;

        console.log(`Enqueueing OpenClaw pipeline for: ${providers?.join(', ')} (Retry: ${isRetry}, AI Only: ${isAiOnly})`);

        // --- STALLED QUEUE CLEANUP ---
        try {
            console.log("Checking and cleaning up stalled AI review worker sessions...");
            const activeJobs = await pipelineQueue.getActiveCount();
            const waitingJobs = await pipelineQueue.getWaitingCount();

            if (waitingJobs > 0) {
                // waiting 상태로 멈춘 잡만 제거. active 잡은 실행 중일 수 있으므로 건드리지 않음.
                console.log(`Found ${waitingJobs} stuck waiting jobs. Clearing queue...`);
                await execPromise(`redis-cli keys "bull:patch-pipeline:*" | xargs -r redis-cli del`);
            } else if (activeJobs > 0) {
                console.log(`${activeJobs} active job(s) detected — withOpenClawLock handles stale lock cleanup automatically.`);
            }

            // Always clean up stale session locks and temp manual inputs
            await execPromise(`rm -f ~/.openclaw/agents/main/sessions/*.lock || true`);
            await execPromise(`rm -f ~/.openclaw/workspace/skills/patch-review/os/linux/manual_review_input_*.json || true`);
        } catch (cleanupError) {
            console.error("Warning: Stalled cleanup failed (non-fatal):", cleanupError);
        }
        // -----------------------------

        // Determine which providers to enqueue
        const providerList: string[] = Array.isArray(providers) && providers.length > 0
            ? providers
            : ['redhat', 'oracle', 'ubuntu'];

        // vendor별 매핑 — deleteMany는 해당 제품 vendor만 삭제해야 다른 제품 데이터를 건드리지 않음
        const PROVIDER_TO_VENDOR: Record<string, string> = {
            redhat: 'Red Hat',
            oracle: 'Oracle',
            ubuntu: 'Ubuntu',
        };

        if (!isAiOnly) {
            // 실행 대상 vendor만 삭제 — WHERE 없는 deleteMany({})는 전 제품 데이터를 삭제하므로 금지
            for (const provider of providerList) {
                const vendor = PROVIDER_TO_VENDOR[provider];
                if (vendor) {
                    await prisma.preprocessedPatch.deleteMany({ where: { vendor } });
                    await prisma.reviewedPatch.deleteMany({ where: { vendor } });
                }
            }
        }

        // Enqueue one job per provider (redhat/oracle/ubuntu each get separate jobs)
        const linuxProviders = providerList.filter(p => PROVIDER_TO_JOB[p]);
        const jobs = [];

        for (const provider of linuxProviders) {
            const jobName = PROVIDER_TO_JOB[provider];
            const job = await pipelineQueue.add(jobName, { providers: [provider], isRetry, isAiOnly, category: 'os' });
            jobs.push({ provider, jobId: job.id });
            console.log(`Enqueued ${jobName} (jobId: ${job.id})`);
        }

        return NextResponse.json({
            success: true,
            message: "Pipeline added to queue",
            jobId: jobs[0]?.jobId,
            jobs,
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
