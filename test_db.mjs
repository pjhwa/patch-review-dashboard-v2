import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
    const p = await prisma.preprocessedPatch.findMany({ select: { vendor: true }, distinct: ['vendor'] });
    console.log("Preprocessed vendors:", p);
    const r = await prisma.reviewedPatch.findMany({ select: { vendor: true }, distinct: ['vendor'] });
    console.log("Reviewed vendors:", r);
    process.exit(0);
}
run();
