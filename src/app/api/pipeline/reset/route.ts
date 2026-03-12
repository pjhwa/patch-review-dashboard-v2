import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
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

        const results: Record<string, number | string> = {};

        // --- 1. Delete SQLite records ---
        const deletedRaw = await prisma.rawPatch.deleteMany({});
        results.rawPatchesDeleted = deletedRaw.count;

        const deletedReviewed = await prisma.reviewedPatch.deleteMany({});
        results.reviewedPatchesDeleted = deletedReviewed.count;

        const deletedPreprocessed = await prisma.preprocessedPatch.deleteMany({});
        results.preprocessedPatchesDeleted = deletedPreprocessed.count;

        // --- 2. Wipe raw batch_data files ---
        const linuxV2Dir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        const batchDataDir = path.join(linuxV2Dir, 'batch_data');

        let filesDeleted = 0;
        if (fs.existsSync(batchDataDir)) {
            const files = fs.readdirSync(batchDataDir).filter(f => f.endsWith('.json'));
            for (const file of files) {
                fs.unlinkSync(path.join(batchDataDir, file));
                filesDeleted++;
            }
        }
        results.batchDataFilesDeleted = filesDeleted;

        // --- 3. Delete intermediate/output files ---
        const filesToDelete = [
            'patches_for_llm_review.json',
            'patch_review_ai_report.json',
            'collection_checkpoint.json',
            'debug_collector.log',
        ];
        let extraFilesDeleted = 0;
        for (const fname of filesToDelete) {
            const fpath = path.join(linuxV2Dir, fname);
            if (fs.existsSync(fpath)) {
                fs.unlinkSync(fpath);
                extraFilesDeleted++;
            }
        }
        results.extraFilesDeleted = extraFilesDeleted;

        console.log(`[RESET] Category "${categoryId}" reset complete. Results:`, results);

        return NextResponse.json({
            success: true,
            message: `All data for category "${categoryId}" has been reset. The next pipeline run will start a fresh full collection.`,
            results,
        });
    } catch (error: any) {
        console.error('[RESET] Error during data reset:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}
