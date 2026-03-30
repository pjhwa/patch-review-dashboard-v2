import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

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
        else if (productId === 'ceph') targetVendor = 'Ceph';
        else if (productId === 'mariadb') targetVendor = 'MariaDB';
        else if (productId === 'windows') targetVendor = 'Windows Server';
        else if (productId === 'sqlserver') targetVendor = 'SQL Server';
        else if (productId === 'vsphere') targetVendor = 'VMware vSphere';
        else if (productId === 'nsx') targetVendor = 'VMware NSX';
        else if (productId === 'pgsql') targetVendor = 'PostgreSQL';
        else if (productId === 'jboss_eap') targetVendor = 'JBoss EAP';

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

            // Fetch Reviewed Patches
            const rows = await prisma.reviewedPatch.findMany({
                where: whereClause,
                orderBy: { reviewedAt: 'desc' }
            });

            // Fetch corresponding Preprocessed Patches to extract URL and Release Date
            const issueIds = rows.map((r: any) => r.issueId);
            const preProcessedData = await prisma.preprocessedPatch.findMany({
                where: { issueId: { in: issueIds } },
                select: { issueId: true, url: true, releaseDate: true }
            });
            const preProcessedMap = new Map();
            preProcessedData.forEach((p: any) => preProcessedMap.set(p.issueId, p));

            // Map DB camelCase fields → PascalCase so the UI can read IssueID, Component, Vendor etc.
            // Without this mapping the UI falls back to '미확인-이슈-N' for missing IssueID.
            patches = rows.map((r: any) => {
                const meta = preProcessedMap.get(r.issueId) || {};
                return {
                    IssueID: r.issueId,
                    Component: r.component,
                    Version: r.version,
                    Vendor: r.vendor,
                    OsVersion: r.osVersion,
                    Criticality: r.criticality,
                    Description: r.description,
                    KoreanDescription: r.koreanDescription,
                    Decision: r.decision,
                    Reason: r.reason,
                    ReviewedAt: r.reviewedAt,
                    Date: meta.releaseDate || 'Unknown',
                    Url: meta.url || null,
                    // Keep camelCase originals for backward compatibility
                    issueId: r.issueId,
                    component: r.component,
                    vendor: r.vendor,
                };
            });
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
