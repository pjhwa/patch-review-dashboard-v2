import { NextResponse } from 'next/server';
import { pipelineQueue } from '@/lib/queue';
import { prisma } from '@/lib/db';

/**
 * POST /api/pipeline/review-manual
 * Body: { issueIds: string[], productId: string }
 *
 * Queues a product-aware selective AI review job for the given preprocessed patch issueIds.
 * The worker runs OpenClaw LLM for these specific patches, upserting results into ReviewedPatch
 * without deleting existing records for the product.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { issueIds, productId } = body as { issueIds: string[], productId: string };

        if (!issueIds || !Array.isArray(issueIds) || issueIds.length === 0) {
            return NextResponse.json(
                { success: false, error: 'issueIds must be a non-empty array' },
                { status: 400 }
            );
        }

        if (!productId) {
            return NextResponse.json(
                { success: false, error: 'productId is required' },
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

        // Enqueue a product-aware selective review job
        const jobName = `manual-review-${productId}`;
        const job = await pipelineQueue.add(jobName, {
            type: 'manual-review',
            productId,
            issueIds: patches.map((p: any) => p.issueId),
            patches: patches.map((p: any) => ({
                id: p.issueId,
                issueId: p.issueId,
                vendor: p.vendor,
                component: p.component,
                version: p.version,
                severity: p.severity,
                description: p.description,
                url: p.url,
                releaseDate: p.releaseDate,
                osVersion: p.osVersion,
            }))
        });

        return NextResponse.json({
            success: true,
            message: `Queued manual AI review for ${patches.length} patches (${productId})`,
            jobId: job.id,
            issueIds: patches.map((p: any) => p.issueId)
        });
    } catch (e: any) {
        return NextResponse.json(
            { success: false, error: e.message },
            { status: 500 }
        );
    }
}
