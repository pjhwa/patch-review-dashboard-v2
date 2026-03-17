import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

const QUARTERLY_ARCHIVE_BASE = path.join(
    process.env.HOME || '/home/citec',
    '.openclaw/workspace/skills/patch-review/quarterly-archive'
);

export async function GET(req: Request, props: { params: Promise<{ quarter: string }> }) {
    try {
        const { quarter } = await props.params; // e.g., "Q4-2025"
        const { searchParams } = new URL(req.url);
        const categoryId = searchParams.get('categoryId');
        const productId = searchParams.get('productId');

        const patchesPath = path.join(QUARTERLY_ARCHIVE_BASE, quarter, 'patches.json');
        if (!fs.existsSync(patchesPath)) {
            return new NextResponse('Archive not found', { status: 404 });
        }

        let patches: any[] = JSON.parse(fs.readFileSync(patchesPath, 'utf-8'));

        if (categoryId) patches = patches.filter((p: any) => p.categoryId === categoryId);
        if (productId) patches = patches.filter((p: any) => p.productId === productId);

        const exportData = patches.map((p: any) => ({
            IssueID: p.IssueID,
            Component: p.Component,
            Version: p.Version,
            Vendor: p.Vendor,
            Date: p.Date,
            Criticality: p.Criticality,
            Description: p.Description,
            KoreanDescription: p.KoreanDescription,
            Decision: p.Decision,
            Reason: p.Reason
        }));

        const quarterDisplay = quarter.replace('-', ' '); // "Q4 2025"
        const csvContent = '\uFEFF' + Papa.unparse(exportData);
        const filename = productId
            ? `Archive_${quarterDisplay}_${productId}.csv`
            : categoryId
                ? `Archive_${quarterDisplay}_${categoryId}.csv`
                : `Archive_${quarterDisplay}_all.csv`;

        return new NextResponse(csvContent, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="${filename}"`
            }
        });
    } catch (error) {
        console.error("Archive download error:", error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
