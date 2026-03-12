import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    if (category !== 'os' && category !== 'storage' && category !== 'database') {
        return NextResponse.json({ products: [] });
    }

    // ==================== STORAGE / CEPH CATEGORY ====================
    if (category === 'storage') {
        const cephSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/storage/ceph');
        const cephDataDir = path.join(cephSkillDir, 'ceph_data');

        const countJsonFiles = (dirPath: string): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((f: string) => 
                        (f.startsWith('GHSA-') || f.startsWith('REDMINE-')) && f.endsWith('.json')
                    ).length;
                } catch { return 0; }
            }
            return 0;
        };

        // Collected = GHSA-* and REDMINE-* JSON files in ceph_data/
        const collected = countJsonFiles(cephDataDir);

        let preprocessed = 0;
        let reviewed = 0;
        try {
            const prePatch = await prisma.preprocessedPatch.count({ where: { vendor: 'Ceph' } });
            preprocessed = prePatch;
            const revPatch = await prisma.reviewedPatch.count({ where: { vendor: 'Ceph' } });
            reviewed = revPatch;
        } catch (e) { /* DB not ready yet */ }

        const cephFinalCsv = path.join(cephSkillDir, 'final_approved_patches_ceph.csv');
        let approved = 0;
        let isReviewCompleted = false;
        if (fs.existsSync(cephFinalCsv)) {
            try {
                const content = fs.readFileSync(cephFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                approved = parsed.data ? parsed.data.length : 0;
                isReviewCompleted = true;
            } catch { isReviewCompleted = true; }
        }

        const storageProducts = [
            {
                id: 'ceph',
                name: 'Ceph',
                stages: { collected, preprocessed, reviewed, approved },
                active: true,
                isReviewCompleted,
            },
        ];

        return NextResponse.json({ products: storageProducts });
    }
    // ==================== END STORAGE ====================

    // ==================== DATABASE / MARIADB CATEGORY ====================
    if (category === 'database') {
        const mariadbSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/database/mariadb');
        const mariadbDataDir = path.join(mariadbSkillDir, 'mariadb_data');

        const countJsonFiles = (dirPath: string): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((f: string) => 
                        (f.startsWith('RHSA-') || f.startsWith('RHBA-')) && f.endsWith('.json')
                    ).length;
                } catch { return 0; }
            }
            return 0;
        };

        // Collected = RHSA-* and RHBA-* JSON files in mariadb_data/
        const collected = countJsonFiles(mariadbDataDir);

        let preprocessed = 0;
        let reviewed = 0;
        try {
            const prePatch = await prisma.preprocessedPatch.count({ where: { vendor: 'MariaDB' } });
            preprocessed = prePatch;
            const revPatch = await prisma.reviewedPatch.count({ where: { vendor: 'MariaDB' } });
            reviewed = revPatch;
        } catch (e) { /* DB not ready yet */ }

        const mariadbFinalCsv = path.join(mariadbSkillDir, 'final_approved_patches_mariadb.csv');
        let approved = 0;
        let isReviewCompleted = false;
        if (fs.existsSync(mariadbFinalCsv)) {
            try {
                const content = fs.readFileSync(mariadbFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                approved = parsed.data ? parsed.data.length : 0;
                isReviewCompleted = true;
            } catch { isReviewCompleted = true; }
        }

        const databaseProducts = [
            {
                id: 'mariadb',
                name: 'MariaDB',
                stages: { collected, preprocessed, reviewed, approved },
                active: true,
                isReviewCompleted,
            },
            { id: 'postgresql', name: 'PostgreSQL', stages: null, active: false, isReviewCompleted: false },
            { id: 'mysql', name: 'MySQL', stages: null, active: false, isReviewCompleted: false },
            { id: 'mongodb', name: 'MongoDB', stages: null, active: false, isReviewCompleted: false },
        ];

        return NextResponse.json({ products: databaseProducts });
    }
    // ==================== END DATABASE ====================

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
