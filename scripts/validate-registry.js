#!/usr/bin/env node
/**
 * validate-registry.js
 * Validates that all active products in PRODUCT_REGISTRY have required files and correct config.
 *
 * Usage: node scripts/validate-registry.js
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/home/citec';
const SKILLS_BASE = path.join(HOME, '.openclaw/workspace/skills/patch-review');

// Inline the essential registry data (mirrors products-registry.ts active entries)
const PRODUCTS = [
    { id: 'redhat',    skillDirRelative: 'os/linux',           preprocessingScript: 'patch_preprocessing.py',   jobName: 'run-redhat-pipeline',    rateLimitFlag: '/tmp/.rate_limit_redhat',    passthrough: true,  ragType: 'prompt-injection', queryScript: 'query_rag.py' },
    { id: 'oracle',    skillDirRelative: 'os/linux',           preprocessingScript: 'patch_preprocessing.py',   jobName: 'run-oracle-pipeline',    rateLimitFlag: '/tmp/.rate_limit_oracle',    passthrough: true,  ragType: 'prompt-injection', queryScript: 'query_rag.py' },
    { id: 'ubuntu',    skillDirRelative: 'os/linux',           preprocessingScript: 'patch_preprocessing.py',   jobName: 'run-ubuntu-pipeline',    rateLimitFlag: '/tmp/.rate_limit_ubuntu',    passthrough: true,  ragType: 'prompt-injection', queryScript: 'query_rag.py' },
    { id: 'windows',   skillDirRelative: 'os/windows',            preprocessingScript: 'windows_preprocessing.py', jobName: 'run-windows-pipeline',   rateLimitFlag: '/tmp/.rate_limit_windows',   passthrough: false, ragType: 'file-hiding',      normalizedDirName: 'windows_data/normalized' },
    { id: 'ceph',      skillDirRelative: 'storage/ceph',          preprocessingScript: 'ceph_preprocessing.py',    jobName: 'run-ceph-pipeline',      rateLimitFlag: '/tmp/.rate_limit_ceph',      passthrough: true,  ragType: 'file-hiding',      normalizedDirName: 'ceph_data/normalized' },
    { id: 'mariadb',   skillDirRelative: 'database/mariadb',      preprocessingScript: 'mariadb_preprocessing.py', jobName: 'run-mariadb-pipeline',   rateLimitFlag: '/tmp/.rate_limit_mariadb',   passthrough: true,  ragType: 'file-hiding',      normalizedDirName: 'mariadb_data/normalized' },
    { id: 'sqlserver', skillDirRelative: 'database/sqlserver',    preprocessingScript: 'sqlserver_preprocessing.py', jobName: 'run-sqlserver-pipeline', rateLimitFlag: '/tmp/.rate_limit_sqlserver', passthrough: false, ragType: 'file-hiding',      normalizedDirName: 'sql_data/normalized' },
    { id: 'pgsql',     skillDirRelative: 'database/pgsql',        preprocessingScript: 'pgsql_preprocessing.py',   jobName: 'run-pgsql-pipeline',     rateLimitFlag: '/tmp/.rate_limit_pgsql',     passthrough: true,  ragType: 'file-hiding',      normalizedDirName: 'pgsql_data/normalized' },
    { id: 'vsphere',   skillDirRelative: 'virtualization/vsphere', preprocessingScript: 'vsphere_preprocessing.py', jobName: 'run-vsphere-pipeline',  rateLimitFlag: '/tmp/.rate_limit_vsphere',   passthrough: true,  ragType: undefined },
    { id: 'nsx',       skillDirRelative: 'virtualization/nsx',     preprocessingScript: 'nsx_preprocessing.py',     jobName: 'run-nsx-pipeline',       rateLimitFlag: '/tmp/.rate_limit_nsx',       passthrough: true,  ragType: undefined },
    { id: 'jboss_eap', skillDirRelative: 'middleware/jboss_eap',  preprocessingScript: 'jboss_eap_preprocessing.py', jobName: 'run-jboss_eap-pipeline', rateLimitFlag: '/tmp/.rate_limit_jboss_eap', passthrough: true,  ragType: 'both',         normalizedDirName: 'jboss_eap_data/normalized', queryScript: 'query_rag.py' },
    { id: 'tomcat',    skillDirRelative: 'middleware/tomcat',      preprocessingScript: 'tomcat_preprocessing.py',    jobName: 'run-tomcat-pipeline',    rateLimitFlag: '/tmp/.rate_limit_tomcat',    passthrough: true,  ragType: 'both',         normalizedDirName: 'tomcat_data/normalized',   queryScript: 'query_rag.py' },
    { id: 'wildfly',   skillDirRelative: 'middleware/wildfly',     preprocessingScript: 'wildfly_preprocessing.py',   jobName: 'run-wildfly-pipeline',   rateLimitFlag: '/tmp/.rate_limit_wildfly',   passthrough: true,  ragType: 'both',         normalizedDirName: 'wildfly_data/normalized',  queryScript: 'query_rag.py' },
    { id: 'mysql',     skillDirRelative: 'database/mysql',         preprocessingScript: 'mysql_preprocessing.py',     jobName: 'run-mysql-pipeline',     rateLimitFlag: '/tmp/.rate_limit_mysql',     passthrough: true,  ragType: 'both',         normalizedDirName: 'mysql_data/normalized',    queryScript: 'query_rag.py' },
];

let passCount = 0;
let failCount = 0;

function pass(id, msg) { console.log(`  ✅ [${id}] ${msg}`); passCount++; }
function fail(id, msg, detail) { console.error(`  ❌ [${id}] ${msg}${detail ? ': ' + detail : ''}`); failCount++; }
function warn(id, msg, detail) { console.warn(`  ⚠️  [${id}] ${msg}${detail ? ': ' + detail : ''}`); }

console.log('\n=== Patch Review Dashboard — Product Registry Validator ===\n');

for (const cfg of PRODUCTS) {
    console.log(`\n── ${cfg.id} ──`);
    const skillDir = path.join(SKILLS_BASE, cfg.skillDirRelative);

    // 1. skillDir exists
    if (fs.existsSync(skillDir)) {
        pass(cfg.id, `skillDir exists`);
    } else {
        fail(cfg.id, 'skillDir missing', skillDir);
        continue;
    }

    // 2. preprocessingScript
    const scriptPath = path.join(skillDir, cfg.preprocessingScript);
    if (fs.existsSync(scriptPath)) {
        pass(cfg.id, `preprocessingScript exists: ${cfg.preprocessingScript}`);
    } else {
        fail(cfg.id, 'preprocessingScript missing', scriptPath);
    }

    // 3. SKILL.md
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
        const lines = fs.readFileSync(skillMdPath, 'utf-8').split('\n');
        if (lines.length >= 100) {
            pass(cfg.id, `SKILL.md: ${lines.length} lines (≥100)`);
        } else {
            fail(cfg.id, `SKILL.md too short`, `${lines.length} lines (need ≥100)`);
        }
        const hasSection4 = lines.some(l => l.startsWith('## 4.') || l.startsWith('## 4 '));
        if (hasSection4) {
            pass(cfg.id, 'SKILL.md has ## 4. section');
        } else {
            fail(cfg.id, 'SKILL.md missing ## 4. section');
        }
    } else {
        fail(cfg.id, 'SKILL.md missing', skillMdPath);
    }

    // 4. RAG exclusion consistency
    if (cfg.ragType === 'file-hiding' || cfg.ragType === 'both') {
        if (cfg.normalizedDirName) {
            pass(cfg.id, `ragExclusion ${cfg.ragType}: normalizedDir=${cfg.normalizedDirName}`);
        } else {
            fail(cfg.id, `ragExclusion ${cfg.ragType} but normalizedDirName missing`);
        }
        if (cfg.ragType === 'both') {
            // query_rag.py는 공유 os/linux/ 디렉토리에 있음
            const sharedQueryPath = path.join(SKILLS_BASE, 'os/linux', cfg.queryScript || 'query_rag.py');
            if (fs.existsSync(sharedQueryPath)) {
                pass(cfg.id, `ragExclusion both: shared queryScript exists`);
            } else {
                fail(cfg.id, 'ragExclusion both: shared queryScript missing', sharedQueryPath);
            }
        }
    } else if (cfg.ragType === 'prompt-injection') {
        const queryPath = path.join(skillDir, cfg.queryScript);
        if (fs.existsSync(queryPath)) {
            pass(cfg.id, `ragExclusion prompt-injection queryScript exists: ${cfg.queryScript}`);
        } else {
            fail(cfg.id, 'ragExclusion queryScript missing', queryPath);
        }
    } else {
        warn(cfg.id, 'No ragExclusion configured');
    }

    // 5. passthrough
    if (cfg.passthrough) {
        pass(cfg.id, 'passthrough enabled');
    } else {
        warn(cfg.id, 'passthrough disabled (expected for version-grouped products)');
    }

    // 6. rateLimitFlag
    if (cfg.rateLimitFlag && cfg.rateLimitFlag.startsWith('/tmp/')) {
        pass(cfg.id, `rateLimitFlag: ${cfg.rateLimitFlag}`);
    } else {
        fail(cfg.id, 'rateLimitFlag should start with /tmp/');
    }

    // 7. jobName convention
    const expectedJobName = `run-${cfg.id}-pipeline`;
    if (cfg.jobName === expectedJobName) {
        pass(cfg.id, `jobName: ${cfg.jobName}`);
    } else {
        fail(cfg.id, `jobName '${cfg.jobName}' != expected '${expectedJobName}'`);
    }
}

console.log(`\n${'='.repeat(55)}`);
console.log(`Validation: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
    console.error('\n❌ Validation FAILED — fix the issues above before deploying.\n');
    process.exit(1);
} else {
    console.log('\n✅ All checks passed!\n');
}
