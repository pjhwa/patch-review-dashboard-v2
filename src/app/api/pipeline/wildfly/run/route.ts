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

        console.log(`[WILDFLY] Enqueueing WildFly pipeline (Retry: ${isRetry}, AI Only: ${isAiOnly})`);

        // --- STALLED QUEUE CLEANUP ---
        try {
            const activeJobs = await pipelineQueue.getActiveCount();
            const waitingJobs = await pipelineQueue.getWaitingCount();

            if (activeJobs > 0 || waitingJobs > 0) {
                console.log(`[WILDFLY] Found ${activeJobs} active and ${waitingJobs} waiting jobs. Cleaning stalled queue...`);
                await execPromise(`redis-cli keys "bull:patch-pipeline:*" | xargs -r redis-cli del`);
                await execPromise(`pkill -9 -f "openclaw" || true`);
            }

            await execPromise(`rm -f ~/.openclaw/agents/main/sessions/*.lock || true`);
        } catch (cleanupError) {
            console.error('[WILDFLY] Warning: Stalled cleanup failed (non-fatal):', cleanupError);
        }

        // Clear WildFly records from DB if not AI-only
        if (!isAiOnly) {
            try {
                await prisma.preprocessedPatch.deleteMany({ where: { vendor: 'WildFly' } });
                await prisma.reviewedPatch.deleteMany({ where: { vendor: 'WildFly' } });
                console.log('[WILDFLY] Cleared WildFly DB records.');
            } catch (dbErr) {
                console.error('[WILDFLY] DB clear warning (non-fatal):', dbErr);
            }
        }

        const job = await pipelineQueue.add('run-wildfly-pipeline', { isRetry, isAiOnly, category: 'middleware' });

        return NextResponse.json({
            success: true,
            message: 'WildFly pipeline added to queue',
            jobId: job.id,
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
