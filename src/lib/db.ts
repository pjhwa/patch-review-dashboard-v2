import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
    globalForPrisma.prisma ||
    new PrismaClient({
        log: ['query'],
    });

if (process.env.DB_TYPE === 'sqlite' || !process.env.DB_TYPE) {
    prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;').catch((e: any) => console.error("WAL error:", e));
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
