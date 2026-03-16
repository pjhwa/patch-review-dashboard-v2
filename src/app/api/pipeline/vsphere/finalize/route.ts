import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import Papa from 'papaparse';
import os from 'os';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { approvedIssueIds } = body;

        const vsphereSkillDir = path.join(os.homedir(), '.openclaw/workspace/skills/patch-review/virtualization/vsphere');
        const sourceJsonPath = path.join(vsphereSkillDir, 'patch_review_ai_report_vsphere.json');
        const outputCsvPath = path.join(vsphereSkillDir, 'final_approved_patches_vsphere.csv');

        // Verify AI reviewed data exists
        try {
            await fs.access(sourceJsonPath);
        } catch {
            return NextResponse.json({ error: 'AI Review JSON missing. Cannot finalize.' }, { status: 404 });
        }

        const rawContent = await fs.readFile(sourceJsonPath, 'utf8');
        let allPatches = JSON.parse(rawContent);

        let approvedPatches;
        if (approvedIssueIds && Array.isArray(approvedIssueIds) && approvedIssueIds.length > 0) {
            approvedPatches = allPatches.filter((patch: any) => {
                const pid = patch.IssueID || patch['Issue ID'] || patch.Issue_ID || patch.patch_id || patch.id;
                return pid && approvedIssueIds.includes(pid);
            });
        } else {
            // If no IDs provided, finalize all reviewed patches
            approvedPatches = allPatches;
        }

        const finalCsvContent = Papa.unparse(approvedPatches);
        await fs.writeFile(outputCsvPath, finalCsvContent, 'utf8');

        return NextResponse.json({
            success: true,
            message: `Finalized ${approvedPatches.length} VMware vSphere patches.`,
            count: approvedPatches.length,
            outputPath: outputCsvPath,
        });
    } catch (e: any) {
        return NextResponse.json({ success: false, error: e.message }, { status: 500 });
    }
}
