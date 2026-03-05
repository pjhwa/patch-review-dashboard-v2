import { NextResponse } from 'next/server';
import { pipelineQueue } from '@/lib/queue';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { providers } = body; // e.g., { providers: ['rhel', 'ubuntu', 'oracle'] }

        console.log(`Enqueueing OpenClaw pipeline for: ${providers?.join(', ')}`);

        // Enqueue to BullMQ
        const job = await pipelineQueue.add('run-pipeline', { providers });

        return NextResponse.json({
            success: true,
            message: "Pipeline added to queue",
            jobId: job.id
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
