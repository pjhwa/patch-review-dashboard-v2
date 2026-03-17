/**
 * validate-registry.ts
 * Validates that all active products in PRODUCT_REGISTRY have required files and correct config.
 *
 * Usage: npx ts-node scripts/validate-registry.ts
 */

// @ts-check
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as typeof import('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path') as typeof import('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PRODUCT_REGISTRY } = require('../src/lib/products-registry') as typeof import('../src/lib/products-registry');

const HOME = process.env.HOME || '/home/citec';
const SKILLS_BASE = path.join(HOME, '.openclaw/workspace/skills/patch-review');

let passCount = 0;
let failCount = 0;

function pass(productId: string, check: string) {
    console.log(`  ✅ [${productId}] ${check}`);
    passCount++;
}

function fail(productId: string, check: string, detail?: string) {
    console.error(`  ❌ [${productId}] ${check}${detail ? `: ${detail}` : ''}`);
    failCount++;
}

function warn(productId: string, check: string, detail?: string) {
    console.warn(`  ⚠️  [${productId}] ${check}${detail ? `: ${detail}` : ''}`);
}

console.log('\n=== Patch Review Dashboard — Product Registry Validator ===\n');

for (const cfg of PRODUCT_REGISTRY) {
    console.log(`\n── ${cfg.name} (${cfg.id}) [${cfg.active ? 'ACTIVE' : 'inactive'}] ──`);

    if (!cfg.active) {
        warn(cfg.id, 'Skipping validation (inactive placeholder)');
        continue;
    }

    const skillDir = path.join(SKILLS_BASE, cfg.skillDirRelative);

    // 1. skillDir exists
    if (fs.existsSync(skillDir)) {
        pass(cfg.id, `skillDir exists: ${skillDir}`);
    } else {
        fail(cfg.id, 'skillDir missing', skillDir);
        continue; // Skip remaining checks if base dir missing
    }

    // 2. preprocessingScript exists
    const scriptPath = path.join(skillDir, cfg.preprocessingScript);
    if (fs.existsSync(scriptPath)) {
        pass(cfg.id, `preprocessingScript exists: ${cfg.preprocessingScript}`);
    } else {
        fail(cfg.id, 'preprocessingScript missing', scriptPath);
    }

    // 3. SKILL.md exists and >= 100 lines and has ## 4. section
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillMdPath)) {
        const lines = fs.readFileSync(skillMdPath, 'utf-8').split('\n');
        if (lines.length >= 100) {
            pass(cfg.id, `SKILL.md exists with ${lines.length} lines (≥100)`);
        } else {
            fail(cfg.id, `SKILL.md too short`, `${lines.length} lines (need ≥100)`);
        }
        const hasSection4 = lines.some(l => l.startsWith('## 4.') || l.startsWith('## 4 '));
        if (hasSection4) {
            pass(cfg.id, 'SKILL.md has ## 4. section');
        } else {
            fail(cfg.id, 'SKILL.md missing ## 4. section (required for AI prompts)');
        }
    } else {
        fail(cfg.id, 'SKILL.md missing', skillMdPath);
    }

    // 4. ragExclusion config consistency
    if (cfg.ragExclusion) {
        const rag = cfg.ragExclusion;
        if (rag.type === 'file-hiding') {
            if (rag.normalizedDirName) {
                pass(cfg.id, `ragExclusion file-hiding has normalizedDirName: ${rag.normalizedDirName}`);
            } else {
                fail(cfg.id, 'ragExclusion type=file-hiding but normalizedDirName is missing');
            }
        } else if (rag.type === 'prompt-injection') {
            if (rag.queryScript) {
                const queryScriptPath = path.join(skillDir, rag.queryScript);
                if (fs.existsSync(queryScriptPath)) {
                    pass(cfg.id, `ragExclusion prompt-injection queryScript exists: ${rag.queryScript}`);
                } else {
                    fail(cfg.id, 'ragExclusion queryScript missing', queryScriptPath);
                }
            } else {
                fail(cfg.id, 'ragExclusion type=prompt-injection but queryScript is missing');
            }
        }
    } else {
        warn(cfg.id, 'No ragExclusion configured (RAG blinding disabled)');
    }

    // 5. passthrough config
    if (cfg.passthrough.enabled) {
        if (cfg.passthrough.fallbackCriticality && cfg.passthrough.fallbackDecision) {
            pass(cfg.id, `passthrough enabled (fallback: ${cfg.passthrough.fallbackCriticality}/${cfg.passthrough.fallbackDecision})`);
        } else {
            fail(cfg.id, 'passthrough enabled but fallbackCriticality or fallbackDecision is missing');
        }
    } else {
        warn(cfg.id, 'passthrough disabled (version-grouped products like Windows/SQL Server are expected)');
    }

    // 6. rateLimitFlag path
    if (cfg.rateLimitFlag && cfg.rateLimitFlag.startsWith('/tmp/')) {
        pass(cfg.id, `rateLimitFlag path: ${cfg.rateLimitFlag}`);
    } else {
        fail(cfg.id, 'rateLimitFlag should start with /tmp/');
    }

    // 7. jobName convention
    const expectedJobName = `run-${cfg.id}-pipeline`;
    if (cfg.jobName === expectedJobName) {
        pass(cfg.id, `jobName follows convention: ${cfg.jobName}`);
    } else {
        fail(cfg.id, `jobName '${cfg.jobName}' does not follow convention 'run-${cfg.id}-pipeline'`);
    }
}

console.log(`\n${'='.repeat(55)}`);
console.log(`Validation complete: ${passCount} passed, ${failCount} failed`);
if (failCount > 0) {
    console.error('\n❌ Validation FAILED — fix the issues above before deploying.\n');
    process.exit(1);
} else {
    console.log('\n✅ All checks passed!\n');
}
