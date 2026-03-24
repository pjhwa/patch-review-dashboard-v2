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

        console.log(`[SQLSERVER] Enqueueing SQL Server pipeline (Retry: ${isRetry}, AI Only: ${isAiOnly})`);

        // --- STALLED QUEUE CLEANUP ---
        try {
            const activeJobs = await pipelineQueue.getActiveCount();
            const waitingJobs = await pipelineQueue.getWaitingCount();

            if (waitingJobs > 0) {
                console.log(`[SQLSERVER] Found ${waitingJobs} stuck waiting jobs. Clearing queue...`);
                await pipelineQueue.clean(0, 1000, 'wait');
            } else if (activeJobs > 0) {
                console.log(`[SQLSERVER] ${activeJobs} active job(s) detected — withOpenClawLock handles stale lock cleanup automatically.`);
            }

            await execPromise(`rm -f ~/.openclaw/agents/main/sessions/*.lock || true`);
        } catch (cleanupError) {
            console.error('[SQLSERVER] Warning: Stalled cleanup failed (non-fatal):', cleanupError);
        }

        // Clear SQL Server records from DB if not AI-only
        if (!isAiOnly) {
            try {
                await prisma.preprocessedPatch.deleteMany({ where: { vendor: 'SQL Server' } });
                await prisma.reviewedPatch.deleteMany({ where: { vendor: 'SQL Server' } });
                console.log('[SQLSERVER] Cleared SQL Server DB records.');
            } catch (dbErr) {
                console.error('[SQLSERVER] DB clear warning (non-fatal):', dbErr);
            }
        }

        const job = await pipelineQueue.add('run-sqlserver-pipeline', { isRetry, isAiOnly, category: 'database' });

        return NextResponse.json({
            success: true,
            message: 'SQL Server pipeline added to queue',
            jobId: job.id,
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
