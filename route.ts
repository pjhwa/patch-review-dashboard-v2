import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET(request: Request, props: { params: Promise<{ stageId: string }> }) {
    const { stageId } = await props.params;
    const { searchParams } = new URL(request.url);
    const productId = searchParams.get('product');

    if (stageId !== 'preprocessed' && stageId !== 'reviewed') {
        return NextResponse.json({ error: "Only preprocessed and reviewed stages are supported for now." }, { status: 400 });
    }

    try {
        let patches: any[] = [];
        let message = "";

        let targetVendor: string | undefined = undefined;
        if (productId === 'redhat') targetVendor = 'Red Hat';
        else if (productId === 'oracle') targetVendor = 'Oracle';
        else if (productId === 'ubuntu') targetVendor = 'Ubuntu';

        if (stageId === 'preprocessed') {
            const whereClause = targetVendor ? { vendor: targetVendor } : {};
            patches = await prisma.preprocessedPatch.findMany({
                where: whereClause,
                orderBy: { collectedAt: 'desc' }
            });
            message = "These are the pre-processed (filtered) patches before AI Review.";
        } else if (stageId === 'reviewed') {
            const whereClause = targetVendor ? {
                vendor: { contains: targetVendor }
            } : {};
            const reviewedPatches = await prisma.reviewedPatch.findMany({
                where: whereClause,
                orderBy: { reviewedAt: 'desc' }
            });

            const issueIds = reviewedPatches.map(p => p.issueId);
            const preprocessed = await prisma.preprocessedPatch.findMany({
                where: { issueId: { in: issueIds } },
                select: { issueId: true, releaseDate: true }
            });
            const dateMap = new Map(preprocessed.map(p => [p.issueId, p.releaseDate]));

            patches = reviewedPatches.map(p => ({
                ...p,
                releaseDate: dateMap.get(p.issueId) || ""
            }));

            message = "These are the final patches reviewed by the AI.";
        }

        return NextResponse.json({
            stage: stageId,
            product: productId || 'all',
            count: patches.length,
            message,
            data: patches
        });
    } catch (e: any) {
        return NextResponse.json({ error: `Failed to read data from DB: ${e.message}` }, { status: 500 });
    }
}
