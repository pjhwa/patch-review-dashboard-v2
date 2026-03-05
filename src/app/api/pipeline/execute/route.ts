import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';

const execAsync = util.promisify(exec);

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { category, productId, isRetry, isAiOnly } = body;

        if (category !== 'os') {
            return NextResponse.json({ error: 'Only OS category is supported for execution right now' }, { status: 400 });
        }

        // Map specific products to their underlying shared collection script platforms.
        // E.g., Red Hat, Oracle, Ubuntu all belong to the shared 'linux' execution pipeline.
        const linuxProducts = ['redhat', 'oracle', 'ubuntu'];
        let platformFolder = '';

        if (linuxProducts.includes(productId)) {
            platformFolder = 'linux';
        } else {
            return NextResponse.json({ error: `Automated execution is not yet configured for ${productId}` }, { status: 400 });
        }

        const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        const statusFile = path.join(linuxSkillDir, 'pipeline_status.json');
        const { spawn } = require('child_process');
        const fs = require('fs');

        if (fs.existsSync(statusFile)) {
            try {
                const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
                if (status.isRunning) {
                    return NextResponse.json({ error: 'Pipeline is already running.' }, { status: 409 });
                }
            } catch (e) { }
        }

        fs.writeFileSync(statusFile, JSON.stringify({ isRunning: true, message: isAiOnly ? "Starting AI Review Analysis..." : (isRetry ? "Starting Retry Data Collection..." : "Starting Data Collection...") }));

        // Archive previous batch data and logs so UI counts reset to 0 cleanly
        if (!isRetry) {
            try {
                const batchDataDir = path.join(linuxSkillDir, 'batch_data');
                const debugLogFile = path.join(linuxSkillDir, 'debug_collector.log');
                const preprocessedFile = path.join(linuxSkillDir, 'patches_for_llm_review.json');
                const finalReportFile = path.join(linuxSkillDir, 'patch_review_ai_report.json'); // Changed to JSON

                const approvedFiles = ['redhat', 'oracle', 'ubuntu'].map(prod =>
                    path.join(linuxSkillDir, `final_approved_patches_${prod}.csv`)
                );

                const shouldArchive = isAiOnly ?
                    (fs.existsSync(finalReportFile) || approvedFiles.some(f => fs.existsSync(f))) :
                    (fs.existsSync(preprocessedFile) || fs.existsSync(finalReportFile) || approvedFiles.some(f => fs.existsSync(f)));

                if (shouldArchive) {
                    // Create archive dir based on current timestamp
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const archiveDir = path.join(linuxSkillDir, 'archive', timestamp);
                    fs.mkdirSync(archiveDir, { recursive: true });

                    if (!isAiOnly) {
                        if (fs.existsSync(debugLogFile)) {
                            fs.renameSync(debugLogFile, path.join(archiveDir, 'debug_collector.log'));
                        }
                        if (fs.existsSync(preprocessedFile)) {
                            fs.renameSync(preprocessedFile, path.join(archiveDir, 'patches_for_llm_review.json'));
                        }
                    }

                    if (fs.existsSync(finalReportFile)) {
                        fs.renameSync(finalReportFile, path.join(archiveDir, 'patch_review_ai_report.json'));
                    }
                    ['redhat', 'oracle', 'ubuntu'].forEach(prod => {
                        const approvedFile = path.join(linuxSkillDir, `final_approved_patches_${prod}.csv`);
                        if (fs.existsSync(approvedFile)) {
                            fs.renameSync(approvedFile, path.join(archiveDir, `final_approved_patches_${prod}.csv`));
                        }
                    });
                }
            } catch (e) {
                console.error("Warning: Failed to archive old data", e);
            }
        }

        const runBackgroundPipeline = () => {
            const runStep = (cmd: string, args: string[], stepName: string, options: any = { cwd: linuxSkillDir }) => {
                return new Promise((resolve, reject) => {
                    console.log(`[Pipeline] Starting ${stepName}...`);
                    fs.writeFileSync(statusFile, JSON.stringify({ isRunning: true, message: `Running: ${stepName}...` }));

                    const logStream = fs.createWriteStream(path.join(linuxSkillDir, 'debug_collector.log'), { flags: 'a' });
                    const p = spawn(cmd, args, options);

                    p.stdout.pipe(logStream);
                    p.stderr.pipe(logStream);

                    p.on('close', (code: number) => {
                        logStream.end();
                        code === 0 ? resolve(true) : reject(new Error(`${stepName} failed with code ${code}`));
                    });
                    p.on('error', (err: any) => {
                        logStream.end();
                        reject(err);
                    });
                });
            };
            (async () => {
                try {
                    const nodePath = path.join(process.env.HOME || '/home/citec', '.nvm/versions/node/v22.22.0/bin/node');

                    if (!isAiOnly) {
                        const scraperArgs = isRetry ? ['batch_collector.js', '--retry-failures'] : ['batch_collector.js'];
                        await runStep(nodePath, scraperArgs, isRetry ? 'Retry Data Collection' : 'Data Collection', { cwd: linuxSkillDir });

                        // Pass `--days 90` to preprocessing so it only hands the last 3 months of accumulated data to the LLM agent
                        await runStep('/usr/bin/python3', ['patch_preprocessing.py', '--days', '90'], 'Preprocessing', { cwd: linuxSkillDir });
                    }

                    const openClawPath = '/home/citec/.nvm/versions/node/v22.22.0/bin/node';
                    const openClawScript = '/home/citec/.nvm/versions/node/v22.22.0/bin/openclaw';
                    let aiPrompt = "Read SKILL.md. Note that Step 1 and Step 2 are completed, and patches_for_llm_review.json is generated. Therefore, you must start from Step 3: Impact Analysis, and then proceed to finalize Step 4: Final JSON Generation. CRITICAL INSTRUCTION: You MUST output the final analytical result EXCLUSIVELY to a file named patch_review_ai_report.json (NOT A CSV). The JSON must be an array of objects. Each object MUST strictly contain the exact exact following string keys: 'IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', and 'KoreanDescription'. Do not skip Step 4. Auto-complete everything without user prompting.";

                    const feedbackFile = path.join(linuxSkillDir, 'user_exclusion_feedback.json');
                    if (fs.existsSync(feedbackFile)) {
                        try {
                            const feedbackList = JSON.parse(fs.readFileSync(feedbackFile, 'utf-8'));
                            if (Array.isArray(feedbackList) && feedbackList.length > 0) {
                                const exclusionRules = feedbackList.map((f: any) => `- Issue: ${f.issueId}, Description: ${f.description}, Reason for exclusion: ${f.reason}`).join('\n');
                                aiPrompt += `\n\nCRITICAL INSTRUCTION: Reviewers have manually marked the following historical patches to be explicitly EXCLUDED from final recommendations for the provided reasons:\n${exclusionRules}\n\nIf you encounter any patches in patches_for_llm_review.json that are highly similar or identical to these excluded patch descriptions/reasons, you MUST filter them out and NOT include them in the final patch_review_ai_report.json.`;
                                console.log("[Pipeline] Injected User Exclusion Feedback into AI Prompt.");
                            }
                        } catch (e) {
                            console.error("Failed to read user exclusion feedback:", e);
                        }
                    }

                    // AI Analysis with auto-retry (up to 2 additional attempts)
                    const MAX_AI_RETRIES = 2;
                    let aiLastError: any = null;
                    let aiSuccess = false;

                    for (let attempt = 1; attempt <= MAX_AI_RETRIES + 1; attempt++) {
                        try {
                            const attemptMsg = attempt > 1 ? ` (재시도 ${attempt - 1}/${MAX_AI_RETRIES})` : '';
                            fs.writeFileSync(statusFile, JSON.stringify({
                                isRunning: true,
                                message: `AI Analysis 진행 중${attemptMsg}... (모델: qwen3-coder → fallback 순서로 자동 전환)`
                            }));

                            await runStep(openClawPath, [openClawScript, 'agent', '--agent', 'main', '--message', aiPrompt], `AI Analysis (attempt ${attempt})`, { cwd: linuxSkillDir });

                            // Check if the JSON output was actually generated
                            const finalReportPath = path.join(linuxSkillDir, 'patch_review_ai_report.json');
                            if (!fs.existsSync(finalReportPath)) {
                                throw new Error(`LLM이 실행은 완료됐지만 patch_review_ai_report.json 파일을 생성하지 않았습니다 (attempt ${attempt})`);
                            }

                            aiSuccess = true;
                            break; // Success — exit retry loop
                        } catch (retryErr: any) {
                            aiLastError = retryErr;
                            console.error(`[AI Analysis] Attempt ${attempt} failed:`, retryErr.message);
                            if (attempt <= MAX_AI_RETRIES) {
                                // Wait 5 seconds before retrying
                                await new Promise(res => setTimeout(res, 5000));
                            }
                        }
                    }

                    if (!aiSuccess) {
                        throw new Error(
                            `AI Review가 ${MAX_AI_RETRIES + 1}번 시도 후 모두 실패했습니다. ` +
                            `마지막 오류: ${aiLastError?.message || '알 수 없는 오류'}. ` +
                            `나중에 'AI 리뷰만 재시도' 버튼을 눌러 해당 단계만 별도로 수행하세요.`
                        );
                    }

                    const completedAt = new Date().toISOString();
                    fs.writeFileSync(statusFile, JSON.stringify({ isRunning: false, message: "Pipeline completed successfully.", lastCompletedAt: completedAt }));
                } catch (e: any) {
                    console.error("[Pipeline Error]", e);
                    fs.writeFileSync(statusFile, JSON.stringify({ isRunning: false, message: `Failed: ${e.message}` }));
                }
            })();
        };

        runBackgroundPipeline();

        return NextResponse.json({
            success: true,
            message: `Started ${isAiOnly ? 'AI-Only ' : (isRetry ? 'retry ' : '')}pipeline execution for Linux servers`,
            jobId: `job-${Date.now()}`
        });

    } catch (error: any) {
        console.error("Pipeline execution failed:", error);
        return NextResponse.json({ error: error.message || 'Execution failed' }, { status: 500 });
    }
}

