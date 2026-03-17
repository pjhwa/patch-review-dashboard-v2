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

            if (activeJobs > 0 || waitingJobs > 0) {
                console.log(`Found ${activeJobs} active and ${waitingJobs} waiting jobs. Force cleaning stalled queue...`);
                // Blunt flush of BullMQ redis keys
                await execPromise(`redis-cli keys "bull:patch-pipeline:*" | xargs -r redis-cli del`);

                // Kill stray openclaw processes to release any hanging spawn() in the Node worker
                await execPromise(`pkill -9 -f "openclaw" || true`);
            }

            // Always clean up stale session locks and temp manual inputs
            await execPromise(`rm -f ~/.openclaw/agents/main/sessions/*.lock || true`);
            await execPromise(`rm -f ~/.openclaw/workspace/skills/patch-review/os/linux-v2/manual_review_input_*.json || true`);
        } catch (cleanupError) {
            console.error("Warning: Stalled cleanup failed (non-fatal):", cleanupError);
        }
        // -----------------------------

        if (!isAiOnly) {
            // Instantly clear the DB so the Dashboard counters drop to 0.
            // Even on retries, we must clear the DB to prevent orphaned records in ReviewedPatch
            await prisma.preprocessedPatch.deleteMany({});
            await prisma.reviewedPatch.deleteMany({});
        }

        // Determine which providers to enqueue
        const providerList: string[] = Array.isArray(providers) && providers.length > 0
            ? providers
            : ['redhat', 'oracle', 'ubuntu'];

        // Enqueue one job per provider (redhat/oracle/ubuntu each get separate jobs)
        const linuxProviders = providerList.filter(p => PROVIDER_TO_JOB[p]);
        const jobs = [];

        for (const provider of linuxProviders) {
            const jobName = PROVIDER_TO_JOB[provider];
            const job = await pipelineQueue.add(jobName, { providers: [provider], isRetry, isAiOnly, category: 'os' });
            jobs.push({ provider, jobId: job.id });
            console.log(`Enqueued ${jobName} (jobId: ${job.id})`);
        }

        // Fallback: if no known providers, fall back to legacy run-pipeline for manual-review compatibility
        if (jobs.length === 0) {
            const job = await pipelineQueue.add('run-pipeline', { providers, isRetry, isAiOnly });
            jobs.push({ provider: 'legacy', jobId: job.id });
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
