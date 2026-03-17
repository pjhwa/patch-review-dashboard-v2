import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import Papa from 'papaparse';
import { PRODUCT_REGISTRY } from '@/lib/products-registry';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const categoryId = searchParams.get('categoryId');
        const productId = searchParams.get('productId');

        if (!categoryId) {
            return new NextResponse('Missing categoryId', { status: 400 });
        }

        let filename = `Final_Approved_Patches_${categoryId}_${new Date().toISOString().split('T')[0]}.csv`;

        let vendorFilters: string[] = [];
        if (productId && productId !== 'all') {
            filename = `Final_Approved_Patches_${categoryId}_${productId}.csv`;
            // Look up vendor string from registry
            const productCfg = PRODUCT_REGISTRY.find(p => p.id === productId);
            if (productCfg) {
                vendorFilters.push(productCfg.vendorString);
            }
        } else {
            // "all" meaning all active vendors in the category
            const categoryProducts = PRODUCT_REGISTRY.filter(
                p => p.active && p.category === categoryId
            );
            vendorFilters = categoryProducts.map(p => p.vendorString);
        }

        const whereClause = vendorFilters.length > 0 ? {
            vendor: {
                in: vendorFilters
            }
        } : {};

        const approvedPatches = await prisma.reviewedPatch.findMany({
            where: whereClause,
            orderBy: { reviewedAt: 'desc' },
            select: {
                issueId: true,
                component: true,
                version: true,
                vendor: true,
                reviewedAt: true,
                criticality: true,
                description: true,
                koreanDescription: true,
                decision: true,
                reason: true
            }
        });

        if (approvedPatches.length === 0) {
            return new NextResponse('No finalized CSVs available. Ensure reviews are marked as complete or records exist.', { status: 404 });
        }

        const mappedPatches = approvedPatches.map((p: any) => ({
            IssueID: p.issueId,
            Component: p.component,
            Version: p.version,
            Vendor: p.vendor,
            Date: p.reviewedAt.toISOString().split('T')[0],
            Criticality: p.criticality,
            Description: p.description,
            KoreanDescription: p.koreanDescription,
            Decision: p.decision,
            Reason: p.reason
        }));

        // \uFEFF is the UTF-8 BOM which tells Excel to read as UTF-8 strictly, preserving Korean characters
        const csvContent = '\uFEFF' + Papa.unparse(mappedPatches);

        // Return the file as a downloadable response
        return new NextResponse(csvContent, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="${filename}"`
            }
        });

    } catch (e: any) {
        console.error("Export error:", e);
        return new NextResponse(`Internal server error: ${e.message}`, { status: 500 });
    }
}
