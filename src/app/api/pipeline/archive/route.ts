import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
    try {
        const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        const archiveDir = path.join(linuxSkillDir, 'archive');

        if (!fs.existsSync(archiveDir)) {
            return NextResponse.json({ archives: [] });
        }

        const items = fs.readdirSync(archiveDir);
        const archives = [];

        for (const item of items) {
            const itemPath = path.join(archiveDir, item);
            const stat = fs.statSync(itemPath);

            if (stat.isDirectory()) {
                const hasFinalJSON = fs.existsSync(path.join(itemPath, 'patch_review_ai_report.json'));

                archives.push({
                    id: item,
                    createdAt: stat.birthtime || stat.mtime,
                    hasFinalJSON
                });
            }
        }

        // Sort descending by creation date (newest first)
        archives.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return NextResponse.json({ archives });
    } catch (error: any) {
        console.error("Failed to fetch archives:", error);
        return NextResponse.json({ error: 'Failed to fetch archives' }, { status: 500 });
    }
}

