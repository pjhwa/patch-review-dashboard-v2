import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';

const execAsync = util.promisify(exec);

export async function POST() {
    try {
        const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        
        // Execute the preprocessing script with the preview flag (no DB insertion)
        console.log('[Preview] Running patch_preprocessing.py --days 90 --no-db');
        const { stdout, stderr } = await execAsync('python3 patch_preprocessing.py --days 90 --no-db', { 
            cwd: linuxSkillDir,
            timeout: 60000 // 60 seconds timeout
        });

        console.log('[Preview] Script executed successfully.');
        
        return NextResponse.json({
            success: true,
            message: 'Preprocessing preview completed successfully.'
        });
    } catch (error: any) {
        console.error("Preprocessing preview failed:", error);
        return NextResponse.json({ 
            error: error.message || 'Execution failed',
            details: error.stderr || '' 
        }, { status: 500 });
    }
}
