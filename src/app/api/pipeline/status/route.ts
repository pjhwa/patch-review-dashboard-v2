import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export async function GET(request: Request) {
    const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
    const statusFile = path.join(linuxSkillDir, 'pipeline_status.json');
    const logFile = path.join(linuxSkillDir, 'debug_collector.log');

    let isRunning = false;
    let message = "Idle";
    let logTail = "";

    let lastCompletedAt = null;
    let failureCount = 0;

    const failuresFile = path.join(linuxSkillDir, 'batch_data', 'collection_failures.json');
    if (fs.existsSync(failuresFile)) {
        try {
            const failuresData = JSON.parse(fs.readFileSync(failuresFile, 'utf-8'));
            if (Array.isArray(failuresData)) {
                failureCount = failuresData.length;
            }
        } catch (e) { }
    }

    if (fs.existsSync(statusFile)) {
        try {
            const statusData = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
            isRunning = statusData.isRunning;
            message = statusData.message;
            if (statusData.lastCompletedAt) lastCompletedAt = statusData.lastCompletedAt;
        } catch (e) { }
    }

    if (isRunning && fs.existsSync(logFile)) {
        try {
            logTail = execSync(`tail -n 3 ${logFile}`).toString().trim();
        } catch (e) { }
    }

    return NextResponse.json({ isRunning, message, logTail, lastCompletedAt, failureCount });
}

