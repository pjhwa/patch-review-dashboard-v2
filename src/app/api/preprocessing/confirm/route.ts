import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { pipelineQueue } from '@/lib/queue';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { patches } = body;

        if (!Array.isArray(patches)) {
            return NextResponse.json({ error: 'Expected an array of patches' }, { status: 400 });
        }

        const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        const patchesPath = path.join(linuxSkillDir, 'patches_for_llm_review.json');

        // 1. Overwrite patches_for_llm_review.json with the confirmed list
        fs.writeFileSync(patchesPath, JSON.stringify(patches, null, 2));

        // 2. Clear existing PreprocessedPatch table & Insert the new confirmed ones
        const runId = uuidv4();
        
        await prisma.preprocessedPatch.deleteMany({});
        
        const insertData = patches.map(p => ({
            id: uuidv4(),
            vendor: p.vendor || 'Unknown',
            issueId: p.id || p.issueId || 'Unknown',
            osVersion: p.os_version || p.dist_version || 'Unknown',
            component: p.component || 'Unknown',
            version: p.specific_version || p.version || 'Unknown',
            severity: p.severity || '',
            releaseDate: p.date || p.releaseDate || '',
            description: p.summary || p.description || '',
            url: p.ref_url || p.url || '',
            isReviewed: false,
            pipelineRunId: runId
        }));

        if (insertData.length > 0) {
            await prisma.preprocessedPatch.createMany({
                data: insertData
            });
        }

        // 3. Trigger BullMQ pipeline with isAiOnly = true to skip preprocessing step again
        const job = await pipelineQueue.add('run-pipeline', { 
            category: 'os', 
            productId: 'redhat', // Can be any mapped product that uses the shared linux skill
            isAiOnly: true 
        });

        return NextResponse.json({
            success: true,
            message: `Confirmed ${patches.length} patches. AI Review pipeline started.`,
            jobId: job.id
        });
    } catch (error: any) {
        console.error("Confirmation and pipeline trigger failed:", error);
        return NextResponse.json({ error: error.message || 'Execution failed' }, { status: 500 });
    }
}
