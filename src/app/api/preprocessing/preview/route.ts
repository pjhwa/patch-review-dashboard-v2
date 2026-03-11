import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
    try {
        const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        const patchesPath = path.join(linuxSkillDir, 'patches_for_llm_review.json');
        
        if (!fs.existsSync(patchesPath)) {
            return NextResponse.json({ 
                success: false, 
                patches: [], 
                message: 'Preview generated file not found. Please run preprocessing first.' 
            });
        }

        const data = fs.readFileSync(patchesPath, 'utf8');
        const patches = JSON.parse(data);

        return NextResponse.json({
            success: true,
            patches
        });
    } catch (error: any) {
        console.error("Failed to read preview patches:", error);
        return NextResponse.json({ 
            error: error.message || 'Failed to read preview patches'
        }, { status: 500 });
    }
}
