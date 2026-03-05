import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import Papa from 'papaparse';

export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url);
        const categoryId = searchParams.get('categoryId');
        const productId = searchParams.get('productId');

        if (!categoryId) {
            return new NextResponse('Missing categoryId', { status: 400 });
        }

        const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(require('os').homedir(), '.openclaw/workspace');
        // Currently, pipelines are shared under os/linux
        const basePath = path.join(workspacePath, 'skills/patch-review', categoryId, 'linux');

        let csvContent = "";
        let filename = `Final_Approved_Patches_${categoryId}_Linux_${new Date().toISOString().split('T')[0]}.csv`;

        if (productId && productId !== 'all') {
            const csvPath = path.join(basePath, `final_approved_patches_${productId}.csv`);
            try {
                csvContent = await fs.readFile(csvPath, 'utf8');
                filename = `Final_Approved_Patches_${categoryId}_${productId}.csv`;
            } catch (e) {
                return new NextResponse(`Final CSV not found for ${productId}.`, { status: 404 });
            }
        } else {
            // Merge all final_approved_patches_*.csv
            try {
                const files = await fs.readdir(basePath);
                const approvedFiles = files.filter(f => f.startsWith('final_approved_patches_') && f.endsWith('.csv'));

                if (approvedFiles.length === 0) {
                    return new NextResponse('No finalized CSVs available. Ensure reviews are marked as complete.', { status: 404 });
                }

                let allRows: any[] = [];
                let headers: string[] = [];

                for (const file of approvedFiles) {
                    const content = await fs.readFile(path.join(basePath, file), 'utf8');
                    const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                    if (headers.length === 0 && parsed.meta.fields) {
                        headers = parsed.meta.fields;
                    }
                    if (parsed.data && parsed.data.length > 0) {
                        allRows = allRows.concat(parsed.data);
                    }
                }

                if (allRows.length === 0) {
                    csvContent = Papa.unparse([], { columns: headers });
                } else {
                    csvContent = Papa.unparse(allRows);
                }
            } catch (e) {
                return new NextResponse('Error reading or merging CSV files.', { status: 500 });
            }
        }

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
