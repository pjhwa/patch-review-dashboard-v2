import { NextResponse } from 'next/server';
import { pipelineQueue } from '@/lib/queue';
import { prisma } from '@/lib/db';

/**
 * POST /api/pipeline/review-manual
 * Body: { issueIds: string[] }
 * 
 * Queues a selective AI review job for the given preprocessed patch issueIds.
 * The worker will run OpenClaw LLM only for these specific patches, writing
 * results to ReviewedPatch table.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { issueIds } = body as { issueIds: string[] };

        if (!issueIds || !Array.isArray(issueIds) || issueIds.length === 0) {
            return NextResponse.json(
                { success: false, error: 'issueIds must be a non-empty array' },
                { status: 400 }
            );
        }

        // Fetch the full preprocessed patch data for the given issueIds
        const patches = await prisma.preprocessedPatch.findMany({
            where: { issueId: { in: issueIds } }
        });

        if (patches.length === 0) {
            return NextResponse.json(
                { success: false, error: 'No matching preprocessed patches found' },
                { status: 404 }
            );
        }

        // Enqueue a selective review job passing the patch data directly
        const job = await pipelineQueue.add('manual-review', {
            type: 'manual-review',
            patches: patches.map(p => ({
                id: p.issueId,
                vendor: p.vendor,
                component: p.component,
                version: p.version,
                severity: p.severity,
                description: p.description,
                url: p.url,
                releaseDate: p.releaseDate,
            }))
        });

        return NextResponse.json({
            success: true,
            message: `Queued manual AI review for ${patches.length} patches`,
            jobId: job.id,
            issueIds: patches.map(p => p.issueId)
        });
    } catch (e: any) {
        return NextResponse.json(
            { success: false, error: e.message },
            { status: 500 }
        );
    }
}
