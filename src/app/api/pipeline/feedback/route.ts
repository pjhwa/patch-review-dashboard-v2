import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(request: Request) {
    const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
    const feedbackFile = path.join(linuxSkillDir, 'user_exclusion_feedback.json');

    if (!fs.existsSync(feedbackFile)) {
        return NextResponse.json({ data: [] });
    }

    try {
        const rawData = fs.readFileSync(feedbackFile, 'utf-8');
        const feedback = JSON.parse(rawData);
        return NextResponse.json({ data: feedback });
    } catch (e: any) {
        return NextResponse.json({ error: `Failed to read feedback data: ${e.message}` }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { issueId, description, reason, dateExcluded } = body;

        if (!issueId || !reason) {
            return NextResponse.json({ error: 'Issue ID and Reason are required.' }, { status: 400 });
        }

        const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        const feedbackFile = path.join(linuxSkillDir, 'user_exclusion_feedback.json');

        let feedbackList = [];
        if (fs.existsSync(feedbackFile)) {
            const rawData = fs.readFileSync(feedbackFile, 'utf-8');
            try {
                feedbackList = JSON.parse(rawData);
            } catch (e) {
                feedbackList = [];
            }
        }

        // Check if already exists, update reason if so
        const existingIdx = feedbackList.findIndex((item: any) => item.issueId === issueId);
        if (existingIdx !== -1) {
            feedbackList[existingIdx].reason = reason;
            feedbackList[existingIdx].dateExcluded = dateExcluded || new Date().toISOString();
        } else {
            feedbackList.push({
                issueId,
                description: description || "No description provided",
                reason,
                dateExcluded: dateExcluded || new Date().toISOString()
            });
        }

        fs.writeFileSync(feedbackFile, JSON.stringify(feedbackList, null, 2));

        return NextResponse.json({ success: true, message: `Feedback saved for ${issueId}` });
    } catch (e: any) {
        console.error("Failed to save feedback:", e);
        return NextResponse.json({ error: e.message || 'Failed to save feedback' }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const issueId = searchParams.get('issueId');

        if (!issueId) {
            return NextResponse.json({ error: 'Issue ID is required.' }, { status: 400 });
        }

        const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        const feedbackFile = path.join(linuxSkillDir, 'user_exclusion_feedback.json');

        if (fs.existsSync(feedbackFile)) {
            const rawData = fs.readFileSync(feedbackFile, 'utf-8');
            let feedbackList = JSON.parse(rawData);

            // Filter out the feedback with the given issueId
            feedbackList = feedbackList.filter((item: any) => item.issueId !== issueId);

            fs.writeFileSync(feedbackFile, JSON.stringify(feedbackList, null, 2));
            return NextResponse.json({ success: true, message: `Feedback removed for ${issueId}` });
        }

        return NextResponse.json({ message: 'No feedback file to modify' });
    } catch (e: any) {
        console.error("Failed to delete feedback:", e);
        return NextResponse.json({ error: e.message || 'Failed to delete feedback' }, { status: 500 });
    }
}

