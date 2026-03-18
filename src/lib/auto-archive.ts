/**
 * Auto-archive utility: checks if all active products have completed manager reviews,
 * and if so, creates a quarterly archive snapshot automatically.
 */
import fs from 'fs';
import path from 'path';
import { prisma } from '@/lib/db';
import { PRODUCT_REGISTRY, getSkillDir } from '@/lib/products-registry';

// 현재 날짜를 기반으로 분기 문자열을 반환한다. 예: "Q1 2026"
export function getCurrentQuarter(): string {
    const now = new Date();
    const month = now.getMonth() + 1; // 1-12
    const year = now.getFullYear();
    const q = Math.ceil(month / 3);
    return `Q${q} ${year}`; // e.g., "Q1 2026"
}

// 아직 finalCsvFile이 생성되지 않은 활성 제품 목록을 반환한다.
// 이 목록이 비어있어야 분기 아카이브를 생성할 수 있다.
export function getIncompleteProducts(): string[] {
    return PRODUCT_REGISTRY
        .filter(p => p.active)
        .filter(p => {
            const skillDir = getSkillDir(p);
            const csvPath = path.join(skillDir, p.finalCsvFile);
            return !fs.existsSync(csvPath);
        })
        .map(p => p.name);
}

// 현재 ReviewedPatch 전체를 스냅샷으로 저장하는 분기 아카이브를 생성한다.
// ~/.openclaw/workspace/skills/patch-review/quarterly-archive/{quarter}/ 아래에
// metadata.json(통계 및 제품 목록)과 patches.json(전체 패치 데이터)을 저장한다.
export async function createQuarterlyArchive(quarter: string): Promise<{ totalPatches: number }> {
    const QUARTERLY_ARCHIVE_BASE = path.join(
        process.env.HOME || '/home/citec',
        '.openclaw/workspace/skills/patch-review/quarterly-archive'
    );

    const reviewedPatches = await prisma.reviewedPatch.findMany({
        orderBy: { reviewedAt: 'desc' }
    });

    // vendor 문자열 → 제품 정보 역방향 맵을 구성해 DB의 vendor 필드로 제품을 조회할 수 있게 한다.
    const vendorToProduct = new Map<string, { productId: string; categoryId: string; productName: string }>();
    for (const product of PRODUCT_REGISTRY) {
        if (product.active) {
            vendorToProduct.set(product.vendorString, {
                productId: product.id,
                categoryId: product.category,
                productName: product.name
            });
        }
    }

    const patches = reviewedPatches.map(p => {
        const productInfo = vendorToProduct.get(p.vendor) || {
            productId: p.vendor.toLowerCase().replace(/\s+/g, '-'),
            categoryId: 'unknown',
            productName: p.vendor
        };
        return {
            categoryId: productInfo.categoryId,
            productId: productInfo.productId,
            IssueID: p.issueId,
            Component: p.component,
            Version: p.version,
            Vendor: p.vendor,
            Date: p.reviewedAt.toISOString().split('T')[0],
            Criticality: p.criticality,
            Description: p.description,
            KoreanDescription: p.koreanDescription,
            Decision: p.decision,
            Reason: p.reason || ''
        };
    });

    const patchCountMap: Record<string, Record<string, number>> = {};
    for (const patch of patches) {
        if (!patchCountMap[patch.categoryId]) patchCountMap[patch.categoryId] = {};
        patchCountMap[patch.categoryId][patch.productId] =
            (patchCountMap[patch.categoryId][patch.productId] || 0) + 1;
    }

    const seenProducts = new Set<string>();
    const productDetails: { categoryId: string; productId: string; productName: string; patchCount: number }[] = [];
    for (const patch of patches) {
        const key = `${patch.categoryId}:${patch.productId}`;
        if (!seenProducts.has(key)) {
            seenProducts.add(key);
            const productCfg = PRODUCT_REGISTRY.find(p => p.id === patch.productId);
            productDetails.push({
                categoryId: patch.categoryId,
                productId: patch.productId,
                productName: productCfg?.name || patch.Vendor,
                patchCount: patchCountMap[patch.categoryId]?.[patch.productId] || 0
            });
        }
    }

    const metadata = {
        quarter,
        createdAt: new Date().toISOString(),
        totalPatches: patches.length,
        products: productDetails
    };

    const dirName = quarter.replace(' ', '-');
    const archiveDir = path.join(QUARTERLY_ARCHIVE_BASE, dirName);

    if (!fs.existsSync(QUARTERLY_ARCHIVE_BASE)) {
        fs.mkdirSync(QUARTERLY_ARCHIVE_BASE, { recursive: true });
    }
    fs.mkdirSync(archiveDir, { recursive: true });

    fs.writeFileSync(path.join(archiveDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    fs.writeFileSync(path.join(archiveDir, 'patches.json'), JSON.stringify(patches, null, 2), 'utf-8');

    return { totalPatches: patches.length };
}
