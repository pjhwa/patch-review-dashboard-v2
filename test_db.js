const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({ log: ['query'] });
async function main() {
    const p = await prisma.reviewedPatch.findFirst({ where: { vendor: { contains: 'Ubuntu' } } });
    console.log(JSON.stringify(p, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
