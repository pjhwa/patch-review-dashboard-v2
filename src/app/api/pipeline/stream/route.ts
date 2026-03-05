import { pipelineQueue } from '@/lib/queue';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
        return new Response('Missing jobId parameter.', { status: 400 });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {

            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "connected", message: "SSE connected to job " + jobId })}\n\n`));

            let lastLogCount = 0;

            const interval = setInterval(async () => {
                try {
                    const job = await pipelineQueue.getJob(jobId);

                    if (!job) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "error", message: "Job not found in queue." })}\n\n`));
                        clearInterval(interval);
                        controller.close();
                        return;
                    }

                    const state = await job.getState();
                    const progress = job.progress || 0;

                    // Fetch logs (BullMQ standard method)
                    const logs = await pipelineQueue.getJobLogs(jobId, lastLogCount, -1);
                    if (logs && logs.logs.length > 0) {
                        for (const line of logs.logs) {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: state, progress, log: line })}\n\n`));
                            lastLogCount++;
                        }
                    } else {
                        // Just heartbeat the state and progress
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: state, progress })}\n\n`));
                    }

                    if (state === 'completed' || state === 'failed') {
                        clearInterval(interval);
                        controller.close();
                    }
                } catch (e: any) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "error", message: e.message })}\n\n`));
                }
            }, 1000);

            request.signal.addEventListener('abort', () => {
                clearInterval(interval);
            });
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            // Disable proxy buffering for Vercel/Nginx
            'X-Accel-Buffering': 'no',
        },
    });
}
