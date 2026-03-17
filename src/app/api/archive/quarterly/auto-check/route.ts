import { NextResponse } from 'next/server';
import { getCurrentQuarter, getIncompleteProducts, createQuarterlyArchive } from '@/lib/auto-archive';

/**
 * POST /api/archive/quarterly/auto-check
 *
 * Called after each product finalize (Mark as DONE).
 * Checks if ALL active products have completed manager reviews.
 * If yes, automatically creates a quarterly archive for the current quarter.
 */
export async function POST() {
    try {
        const incompleteProducts = getIncompleteProducts();

        if (incompleteProducts.length > 0) {
            return NextResponse.json({
                triggered: false,
                remaining: incompleteProducts
            });
        }

        const quarter = getCurrentQuarter();
        const { totalPatches } = await createQuarterlyArchive(quarter);

        console.log(`[Auto-Archive] All products completed. Created quarterly archive: ${quarter} (${totalPatches} patches)`);

        return NextResponse.json({
            triggered: true,
            quarter,
            totalPatches
        });
    } catch (error: any) {
        console.error("[Auto-Archive] Failed:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
