import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { PRODUCT_REGISTRY, getSkillDir } from '@/lib/products-registry';
import fs from 'fs';
import path from 'path';

/**
 * POST /api/pipeline/reset
 * Wipes all collected + preprocessed + reviewed data for a given category.
 * Body: { categoryId: string, confirm: "RESET" }
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { categoryId, confirm } = body;

        if (!categoryId) {
            return NextResponse.json({ success: false, error: 'categoryId is required' }, { status: 400 });
        }

        // Double-safety: require explicit "RESET" confirmation string from frontend
        if (confirm !== 'RESET') {
            return NextResponse.json({ success: false, error: 'Missing confirmation string. Send { confirm: "RESET" }' }, { status: 400 });
        }

        // 해당 카테고리의 활성 제품만 대상으로 한다
        const categoryProducts = PRODUCT_REGISTRY.filter(p => p.active && p.category === categoryId);
        if (categoryProducts.length === 0) {
            return NextResponse.json({ success: false, error: `Unknown or empty category: ${categoryId}` }, { status: 400 });
        }

        const vendorStrings = categoryProducts.map(p => p.vendorString);
        const results: Record<string, number | string> = {};

        // --- 1. Delete SQLite records (해당 카테고리 vendor만) ---
        const deletedRaw = await prisma.rawPatch.deleteMany({
            where: { vendor: { in: vendorStrings } },
        });
        results.rawPatchesDeleted = deletedRaw.count;

        const deletedReviewed = await prisma.reviewedPatch.deleteMany({
            where: { vendor: { in: vendorStrings } },
        });
        results.reviewedPatchesDeleted = deletedReviewed.count;

        const deletedPreprocessed = await prisma.preprocessedPatch.deleteMany({
            where: { vendor: { in: vendorStrings } },
        });
        results.preprocessedPatchesDeleted = deletedPreprocessed.count;

        // --- 2. Delete intermediate/output files (제품별 skillDir 기준) ---
        let filesDeleted = 0;
        for (const prod of categoryProducts) {
            const skillDir = getSkillDir(prod);
            const filesToDelete = [
                prod.patchesForReviewFile,
                prod.aiReportFile,
                prod.finalCsvFile,
                'collection_checkpoint.json',
                'debug_collector.log',
            ];
            for (const fname of filesToDelete) {
                const fpath = path.join(skillDir, fname);
                if (fs.existsSync(fpath)) {
                    fs.unlinkSync(fpath);
                    filesDeleted++;
                }
            }
        }
        results.filesDeleted = filesDeleted;

        console.log(`[RESET] Category "${categoryId}" (vendors: ${vendorStrings.join(', ')}) reset complete.`, results);

        return NextResponse.json({
            success: true,
            message: `Category "${categoryId}" reset complete (${vendorStrings.join(', ')}).`,
            results,
        });
    } catch (error: any) {
        console.error('[RESET] Error during data reset:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
