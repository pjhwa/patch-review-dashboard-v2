import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import util from 'util';
import { prisma } from '@/lib/db';
import { ProductConfig, PRODUCT_MAP, getSkillDir } from '@/lib/products-registry';

// Redis 연결: BullMQ 큐와 워커가 공유하는 단일 연결.
// maxRetriesPerRequest: null 은 BullMQ Worker에 필수 옵션으로, 연결 재시도를 무한히 허용한다.
const connection = new IORedis({
    host: '127.0.0.1',
    port: 6379,
    maxRetriesPerRequest: null,
}) as any;

// 'patch-pipeline' 큐에 작업을 추가하는 Queue 인스턴스. API 라우트에서 이 객체를 통해 파이프라인 작업을 등록한다.
export const pipelineQueue = new Queue('patch-pipeline', { connection });

// Define the worker on the Next.js server side.
// Note: In a production app, this might run in a separate Node process, but for this dashboard it's spawned here.
let workerStarted = false;

// OpenClaw AI 프로세스에 대한 글로벌 뮤텍스 (디렉토리 기반 락).
// 여러 제품 파이프라인이 동시에 AI를 호출하면 세션 충돌이 발생하므로,
// 한 번에 하나의 AI 호출만 실행되도록 보장한다.
// 파일이 아닌 디렉토리로 락을 구현하는 이유: mkdir은 OS 레벨에서 원자적(atomic)으로 동작해
// 파일 생성보다 경쟁 조건(race condition)이 발생할 가능성이 없다.
// PID 파일을 lock 디렉토리 안에 기록해 프로세스 종료(pm2 재시작, 강제 kill) 후 남은
// 고아 lock을 자동으로 감지하고 제거한다.
async function withOpenClawLock(jobLog: (msg: string) => Promise<any>, fn: () => Promise<any>): Promise<any> {
    const lockDir = '/tmp/openclaw_execution.lock';
    const pidFile = `${lockDir}/pid`;
    let loggedWaiting = false;
    while (true) {
        try {
            fs.mkdirSync(lockDir);
            // lock 획득 성공 — 현재 PID 기록
            fs.writeFileSync(pidFile, String(process.pid));
            break;
        } catch (err: any) {
            if (err.code === 'EEXIST') {
                // 고아 lock 감지: PID 파일이 없거나 해당 프로세스가 죽었으면 stale lock으로 판단
                try {
                    const storedPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
                    if (!isNaN(storedPid)) {
                        try {
                            process.kill(storedPid, 0); // 프로세스 생존 여부만 확인 (signal 0)
                        } catch {
                            // 프로세스가 존재하지 않음 → stale lock 제거 후 재시도
                            fs.rmSync(lockDir, { recursive: true, force: true });
                            continue;
                        }
                    }
                } catch {
                    // PID 파일 읽기 실패 → stale lock으로 간주하고 제거
                    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
                    continue;
                }
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
    try { return await fn(); } finally { try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch(e) {} }
}

// AI 컨텍스트 토큰 한도를 초과하지 않도록 패치 데이터를 정리하는 범용 pruner.
// URL을 [URL] 플레이스홀더로 대체하고 텍스트를 잘라낸다.
// Linux 제품을 제외한 모든 제품(Ceph, MariaDB, PostgreSQL 등)에서 사용된다.
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

// Linux(RHEL/Oracle/Ubuntu) 패치 전용 pruner.
// Linux 패치는 packages, cves, affected_products 같은 배열이 매우 길어
// 범용 pruner보다 강력한 배열 잘라내기(최대 15개)를 추가로 적용한다.
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

// 특정 skillDir에 바인딩된 runStream 함수를 반환하는 팩토리.
// 각 제품의 파이프라인은 자신의 skillDir(작업 디렉토리)에서 Python 스크립트와 openclaw를 실행하므로,
// cwd를 미리 고정한 함수를 만들어 각 호출 시 반복 지정하는 번거로움을 제거한다.
// stdout/stderr 스트리밍으로 BullMQ job 로그에 실시간으로 기록한다.
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

// AI 호출 전 세션 파일을 정리한다.
// openclaw는 이전 세션의 .lock / .jsonl 파일이 남아있으면 재사용해서 오염된 컨텍스트로 응답할 수 있다.
// sessions.json도 반드시 삭제해야 한다 — 남아있으면 이전 대화 상태가 복원되는 버그 발생 가능.
function cleanupSessions(): void {
    const sessionsDir = path.join(process.env.HOME || '/home/citec', '.openclaw/agents/main/sessions');
    if (fs.existsSync(sessionsDir)) {
        const oldFiles = fs.readdirSync(sessionsDir).filter((f: string) => f.endsWith('.lock') || f.includes('.jsonl'));
        for (const lf of oldFiles) fs.rmSync(path.join(sessionsDir, lf), { force: true });
        const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
        if (fs.existsSync(sessionsJsonPath)) fs.rmSync(sessionsJsonPath, { force: true });
    }
}

// 패스스루(Passthrough) 안전망: AI가 평가하지 않은 패치를 직접 DB에 삽입한다.
// AI는 SKILL.md 기준에 따라 일부 패치를 의도적으로 건너뛸 수 있다.
// passthrough가 활성화된 제품은 AI에서 누락된 패치를 fallbackCriticality/fallbackDecision으로
// ReviewedPatch에 강제 삽입해 전처리 기록과 리뷰 기록 사이에 괴리가 생기지 않도록 한다.
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

// AI 출력 텍스트에서 JSON 배열을 추출한다.
// openclaw는 종종 응답을 ```json ... ``` 코드 펜스로 감싸므로, 코드 펜스를 제거한 후 파싱한다.
function extractJsonArray(text: string): any {
    const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');
    const match = stripped.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (!match) return null;
    return JSON.parse(match[0]);
}

// 모든 제품에서 공통으로 사용하는 AI 리뷰 루프.
// 패치를 BATCH_SIZE(5)개 단위로 나눠 순차적으로 openclaw AI에 전달하고,
// 결과를 Zod 스키마로 검증한다. 검증 실패 시 최대 MAX_AI_RETRIES(2)번 재시도한다.
// Rate Limit 오류가 발생하면 rateLimitFlag 파일을 생성하고 예외를 throw해 재개 모드(resume)를 가능하게 한다.
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
    const BATCH_SIZE = productCfg.aiBatchSize ?? 5;

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

    // RAG 제외 규칙 주입 (prompt-injection 방식 — 전 제품 공통).
    // 사용자가 수동 피드백으로 등록한 '제외 패치' 목록을 RAG DB에서 조회해
    // 프롬프트에 직접 포함시켜 AI가 유사 패치를 자동으로 Exclude 처리하도록 유도한다.
    // query_rag.py와 user_exclusion_feedback.json은 항상 os/linux/ 공유 디렉토리에 존재한다.
    let ragExclusions = '';
    const ragType = productCfg.ragExclusion?.type;
    if ((ragType === 'prompt-injection' || ragType === 'both') && productCfg.ragExclusion?.queryScript) {
        const runStepSync = util.promisify(require('child_process').exec);
        // query_rag.py와 피드백 파일은 항상 os/linux/ 공유 디렉토리에서 실행
        const sharedRagDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux');
        const queryScriptPath = path.join(sharedRagDir, productCfg.ragExclusion.queryScript);
        try {
            let queryTextContext = 'security updates';
            if (patches.length > 0) {
                const sampleSize = productCfg.ragExclusion.queryTextSampleSize || 3;
                queryTextContext = patches.slice(0, sampleSize).map((p: any) => p.Description || p.description || p.id || '').join(' ');
            }
            const escapedQuery = queryTextContext.replace(/"/g, '\\"').replace(/\n/g, ' ');
            const ragResult = await runStepSync(`python3 ${queryScriptPath} "${escapedQuery}"`, { cwd: sharedRagDir });
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

    // RAG 제외 규칙 적용 (file-hiding 방식 — type: 'file-hiding' 또는 'both').
    // normalized/ 디렉토리와 patches_for_llm_review_*.json을 AI 호출 전에 임시로 숨긴다.
    // openclaw의 파일 도구가 이전 리뷰 데이터에 접근해 편향된 결과를 생성하는 것을 방지한다.
    // AI 루프 종료 후 반드시 원래 이름으로 복원한다.
    let normalizedDir: string | null = null;
    let hiddenNormalizedDir: string | null = null;
    let patchesFilePath: string | null = null;
    let hiddenPatchesFilePath: string | null = null;

    if (ragType === 'file-hiding' || ragType === 'both') {
        if (productCfg.ragExclusion?.normalizedDirName) {
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
                        ['agent', '--local', '--agent', 'main', '--json', '--timeout', '1800', '--session-id', `${productCfg.id}_${job.id}_batch_${batchIndex}_${attempt}`, '-m', prompt],
                        {}, { shell: false, cwd: skillDir }, true
                    );
                });

                const openclawWrapper = JSON.parse(rawAiOutput);
                const payloads = openclawWrapper?.payloads || [];
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

                // 배치 완료 시마다 중간 저장: 파이프라인이 중간에 실패하더라도
        // 이미 검토된 배치는 DB에 보존되어 재개 모드(resume)에서 재처리하지 않아도 된다.
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
                    await job.log(`  -> Attempt ${attempt} failed for batch ${batchIndex}, retrying... Error: ${err.message}`);
                } else {
                    await job.log(`[SKIP] Batch ${batchIndex} permanently failed after ${MAX_AI_RETRIES} retries. Error: ${err.message}`);
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

// AI 리뷰 결과를 DB에 최종 반영한다.
// isResumeMode / isAiOnly 가 아닐 때만 기존 데이터를 삭제하고 새로 삽입한다.
// 'Exclude' 결정이거나 criticality가 moderate/medium/low인 패치는 DB에 넣지 않는다.
// vsphere는 createMany 대신 개별 create를 사용한다 (배치 삽입 시 스키마 호환 문제).
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

        if (!isResumeMode) await prisma.reviewedPatch.deleteMany({ where: { vendor: productCfg.vendorString } });
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
                        osVersion: item.OsVersion || item.osVersion || null,
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
                        osVersion: item.OsVersion || item.osVersion || null,
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

// 단일 제품에 대한 5단계 파이프라인을 실행한다.
// 1단계: Python 전처리 스크립트 실행 (isAiOnly/Resume 모드에서는 건너뜀)
// 2단계: 전처리 결과 JSON 파일 읽기
// 3단계: AI 리뷰 루프 실행 (runAiReviewLoop)
// 4단계: DB 반영 (ingestToDb)
// 5단계: 패스스루 — AI가 빠뜨린 패치를 기본값으로 채워 넣음 (runPassthrough)
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
    const isLinux = productCfg.id === 'redhat' || productCfg.id === 'oracle' || productCfg.id === 'ubuntu';
    let patchesRaw: any[] = [];
    try { patchesRaw = JSON.parse(fs.readFileSync(patchesPath, 'utf-8')); } catch (e) { }

    // Step 2.5: Kernel dual-window deduplication (Linux only)
    // If a recent-window (0~3m) entry exists for the same (vendor, component, os_version),
    // exclude the early-window (6m~3m) entry — it is superseded by the more current critical patch.
    const deduplicatedIds = new Set<string>(); // track removed IDs so passthrough skips them
    if (isLinux && patchesRaw.length > 0) {
        const KERNEL_PREFIXES = ['kernel', 'linux-image', 'linux-firmware', 'microcode'];
        const isKernelRelated = (component: string) => {
            const c = (component || '').toLowerCase();
            return KERNEL_PREFIXES.some(p => c === p || c.startsWith(p + '-') || c.startsWith(p + '_'));
        };
        const recentKernelKeys = new Set<string>();
        for (const p of patchesRaw) {
            if (isKernelRelated(p.component) && p.window_type === 'recent') {
                recentKernelKeys.add(`${p.vendor}|${p.component}|${p.os_version}`);
            }
        }
        if (recentKernelKeys.size > 0) {
            const before = patchesRaw.length;
            patchesRaw = patchesRaw.filter((p: any) => {
                if (isKernelRelated(p.component) && p.window_type === 'early') {
                    if (recentKernelKeys.has(`${p.vendor}|${p.component}|${p.os_version}`)) {
                        deduplicatedIds.add((p.id || p.issueId || '').toString());
                        return false;
                    }
                }
                return true;
            });
            const removed = before - patchesRaw.length;
            if (removed > 0) {
                await job.log(`[${productCfg.logTag}-PIPELINE] Kernel dedup: removed ${removed} early-window entries superseded by recent-window critical patches.`);
            }
        }
    }

    // Step 3: AI Review Loop
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
    // Include deduplicatedIds so passthrough does not re-insert early-window entries that were
    // intentionally removed by Step 2.5 kernel dedup.
    const aiReviewedIds = new Set([
        ...finalReviewedPatches.map((d: any) => (d.IssueID || d.id || '').toString()),
        ...deduplicatedIds,
    ]);
    await runPassthrough(job, productCfg, aiReviewedIds);

    await job.updateProgress(100);
    await job.log(`[${productCfg.logTag}-PIPELINE] All tasks completed successfully.`);
    return `${productCfg.name} pipeline success`;
}

// BullMQ Worker를 등록한다. Next.js 서버 프로세스 내에서 실행되며,
// 큐에서 작업이 들어오면 job.name으로 제품을 식별해 파이프라인을 실행한다.
// workerStarted 플래그로 중복 등록을 방지한다.
export function startWorker() {
    if (workerStarted) return;
    workerStarted = true;

    new Worker('patch-pipeline', async (job: Job) => {
        return new Promise((resolve, reject) => {
            console.log(`Starting pipeline job ${job.id} (name: ${job.name})`);
            // 레거시 Linux OS 파이프라인과 manual-review에서 사용하는 기본 skillDir.
            const linuxV2Dir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux');
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
                    // job.name으로 PRODUCT_MAP에서 ProductConfig를 찾아 runProductPipeline으로 위임한다.
                    // 새 제품을 추가하면 products-registry.ts에 등록하고 여기에 job.name → id 매핑만 추가하면 된다.
                    // ============================================================
                    const productCfg = PRODUCT_MAP[
                        job.name === 'run-ceph-pipeline' ? 'ceph' :
                        job.name === 'run-sqlserver-pipeline' ? 'sqlserver' :
                        job.name === 'run-mariadb-pipeline' ? 'mariadb' :
                        job.name === 'run-pgsql-pipeline' ? 'pgsql' :
                        job.name === 'run-vsphere-pipeline' ? 'vsphere' :
                        job.name === 'run-windows-pipeline' ? 'windows' :
                        job.name === 'run-jboss_eap-pipeline' ? 'jboss_eap' :
                        job.name === 'run-tomcat-pipeline' ? 'tomcat' :
                        job.name === 'run-wildfly-pipeline' ? 'wildfly' :
                        job.name === 'run-mysql-pipeline' ? 'mysql' :
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

                    // ============================================================
                    // PRODUCT-AWARE MANUAL REVIEW  (manual-review-{productId})
                    // 담당자가 전처리 목록에서 수동 선택한 패치를 AI로 검토해
                    // ReviewedPatch에 추가한다. 기존 레코드는 삭제하지 않고 upsert만 수행.
                    // ============================================================
                    if (job.name.startsWith('manual-review-')) {
                        const manualProductId = job.name.replace('manual-review-', '');
                        const manualCfg = PRODUCT_MAP[manualProductId];
                        if (!manualCfg) {
                            reject(new Error(`[MANUAL-REVIEW] Unknown productId: ${manualProductId}`));
                            return;
                        }
                        try {
                            await job.updateProgress(5);
                            const patchList: any[] = job.data.patches || [];
                            await job.log(`[MANUAL-REVIEW] Starting manual AI review for ${manualCfg.name}: ${patchList.length} patches selected by operator.`);

                            if (patchList.length === 0) {
                                await job.log('[MANUAL-REVIEW] No patches to review. Done.');
                                await job.updateProgress(100);
                                resolve('manual-review: no patches');
                                return;
                            }

                            const manualSkillDir = getSkillDir(manualCfg);
                            const manualRunStream = makeStreamRunner(manualSkillDir, job);
                            const manualIsLinux = manualCfg.id === 'redhat' || manualCfg.id === 'oracle' || manualCfg.id === 'ubuntu';

                            await job.log(`[MANUAL-REVIEW] Running AI review loop (skill: ${manualSkillDir})...`);
                            const manualReviewed = await runAiReviewLoop(job, manualCfg, manualSkillDir, manualRunStream, patchList, false, manualIsLinux);

                            // Build lookup map for hallucination filtering
                            const manualIssueIds: string[] = patchList.map((p: any) => p.id || p.issueId).filter(Boolean);
                            const manualPrePatches = await prisma.preprocessedPatch.findMany({
                                where: { issueId: { in: manualIssueIds } },
                                select: { issueId: true, osVersion: true, vendor: true }
                            });
                            const manualPreMap = new Map(manualPrePatches.map((p: any) => [p.issueId, p]));

                            let manualIngestedCount = 0;
                            for (const item of manualReviewed) {
                                const issueId = item.IssueID || item.id || 'Unknown';
                                if (!manualPreMap.has(issueId)) {
                                    await job.log(`[MANUAL-REVIEW-SKIP] Hallucinated issueId not in preprocessed: ${issueId}`);
                                    continue;
                                }
                                const meta: any = manualPreMap.get(issueId) || {};
                                try {
                                    await prisma.reviewedPatch.upsert({
                                        where: { issueId },
                                        update: {
                                            vendor: item.Vendor || manualCfg.vendorString,
                                            osVersion: item.OsVersion || item.osVersion || meta.osVersion || null,
                                            component: item.Component || manualCfg.aiComponentDefault,
                                            version: item.Version || '',
                                            criticality: item.Criticality || 'Important',
                                            description: item.Description || '',
                                            koreanDescription: item.KoreanDescription || item.Description || '',
                                            decision: item.Decision === 'Exclude' ? 'Done' : (item.Decision || 'Done'),
                                            reason: item.Reason || null,
                                            pipelineRunId: String(job.id)
                                        },
                                        create: {
                                            issueId,
                                            vendor: item.Vendor || manualCfg.vendorString,
                                            osVersion: item.OsVersion || item.osVersion || meta.osVersion || null,
                                            component: item.Component || manualCfg.aiComponentDefault,
                                            version: item.Version || '',
                                            criticality: item.Criticality || 'Important',
                                            description: item.Description || '',
                                            koreanDescription: item.KoreanDescription || item.Description || '',
                                            decision: item.Decision === 'Exclude' ? 'Done' : (item.Decision || 'Done'),
                                            reason: item.Reason || null,
                                            pipelineRunId: String(job.id)
                                        }
                                    });
                                    manualIngestedCount++;
                                } catch (e) {
                                    await job.log(`[MANUAL-REVIEW-DB] Upsert failed for ${issueId}`);
                                }
                            }

                            // Clear isAiReviewRequested for processed patches
                            if (manualIssueIds.length > 0) {
                                await prisma.preprocessedPatch.updateMany({
                                    where: { issueId: { in: manualIssueIds } },
                                    data: { isAiReviewRequested: false }
                                });
                            }

                            await job.updateProgress(100);
                            await job.log(`[MANUAL-REVIEW-PIPELINE] Manual AI review done. ${manualIngestedCount}/${manualReviewed.length} patches ingested into ReviewedPatch.`);
                            resolve(`${manualCfg.name} manual-review success`);
                        } catch (e: any) {
                            await job.log(`[MANUAL-REVIEW] CRITICAL ERROR: ${e.message}`);
                            reject(e);
                        }
                        return;
                    }
                    // ============================================================
                    // END PRODUCT-AWARE MANUAL REVIEW
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

                    // Determine vendor-specific SKILL.md for this manual review batch.
                    // Oracle/Ubuntu have their own vendor SKILL.md; fall back to redhat if unknown.
                    const MANUAL_VENDOR_TO_DIR: Record<string, string> = {
                        'Red Hat': 'redhat',
                        'Oracle': 'oracle',
                        'Ubuntu': 'ubuntu',
                    };
                    const firstPatchVendor = patchesRaw[0]?.vendor || job.data.patches?.[0]?.vendor || '';
                    const manualVendorDir = MANUAL_VENDOR_TO_DIR[firstPatchVendor] || 'redhat';
                    const manualSkillMdPath = path.join(linuxSkillDir, manualVendorDir, 'SKILL.md');
                    await job.log(`[Manual Review] SKILL.md: ${manualVendorDir}/SKILL.md (vendor: ${firstPatchVendor || 'unknown → redhat'})`);

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
                        let basePrompt = `Read the rules explicitly from ${manualSkillMdPath}. Evaluate the following ${actualBatchSize} PATCHES exactly according to the strict LLM evaluation rules detailed in section 3 of that file.
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
                                        ['agent', '--local', '--agent', 'main', '--json', '--timeout', '1800', '--session-id', `os_${job.id}_batch_${batchIndex}_${attempt}`, '-m', currentPrompt],
                                        {}, { shell: false }, true
                                    );
                                });

                                const openclawWrapper = JSON.parse(rawAiOutput);
                                const payloads = openclawWrapper?.payloads || [];
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

                    // 5. 레거시 run-pipeline / manual-review 경로의 DB 반영.
                    // preprocessedMap을 통해 AI가 만들어낸 가짜(환각) issueId를 필터링한다.
                    // PreprocessedPatch에 존재하지 않는 issueId는 AI 환각으로 간주해 삽입하지 않는다.
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
                    // manual-review는 선택된 패치만 재리뷰하는 것이므로 passthrough 불필요 — 건너뜀.
                    // run-pipeline (레거시) 경로는 Linux 전용이므로 vendor 범위를 Linux 3종으로 제한.
                    try {
                        const aiIssuedIds = new Set(data.map((d: any) => (d.IssueID || d.id || '').toString()));
                        if (job.name === 'manual-review') {
                            // 선택적 재리뷰이므로 passthrough 생략
                            await job.log('[PASSTHROUGH] Skipped for manual-review job.');
                        } else {
                        const missingPatches = await prisma.preprocessedPatch.findMany({
                            where: {
                                vendor: { in: ['Red Hat', 'Oracle', 'Ubuntu'] },
                                issueId: { notIn: Array.from(aiIssuedIds) }
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
                        } // end else (non-manual-review)
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

// 모듈이 로드되는 순간 워커를 자동으로 시작한다.
// Next.js HMR 환경에서 모듈이 여러 번 로드될 수 있으므로 globalForQueue로 중복 실행을 방지한다.
const globalForQueue = global as unknown as { workerStarted: boolean };
if (!globalForQueue.workerStarted) {
    globalForQueue.workerStarted = true;
    startWorker();
}
