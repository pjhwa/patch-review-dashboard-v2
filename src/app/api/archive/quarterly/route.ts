import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { createQuarterlyArchive } from '@/lib/auto-archive';
import { prisma } from '@/lib/db';

const QUARTERLY_ARCHIVE_BASE = path.join(
    process.env.HOME || '/home/citec',
    '.openclaw/workspace/skills/patch-review/quarterly-archive'
);

function parseQuarterValue(q: string): number {
    const [qPart, year] = q.split(' ');
    return parseInt(year) * 10 + parseInt(qPart.replace('Q', ''));
}

export async function GET() {
    try {
        if (!fs.existsSync(QUARTERLY_ARCHIVE_BASE)) {
            return NextResponse.json({ quarters: [] });
        }

        const dirs = fs.readdirSync(QUARTERLY_ARCHIVE_BASE).filter(item => {
            const itemPath = path.join(QUARTERLY_ARCHIVE_BASE, item);
            return fs.statSync(itemPath).isDirectory();
        });

        const quarters = [];
        for (const dir of dirs) {
            const metadataPath = path.join(QUARTERLY_ARCHIVE_BASE, dir, 'metadata.json');
            if (fs.existsSync(metadataPath)) {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                quarters.push({ ...metadata, dirName: dir });
            }
        }

        quarters.sort((a, b) => parseQuarterValue(b.quarter) - parseQuarterValue(a.quarter));

        return NextResponse.json({ quarters });
    } catch (error: any) {
        console.error("Failed to fetch quarterly archives:", error);
        return NextResponse.json({ error: 'Failed to fetch quarterly archives' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { quarter } = body; // e.g., "Q4 2025"

        if (!quarter || !/^Q[1-4] \d{4}$/.test(quarter)) {
            return NextResponse.json(
                { error: 'Invalid quarter format. Expected format: Q1 2025' },
                { status: 400 }
            );
        }

        const reviewedCount = await prisma.reviewedPatch.count();
        if (reviewedCount === 0) {
            return NextResponse.json(
                { error: 'No finalized patches found. Complete manager reviews before creating an archive.' },
                { status: 400 }
            );
        }

        const { totalPatches } = await createQuarterlyArchive(quarter);
        return NextResponse.json({ success: true, quarter, totalPatches });
    } catch (error: any) {
        console.error("Failed to create quarterly archive:", error);
        return NextResponse.json({ error: `Failed to create quarterly archive: ${error.message}` }, { status: 500 });
    }
}
