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

        console.log(`[CEPH] Enqueueing Ceph pipeline (Retry: ${isRetry}, AI Only: ${isAiOnly})`);

        // --- STALLED QUEUE CLEANUP ---
        try {
            const activeJobs = await pipelineQueue.getActiveCount();
            const waitingJobs = await pipelineQueue.getWaitingCount();

            if (waitingJobs > 0) {
                // waiting 상태로 멈춘 잡만 제거. active 잡은 실행 중일 수 있으므로 건드리지 않음.
                console.log(`[CEPH] Found ${waitingJobs} stuck waiting jobs. Clearing queue...`);
                await pipelineQueue.clean(0, 1000, 'wait');
            } else if (activeJobs > 0) {
                console.log(`[CEPH] ${activeJobs} active job(s) detected — withOpenClawLock handles stale lock cleanup automatically.`);
            }

            await execPromise(`rm -f ~/.openclaw/agents/main/sessions/*.lock || true`);
        } catch (cleanupError) {
            console.error('[CEPH] Warning: Stalled cleanup failed (non-fatal):', cleanupError);
        }

        // Clear Ceph records from DB if not AI-only
        if (!isAiOnly) {
            try {
                await prisma.preprocessedPatch.deleteMany({ where: { vendor: 'Ceph' } });
                await prisma.reviewedPatch.deleteMany({ where: { vendor: 'Ceph' } });
                console.log('[CEPH] Cleared Ceph DB records.');
            } catch (dbErr) {
                console.error('[CEPH] DB clear warning (non-fatal):', dbErr);
            }
        }

        const job = await pipelineQueue.add('run-ceph-pipeline', { isRetry, isAiOnly, category: 'storage' });

        return NextResponse.json({
            success: true,
            message: 'Ceph pipeline added to queue',
            jobId: job.id,
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
