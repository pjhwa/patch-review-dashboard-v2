import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL || "file:./patch-review.db"
});

async function main() {
    const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux');
    const batchDataDir = path.join(linuxSkillDir, 'batch_data');
    const preprocessedFile = path.join(linuxSkillDir, 'patches_for_llm_review.json');
    const finalReportFile = path.join(linuxSkillDir, 'patch_review_ai_report.json');

    console.log("Seeding RawPatch from batch_data...");
    if (fs.existsSync(batchDataDir)) {
        const files = fs.readdirSync(batchDataDir).filter(f => f.endsWith('.json') && f !== 'collection_failures.json');
        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(batchDataDir, file), 'utf-8');
                const data = JSON.parse(content);
                // Ensure array
                const items = Array.isArray(data) ? data : [data];
                for (const item of items) {
                    await prisma.rawPatch.create({
                        data: {
                            vendor: item.vendor || 'Unknown',
                            originalId: item.id || item.name || file,
                            data: JSON.stringify(item),
                            preprocessed: true
                        }
                    });
                }
            } catch (e) {
                console.error(`Failed to parse ${file}`, e);
            }
        }
    }

    console.log("Seeding PreprocessedPatch...");
    if (fs.existsSync(preprocessedFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(preprocessedFile, 'utf-8'));
            for (const item of data) {
                await prisma.preprocessedPatch.create({
                    data: {
                        vendor: item.vendor || 'Unknown',
                        issueId: item.id || item.issueId || 'Unknown',
                        component: item.component || item.package || 'Unknown',
                        version: item.version || 'Unknown',
                        severity: item.severity || item.Criticality || null,
                        releaseDate: item.releaseDate || item.date || null,
                        description: item.description || null,
                        isReviewed: true
                    }
                });
            }
        } catch (e) { console.error(e); }
    }

    console.log("Seeding ReviewedPatch...");
    if (fs.existsSync(finalReportFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(finalReportFile, 'utf-8'));
            if (Array.isArray(data)) {
                for (const item of data) {
                    await prisma.reviewedPatch.create({
                        data: {
                            vendor: item.Vendor || item.vendor || 'Unknown',
                            issueId: item.IssueID || item.id || 'Unknown',
                            component: item.Component || item.component || 'Unknown',
                            version: item.Version || item.version || 'Unknown',
                            criticality: item.Criticality || item.criticality || 'Unknown',
                            description: item.Description || item.description || 'Unknown',
                            koreanDescription: item.KoreanDescription || item.description || 'Unknown',
                            decision: "Done",  // Assumed as they made it to the final JSON
                        }
                    });
                }
            }
        } catch (e) { console.error(e); }
    }

    console.log("Seeding completed.");
}

main()
    .then(async () => {
        await prisma.$disconnect()
    })
    .catch(async (e) => {
        console.error(e)
        await prisma.$disconnect()
        process.exit(1)
    })
