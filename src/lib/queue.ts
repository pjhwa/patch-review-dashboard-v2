import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import util from 'util';
import { prisma } from '@/lib/db';
import { ProductConfig, PRODUCT_MAP, getSkillDir } from '@/lib/products-registry';

const connection = new IORedis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null,
}) as any;

export const pipelineQueue = new Queue('patch-pipeline', { connection });

// Define the worker on the Next.js server side.
// Note: In a production app, this might run in a separate Node process, but for this dashboard it's spawned here.
let workerStarted = false;

async function withOpenClawLock(jobLog: (msg: string) => Promise<any>, fn: () => Promise<any>): Promise<any> {
    const lockDir = '/tmp/openclaw_execution.lock';
    let loggedWaiting = false;
    while (true) {
        try {
            fs.mkdirSync(lockDir);
            break;
        } catch (err: any) {
            if (err.code === 'EEXIST') {
                if (!loggedWaiting) {
                    await jobLog("Waiting for another AI process to finish (OpenClaw Global Lock)...");
                    loggedWaiting = true;
                }
                await new Promise(r => setTimeout(r, 2000));
            } else {
                throw err;
            }
        }
    }
    try { return await fn(); } finally { try { fs.rmdirSync(lockDir, { recursive: true }); } catch(e) {} }
}

// Single shared text-pruning function (all products use same logic)
function prunePatch(obj: any): any {
    if (!obj) return obj;
    const copy = JSON.parse(JSON.stringify(obj));
    const pruneText = (text: string, maxLen: number) => {
        if (typeof text !== 'string') return text;
        let pruned = text.replace(/https?:\/\/[^\s"'<>\\]+/g, '[URL]');
        return pruned.length > maxLen ? pruned.slice(0, maxLen) + '...[TRUNCATED]' : pruned;
    };
    const traverse = (o: any) => {
        if (Array.isArray(o)) {
            for (let i = 0; i < o.length; i++) {
                if (typeof o[i] === 'object') traverse(o[i]);
                else if (typeof o[i] === 'string') o[i] = pruneText(o[i], 3000);
            }
        } else if (typeof o === 'object' && o !== null) {
            for (const key of Object.keys(o)) {
                if (typeof o[key] === 'string') o[key] = pruneText(o[key], 5000);
                else if (typeof o[key] === 'object') traverse(o[key]);
            }
        }
    };
    traverse(copy);
    return copy;
}

// Linux-specific pruner preserves extra array truncation logic
function prunePatchLinux(obj: any): any {
    if (!obj) return obj;
    const copy = JSON.parse(JSON.stringify(obj));

    const truncateArray = (arr: any[], max: number) => {
        if (Array.isArray(arr) && arr.length > max) {
            return [...arr.slice(0, max), `... and ${arr.length - max} more items`];
        }
        return arr;
    };

    const pruneText = (text: string, maxLen: number) => {
        if (typeof text !== 'string') return text;
        let pruned = text.replace(/https?:\/\/[^\s"'<>\\]+/g, '[URL REMOVED]');
        if (pruned.length > maxLen) {
            pruned = pruned.slice(0, maxLen) + '... [TRUNCATED]';
        }
        return pruned;
    };

    const keysToTruncateArray = ['packages', 'cves', 'affected_products', 'references', 'issues', 'bugzilla'];
    const keysToPruneText = ['description', 'details', 'synopsis'];

    const traverse = (o: any) => {
        if (Array.isArray(o)) {
            for (let i = 0; i < o.length; i++) {
                if (typeof o[i] === 'object' && o[i] !== null) traverse(o[i]);
                else if (typeof o[i] === 'string') o[i] = pruneText(o[i], 3000);
            }
        } else if (typeof o === 'object' && o !== null) {
            for (const key of Object.keys(o)) {
                const lKey = key.toLowerCase();
                if (keysToTruncateArray.includes(lKey) && Array.isArray(o[key])) {
                    o[key] = truncateArray(o[key], 15);
                }
                if (typeof o[key] === 'string') {
                    o[key] = pruneText(o[key], keysToPruneText.includes(lKey) ? 3000 : 5000);
                } else if (typeof o[key] === 'object' && o[key] !== null) {
                    traverse(o[key]);
                }
            }
        }
    };
    traverse(copy);
    return copy;
}

// Factory: creates a runStream function bound to a specific cwd
function makeStreamRunner(skillDir: string, job: Job) {
    return async (command: string, args: string[], progressMap: any = {}, overrideOpts: any = {}, suppressLog: boolean = false): Promise<any> => {
        return new Promise((res, rej) => {
            let fullStdout = '';
            let isRej = false;
            const p = spawn(command, args, { cwd: skillDir, shell: false, ...overrideOpts });
            p.stdout.setEncoding('utf8');
            p.stderr.setEncoding('utf8');
            p.stdout.on('data', async (data: any) => {
                const chunk = data.toString();
                fullStdout += chunk;
                const lines = chunk.split('\n');
                for (const line of lines) {
                    if (line.trim()) {
                        if (!suppressLog) job.log(line).catch(() => { });
                        for (const [keyword, prog] of Object.entries(progressMap)) {
                            if (line.includes(keyword)) job.updateProgress(prog as number).catch(() => { });
                        }
                    }
                }
            });
            p.stderr.on('data', (data: any) => {
                const errText = data.toString();
                job.log(`ERROR: ${errText}`).catch(() => { });
                if (errText.includes('rate limit')) { isRej = true; rej(new Error('AI_REVIEW_FAILED: API Rate Limit Error')); }
                else if (errText.includes('timeout')) { isRej = true; rej(new Error('OpenClaw timed out.')); }
            });
            p.on('close', (code: number | null) => {
                if (!isRej) { code === 0 ? res(fullStdout) : rej(new Error(`Command ${command} failed with code ${code}`)); }
            });
        });
    };
}

// Clean up openclaw session files before each AI call
function cleanupSessions(): void {
    const sessionsDir = path.join(process.env.HOME || '/home/citec', '.openclaw/agents/main/sessions');
    if (fs.existsSync(sessionsDir)) {
        const oldFiles = fs.readdirSync(sessionsDir).filter((f: string) => f.endsWith('.lock') || f.includes('.jsonl'));
        for (const lf of oldFiles) fs.rmSync(path.join(sessionsDir, lf), { force: true });
        const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
        if (fs.existsSync(sessionsJsonPath)) fs.rmSync(sessionsJsonPath, { force: true });
    }
}

// Passthrough: ensure all preprocessed patches appear in ReviewedPatch (for products that have it enabled)
async function runPassthrough(job: Job, productCfg: ProductConfig, aiReviewedIds: Set<string>): Promise<void> {
    if (!productCfg.passthrough.enabled) return;
    try {
        const missingPatches = await prisma.preprocessedPatch.findMany({
            where: {
                vendor: productCfg.vendorString,
                issueId: { notIn: Array.from(aiReviewedIds) }
            }
        });
        if (missingPatches.length > 0) {
            await job.log(`[PASSTHROUGH] AI skipped ${missingPatches.length} patches – ingesting them directly.`);
            for (const pp of missingPatches) {
                await prisma.reviewedPatch.upsert({
                    where: { issueId: pp.issueId },
                    update: {
                        vendor: pp.vendor,
                        osVersion: pp.osVersion || null,
                        component: pp.component || productCfg.aiComponentDefault,
                        version: pp.version || 'Unknown',
                        criticality: productCfg.passthrough.fallbackCriticality,
                        description: pp.description || '',
                        koreanDescription: pp.description || '',
                        decision: productCfg.passthrough.fallbackDecision,
                        pipelineRunId: String(job.id)
                    },
                    create: {
                        issueId: pp.issueId,
                        vendor: pp.vendor,
                        osVersion: pp.osVersion || null,
                        component: pp.component || productCfg.aiComponentDefault,
                        version: pp.version || 'Unknown',
                        criticality: productCfg.passthrough.fallbackCriticality,
                        description: pp.description || '',
                        koreanDescription: pp.description || '',
                        decision: productCfg.passthrough.fallbackDecision,
                        pipelineRunId: String(job.id)
                    }
                });
            }
            await job.log(`[PASSTHROUGH] Ingested ${missingPatches.length} passthrough patches.`);
        }
    } catch (ptErr: any) {
        await job.log(`[PASSTHROUGH WARNING] ${ptErr.message}`);
    }
}

// Extract JSON array from AI text output
function extractJsonArray(text: string): any {
    const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    const match = stripped.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (!match) return null;
    return JSON.parse(match[0]);
}

// Main AI review loop for any product
async function runAiReviewLoop(
    job: Job,
    productCfg: ProductConfig,
    skillDir: string,
    runStream: (command: string, args: string[], progressMap?: any, overrideOpts?: any, suppressLog?: boolean) => Promise<any>,
    patches: any[],
    isResumeMode: boolean,
    isLinux: boolean = false
): Promise<any[]> {
    const { ReviewItemSchema } = require('@/lib/schema');
    const MAX_AI_RETRIES = 2;
    const BATCH_SIZE = 5;

    let finalReviewedPatches: any[] = [];
    const alreadyReviewed = new Set<string>();

    const outputReportPath = path.join(skillDir, productCfg.aiReportFile);

    if (isResumeMode) {
        try {
            finalReviewedPatches = JSON.parse(fs.readFileSync(outputReportPath, 'utf-8'));
            for (const p of finalReviewedPatches) alreadyReviewed.add(p.IssueID || p.id);
            await job.log(`[RESUME] 이전에 API Rate Limit으로 중단된 리뷰를 이어서 진행합니다. (완료: ${alreadyReviewed.size}건, 남은 패치: ${patches.length - alreadyReviewed.size}건)`);
        } catch (e) {
            finalReviewedPatches = [];
        }
    } else {
        if (fs.existsSync(productCfg.rateLimitFlag)) fs.unlinkSync(productCfg.rateLimitFlag);
    }

    // RAG injection for Linux (prompt-injection type)
    let ragExclusions = '';
    if (isLinux && productCfg.ragExclusion?.type === 'prompt-injection' && productCfg.ragExclusion.queryScript) {
        const runStepSync = util.promisify(require('child_process').exec);
        try {
            let queryTextContext = 'security updates';
            if (patches.length > 0) {
                const sampleSize = productCfg.ragExclusion.queryTextSampleSize || 3;
                queryTextContext = patches.slice(0, sampleSize).map((p: any) => p.Description || p.description || p.id || '').join(' ');
            }
            const escapedQuery = queryTextContext.replace(/"/g, '\\"').replace(/\n/g, ' ');
            const ragResult = await runStepSync(`python3 ${productCfg.ragExclusion.queryScript} "${escapedQuery}"`, { cwd: skillDir });
            if (ragResult.stdout) {
                const retrievedItems = JSON.parse(ragResult.stdout);
                if (Array.isArray(retrievedItems) && retrievedItems.length > 0) {
                    const exclusionRules = retrievedItems.map((f: any) => `- Excluded Issue: ${f.issueId}, Reason: ${f.reason || f.description}`).join('\\n');
                    ragExclusions = `\\n\\nCRITICAL INSTRUCTION: Reviewers have manually marked the following historical patches to be explicitly EXCLUDED from final recommendations for the provided reasons:\\n${exclusionRules}\\n\\nIf you encounter any patches that are highly similar or identical to these excluded patch descriptions/reasons, you MUST filter them out. Output the JSON object but set 'Decision' to 'Exclude' and 'Reason' to the matching exclusion reason.`;
                    await job.log("Loaded RAG Feedback for exclusion rules.");
                }
            }
        } catch (e) {
            await job.log("RAG query fallback failed or returned empty.");
        }
    }

    // File-hiding RAG exclusion: hide normalized dir and patches file before AI calls
    let normalizedDir: string | null = null;
    let hiddenNormalizedDir: string | null = null;
    let patchesFilePath: string | null = null;
    let hiddenPatchesFilePath: string | null = null;

    if (productCfg.ragExclusion?.type === 'file-hiding') {
        if (productCfg.ragExclusion.normalizedDirName) {
            normalizedDir = path.join(skillDir, productCfg.ragExclusion.normalizedDirName);
            hiddenNormalizedDir = normalizedDir + '_hidden';
            try { if (fs.existsSync(normalizedDir)) fs.renameSync(normalizedDir, hiddenNormalizedDir); } catch (e) {}
        }
        patchesFilePath = path.join(skillDir, productCfg.patchesForReviewFile);
        hiddenPatchesFilePath = patchesFilePath + '.hidden';
        try { if (fs.existsSync(patchesFilePath)) fs.renameSync(patchesFilePath, hiddenPatchesFilePath); } catch (e) {}
    }

    await job.updateProgress(50);
    await job.log(`[${productCfg.logTag}-AI] Sequentially evaluating ${patches.length} patches (RAG-blinded)...`);

    const pruneFn = isLinux ? prunePatchLinux : prunePatch;

    for (let i = 0; i < patches.length; i += BATCH_SIZE) {
        const batch = patches.slice(i, i + BATCH_SIZE);
        const actualBatchSize = batch.length;
        const batchNames = batch.map((p: any) => p.patch_id || p.id || p.issueId || p.IssueID || 'Unknown').join(', ');
        const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(patches.length / BATCH_SIZE);

        // Check if entire batch is already reviewed
        let allReviewed = true;
        for (const p of batch) {
            const pName = p.patch_id || p.id || p.issueId || p.IssueID || 'Unknown';
            if (!alreadyReviewed.has(pName)) allReviewed = false;
        }
        if (isResumeMode && allReviewed) {
            await job.log(`[SKIP-RESUME] 이미 리뷰가 완료된 배치입니다: ${batchNames}`);
            await job.updateProgress(50 + Math.floor(((i + actualBatchSize) / patches.length) * 40));
            continue;
        }

        await job.log(`[${productCfg.logTag}-AI Analysis] Processing batch ${batchIndex}/${totalBatches} (${actualBatchSize} patches): ${batchNames}`);

        const prunedBatch = batch.map((p: any) => pruneFn(p));
        let prompt = productCfg.buildPrompt(skillDir, actualBatchSize, prunedBatch);
        if (ragExclusions) prompt += ragExclusions;

        fs.writeFileSync(path.join(skillDir, `debug_prompt_${batchIndex}.txt`), prompt);

        let parsedJson: any = null;
        for (let attempt = 1; attempt <= MAX_AI_RETRIES + 1; attempt++) {
            try {
                const rawAiOutput = await withOpenClawLock(async (msg) => await job.log(msg), async () => {
                    cleanupSessions();
                    return await runStream('/home/citec/.nvm/versions/node/v22.22.0/bin/openclaw',
                        ['agent', '--agent', 'main', '--json', '--timeout', '1800', '--session-id', `${productCfg.id}_${job.id}_batch_${batchIndex}_${attempt}`, '-m', prompt],
                        {}, { shell: false, cwd: skillDir }, true
                    );
                });

                const openclawWrapper = JSON.parse(rawAiOutput);
                const payloads = openclawWrapper?.result?.payloads || [];
                const textContents = payloads.map((p: any) => p.text).join('\n');

                if (textContents.toLowerCase().includes('rate limit')) throw new Error('AI_REVIEW_FAILED: Rate Limit');
                if (isLinux && (textContents.toLowerCase().includes('gateway closed') || textContents.toLowerCase().includes('gateway timeout') || textContents.toLowerCase().includes('gateway not connected'))) {
                    throw new Error('OpenClaw execution timed out or gateway closed.');
                }

                parsedJson = extractJsonArray(textContents);
                if (!parsedJson) throw new Error('No JSON array in AI output');

                if (productCfg.aiBatchValidation === 'exact') {
                    if (!Array.isArray(parsedJson) || parsedJson.length !== actualBatchSize) {
                        throw new Error(`Expected array of length ${actualBatchSize}, but got ${Array.isArray(parsedJson) ? parsedJson.length : 'non-array'}`);
                    }
                } else {
                    // nonEmpty validation
                    if (!Array.isArray(parsedJson) || parsedJson.length === 0) {
                        throw new Error(`Expected non-empty array, but got ${Array.isArray(parsedJson) ? 'empty array' : 'non-array'}`);
                    }
                }

                for (const item of parsedJson) {
                    const validation = ReviewItemSchema.safeParse(item);
                    if (!validation.success) {
                        const errorDetails = validation.error.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`).join(', ');
                        throw new Error(`Zod Validation Failed for an item: ${errorDetails}`);
                    }
                    finalReviewedPatches.push(item);
                    alreadyReviewed.add(item.IssueID || item.id);
                }

                fs.writeFileSync(outputReportPath, JSON.stringify(finalReviewedPatches, null, 2));

                // Upsert reviewed items to DB during batch (mid-pipeline persistence)
                for (const rItem of parsedJson) {
                    try {
                        const rIssueId = rItem.IssueID || rItem.id || 'Unknown';
                        await prisma.reviewedPatch.upsert({
                            where: { issueId: rIssueId },
                            update: {
                                vendor: productCfg.vendorString,
                                component: rItem.Component || productCfg.aiComponentDefault,
                                version: rItem.Version || '',
                                criticality: rItem.Criticality || 'Unknown',
                                description: rItem.Description || '',
                                koreanDescription: rItem.KoreanDescription || rItem.Description || '',
                                decision: rItem.Decision || 'Done',
                                pipelineRunId: String(job.id)
                            },
                            create: {
                                issueId: rIssueId,
                                vendor: productCfg.vendorString,
                                component: rItem.Component || productCfg.aiComponentDefault,
                                version: rItem.Version || '',
                                criticality: rItem.Criticality || 'Unknown',
                                description: rItem.Description || '',
                                koreanDescription: rItem.KoreanDescription || rItem.Description || '',
                                decision: rItem.Decision || 'Done',
                                pipelineRunId: String(job.id)
                            },
                        });
                    } catch (dbUpsertErr) {}
                }

                break;
            } catch (err: any) {
                if (err.message.includes('AI_REVIEW_FAILED')) {
                    if (err.message.includes('Rate Limit')) fs.writeFileSync(productCfg.rateLimitFlag, 'true');
                    // Restore hidden files before throwing
                    if (hiddenNormalizedDir && normalizedDir) { try { if (fs.existsSync(hiddenNormalizedDir)) fs.renameSync(hiddenNormalizedDir, normalizedDir); } catch (e) {} }
                    if (hiddenPatchesFilePath && patchesFilePath) { try { if (fs.existsSync(hiddenPatchesFilePath)) fs.renameSync(hiddenPatchesFilePath, patchesFilePath); } catch (e) {} }
                    throw err;
                }
                if (attempt <= MAX_AI_RETRIES) {
                    if (productCfg.aiVersionGrouped) {
                        prompt += `\n\nPrevious attempt failed. Fix this error and resubmit: ${err.message}\nReturn ONLY a JSON array with ONE object per input VERSION GROUP.`;
                    } else {
                        prompt += `\n\nPrevious attempt failed. Fix this error and resubmit: ${err.message}\nReturn ONLY a JSON array with EXACTLY ${actualBatchSize} objects.`;
                    }
                    await job.log(`  -> Attempt ${attempt} failed for batch ${batchIndex}, retrying...`);
                } else {
                    await job.log(`[SKIP] Batch ${batchIndex} permanently failed after ${MAX_AI_RETRIES} retries.`);
                }
            }
        }
        await job.updateProgress(50 + Math.floor(((i + actualBatchSize) / patches.length) * 40));
    }

    // Restore hidden files after loop
    if (hiddenNormalizedDir && normalizedDir) { try { if (fs.existsSync(hiddenNormalizedDir)) fs.renameSync(hiddenNormalizedDir, normalizedDir); } catch (e) {} }
    if (hiddenPatchesFilePath && patchesFilePath) { try { if (fs.existsSync(hiddenPatchesFilePath)) fs.renameSync(hiddenPatchesFilePath, patchesFilePath); } catch (e) {} }

    return finalReviewedPatches;
}

// DB ingestion for any product
async function ingestToDb(
    job: Job,
    productCfg: ProductConfig,
    patchesRaw: any[],
    reviewed: any[],
    isResumeMode: boolean,
    isAiOnly: boolean
): Promise<void> {
    try {
        if (!isResumeMode && !isAiOnly) await prisma.preprocessedPatch.deleteMany({ where: { vendor: productCfg.vendorString } });
        if (!isResumeMode && !isAiOnly && patchesRaw.length > 0) {
            // For vsphere, individual creates are used (no createMany) to avoid batch issues
            if (productCfg.id === 'vsphere') {
                for (const p of patchesRaw) {
                    await prisma.preprocessedPatch.create({
                        data: productCfg.preprocessedPatchMapper(p) as any,
                    });
                }
            } else {
                await prisma.preprocessedPatch.createMany({
                    data: patchesRaw.map((p: any) => productCfg.preprocessedPatchMapper(p)) as any,
                });
            }
        }
        if (!isResumeMode && !isAiOnly) await job.log(`[${productCfg.logTag}-DB] Preprocessed ${patchesRaw.length} patches ingested.`);

        if (!isResumeMode && !isAiOnly) await prisma.reviewedPatch.deleteMany({ where: { vendor: productCfg.vendorString } });
        for (const item of reviewed) {
            const issueId = item.IssueID || item.id || 'Unknown';
            const isExcluded = (item.Decision || item.decision || '').toLowerCase() === 'exclude';
            const isLowCriticality = ['moderate', 'medium', 'low'].includes((item.Criticality || item.criticality || '').toLowerCase());
            if (isExcluded || isLowCriticality) continue;

            try {
                await prisma.reviewedPatch.upsert({
                    where: { issueId },
                    update: {
                        vendor: productCfg.vendorString,
                        component: item.Component || productCfg.aiComponentDefault,
                        version: item.Version || '',
                        criticality: item.Criticality || 'Unknown',
                        description: item.Description || '',
                        koreanDescription: item.KoreanDescription || item.Description || '',
                        decision: item.Decision || 'Done',
                        pipelineRunId: String(job.id)
                    },
                    create: {
                        issueId,
                        vendor: productCfg.vendorString,
                        component: item.Component || productCfg.aiComponentDefault,
                        version: item.Version || '',
                        criticality: item.Criticality || 'Unknown',
                        description: item.Description || '',
                        koreanDescription: item.KoreanDescription || item.Description || '',
                        decision: item.Decision || 'Done',
                        pipelineRunId: String(job.id)
                    },
                });
            } catch (e) { await job.log(`[${productCfg.logTag}-DB WARN] Upsert failed for ${issueId}`); }
        }
        await job.log(`[${productCfg.logTag}-DB] Reviewed patches ingested: ${reviewed.length}`);
    } catch (dbErr: any) {
        await job.log(`[${productCfg.logTag}-DB WARNING] DB ingestion error: ${dbErr.message}`);
    }
}

// Generic product pipeline runner
async function runProductPipeline(job: Job, productCfg: ProductConfig, isAiOnly: boolean, isRetry: boolean): Promise<string> {
    const skillDir = getSkillDir(productCfg);
    const isResumeMode = (isAiOnly || isRetry) && fs.existsSync(productCfg.rateLimitFlag);
    const runStream = makeStreamRunner(skillDir, job);
    const patchesPath = path.join(skillDir, productCfg.patchesForReviewFile);
    const outputReportPath = path.join(skillDir, productCfg.aiReportFile);

    // Step 1: Preprocessing
    if (!isResumeMode && !isAiOnly) {
        await job.updateProgress(10);
        await job.log(`[${productCfg.logTag}-PIPELINE] Starting ${productCfg.name} patch preprocessing...`);
        await runStream('python3', [productCfg.preprocessingScript, ...productCfg.preprocessingArgs], {
            '전처리 완료': 40,
            'Saved review packet': 40,
            'Final': 40,
            '[SQL-PREPROCESS]': 15,
            '[PREPROCESS]': 15,
            'PREPROCESS_DONE': 40,
            'Found': 15,
        });
        await job.updateProgress(40);
        await job.log(`[${productCfg.logTag}-PREPROCESS_DONE] Preprocessing complete.`);
    } else {
        await job.updateProgress(40);
        await job.log(`[${productCfg.logTag}-PIPELINE] Skipping preprocessing (AI-Only/Resume mode).`);
    }

    // Step 2: Read patches
    let patchesRaw: any[] = [];
    try { patchesRaw = JSON.parse(fs.readFileSync(patchesPath, 'utf-8')); } catch (e) { }

    // Step 3: AI Review Loop
    const isLinux = productCfg.id === 'redhat' || productCfg.id === 'oracle' || productCfg.id === 'ubuntu';
    const finalReviewedPatches = await runAiReviewLoop(
        job, productCfg, skillDir, runStream, patchesRaw, isResumeMode, isLinux
    );

    if (isResumeMode && fs.existsSync(productCfg.rateLimitFlag)) fs.unlinkSync(productCfg.rateLimitFlag);

    // Save AI report
    fs.writeFileSync(outputReportPath, JSON.stringify(finalReviewedPatches, null, 2));
    await job.log(`[${productCfg.logTag}-AI] AI review complete. ${finalReviewedPatches.length} patches reviewed.`);

    // Step 4: DB Ingestion
    await ingestToDb(job, productCfg, patchesRaw, finalReviewedPatches, isResumeMode, isAiOnly);

    // Step 5: Passthrough
    const aiReviewedIds = new Set(finalReviewedPatches.map((d: any) => (d.IssueID || d.id || '').toString()));
    await runPassthrough(job, productCfg, aiReviewedIds);

    await job.updateProgress(100);
    await job.log(`[${productCfg.logTag}-PIPELINE] All tasks completed successfully.`);
    return `${productCfg.name} pipeline success`;
}

export function startWorker() {
    if (workerStarted) return;
    workerStarted = true;

    new Worker('patch-pipeline', async (job: Job) => {
        return new Promise((resolve, reject) => {
            console.log(`Starting pipeline job ${job.id} (name: ${job.name})`);
            const linuxV2Dir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
            const linuxSkillDir = linuxV2Dir;

            const outputReportFilename = job.name === 'manual-review' ? `manual_ai_report_${job.id}.json` : 'patch_review_ai_report.json';

            // Legacy linux stream runner (cwd = linuxV2Dir, used for manual-review and run-pipeline)
            const runStream = async (command: string, args: string[], progressMap: any = {}, overrideOpts: any = {}, suppressLog: boolean = false): Promise<any> => {
                return new Promise((res, rej) => {
                    let fullStdout = "";
                    let isRej = false;
                    const p = spawn(command, args, { cwd: linuxV2Dir, shell: false, ...overrideOpts });
                    p.stdout.setEncoding('utf8');
                    p.stderr.setEncoding('utf8');
                    p.stdout.on('data', async (data: any) => {
                        const chunk = data.toString();
                        fullStdout += chunk;
                        const lines = chunk.split('\\n');
                        for (const line of lines) {
                            if (line.trim()) {
                                if (!suppressLog) console.log(`[JOB ${job.id}] ${line}`);
                                if (!suppressLog) job.log(line).catch(() => { });
                                for (const [keyword, prog] of Object.entries(progressMap)) {
                                    if (line.includes(keyword)) job.updateProgress(prog as number).catch(() => { });
                                }
                            }
                        }
                    });
                    p.stderr.on('data', (data: any) => {
                        const errText = data.toString();
                        console.error(`[JOB ${job.id} ERR] ${errText}`);
                        job.log(`ERROR: ${errText}`).catch(() => { });

                        if (errText.includes('rate limit')) {
                            isRej = true;
                            rej(new Error('AI_REVIEW_FAILED: API Rate Limit Error'));
                        } else if (errText.includes('timeout')) {
                            isRej = true;
                            rej(new Error('OpenClaw execution timed out.'));
                        }
                    });
                    p.on('close', (code: number | null) => {
                        if (!isRej) {
                            code === 0 ? res(fullStdout) : rej(new Error(`Command ${command} failed with code ${code}`));
                        }
                    });
                });
            };

            const runStepSync = util.promisify(require('child_process').exec);

            (async () => {
                try {
                    const isAiOnly = job.data?.isAiOnly || false;
                    const isRetry = job.data?.isRetry || false;

                    // ============================================================
                    // PRODUCT PIPELINE BRANCHES (via registry)
                    // ============================================================
                    const productCfg = PRODUCT_MAP[
                        job.name === 'run-ceph-pipeline' ? 'ceph' :
                        job.name === 'run-sqlserver-pipeline' ? 'sqlserver' :
                        job.name === 'run-mariadb-pipeline' ? 'mariadb' :
                        job.name === 'run-pgsql-pipeline' ? 'pgsql' :
                        job.name === 'run-vsphere-pipeline' ? 'vsphere' :
                        job.name === 'run-windows-pipeline' ? 'windows' :
                        job.name === 'run-redhat-pipeline' ? 'redhat' :
                        job.name === 'run-oracle-pipeline' ? 'oracle' :
                        job.name === 'run-ubuntu-pipeline' ? 'ubuntu' :
                        ''
                    ];

                    if (productCfg) {
                        try {
                            const result = await runProductPipeline(job, productCfg, isAiOnly, isRetry);
                            resolve(result);
                        } catch (e: any) {
                            reject(e);
                        }
                        return;
                    }
                    // ============================================================
                    // END PRODUCT PIPELINE BRANCHES
                    // ============================================================

                    const rateLimitFlagFile = path.join('/tmp', '.rate_limit_os');
                    const isResumeMode = (isAiOnly || isRetry) && fs.existsSync(rateLimitFlagFile);

                    if (job.name === 'manual-review') {
                        await job.updateProgress(5);
                        await job.log("Manual AI Review queued. Preparing input patches...");
                        const inputPath = path.join(linuxV2Dir, `manual_review_input_${job.id}.json`);
                        fs.writeFileSync(inputPath, JSON.stringify(job.data.patches, null, 2));
                    } else if (isAiOnly || isResumeMode) {
                        await job.updateProgress(5);
                        await job.log("Skipping collection and preprocessing (AI-Only/Resume mode).");
                    } else {
                        // 2. Preprocessing (legacy run-pipeline for manual-review fallback)
                        await job.updateProgress(10);
                        await job.log("[PIPELINE] Starting patch preprocessing & pruning...");
                        await runStream('python3', ['patch_preprocessing.py', '--days', '180']);
                        // Count how many preprocessed patches were just inserted
                        const ppCount = await prisma.preprocessedPatch.count();
                        await job.updateProgress(50);
                        await job.log(`[PREPROCESS_DONE] count=${ppCount}`);
                    }

                    // 3. RAG Injection
                    const absoluteReportPath = path.join(linuxV2Dir, outputReportFilename);

                    // Build vendor summary for the AI prompt
                    const patchesPath = path.join(linuxV2Dir, job.name === 'manual-review' ? `manual_review_input_${job.id}.json` : 'patches_for_llm_review.json');
                    let queryTextContext = 'security updates';
                    let totalPatchCount = 0;
                    if (fs.existsSync(patchesPath)) {
                        try {
                            const patches = JSON.parse(fs.readFileSync(patchesPath, 'utf-8'));
                            totalPatchCount = patches.length;
                            queryTextContext = patches.slice(0, 5).map((p: any) => p.Description || p.description || p.id || '').join(' ');
                        } catch (e) { }
                    }

                    let ragExclusions = '';
                    try {
                        const escapedQuery = queryTextContext.replace(/"/g, '\\"').replace(/\n/g, ' ');
                        const ragResult = await runStepSync(`python3 query_rag.py "${escapedQuery}"`, { cwd: linuxSkillDir });
                        if (ragResult.stdout) {
                            const retrievedItems = JSON.parse(ragResult.stdout);
                            if (Array.isArray(retrievedItems) && retrievedItems.length > 0) {
                                const exclusionRules = retrievedItems.map((f: any) => `- Excluded Issue: ${f.issueId}, Reason: ${f.reason || f.description}`).join('\\n');
                                ragExclusions = `\\n\\nCRITICAL INSTRUCTION: Reviewers have manually marked the following historical patches to be explicitly EXCLUDED from final recommendations for the provided reasons:\\n${exclusionRules}\\n\\nIf you encounter any patches that are highly similar or identical to these excluded patch descriptions/reasons, you MUST filter them out. Output the JSON object but set 'Decision' to 'Exclude' and 'Reason' to the matching exclusion reason.`;
                                await job.log("Loaded RAG Feedback for exclusion rules.");
                            }
                        }
                    } catch (e) {
                        await job.log("RAG query fallback failed or returned empty.");
                    }

                    // 4. Sequential AI Loop + Zod
                    const { ReviewSchema, ReviewItemSchema } = require('@/lib/schema');
                    const MAX_AI_RETRIES = 2;
                    let finalReviewedPatches: any[] = [];
                    let patchesRaw: any[] = [];
                    try { patchesRaw = JSON.parse(fs.readFileSync(patchesPath, 'utf-8')); } catch (e) { }

                    const alreadyReviewed = new Set<string>();
                    if (isResumeMode) {
                        try {
                            finalReviewedPatches = JSON.parse(fs.readFileSync(absoluteReportPath, 'utf-8'));
                            for (const p of finalReviewedPatches) alreadyReviewed.add(p.IssueID || p.id);
                            await job.log(`[RESUME] 이전에 API Rate Limit으로 중단된 리뷰를 이어서 진행합니다. (완료: ${alreadyReviewed.size}건, 남은 패치: ${patchesRaw.length - alreadyReviewed.size}건)`);
                        } catch (e) {
                            finalReviewedPatches = [];
                        }
                    } else {
                        if (fs.existsSync(rateLimitFlagFile)) fs.unlinkSync(rateLimitFlagFile);
                    }

                    await job.updateProgress(60);
                    await job.log(`AI Review in progress... Sequentially evaluating ${patchesRaw.length} patches (Zod Self-Healing enabled)`);

                    const BATCH_SIZE = 5;
                    for (let i = 0; i < patchesRaw.length; i += BATCH_SIZE) {
                        const batch = patchesRaw.slice(i, i + BATCH_SIZE);
                        const actualBatchSize = batch.length;
                        const batchNames = batch.map((p: any) => p.id || p.issueId || p.IssueID || 'Unknown').join(', ');
                        const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
                        const totalBatches = Math.ceil(patchesRaw.length / BATCH_SIZE);

                        // check if entire batch is already reviewed
                        let allReviewed = true;
                        for (const p of batch) {
                            const pName = p.id || p.issueId || p.IssueID || 'Unknown';
                            if (!alreadyReviewed.has(pName)) allReviewed = false;
                        }

                        if (isResumeMode && allReviewed) {
                            await job.log(`[SKIP-RESUME] 이미 리뷰가 완료된 배치입니다: ${batchNames}`);
                            await job.updateProgress(60 + Math.floor(((i + actualBatchSize) / patchesRaw.length) * 30));
                            continue;
                        }

                        await job.log(`[AI Analysis] Processing batch ${batchIndex}/${totalBatches} (${actualBatchSize} patches): ${batchNames}`);

                        const prunedBatch = batch.map((p: any) => prunePatchLinux(p));
                        let basePrompt = `Read the rules explicitly from ${path.join(linuxSkillDir, 'SKILL.md')}. Evaluate the following ${actualBatchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 4 of that file.
CRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES OR PREVIOUS SUMMARIES. BASE ASSESSMENTS SOLELY ON THE [PATCH DATA] BELOW.
Do NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${actualBatchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`;
                        basePrompt += ragExclusions;

                        let currentPrompt = basePrompt;
                        let parsedJson: any = null;

                        for (let attempt = 1; attempt <= MAX_AI_RETRIES + 1; attempt++) {
                            try {
                                const rawAiOutput = await withOpenClawLock(async (msg) => await job.log(msg), async () => {
                                    const sessionsDir = path.join(process.env.HOME || '/home/citec', '.openclaw/agents/main/sessions');
                                    if (fs.existsSync(sessionsDir)) {
                                        const lockFiles = fs.readdirSync(sessionsDir).filter((f: string) => f.endsWith('.lock') || f.includes('.jsonl'));
                                        for (const lf of lockFiles) fs.rmSync(path.join(sessionsDir, lf), { force: true });
                                    }
                                    return await runStream('/home/citec/.nvm/versions/node/v22.22.0/bin/openclaw',
                                        ['agent', '--agent', 'main', '--json', '--timeout', '1800', '--session-id', `os_${job.id}_batch_${batchIndex}_${attempt}`, '-m', currentPrompt],
                                        {}, { shell: false }, true
                                    );
                                });

                                const openclawWrapper = JSON.parse(rawAiOutput);
                                const payloads = openclawWrapper?.result?.payloads || [];
                                const textContents = payloads.map((p: any) => p.text).join('\n');

                                if (textContents.toLowerCase().includes('rate limit')) throw new Error("AI_REVIEW_FAILED: API Rate Limit Error");
                                if (textContents.toLowerCase().includes('gateway closed') || textContents.toLowerCase().includes('gateway timeout') || textContents.toLowerCase().includes('gateway not connected')) throw new Error("OpenClaw execution timed out or gateway closed.");

                                parsedJson = extractJsonArray(textContents);
                                if (!parsedJson) throw new Error('No JSON array found in AI output even after code fence stripping.');
                                if (!Array.isArray(parsedJson) || parsedJson.length !== actualBatchSize) {
                                    throw new Error(`Expected array of length ${actualBatchSize}, but got ${Array.isArray(parsedJson) ? parsedJson.length : 'non-array'}`);
                                }

                                for (const item of parsedJson) {
                                    const validation = ReviewItemSchema.safeParse(item);
                                    if (!validation.success) {
                                        const errorDetails = validation.error.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`).join(', ');
                                        throw new Error(`Zod Schema Validation Failed: ${errorDetails}`);
                                    }
                                    finalReviewedPatches.push(item);
                                    alreadyReviewed.add(item.IssueID || item.id);
                                }

                                fs.writeFileSync(absoluteReportPath, JSON.stringify(finalReviewedPatches, null, 2));

                                break;
                            } catch (err: any) {
                                if (err.message.includes('AI_REVIEW_FAILED')) {
                                    if (err.message.includes('Rate Limit')) fs.writeFileSync(rateLimitFlagFile, 'true');
                                    throw err;
                                }

                                if (attempt <= MAX_AI_RETRIES) {
                                    currentPrompt += `\\n\\n이전 응답이 실패했습니다. 다음 Zod 구조적 에러를 해결하여 다시 제출하세요: ${err.message}\\n반드시 JSON 배열 형태로 EXACTLY ${actualBatchSize} objects를 출력하세요.`;
                                    await job.log(`  -> Attempt ${attempt} failed for batch ${batchIndex}, retrying...`);
                                } else {
                                    await job.log(`[SKIP] Batch ${batchIndex} permanently failed AI review after ${MAX_AI_RETRIES} retries. Error: ${err.message}`);
                                }
                            }
                        }
                        await job.updateProgress(60 + Math.floor(((i + actualBatchSize) / patchesRaw.length) * 30));
                    }

                    if (isResumeMode && fs.existsSync(rateLimitFlagFile)) fs.unlinkSync(rateLimitFlagFile);
                    fs.writeFileSync(absoluteReportPath, JSON.stringify(finalReviewedPatches, null, 2));

                    // 5. Database Ingestion - validate against preprocessed data first
                    console.log(`Job ${job.id} finished AI loop. Ingesting AI results to SQLite DB...`);
                    await job.log("OpenClaw sequential loop finished. Merging with PreprocessedPatch metadata and ingesting...");

                    const data = finalReviewedPatches;
                    if (data.length === 0) {
                        await job.log("Warning: 0 patches successfully evaluated by AI (all failed Zod). Proceeding to passthrough.");
                    }

                    // Build a lookup map from PreprocessedPatch (all vendors, current run)
                    const allPreprocessed = await prisma.preprocessedPatch.findMany({
                        select: { issueId: true, url: true, releaseDate: true, osVersion: true, vendor: true, component: true, version: true, description: true }
                    });
                    const preprocessedMap = new Map<string, any>();
                    for (const pp of allPreprocessed) {
                        preprocessedMap.set(pp.issueId, pp);
                    }

                    let ingestedCount = 0;
                    let skippedCount = 0;
                    for (const item of data) {
                        const issueId = item.IssueID || item.id || 'Unknown';

                        const isExcluded = (item.Decision || item.decision || '').toLowerCase() === 'exclude';
                        const isLowCriticality = ['moderate', 'medium', 'low'].includes((item.Criticality || item.criticality || '').toLowerCase());
                        if (isExcluded || isLowCriticality) {
                            skippedCount++;
                            continue;
                        }

                        // Skip AI-hallucinated entries: only insert if issueId exists in PreprocessedPatch
                        if (!preprocessedMap.has(issueId)) {
                            skippedCount++;
                            await job.log(`[SKIP] AI hallucinated issueId not in preprocessed: ${issueId}`);
                            continue;
                        }
                        const meta = preprocessedMap.get(issueId);
                        try {
                            await prisma.reviewedPatch.upsert({
                                where: { issueId },
                                update: {
                                    vendor: item.Vendor || item.vendor || meta.vendor || 'Unknown',
                                    osVersion: item.OsVersion || item.osVersion || meta.osVersion || null,
                                    component: item.Component || item.component || meta.component || 'Unknown',
                                    version: item.Version || item.version || meta.version || 'Unknown',
                                    criticality: item.Criticality || item.criticality || 'Unknown',
                                    description: item.Description || item.description || meta.description || 'Unknown',
                                    koreanDescription: item.KoreanDescription || item.koreanDescription || item.description || meta.description || 'Unknown',
                                    decision: item.Decision || item.decision || 'Done',
                                    reason: item.Reason || item.reason || null,
                                    pipelineRunId: String(job.id)
                                },
                                create: {
                                    issueId,
                                    vendor: item.Vendor || item.vendor || meta.vendor || 'Unknown',
                                    osVersion: item.OsVersion || item.osVersion || meta.osVersion || null,
                                    component: item.Component || item.component || meta.component || 'Unknown',
                                    version: item.Version || item.version || meta.version || 'Unknown',
                                    criticality: item.Criticality || item.criticality || 'Unknown',
                                    description: item.Description || item.description || meta.description || 'Unknown',
                                    koreanDescription: item.KoreanDescription || item.koreanDescription || item.description || meta.description || 'Unknown',
                                    decision: item.Decision || item.decision || 'Done',
                                    reason: item.Reason || item.reason || null,
                                    pipelineRunId: String(job.id)
                                }
                            });
                            ingestedCount++;
                        } catch (e) { console.error("Prisma insert error: ", e); }
                    }
                    await job.log(`AI ingestion done: ${ingestedCount} inserted, ${skippedCount} hallucinated entries skipped.`);

                    await job.updateProgress(100);
                    await job.log(`Ingested ${data.length} AI-reviewed patches into SQLite.`);

                    // 6. Passthrough: ensure ALL preprocessed patches appear in ReviewedPatch.
                    // The AI's SKILL.md criteria may filter out vendors.  We fill the gaps here.
                    try {
                        const aiIssuedIds = new Set(data.map((d: any) => (d.IssueID || d.id || '').toString()));
                        const missingPatches = await prisma.preprocessedPatch.findMany({
                            where: { issueId: { notIn: Array.from(aiIssuedIds) } }
                        });
                        if (missingPatches.length > 0) {
                            await job.log(`[PASSTHROUGH] AI skipped ${missingPatches.length} patches – ingesting them directly.`);
                            for (const pp of missingPatches) {
                                await prisma.reviewedPatch.upsert({
                                    where: { issueId: pp.issueId },
                                    update: {
                                        vendor: pp.vendor,
                                        osVersion: pp.osVersion || null,
                                        component: pp.component || 'Unknown',
                                        version: pp.version || 'Unknown',
                                        criticality: 'Important',
                                        description: pp.description || '',
                                        koreanDescription: pp.description || '',
                                        decision: 'Pending',
                                        pipelineRunId: String(job.id)
                                    },
                                    create: {
                                        vendor: pp.vendor,
                                        issueId: pp.issueId,
                                        osVersion: pp.osVersion || null,
                                        component: pp.component || 'Unknown',
                                        version: pp.version || 'Unknown',
                                        criticality: 'Important',
                                        description: pp.description || '',
                                        koreanDescription: pp.description || '',
                                        decision: 'Pending',
                                        pipelineRunId: String(job.id)
                                    }
                                });
                            }
                            await job.log(`[PASSTHROUGH] Ingested ${missingPatches.length} passthrough patches.`);
                        }
                    } catch (ptErr: any) {
                        await job.log(`[PASSTHROUGH WARNING] ${ptErr.message}`);
                    }

                    await job.log(`[PIPELINE] All tasks completed successfully. Done.`);
                    resolve("Success");

                } catch (e: any) {
                    await job.log(`CRITICAL PIPELINE ERROR: ${e.message}`);
                    if (e.message.includes('AI_REVIEW_FAILED')) {
                        await job.updateProgress(100); // Trigger frontend error dialog without total crashing
                        reject(e);
                    } else {
                        reject(e);
                    }
                }
            })();
        });
    }, { connection });

    console.log("BullMQ Worker for 'patch-pipeline' initialized.");
}

const globalForQueue = global as unknown as { workerStarted: boolean };
if (!globalForQueue.workerStarted) {
    globalForQueue.workerStarted = true;
    startWorker();
}
