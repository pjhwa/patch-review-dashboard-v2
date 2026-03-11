import { NextResponse } from 'next/server';
import { pipelineQueue } from '@/lib/queue';
import { prisma } from '@/lib/db';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

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

        // Enqueue to BullMQ
        const job = await pipelineQueue.add('run-pipeline', { providers, isRetry, isAiOnly });

        return NextResponse.json({
            success: true,
            message: "Pipeline added to queue",
            jobId: job.id
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
