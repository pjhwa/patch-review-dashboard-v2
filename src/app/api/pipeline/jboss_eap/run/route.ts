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

        console.log(`[JBOSS_EAP] Enqueueing JBoss EAP pipeline (Retry: ${isRetry}, AI Only: ${isAiOnly})`);

        // --- STALLED QUEUE CLEANUP ---
        try {
            const activeJobs = await pipelineQueue.getActiveCount();
            const waitingJobs = await pipelineQueue.getWaitingCount();

            if (activeJobs > 0 || waitingJobs > 0) {
                console.log(`[JBOSS_EAP] Found ${activeJobs} active and ${waitingJobs} waiting jobs. Cleaning stalled queue...`);
                await execPromise(`redis-cli keys "bull:patch-pipeline:*" | xargs -r redis-cli del`);
                await execPromise(`pkill -9 -f "openclaw" || true`);
            }

            await execPromise(`rm -f ~/.openclaw/agents/main/sessions/*.lock || true`);
        } catch (cleanupError) {
            console.error('[JBOSS_EAP] Warning: Stalled cleanup failed (non-fatal):', cleanupError);
        }

        // Clear JBoss EAP records from DB if not AI-only
        if (!isAiOnly) {
            try {
                await prisma.preprocessedPatch.deleteMany({ where: { vendor: 'JBoss EAP' } });
                await prisma.reviewedPatch.deleteMany({ where: { vendor: 'JBoss EAP' } });
                console.log('[JBOSS_EAP] Cleared JBoss EAP DB records.');
            } catch (dbErr) {
                console.error('[JBOSS_EAP] DB clear warning (non-fatal):', dbErr);
            }
        }

        const job = await pipelineQueue.add('run-jboss_eap-pipeline', { isRetry, isAiOnly, category: 'middleware' });

        return NextResponse.json({
            success: true,
            message: 'JBoss EAP pipeline added to queue',
            jobId: job.id,
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
