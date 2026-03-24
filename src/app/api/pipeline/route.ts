import { NextResponse } from 'next/server';
import { pipelineQueue } from '@/lib/queue';

export async function GET() {
    try {
        const activeJobs = await pipelineQueue.getActive();
        const waitingJobs = await pipelineQueue.getWaiting();

        const activeJob = activeJobs.length > 0 ? activeJobs[0] : null;
        const waitingJob = waitingJobs.length > 0 ? waitingJobs[0] : null;

        const job = activeJob || waitingJob;

        if (job) {
            // Derive productId from job data (OS products) or job name (other products)
            const provider = job.data?.providers?.[0] ||
                (job.name?.match(/^run-([a-zA-Z0-9_]+)-pipeline$/)?.[1] ?? null);
            return NextResponse.json({
                hasActiveJob: true,
                jobId: job.id,
                status: activeJob ? 'active' : 'waiting',
                progress: job.progress || 0,
                provider,
            });
        }

        return NextResponse.json({
            hasActiveJob: false,
            jobId: null,
            status: 'idle',
            progress: 0
        });
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch pipeline queue state' }, { status: 500 });
    }
}
