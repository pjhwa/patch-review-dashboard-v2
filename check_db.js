const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const preUB = await prisma.preprocessedPatch.findMany({ where: { vendor: 'Ubuntu' } });
    const revUB = await prisma.reviewedPatch.findMany({ where: { vendor: { contains: 'Ubuntu' } } });

    console.log('Preprocessed Ubuntu Count:', preUB.length);
    console.log('Reviewed Ubuntu Count:', revUB.length);

    if (revUB.length > preUB.length) {
        console.log('--- EXTRA ITEMS IN REVIEWED PATCH ---');
        const preIds = new Set(preUB.map(p => p.issueId));
        const extra = revUB.filter(r => !preIds.has(r.issueId));
        for (const e of extra) {
            const preOrigin = await prisma.preprocessedPatch.findFirst({ where: { issueId: e.issueId } });
            console.log(`Extra issueId: ${e.issueId}, Vendor in Reviewed: ${e.vendor}, Vendor in Preprocessed: ${preOrigin ? preOrigin.vendor : 'NOT FOUND'}`);
        }
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
