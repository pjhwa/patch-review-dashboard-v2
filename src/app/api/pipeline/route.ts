import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// Mock path for tom26 patch review JSON data
// Real implementation will point to the actual script output paths
const MOCK_DATA_PATH = process.env.PATCH_DATA_DIR || '/tmp/patch_review_data';

export async function GET() {
    try {
        // In a real environment, read from fs.readFileSync(path.join(MOCK_DATA_PATH, 'pipeline.json'))
        const mockPipelineData = {
            quarter: "Q1 2026",
            stages: [
                { id: "collection", name: "Data Collection", status: "completed", count: 124 },
                { id: "preprocessing", name: "Preprocessing", status: "in_progress", count: 85 },
                { id: "ai_review", name: "AI Review Analysis", status: "pending", count: 0 },
                { id: "manager_review", name: "Manager Verification", status: "pending", count: 0 }
            ],
            lastUpdated: new Date().toISOString()
        };

        return NextResponse.json(mockPipelineData);
    } catch (error) {
        return NextResponse.json({ error: 'Failed to fetch pipeline data' }, { status: 500 });
    }
}
