import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
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

            let openclawArgs = ['run'];
            let outputReportFilename = 'patch_review_ai_report.json';

            if (job.name === 'manual-review') {
                const inputPath = path.join(linuxV2Dir, `manual_review_input_${job.id}.json`);
                fs.writeFileSync(inputPath, JSON.stringify(job.data.patches, null, 2));
                openclawArgs = [
                    'ask',
                    `Read ${inputPath} and evaluate these patches exactly according to the strict LLM evaluation rules detailed in SKILL.md section 4. Do NOT perform any web scraping, do NOT run batch_collector.js or patch_preprocessing.py. Save your final review array directly to manual_ai_report_${job.id}.json. Ensure it is strict generic JSON without markdown fences.`
                ];
                outputReportFilename = `manual_ai_report_${job.id}.json`;
            } else if (job.data?.isAiOnly) {
                openclawArgs = [
                    'ask',
                    `Read existing patches_for_llm_review.json and perform ONLY the AI evaluation step according to SKILL.md. Do NOT scrape or run batch scripts. Output to ${outputReportFilename}.`
                ];
            } else if (job.data?.isRetry) {
                openclawArgs = [
                    'ask',
                    `Run node batch_collector.js --retry-failures and then python patch_preprocessing.py. After that, perform normal LLM review on the results and output to ${outputReportFilename}.`
                ];
            }

            const cmd = spawn('openclaw', openclawArgs, {
                cwd: linuxV2Dir,
                shell: true,
            });

            cmd.stdout.on('data', async (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    if (line.trim()) {
                        console.log(`[JOB ${job.id}] ${line}`);

                        // Heuristic progress tracking based on stdout logs
                        if (line.includes('Fetching HTML for RHEL 8')) {
                            await job.updateProgress(10);
                            await job.log("Collecting Red Hat Advisories...");
                        } else if (line.includes('Fetching CSAF for Red Hat')) {
                            await job.updateProgress(20);
                            await job.log("Fetching CSAF for Red Hat...");
                        } else if (line.includes('Fetching Ubuntu RSS')) {
                            await job.updateProgress(30);
                            await job.log("Collecting Ubuntu Advisories...");
                        } else if (line.includes('Final Candidates for LLM:')) {
                            await job.updateProgress(50);
                            await job.log("Pre-processing & Pruning Complete. Handing off to AI...");
                        } else if (line.includes('[LLM-REVIEW] Starting Batch Evaluation')) {
                            await job.updateProgress(60);
                            await job.log("AI Review in progress...");
                        } else if (line.includes('[LLM-REVIEW] Saved CSV')) {
                            await job.updateProgress(80);
                            await job.log("AI Analysis recorded. Generating final reports...");
                        } else if (line.includes('pipeline sequence completed')) {
                            await job.updateProgress(100);
                            await job.log("Pipeline successfully finished!");
                        } else {
                            // Default heartbeat log
                            await job.log(line);
                        }
                    }
                }
            });

            cmd.stderr.on('data', async (data) => {
                const msg = data.toString();
                console.error(`[JOB ${job.id} ERR] ${msg}`);
                await job.log(`ERROR: ${msg}`);
            });

            cmd.on('close', async (code) => {
                if (code === 0) {
                    console.log(`Job ${job.id} finished successfully. Ingesting AI results to SQLite DB...`);
                    await job.log("OpenClaw process exited successfully. Finalizing AI reports into the Database...");

                    try {
                        const reportPath = path.join(linuxV2Dir, outputReportFilename);
                        if (fs.existsSync(reportPath)) {
                            const rawData = fs.readFileSync(reportPath, 'utf-8');
                            // Extract JSON array using regex in case LLM added markdown fences
                            const match = rawData.match(/\[[\s\S]*\]/);
                            if (match) {
                                const data = JSON.parse(match[0]);
                                if (Array.isArray(data)) {
                                    for (const item of data) {
                                        await prisma.reviewedPatch.create({
                                            data: {
                                                vendor: item.Vendor || item.vendor || 'Unknown',
                                                issueId: item.IssueID || item.id || 'Unknown',
                                                osVersion: item.OsVersion || item.osVersion || null,
                                                component: item.Component || item.component || 'Unknown',
                                                version: item.Version || item.version || 'Unknown',
                                                criticality: item.Criticality || item.criticality || 'Unknown',
                                                description: item.Description || item.description || 'Unknown',
                                                koreanDescription: item.KoreanDescription || item.koreanDescription || item.description || 'Unknown',
                                                decision: item.Decision || item.decision || "Done",
                                                reason: item.Reason || item.reason || null,
                                                pipelineRunId: String(job.id)
                                            }
                                        });
                                    }
                                    await job.log(`Ingested ${data.length} AI-reviewed patches into SQLite.`);
                                }
                            } else {
                                await job.log(`Warning: Failed to parse JSON array from ${reportPath}.`);
                            }
                        } else {
                            await job.log(`Warning: ${reportPath} was not found. Emitted no final database records.`);
                        }
                    } catch (dbError: any) {
                        await job.log(`ERROR: Failed to save AI report to Database: ${dbError.message}`);
                        return reject(new Error("Database ingestion failed."));
                    }

                    resolve("Success");
                } else {
                    reject(new Error(`OpenClaw pipeline exited with code ${code}`));
                }
            });
        });
    }, { connection });

    console.log("BullMQ Worker for 'patch-pipeline' initialized.");
}

const globalForQueue = global as unknown as { workerStarted: boolean };
if (!globalForQueue.workerStarted) {
    globalForQueue.workerStarted = true;
    startWorker();
}
