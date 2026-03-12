import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * PATCH /api/pipeline/review-request
 * Body: { issueId: string, requested: boolean }
 * 
 * Toggles the `isAiReviewRequested` boolean on a preprocessed patch.
 */
export async function PATCH(request: Request) {
    try {
        const body = await request.json();
        const { issueId, requested } = body as { issueId: string, requested: boolean };

        if (!issueId) {
            return NextResponse.json(
                { success: false, error: 'issueId is required' },
                { status: 400 }
            );
        }

        // Update all patches with this issueId
        const updated = await prisma.preprocessedPatch.updateMany({
            where: { issueId },
            data: { isAiReviewRequested: requested }
        });

        return NextResponse.json({
            success: true,
            message: `Updated isAiReviewRequested to ${requested} for issueId: ${issueId}`,
            updatedCount: updated.count
        });
    } catch (e: any) {
        return NextResponse.json(
            { success: false, error: e.message },
            { status: 500 }
        );
    }
}
