import { NextResponse } from 'next/server';
import { pipelineQueue } from '@/lib/queue';
import { prisma } from '@/lib/db';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const { isRetry, isAiOnly } = body;

        console.log(`[WINDOWS] Enqueueing Windows Server pipeline (Retry: ${isRetry}, AI Only: ${isAiOnly})`);

        // --- STALLED QUEUE CLEANUP ---
        try {
            const activeJobs = await pipelineQueue.getActiveCount();
            const waitingJobs = await pipelineQueue.getWaitingCount();

            if (waitingJobs > 0) {
                console.log(`[WINDOWS] Found ${waitingJobs} stuck waiting jobs. Clearing queue...`);
                await execPromise(`redis-cli keys "bull:patch-pipeline:*" | xargs -r redis-cli del`);
            } else if (activeJobs > 0) {
                console.log(`[WINDOWS] ${activeJobs} active job(s) detected — withOpenClawLock handles stale lock cleanup automatically.`);
            }

            await execPromise(`rm -f ~/.openclaw/agents/main/sessions/*.lock || true`);
        } catch (cleanupError) {
            console.error('[WINDOWS] Warning: Stalled cleanup failed (non-fatal):', cleanupError);
        }

        // Clear Windows records from DB if not AI-only
        if (!isAiOnly) {
            try {
                await prisma.preprocessedPatch.deleteMany({ where: { vendor: 'Windows Server' } });
                await prisma.reviewedPatch.deleteMany({ where: { vendor: 'Windows Server' } });
                console.log('[WINDOWS] Cleared Windows Server DB records.');
            } catch (dbErr) {
                console.error('[WINDOWS] DB clear warning (non-fatal):', dbErr);
            }
        }

        const job = await pipelineQueue.add('run-windows-pipeline', { isRetry, isAiOnly, category: 'windows' });

        return NextResponse.json({
            success: true,
            message: 'Windows Server pipeline added to queue',
            jobId: job.id,
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
