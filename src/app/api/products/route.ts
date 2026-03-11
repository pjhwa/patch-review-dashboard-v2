import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    if (category !== 'os') {
        return NextResponse.json({ products: [] });
    }

    const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');

    const counts = {
        redhat: { collected: 0, preprocessed: 0, reviewed: 0 },
        oracle: { collected: 0, preprocessed: 0, reviewed: 0 },
        ubuntu: { collected: 0, preprocessed: 0, reviewed: 0 }
    };

    try {
        // 1. Count Collected from Filesystem (JSON directories) instead of RawPatch DB
        const getFileCount = (subDir: string) => {
            const dirPath = path.join(linuxSkillDir, subDir);
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((file: string) => file.endsWith('.json')).length;
                } catch (e) {
                    return 0;
                }
            }
            return 0;
        };

        counts.redhat.collected = getFileCount('redhat/redhat_data');
        counts.oracle.collected = getFileCount('oracle/oracle_data');
        counts.ubuntu.collected = getFileCount('ubuntu/ubuntu_data');

        // 2. Count Preprocessed from DB
        const preCounts = await prisma.preprocessedPatch.groupBy({
            by: ['vendor'],
            _count: true,
        });
        for (const row of preCounts) {
            if (row.vendor === 'Red Hat') counts.redhat.preprocessed = row._count;
            if (row.vendor === 'Oracle') counts.oracle.preprocessed = row._count;
            if (row.vendor === 'Ubuntu') counts.ubuntu.preprocessed = row._count;
        }

        // 3. Count Reviewed from DB
        const revCounts = await prisma.reviewedPatch.groupBy({
            by: ['vendor'],
            _count: true,
        });
        for (const row of revCounts) {
            const v = row.vendor.toLowerCase();
            if (v.includes('red hat')) counts.redhat.reviewed = row._count;
            if (v.includes('oracle')) counts.oracle.reviewed = row._count;
            if (v.includes('ubuntu')) counts.ubuntu.reviewed = row._count;
        }
    } catch (dbError) {
        console.error("Database query error:", dbError);
    }

    const checkFinalized = (prodId: string) => {
        const filePath = path.join(linuxSkillDir, `final_approved_patches_${prodId}.csv`);
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                return { isCompleted: true, approvedCount: parsed.data ? parsed.data.length : 0 };
            } catch (e) {
                return { isCompleted: true, approvedCount: 0 };
            }
        }
        return { isCompleted: false, approvedCount: 0 };
    };

    const osProducts = [
        { id: 'redhat', name: 'Red Hat Enterprise Linux', stages: { ...counts.redhat, approved: checkFinalized('redhat').approvedCount }, active: true, isReviewCompleted: checkFinalized('redhat').isCompleted },
        { id: 'oracle', name: 'Oracle Linux', stages: { ...counts.oracle, approved: checkFinalized('oracle').approvedCount }, active: true, isReviewCompleted: checkFinalized('oracle').isCompleted },
        { id: 'ubuntu', name: 'Ubuntu Linux', stages: { ...counts.ubuntu, approved: checkFinalized('ubuntu').approvedCount }, active: true, isReviewCompleted: checkFinalized('ubuntu').isCompleted },
        { id: 'windows', name: 'Windows Server', stages: null, active: false, isReviewCompleted: false },
        { id: 'hpux', name: 'HP-UX', stages: null, active: false, isReviewCompleted: false },
        { id: 'aix', name: 'IBM AIX', stages: null, active: false, isReviewCompleted: false },
        { id: 'solaris', name: 'Oracle Solaris', stages: null, active: false, isReviewCompleted: false },
    ];

    return NextResponse.json({ products: osProducts });
}
