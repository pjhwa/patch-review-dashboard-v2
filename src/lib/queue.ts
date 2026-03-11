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
            console.log(`Starting pipeline job ${job.id}`);
            const linuxV2Dir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');

            const linuxSkillDir = linuxV2Dir;
            const outputReportFilename = job.name === 'manual-review' ? `manual_ai_report_${job.id}.json` : 'patch_review_ai_report.json';

            const runStream = async (command: string, args: string[], progressMap: any = {}, overrideOpts: any = {}): Promise<any> => {
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
                                console.log(`[JOB ${job.id}] ${line}`);
                                job.log(line).catch(() => { });
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
                        await runStream('python3', ['patch_preprocessing.py', '--days', '90']);
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

                    let aiPrompt = job.name === 'manual-review'
                        ? `Read manual_review_input_${job.id}.json and evaluate these patches exactly according to the strict LLM evaluation rules detailed in SKILL.md section 4. Do NOT perform any web scraping, do NOT run batch_collector.js or patch_preprocessing.py. Save your final review array EXCLUSIVELY to the exact absolute path: ${absoluteReportPath}. Ensure it is strict generic JSON array without any markdown fences.`
                        : `Read SKILL.md. Note that Step 1 and Step 2 are completed, and patches_for_llm_review.json is generated. It contains EXACTLY ${totalPatchCount} patches across vendors: ${patchVendorSummary}. You MUST evaluate ALL ${totalPatchCount} patches across ALL vendors (Red Hat, Oracle, Ubuntu). Therefore, start from Step 3: Impact Analysis, then proceed to Step 4: Final JSON Generation. CRITICAL INSTRUCTIONS: (1) Your output MUST include ALL ${totalPatchCount} patches - do NOT summarize or select only a subset. (2) Write the final JSON output EXCLUSIVELY to the EXACT ABSOLUTE FILE PATH: ${absoluteReportPath} (NOT a CSV, NOT to any other path). (3) The JSON must be an array of objects where each object MUST contain exactly: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription'. (4) Do not skip Step 4. Auto-complete everything without user prompting.`;

                    try {
                        const escapedQuery = queryTextContext.replace(/"/g, '\\"').replace(/\n/g, ' ');
                        const ragResult = await runStepSync(`python3 ../../../../pipeline_scripts/query_rag.py "${escapedQuery}"`, { cwd: linuxSkillDir });
                        if (ragResult.stdout) {
                            const retrievedItems = JSON.parse(ragResult.stdout);
                            if (Array.isArray(retrievedItems) && retrievedItems.length > 0) {
                                const exclusionRules = retrievedItems.map((f: any) => `- Excluded Issue: ${f.issueId}, Reason: ${f.reason || f.description}`).join('\\n');
                                aiPrompt += `\\n\\nCRITICAL INSTRUCTION: Reviewers have manually marked the following historical patches to be explicitly EXCLUDED from final recommendations for the provided reasons:\\n${exclusionRules}\\n\\nIf you encounter any patches that are highly similar or identical to these excluded patch descriptions/reasons, you MUST filter them out and NOT include them in the final ${outputReportFilename}.`;
                                await job.log("Injected Incremental RAG Feedback into AI Prompt.");
                            }
                        }
                    } catch (e) {
                        await job.log("RAG query fallback failed or returned empty.");
                    }

                    // 4. Zod Loop + AI
                    const { ReviewSchema } = require('@/lib/schema');
                    const MAX_AI_RETRIES = 2;
                    let currentPrompt = aiPrompt;
                    let success = false;
                    let parsedJson: any = null;

                    await job.updateProgress(60);
                    await job.log("AI Review in progress (with Zod Self-Healing)...");

                    for (let attempt = 1; attempt <= MAX_AI_RETRIES + 1; attempt++) {
                        try {
                            await job.log(`[AI Analysis] Attempt ${attempt} started...`);

                            // Clean up any stale session lock files from previous crashed runs
                            try {
                                const sessionsDir = path.join(process.env.HOME || '/home/citec', '.openclaw/agents/main/sessions');
                                if (fs.existsSync(sessionsDir)) {
                                    const lockFiles = fs.readdirSync(sessionsDir).filter((f: string) => f.endsWith('.lock'));
                                    for (const lf of lockFiles) {
                                        fs.rmSync(path.join(sessionsDir, lf), { force: true });
                                        await job.log(`[AI Cleanup] Removed stale lock: ${lf}`);
                                    }
                                }
                            } catch (cleanErr) {
                                await job.log(`[AI Cleanup] Warning: ${cleanErr}`);
                            }

                            const rawAiOutput = await runStream('/home/citec/.nvm/versions/node/v22.22.0/bin/openclaw',
                                ['agent', '--agent', 'main', '--json', '-m', currentPrompt],
                                {
                                    'generating response': 70,
                                    'call:': 75
                                },
                                { shell: false }
                            );

                            const finalReportPath = path.join(linuxV2Dir, outputReportFilename);
                            try {
                                if (rawAiOutput.toLowerCase().includes('rate limit')) {
                                    throw new Error("AI_REVIEW_FAILED: API Rate Limit Error");
                                }
                                if (rawAiOutput.toLowerCase().includes('gateway closed') || rawAiOutput.toLowerCase().includes('gateway timeout')) {
                                    throw new Error("AI_REVIEW_FAILED: OpenClaw execution timed out or gateway closed.");
                                }

                                // Helper: strip markdown code fences and extract first JSON array
                                const extractJsonArray = (text: string): any => {
                                    // Remove markdown code fences (```json...``` or ```...```)
                                    const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
                                    const match = stripped.match(/\[\s*\{[\s\S]*?\}\s*\]/);
                                    if (!match) return null;
                                    return JSON.parse(match[0]);
                                };

                                // Primary: try recently modified file
                                if (fs.existsSync(finalReportPath)) {
                                    const stat = fs.statSync(finalReportPath);
                                    if (Date.now() - stat.mtimeMs < 180000) {
                                        const fileText = fs.readFileSync(finalReportPath, 'utf-8');
                                        parsedJson = extractJsonArray(fileText);
                                    }
                                }

                                // Fallback: parse from OpenClaw stdout wrapper
                                if (!parsedJson) {
                                    const openclawWrapper = JSON.parse(rawAiOutput);
                                    const payloads = openclawWrapper?.result?.payloads || [];
                                    const textContents = payloads.map((p: any) => p.text).join('\n');

                                    if (textContents.toLowerCase().includes('rate limit')) {
                                        throw new Error("AI_REVIEW_FAILED: API Rate Limit Error");
                                    }

                                    parsedJson = extractJsonArray(textContents);
                                    if (!parsedJson) {
                                        fs.writeFileSync(path.join(linuxV2Dir, 'failed_ai_text.txt'), textContents);
                                        throw new Error('No JSON array found in AI output even after code fence stripping.');
                                    }
                                }
                            } catch (e: any) {
                                if (e.message.includes('AI_REVIEW_FAILED')) throw e;
                                throw new Error(`Output is not valid JSON array: ${e.message}`);
                            }

                            const validation = ReviewSchema.safeParse(parsedJson);
                            if (!validation.success) {
                                const errorDetails = validation.error.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`).join(', ');
                                throw new Error(`Zod Schema Validation Failed: ${errorDetails}`);
                            }

                            await job.updateProgress(90);
                            await job.log(`[AI Analysis] Attempt ${attempt} successful! Zod Schema verified.`);
                            success = true;
                            break;
                        } catch (err: any) {
                            await job.log(`[AI Analysis] Attempt ${attempt} failed: ${err.message}`);

                            // If it's a critical API limit or execution failure, do not retry Zod validation.
                            if (err.message.includes('AI_REVIEW_FAILED')) {
                                throw err;
                            }

                            if (attempt <= MAX_AI_RETRIES) {
                                currentPrompt += `\\n\\n이전 응답이 실패했습니다. 다음 Zod 구조적 에러를 해결하여 다시 제출하세요: ${err.message}\\n반드시 JSON 배열 형태로 출력하세요.`;
                            } else {
                                throw new Error(`AI Analysis permanently failed after ${MAX_AI_RETRIES} retries. Last error: ${err.message}`);
                            }
                        }
                    }

                    if (!success) throw new Error("AI Analysis completely failed.");

                    // 5. Database Ingestion - validate against preprocessed data first
                    console.log(`Job ${job.id} finished. Ingesting AI results to SQLite DB...`);
                    await job.log("OpenClaw finished. Merging with PreprocessedPatch metadata and ingesting...");

                    const data = Array.isArray(parsedJson) ? parsedJson : [];
                    if (data.length === 0) throw new Error("parsedJson is empty, cannot ingest.");

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
