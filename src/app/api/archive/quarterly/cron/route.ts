import { NextResponse } from 'next/server';
import { getPreviousQuarter, isQuarterArchiveExists, createQuarterlyArchive } from '@/lib/auto-archive';
import { prisma } from '@/lib/db';

/**
 * POST /api/archive/quarterly/cron
 *
 * 분기 첫 날(1월 1일, 4월 1일, 7월 1일, 10월 1일)에 시스템 cron이 호출한다.
 * 이전 분기의 담당자리뷰완료 또는 AI리뷰완료 상태의 패치 데이터를 자동 아카이브한다.
 * 이미 해당 분기 아카이브가 존재하면 중복 생성하지 않는다.
 */
export async function POST() {
    try {
        const quarter = getPreviousQuarter();

        // 중복 아카이브 방지: 이미 존재하면 스킵
        if (isQuarterArchiveExists(quarter)) {
            console.log(`[Quarterly-Cron] Archive already exists for ${quarter}, skipping.`);
            return NextResponse.json({ triggered: false, reason: 'already_exists', quarter });
        }

        // AI리뷰완료 또는 담당자리뷰완료 단계의 데이터가 있는지 확인 (ReviewedPatch = 두 단계 모두 포함)
        const reviewedCount = await prisma.reviewedPatch.count();
        if (reviewedCount === 0) {
            console.log(`[Quarterly-Cron] No reviewed patches found for ${quarter}, skipping.`);
            return NextResponse.json({ triggered: false, reason: 'no_data', quarter });
        }

        const { totalPatches } = await createQuarterlyArchive(quarter);
        console.log(`[Quarterly-Cron] Created archive for ${quarter}: ${totalPatches} patches`);

        return NextResponse.json({ triggered: true, quarter, totalPatches });
    } catch (error: any) {
        console.error('[Quarterly-Cron] Failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
