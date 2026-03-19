import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import util from 'util';
import { prisma } from '@/lib/db';

const connection = new IORedis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null,
}) as any;

export const pipelineQueue = new Queue('patch-pipeline', { connection });

// Define the worker on the Next.js server side. 
// Note: In a production app, this might run in a separate Node process, but for this dashboard it's spawned here.
let workerStarted = false;

export function startWorker() {
    if (workerStarted) return;
    workerStarted = true;

    new Worker('patch-pipeline', async (job: Job) => {
        return new Promise((resolve, reject) => {
            console.log(`Starting pipeline job ${job.id} (name: ${job.name})`);
            const linuxV2Dir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
            const cephSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/storage/ceph');

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

            const linuxSkillDir = linuxV2Dir;
            const outputReportFilename = job.name === 'manual-review' ? `manual_ai_report_${job.id}.json` : 'patch_review_ai_report.json';

            const runStream = async (command: string, args: string[], progressMap: any = {}, overrideOpts: any = {}, suppressLog: boolean = false): Promise<any> => {
                return new Promise((res, rej) => {
                    let fullStdout = "";
                    let isRej = false;
                    const p = spawn(command, args, { cwd: linuxV2Dir, shell: false, ...overrideOpts });
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
                        } else if (errText.includes('timeout') || errText.includes('gateway closed')) {
                            isRej = true;
                            rej(new Error('AI_REVIEW_FAILED: OpenClaw execution timed out or gateway closed.'));
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
                    // CEPH PIPELINE BRANCH
                    // ============================================================
                    if (job.name === 'run-ceph-pipeline') {
                        const cephOutputReport = path.join(cephSkillDir, 'patch_review_ai_report_ceph.json');
                        const cephPatchesPath = path.join(cephSkillDir, 'patches_for_llm_review_ceph.json');

                        const runCephStream = async (command: string, args: string[], progressMap: any = {}, overrideOpts: any = {}, suppressLog: boolean = false): Promise<any> => {
                            return new Promise((res, rej) => {
                                let fullStdout = '';
                                let isRej = false;
                                const p = spawn(command, args, { cwd: cephSkillDir, shell: false, ...overrideOpts });
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
                                    else if (errText.includes('timeout') || errText.includes('gateway closed')) { isRej = true; rej(new Error('AI_REVIEW_FAILED: OpenClaw timed out.')); }
                                });
                                p.on('close', (code: number | null) => {
                                    if (!isRej) { code === 0 ? res(fullStdout) : rej(new Error(`Command ${command} failed with code ${code}`)); }
                                });
                            });
                        };

                        // Step 1: Preprocessing
                        await job.updateProgress(10);
                        await job.log('[CEPH-PIPELINE] Starting Ceph patch preprocessing...');
                        await runCephStream('python3', ['ceph_preprocessing.py', '--days', '180'], {
                            '전처리 완료': 40,
                            'Ceph Patch Preprocessor 시작': 15,
                        });
                        await job.updateProgress(40);
                        await job.log('[CEPH-PREPROCESS_DONE] Preprocessing complete.');

                        // Step 2: AI Review Loop
                        const { ReviewSchema } = require('@/lib/schema');
                        const MAX_AI_RETRIES = 2;
                        let finalReviewedPatches: any[] = [];
                        let cephPatchesRaw: any[] = [];
                        try { cephPatchesRaw = JSON.parse(fs.readFileSync(cephPatchesPath, 'utf-8')); } catch (e) { }

                        await job.updateProgress(50);
                        await job.log(`[CEPH-AI] Sequentially evaluating ${cephPatchesRaw.length} patches...`);

                        const prunePatchCeph = (obj: any): any => {
                            if (!obj) return obj;
                            const copy = JSON.parse(JSON.stringify(obj));
                            const pruneText = (text: string, maxLen: number) => {
                                if (typeof text !== 'string') return text;
                                let pruned = text.replace(/https?:\/\/[^\s"'<>\\]+/g, '[URL]');
                                return pruned.length > maxLen ? pruned.slice(0, maxLen) + '...[TRUNCATED]' : pruned;
                            };
                            const traverse = (o: any) => {
                                if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) { if (typeof o[i] === 'object') traverse(o[i]); else if (typeof o[i] === 'string') o[i] = pruneText(o[i], 3000); } }
                                else if (typeof o === 'object' && o !== null) { for (const key of Object.keys(o)) { if (typeof o[key] === 'string') o[key] = pruneText(o[key], 5000); else if (typeof o[key] === 'object') traverse(o[key]); } }
                            };
                            traverse(copy);
                            return copy;
                        };

                        const BATCH_SIZE = 5;
                        for (let i = 0; i < cephPatchesRaw.length; i += BATCH_SIZE) {
                            const batch = cephPatchesRaw.slice(i, i + BATCH_SIZE);
                            const actualBatchSize = batch.length;
                            const batchNames = batch.map((p: any) => p.patch_id || p.id || 'Unknown').join(', ');
                            const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
                            const totalBatches = Math.ceil(cephPatchesRaw.length / BATCH_SIZE);
                            
                            await job.log(`[CEPH-AI Analysis] Processing batch ${batchIndex}/${totalBatches} (${actualBatchSize} patches): ${batchNames}`);

                            const prunedBatch = batch.map((p: any) => prunePatchCeph(p));
                            let prompt = `Read SKILL.md. Evaluate the following ${actualBatchSize} Ceph storage patches according to the strict LLM evaluation rules in SKILL.md section 4. Return ONLY a pure JSON array with EXACTLY ${actualBatchSize} objects. Each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. For Vendor use 'Ceph'. For Component use the specific Ceph component. Do NOT skip evaluation steps.\n\n[BATCH DATA]:\n${JSON.stringify(prunedBatch)}`;

                            let parsedJson: any = null;
                            for (let attempt = 1; attempt <= MAX_AI_RETRIES + 1; attempt++) {
                                try {
                                    const rawAiOutput = await withOpenClawLock(async (msg) => await job.log(msg), async () => {
                                        const sessionsDir = path.join(process.env.HOME || '/home/citec', '.openclaw/agents/main/sessions');
                                        if (fs.existsSync(sessionsDir)) {
                                            const oldFiles = fs.readdirSync(sessionsDir).filter((f: string) => f.endsWith('.lock') || f.includes('.jsonl'));
                                            for (const lf of oldFiles) fs.rmSync(path.join(sessionsDir, lf), { force: true });
                                        }
                                        return await runCephStream('/home/citec/.nvm/versions/node/v22.22.0/bin/openclaw',
                                            ['agent', '--agent', 'main', '--json', '--session-id', `ceph_${job.id}_batch_${batchIndex}_${attempt}`, '-m', prompt],
                                            {}, { shell: false, cwd: cephSkillDir }, true
                                        );
                                    });

                                    const extractJsonArray = (text: string): any => {
                                        const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
                                        const match = stripped.match(/\[\s*\{[\s\S]*?\}\s*\]/);
                                        if (!match) return null;
                                        return JSON.parse(match[0]);
                                    };

                                    const openclawWrapper = JSON.parse(rawAiOutput);
                                    const payloads = openclawWrapper?.result?.payloads || [];
                                    const textContents = payloads.map((p: any) => p.text).join('\n');

                                    if (textContents.toLowerCase().includes('rate limit')) throw new Error('AI_REVIEW_FAILED: Rate Limit');
                                    parsedJson = extractJsonArray(textContents);
                                    if (!parsedJson) throw new Error('No JSON array in AI output');
                                    if (!Array.isArray(parsedJson) || parsedJson.length !== actualBatchSize) {
                                        throw new Error(`Expected array of length ${actualBatchSize}, but got ${Array.isArray(parsedJson) ? parsedJson.length : 'non-array'}`);
                                    }

                                    for(const item of parsedJson) {
                                        const validation = ReviewSchema.safeParse(item);
                                        if (!validation.success) {
                                            const errorDetails = validation.error.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`).join(', ');
                                            throw new Error(`Zod Validation Failed for an item: ${errorDetails}`);
                                        }
                                        finalReviewedPatches.push(item);
                                    }
                                    
                                    break;
                                } catch (err: any) {
                                    if (err.message.includes('AI_REVIEW_FAILED')) throw err;
                                    if (attempt <= MAX_AI_RETRIES) {
                                        prompt += `\n\nPrevious attempt failed. Fix this error and resubmit: ${err.message}\nReturn ONLY a JSON array with EXACTLY ${actualBatchSize} objects.`;
                                        await job.log(`  -> Attempt ${attempt} failed for batch ${batchIndex}, retrying...`);
                                    } else {
                                        await job.log(`[SKIP] Batch ${batchIndex} permanently failed after ${MAX_AI_RETRIES} retries.`);
                                    }
                                }
                            }
                            await job.updateProgress(50 + Math.floor(((i + actualBatchSize) / cephPatchesRaw.length) * 40));
                        }

                        // Save AI report
                        fs.writeFileSync(cephOutputReport, JSON.stringify(finalReviewedPatches, null, 2));
                        await job.log(`[CEPH-AI] AI review complete. ${finalReviewedPatches.length} patches reviewed.`);

                        // Step 3: DB Ingestion
                        try {
                            await prisma.preprocessedPatch.deleteMany({ where: { vendor: 'Ceph' } });
                            for (const p of cephPatchesRaw) {
                                await prisma.preprocessedPatch.create({
                                    data: { issueId: p.patch_id, vendor: 'Ceph', component: p.component || 'ceph', version: p.version || '', osVersion: p.os_version || null, description: (p.description || '').slice(0, 4000), releaseDate: p.issued_date || null },
                                });
                            }
                            await job.log(`[CEPH-DB] Preprocessed ${cephPatchesRaw.length} patches ingested.`);

                            await prisma.reviewedPatch.deleteMany({ where: { vendor: 'Ceph' } });
                            for (const item of finalReviewedPatches) {
                                const issueId = item.IssueID || item.id || 'Unknown';
                                try {
                                    await prisma.reviewedPatch.upsert({
                                        where: { issueId },
                                        update: { vendor: 'Ceph', component: item.Component || 'ceph', version: item.Version || '', criticality: item.Criticality || 'Unknown', description: item.Description || '', koreanDescription: item.KoreanDescription || item.Description || '', decision: item.Decision || 'Done', pipelineRunId: String(job.id) },
                                        create: { issueId, vendor: 'Ceph', component: item.Component || 'ceph', version: item.Version || '', criticality: item.Criticality || 'Unknown', description: item.Description || '', koreanDescription: item.KoreanDescription || item.Description || '', decision: item.Decision || 'Done', pipelineRunId: String(job.id) },
                                    });
                                } catch (e) { await job.log(`[CEPH-DB WARN] Upsert failed for ${issueId}`); }
                            }
                            await job.log(`[CEPH-DB] Reviewed patches ingested: ${finalReviewedPatches.length}`);
                        } catch (dbErr: any) {
                            await job.log(`[CEPH-DB WARNING] DB ingestion error: ${dbErr.message}`);
                        }

                        await job.updateProgress(100);
                        await job.log('[CEPH-PIPELINE] All tasks completed successfully.');
                        resolve('Ceph pipeline success');
                        return;
                    }
                    // ============================================================
                    // END CEPH PIPELINE BRANCH
                    // ============================================================

                    if (job.name === 'manual-review') {
                        await job.updateProgress(5);
                        await job.log("Manual AI Review queued. Preparing input patches...");
                        const inputPath = path.join(linuxV2Dir, `manual_review_input_${job.id}.json`);
                        fs.writeFileSync(inputPath, JSON.stringify(job.data.patches, null, 2));
                    } else if (isAiOnly) {
                        await job.updateProgress(5);
                        await job.log("AI-Only pipeline queued. Bypassing collection...");
                    } else {
                        // 2. Preprocessing
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
                    let patchVendorSummary = '';
                    let queryTextContext = 'security updates';
                    let totalPatchCount = 0;
                    if (fs.existsSync(patchesPath)) {
                        try {
                            const patches = JSON.parse(fs.readFileSync(patchesPath, 'utf-8'));
                            totalPatchCount = patches.length;
                            const vendorCountMap: Record<string, number> = {};
                            for (const p of patches) {
                                const v = p.vendor || p.Vendor || 'Unknown';
                                vendorCountMap[v] = (vendorCountMap[v] || 0) + 1;
                            }
                            patchVendorSummary = Object.entries(vendorCountMap)
                                .map(([v, c]) => `${v}: ${c} patches`).join(', ');
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
                    const { ReviewSchema } = require('@/lib/schema');
                    const MAX_AI_RETRIES = 2;
                    let finalReviewedPatches: any[] = [];
                    let patchesRaw: any[] = [];
                    try { patchesRaw = JSON.parse(fs.readFileSync(patchesPath, 'utf-8')); } catch (e) { }

                    const prunePatchData = (obj: any): any => {
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
                            // Remove URLs to save token and payload size
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
                    };

                    await job.updateProgress(60);
                    await job.log(`AI Review in progress... Sequentially evaluating ${patchesRaw.length} patches (Zod Self-Healing enabled)`);

                    const BATCH_SIZE = 5;
                    for (let i = 0; i < patchesRaw.length; i += BATCH_SIZE) {
                        const batch = patchesRaw.slice(i, i + BATCH_SIZE);
                        const actualBatchSize = batch.length;
                        const batchNames = batch.map((p: any) => p.id || p.issueId || p.IssueID || 'Unknown').join(', ');
                        const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
                        const totalBatches = Math.ceil(patchesRaw.length / BATCH_SIZE);
                        
                        await job.log(`[AI Analysis] Processing batch ${batchIndex}/${totalBatches} (${actualBatchSize} patches): ${batchNames}`);

                        const prunedBatch = batch.map((p: any) => prunePatchData(p));
                        let basePrompt = `Read SKILL.md. Evaluate the following ${actualBatchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in SKILL.md section 4. Do NOT perform any web scraping. Do NOT use tools to write to files, simply output the text directly. Return ONLY a pure JSON array containing EXACTLY ${actualBatchSize} objects. The object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'. Do not skip Step 4.\\n\\n[BATCH DATA TO EVALUATE]:\\n${JSON.stringify(prunedBatch)}`;
                        basePrompt += ragExclusions;

                        let currentPrompt = basePrompt;
                        let parsedJson: any = null;

                        for (let attempt = 1; attempt <= MAX_AI_RETRIES + 1; attempt++) {
                            try {
                                const rawAiOutput = await withOpenClawLock(async (msg) => await job.log(msg), async () => {
                                    const sessionsDir = path.join(process.env.HOME || '/home/citec', '.openclaw/agents/main/sessions');
                                    if (fs.existsSync(sessionsDir)) {
                                        const oldFiles = fs.readdirSync(sessionsDir).filter((f: string) => f.endsWith('.lock') || f.includes('.jsonl'));
                                        for (const lf of oldFiles) fs.rmSync(path.join(sessionsDir, lf), { force: true });
                                    }
                                    return await runStream('/home/citec/.nvm/versions/node/v22.22.0/bin/openclaw',
                                        ['agent', '--agent', 'main', '--json', '--session-id', `os_${job.id}_batch_${batchIndex}_${attempt}`, '-m', currentPrompt],
                                        {}, { shell: false }, true
                                    );
                                });

                                const extractJsonArray = (text: string): any => {
                                    const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
                                    const match = stripped.match(/\[\s*\{[\s\S]*?\}\s*\]/);
                                    if (!match) return null;
                                    return JSON.parse(match[0]);
                                };

                                const openclawWrapper = JSON.parse(rawAiOutput);
                                const payloads = openclawWrapper?.result?.payloads || [];
                                const textContents = payloads.map((p: any) => p.text).join('\n');

                                if (textContents.toLowerCase().includes('rate limit')) throw new Error("AI_REVIEW_FAILED: API Rate Limit Error");
                                if (textContents.toLowerCase().includes('gateway closed') || textContents.toLowerCase().includes('gateway timeout')) throw new Error("AI_REVIEW_FAILED: OpenClaw execution timed out or gateway closed.");

                                parsedJson = extractJsonArray(textContents);
                                if (!parsedJson) throw new Error('No JSON array found in AI output even after code fence stripping.');
                                if (!Array.isArray(parsedJson) || parsedJson.length !== actualBatchSize) {
                                    throw new Error(`Expected array of length ${actualBatchSize}, but got ${Array.isArray(parsedJson) ? parsedJson.length : 'non-array'}`);
                                }

                                for(const item of parsedJson) {
                                    const validation = ReviewSchema.safeParse(item);
                                    if (!validation.success) {
                                        const errorDetails = validation.error.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`).join(', ');
                                        throw new Error(`Zod Schema Validation Failed for an item: ${errorDetails}`);
                                    }
                                    finalReviewedPatches.push(item);
                                }
                                
                                // Success
                                break;
                            } catch (err: any) {
                                if (err.message.includes('AI_REVIEW_FAILED')) throw err;

                                if (attempt <= MAX_AI_RETRIES) {
                                    currentPrompt += `\\n\\n이전 응답이 실패했습니다. 다음 에러를 해결하여 다시 제출하세요: ${err.message}\\n반드시 JSON 배열 형태로 EXACTLY ${actualBatchSize} 개의 객체를 출력하세요.`;
                                    await job.log(`  -> Attempt ${attempt} failed for batch ${batchIndex}, retrying...`);
                                } else {
                                    await job.log(`[SKIP] Batch ${batchIndex} permanently failed AI review after ${MAX_AI_RETRIES} retries. Error: ${err.message}`);
                                }
                            }
                        }
                        await job.updateProgress(60 + Math.floor(((i + actualBatchSize) / patchesRaw.length) * 30));
                    }

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
