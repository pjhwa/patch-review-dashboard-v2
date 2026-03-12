const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    const patches = await prisma.preprocessedPatch.findMany({ take: 5 });
    console.log(patches);
}
main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
