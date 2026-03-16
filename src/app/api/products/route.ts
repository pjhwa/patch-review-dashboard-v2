import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    if (category !== 'os' && category !== 'storage' && category !== 'database' && category !== 'virtualization') {
        return NextResponse.json({ products: [] });
    }

    // ==================== VIRTUALIZATION / VSPHERE CATEGORY ====================
    if (category === 'virtualization') {
        const vsphereSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/virtualization/vsphere');
        const vsphereDataDir = path.join(vsphereSkillDir, 'vsphere_data');

        const countVsphereJsonFiles = (dirPath: string): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((f: string) => f.endsWith('.json')).length;
                } catch { return 0; }
            }
            return 0;
        };

        const vsphereCollected = countVsphereJsonFiles(vsphereDataDir);

        let vspherePreprocessed = 0;
        let vsphereReviewed = 0;
        try {
            vspherePreprocessed = await prisma.preprocessedPatch.count({ where: { vendor: 'VMware vSphere' } });
            vsphereReviewed = await prisma.reviewedPatch.count({ where: { vendor: 'VMware vSphere' } });
        } catch (e) { }

        const vsphereFinalCsv = path.join(vsphereSkillDir, 'final_approved_patches_vsphere.csv');
        let vsphereApproved = 0;
        let vsphereIsReviewCompleted = false;
        if (fs.existsSync(vsphereFinalCsv)) {
            try {
                const content = fs.readFileSync(vsphereFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                vsphereApproved = parsed.data ? parsed.data.length : 0;
                vsphereIsReviewCompleted = true;
            } catch { vsphereIsReviewCompleted = true; }
        }

        const virtualizationProducts = [
            {
                id: 'vsphere',
                name: 'VMware vSphere',
                stages: { collected: vsphereCollected, preprocessed: vspherePreprocessed, reviewed: vsphereReviewed, approved: vsphereApproved },
                active: true,
                isReviewCompleted: vsphereIsReviewCompleted,
            },
        ];

        return NextResponse.json({ products: virtualizationProducts });
    }
    // ==================== END VIRTUALIZATION ====================

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

    // ==================== DATABASE / MARIADB & SQL SERVER CATEGORY ====================
    if (category === 'database') {
        // --- MariaDB ---
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

        const mariadbCollected = countJsonFiles(mariadbDataDir);

        let mariadbPreprocessed = 0;
        let mariadbReviewed = 0;
        try {
            mariadbPreprocessed = await prisma.preprocessedPatch.count({ where: { vendor: 'MariaDB' } });
            mariadbReviewed = await prisma.reviewedPatch.count({ where: { vendor: 'MariaDB' } });
        } catch (e) { }

        const mariadbFinalCsv = path.join(mariadbSkillDir, 'final_approved_patches_mariadb.csv');
        let mariadbApproved = 0;
        let mariadbIsReviewCompleted = false;
        if (fs.existsSync(mariadbFinalCsv)) {
            try {
                const content = fs.readFileSync(mariadbFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                mariadbApproved = parsed.data ? parsed.data.length : 0;
                mariadbIsReviewCompleted = true;
            } catch { mariadbIsReviewCompleted = true; }
        }

        // --- SQL Server ---
        const sqlserverSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/database/sqlserver');
        const sqlserverDataDir = path.join(sqlserverSkillDir, 'sql_data');

        const countSqlJsonFiles = (dirPath: string): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((f: string) => 
                        f.startsWith('SQLU-') && f.endsWith('.json')
                    ).length;
                } catch { return 0; }
            }
            return 0;
        };

        const sqlserverCollected = countSqlJsonFiles(sqlserverDataDir);

        let sqlserverPreprocessed = 0;
        let sqlserverReviewed = 0;
        try {
            sqlserverPreprocessed = await prisma.preprocessedPatch.count({ where: { vendor: 'SQL Server' } });
            sqlserverReviewed = await prisma.reviewedPatch.count({ where: { vendor: 'SQL Server' } });
        } catch (e) { }

        const sqlserverFinalCsv = path.join(sqlserverSkillDir, 'final_approved_patches_sqlserver.csv');
        let sqlserverApproved = 0;
        let sqlserverIsReviewCompleted = false;
        if (fs.existsSync(sqlserverFinalCsv)) {
            try {
                const content = fs.readFileSync(sqlserverFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                sqlserverApproved = parsed.data ? parsed.data.length : 0;
                sqlserverIsReviewCompleted = true;
            } catch { sqlserverIsReviewCompleted = true; }
        }

        // --- PostgreSQL ---
        const pgsqlSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/database/pgsql');
        const pgsqlDataDir = path.join(pgsqlSkillDir, 'pgsql_data');

        const countPgsqlJsonFiles = (dirPath: string): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((f: string) =>
                        f.startsWith('PGSL-') && f.endsWith('.json')
                    ).length;
                } catch { return 0; }
            }
            return 0;
        };

        const pgsqlCollected = countPgsqlJsonFiles(pgsqlDataDir);

        let pgsqlPreprocessed = 0;
        let pgsqlReviewed = 0;
        try {
            pgsqlPreprocessed = await prisma.preprocessedPatch.count({ where: { vendor: 'PostgreSQL' } });
            pgsqlReviewed = await prisma.reviewedPatch.count({ where: { vendor: 'PostgreSQL' } });
        } catch (e) { }

        const pgsqlFinalCsv = path.join(pgsqlSkillDir, 'final_approved_patches_pgsql.csv');
        let pgsqlApproved = 0;
        let pgsqlIsReviewCompleted = false;
        if (fs.existsSync(pgsqlFinalCsv)) {
            try {
                const content = fs.readFileSync(pgsqlFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                pgsqlApproved = parsed.data ? parsed.data.length : 0;
                pgsqlIsReviewCompleted = true;
            } catch { pgsqlIsReviewCompleted = true; }
        }

        const databaseProducts = [
            {
                id: 'mariadb',
                name: 'MariaDB',
                stages: { collected: mariadbCollected, preprocessed: mariadbPreprocessed, reviewed: mariadbReviewed, approved: mariadbApproved },
                active: true,
                isReviewCompleted: mariadbIsReviewCompleted,
            },
            {
                id: 'sqlserver',
                name: 'SQL Server',
                stages: { collected: sqlserverCollected, preprocessed: sqlserverPreprocessed, reviewed: sqlserverReviewed, approved: sqlserverApproved },
                active: true,
                isReviewCompleted: sqlserverIsReviewCompleted,
            },
            {
                id: 'pgsql',
                name: 'PostgreSQL',
                stages: { collected: pgsqlCollected, preprocessed: pgsqlPreprocessed, reviewed: pgsqlReviewed, approved: pgsqlApproved },
                active: true,
                isReviewCompleted: pgsqlIsReviewCompleted,
            },
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
        ubuntu: { collected: 0, preprocessed: 0, reviewed: 0 },
        windows: { collected: 0, preprocessed: 0, reviewed: 0 }
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
        counts.windows.collected = getFileCount('../windows/windows_data');

        // 2. Count Preprocessed from DB
        const preCounts = await prisma.preprocessedPatch.groupBy({
            by: ['vendor'],
            _count: true,
        });
        for (const row of preCounts) {
            if (row.vendor === 'Red Hat') counts.redhat.preprocessed = row._count;
            if (row.vendor === 'Oracle') counts.oracle.preprocessed = row._count;
            if (row.vendor === 'Ubuntu') counts.ubuntu.preprocessed = row._count;
            if (row.vendor === 'Windows Server') counts.windows.preprocessed = row._count;
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
            if (v.includes('windows')) counts.windows.reviewed = row._count;
        }
    } catch (dbError) {
        console.error("Database query error:", dbError);
    }

    const checkFinalized = (prodId: string) => {
        const filePath = prodId === 'windows' 
            ? path.join(linuxSkillDir, '../windows', `final_approved_patches_${prodId}.csv`) 
            : path.join(linuxSkillDir, `final_approved_patches_${prodId}.csv`);
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
        { id: 'windows', name: 'Windows Server', stages: { ...counts.windows, approved: checkFinalized('windows').approvedCount }, active: true, isReviewCompleted: checkFinalized('windows').isCompleted },
        { id: 'hpux', name: 'HP-UX', stages: null, active: false, isReviewCompleted: false },
        { id: 'aix', name: 'IBM AIX', stages: null, active: false, isReviewCompleted: false },
        { id: 'solaris', name: 'Oracle Solaris', stages: null, active: false, isReviewCompleted: false },
    ];

    return NextResponse.json({ products: osProducts });
}
