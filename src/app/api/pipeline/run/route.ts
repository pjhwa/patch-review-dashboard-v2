import { NextResponse } from 'next/server';
import { pipelineQueue } from '@/lib/queue';
import { prisma } from '@/lib/db';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { providers, isRetry, isAiOnly } = body;

        console.log(`Enqueueing OpenClaw pipeline for: ${providers?.join(', ')} (Retry: ${isRetry}, AI Only: ${isAiOnly})`);

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
