const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
    const allPreprocessed = await prisma.preprocessedPatch.findMany({
        select: { issueId: true }
    });
    const preprocessedMap = new Map();
    for (const pp of allPreprocessed) {
        preprocessedMap.set(pp.issueId, pp);
    }

    const extraIds = ['USN-8049-1', 'USN-8056-1', 'USN-8068-1', 'USN-8065-1', 'USN-8062-1'];

    console.log('--- Checking Map ---');
    for (const id of extraIds) {
        console.log(`${id} in map? ${preprocessedMap.has(id)}`);
    }
}
check().catch(console.error).finally(() => prisma.$disconnect());
