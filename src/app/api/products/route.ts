import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    if (category !== 'os' && category !== 'storage' && category !== 'database' && category !== 'virtualization' && category !== 'middleware') {
        return NextResponse.json({ products: [] });
    }

    // ==================== VIRTUALIZATION / VSPHERE & NSX CATEGORY ====================
    if (category === 'virtualization') {
        const vsphereSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/virtualization/vsphere');
        const vsphereDataDir = path.join(vsphereSkillDir, 'vsphere_data');

        const countFilteredJsonFiles = (dirPath: string, filter: (f: string) => boolean): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter(filter).length;
                } catch { return 0; }
            }
            return 0;
        };

        const vsphereCollected = countFilteredJsonFiles(vsphereDataDir, (f) => f.startsWith('VSPH-') && f.endsWith('.json'));

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

        // --- VMware NSX ---
        const nsxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/virtualization/nsx');
        const nsxDataDir = path.join(nsxSkillDir, 'nsx_data');

        const nsxCollected = countFilteredJsonFiles(nsxDataDir, (f) => f.startsWith('NSX-') && f.endsWith('.json'));

        let nsxPreprocessed = 0;
        let nsxReviewed = 0;
        try {
            nsxPreprocessed = await prisma.preprocessedPatch.count({ where: { vendor: 'VMware NSX' } });
            nsxReviewed = await prisma.reviewedPatch.count({ where: { vendor: 'VMware NSX' } });
        } catch (e) { }

        const nsxFinalCsv = path.join(nsxSkillDir, 'final_approved_patches_nsx.csv');
        let nsxApproved = 0;
        let nsxIsReviewCompleted = false;
        if (fs.existsSync(nsxFinalCsv)) {
            try {
                const content = fs.readFileSync(nsxFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                nsxApproved = parsed.data ? parsed.data.length : 0;
                nsxIsReviewCompleted = true;
            } catch { nsxIsReviewCompleted = true; }
        }

        const virtualizationProducts = [
            {
                id: 'vsphere',
                name: 'VMware vSphere',
                stages: { collected: vsphereCollected, preprocessed: vspherePreprocessed, reviewed: vsphereReviewed, approved: vsphereApproved },
                active: true,
                isReviewCompleted: vsphereIsReviewCompleted,
            },
            {
                id: 'nsx',
                name: 'VMware NSX',
                stages: { collected: nsxCollected, preprocessed: nsxPreprocessed, reviewed: nsxReviewed, approved: nsxApproved },
                active: true,
                isReviewCompleted: nsxIsReviewCompleted,
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

        // --- MySQL ---
        const mysqlSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/database/mysql');
        const mysqlDataDir = path.join(mysqlSkillDir, 'mysql_data');

        const countMysqlJsonFiles = (dirPath: string): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((f: string) =>
                        f.startsWith('MYSQ-') && f.endsWith('.json')
                    ).length;
                } catch { return 0; }
            }
            return 0;
        };

        const mysqlCollected = countMysqlJsonFiles(mysqlDataDir);

        let mysqlPreprocessed = 0;
        let mysqlReviewed = 0;
        try {
            mysqlPreprocessed = await prisma.preprocessedPatch.count({ where: { vendor: 'MySQL Community' } });
            mysqlReviewed = await prisma.reviewedPatch.count({ where: { vendor: 'MySQL Community' } });
        } catch (e) { }

        const mysqlFinalCsv = path.join(mysqlSkillDir, 'final_approved_patches_mysql.csv');
        let mysqlApproved = 0;
        let mysqlIsReviewCompleted = false;
        if (fs.existsSync(mysqlFinalCsv)) {
            try {
                const content = fs.readFileSync(mysqlFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                mysqlApproved = parsed.data ? parsed.data.length : 0;
                mysqlIsReviewCompleted = true;
            } catch { mysqlIsReviewCompleted = true; }
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
            {
                id: 'mysql',
                name: 'MySQL Community',
                stages: { collected: mysqlCollected, preprocessed: mysqlPreprocessed, reviewed: mysqlReviewed, approved: mysqlApproved },
                active: true,
                isReviewCompleted: mysqlIsReviewCompleted,
            },
        ];

        return NextResponse.json({ products: databaseProducts });
    }
    // ==================== END DATABASE ====================

    // ==================== MIDDLEWARE / JBOSS EAP CATEGORY ====================
    if (category === 'middleware') {
        const jbossEapSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/middleware/jboss_eap');
        const jbossEapDataDir = path.join(jbossEapSkillDir, 'jboss_eap_data');

        const countJbossJsonFiles = (dirPath: string): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((f: string) =>
                        (f.startsWith('RHSA-') || f.startsWith('RHBA-')) && f.endsWith('.json')
                    ).length;
                } catch { return 0; }
            }
            return 0;
        };

        const jbossEapCollected = countJbossJsonFiles(jbossEapDataDir);

        let jbossEapPreprocessed = 0;
        let jbossEapReviewed = 0;
        try {
            jbossEapPreprocessed = await prisma.preprocessedPatch.count({ where: { vendor: 'JBoss EAP' } });
            jbossEapReviewed = await prisma.reviewedPatch.count({ where: { vendor: 'JBoss EAP' } });
        } catch (e) { }

        const jbossEapFinalCsv = path.join(jbossEapSkillDir, 'final_approved_patches_jboss_eap.csv');
        let jbossEapApproved = 0;
        let jbossEapIsReviewCompleted = false;
        if (fs.existsSync(jbossEapFinalCsv)) {
            try {
                const content = fs.readFileSync(jbossEapFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                jbossEapApproved = parsed.data ? parsed.data.length : 0;
                jbossEapIsReviewCompleted = true;
            } catch { jbossEapIsReviewCompleted = true; }
        }

        // --- Apache Tomcat ---
        const tomcatSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/middleware/tomcat');
        const tomcatDataDir = path.join(tomcatSkillDir, 'tomcat_data');

        const countTomcatJsonFiles = (dirPath: string): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((f: string) =>
                        f.startsWith('TOMC-') && f.endsWith('.json')
                    ).length;
                } catch { return 0; }
            }
            return 0;
        };

        const tomcatCollected = countTomcatJsonFiles(tomcatDataDir);

        let tomcatPreprocessed = 0;
        let tomcatReviewed = 0;
        try {
            tomcatPreprocessed = await prisma.preprocessedPatch.count({ where: { vendor: 'Apache Tomcat' } });
            tomcatReviewed = await prisma.reviewedPatch.count({ where: { vendor: 'Apache Tomcat' } });
        } catch (e) { }

        const tomcatFinalCsv = path.join(tomcatSkillDir, 'final_approved_patches_tomcat.csv');
        let tomcatApproved = 0;
        let tomcatIsReviewCompleted = false;
        if (fs.existsSync(tomcatFinalCsv)) {
            try {
                const content = fs.readFileSync(tomcatFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                tomcatApproved = parsed.data ? parsed.data.length : 0;
                tomcatIsReviewCompleted = true;
            } catch { tomcatIsReviewCompleted = true; }
        }

        // --- WildFly ---
        const wildflySkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/middleware/wildfly');
        const wildflyDataDir = path.join(wildflySkillDir, 'wildfly_data');

        const countWildflyJsonFiles = (dirPath: string): number => {
            if (fs.existsSync(dirPath)) {
                try {
                    return fs.readdirSync(dirPath).filter((f: string) =>
                        f.startsWith('WFLY-') && f.endsWith('.json')
                    ).length;
                } catch { return 0; }
            }
            return 0;
        };

        const wildflyCollected = countWildflyJsonFiles(wildflyDataDir);

        let wildflyPreprocessed = 0;
        let wildflyReviewed = 0;
        try {
            wildflyPreprocessed = await prisma.preprocessedPatch.count({ where: { vendor: 'WildFly' } });
            wildflyReviewed = await prisma.reviewedPatch.count({ where: { vendor: 'WildFly' } });
        } catch (e) { }

        const wildflyFinalCsv = path.join(wildflySkillDir, 'final_approved_patches_wildfly.csv');
        let wildflyApproved = 0;
        let wildflyIsReviewCompleted = false;
        if (fs.existsSync(wildflyFinalCsv)) {
            try {
                const content = fs.readFileSync(wildflyFinalCsv, 'utf-8');
                const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
                wildflyApproved = parsed.data ? parsed.data.length : 0;
                wildflyIsReviewCompleted = true;
            } catch { wildflyIsReviewCompleted = true; }
        }

        const middlewareProducts = [
            {
                id: 'jboss_eap',
                name: 'JBoss EAP',
                stages: { collected: jbossEapCollected, preprocessed: jbossEapPreprocessed, reviewed: jbossEapReviewed, approved: jbossEapApproved },
                active: true,
                isReviewCompleted: jbossEapIsReviewCompleted,
            },
            {
                id: 'tomcat',
                name: 'Apache Tomcat',
                stages: { collected: tomcatCollected, preprocessed: tomcatPreprocessed, reviewed: tomcatReviewed, approved: tomcatApproved },
                active: true,
                isReviewCompleted: tomcatIsReviewCompleted,
            },
            {
                id: 'wildfly',
                name: 'WildFly',
                stages: { collected: wildflyCollected, preprocessed: wildflyPreprocessed, reviewed: wildflyReviewed, approved: wildflyApproved },
                active: true,
                isReviewCompleted: wildflyIsReviewCompleted,
            },
        ];

        return NextResponse.json({ products: middlewareProducts });
    }
    // ==================== END MIDDLEWARE ====================

    const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux');

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
