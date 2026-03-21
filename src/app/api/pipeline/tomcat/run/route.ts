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

        console.log(`[TOMCAT] Enqueueing Apache Tomcat pipeline (Retry: ${isRetry}, AI Only: ${isAiOnly})`);

        // --- STALLED QUEUE CLEANUP ---
        try {
            const activeJobs = await pipelineQueue.getActiveCount();
            const waitingJobs = await pipelineQueue.getWaitingCount();

            if (activeJobs > 0 || waitingJobs > 0) {
                console.log(`[TOMCAT] Found ${activeJobs} active and ${waitingJobs} waiting jobs. Cleaning stalled queue...`);
                await execPromise(`redis-cli keys "bull:patch-pipeline:*" | xargs -r redis-cli del`);
                await execPromise(`pkill -9 -f "openclaw" || true`);
            }

            await execPromise(`rm -f ~/.openclaw/agents/main/sessions/*.lock || true`);
        } catch (cleanupError) {
            console.error('[TOMCAT] Warning: Stalled cleanup failed (non-fatal):', cleanupError);
        }

        // Clear Tomcat records from DB if not AI-only
        if (!isAiOnly) {
            try {
                await prisma.preprocessedPatch.deleteMany({ where: { vendor: 'Apache Tomcat' } });
                await prisma.reviewedPatch.deleteMany({ where: { vendor: 'Apache Tomcat' } });
                console.log('[TOMCAT] Cleared Apache Tomcat DB records.');
            } catch (dbErr) {
                console.error('[TOMCAT] DB clear warning (non-fatal):', dbErr);
            }
        }

        const job = await pipelineQueue.add('run-tomcat-pipeline', { isRetry, isAiOnly, category: 'middleware' });

        return NextResponse.json({
            success: true,
            message: 'Apache Tomcat pipeline added to queue',
            jobId: job.id,
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
