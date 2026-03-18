import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import Papa from 'papaparse';
import os from 'os';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { productId, categoryId, approvedIssueIds } = body;

        if (!productId || !approvedIssueIds || !Array.isArray(approvedIssueIds)) {
            return NextResponse.json({ error: 'Missing or invalid parameters' }, { status: 400 });
        }

        const homedir = os.homedir();
        const workspacePath = process.env.OPENCLAW_WORKSPACE || path.join(homedir, '.openclaw/workspace');

        // Determine source JSON and output CSV path based on productId
        let sourceJsonPath: string;
        let outputCsvPath: string;

        if (productId === 'redhat' || productId === 'oracle' || productId === 'ubuntu') {
            const linuxV2Dir = path.join(workspacePath, 'skills/patch-review/os/linux');
            sourceJsonPath = path.join(linuxV2Dir, `patch_review_ai_report_${productId}.json`);
            outputCsvPath = path.join(linuxV2Dir, `final_approved_patches_${productId}.csv`);
        } else {
            // Legacy fallback path (should not normally be reached)
            const basePath = path.join(workspacePath, 'skills/patch-review', categoryId || 'os', 'linux');
            sourceJsonPath = path.join(basePath, 'patch_review_ai_report.json');
            outputCsvPath = path.join(basePath, `final_approved_patches_${productId}.csv`);
        }

        // Verify AI reviewed data exists
        try {
            await fs.access(sourceJsonPath);
        } catch {
            return NextResponse.json({ error: `AI Review JSON missing at ${sourceJsonPath}. Cannot finalize.` }, { status: 404 });
        }

        // Read the AI generated JSON
        const rawContent = await fs.readFile(sourceJsonPath, 'utf8');
        let allPatches = JSON.parse(rawContent);

        // Filter the preprocessed data to ONLY include patches that match approvedIssueIds
        const approvedPatches = allPatches.filter((patch: any) => {
            const pid = patch.IssueID || patch['Issue ID'] || patch.Issue_ID || patch.id;
            return pid && approvedIssueIds.includes(pid);
        });

        if (approvedPatches.length === 0) {
            // Write empty CSV with headers
            const emptyCsv = Papa.unparse([], { columns: ['IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription'] });
            await fs.writeFile(outputCsvPath, emptyCsv, 'utf8');
            return NextResponse.json({ message: 'Finalized. No patches were approved.', count: 0 });
        }

        // Generate final CSV content retaining all rich AI fields
        const finalCsvContent = '\uFEFF' + Papa.unparse(approvedPatches);

        // Save the CSV
        await fs.writeFile(outputCsvPath, finalCsvContent, 'utf8');

        return NextResponse.json({
            success: true,
            message: 'Finalized CSV generated successfully.',
            count: approvedPatches.length
        });

    } catch (e: any) {
        console.error("Finalize error:", e);
        return NextResponse.json({ error: 'Internal server error', details: e.message }, { status: 500 });
    }
}
