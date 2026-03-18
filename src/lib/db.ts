import { PrismaClient } from '@prisma/client';

// Next.js 개발 모드에서는 HMR(Hot Module Replacement)로 인해 모듈이 반복 로드되므로,
// global 객체에 Prisma 인스턴스를 캐싱해서 불필요한 DB 커넥션 생성을 방지한다.
const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
    globalForPrisma.prisma ||
    new PrismaClient({
        log: ['query'],
    });

// SQLite 기본 journal 모드(DELETE)는 단일 writer만 허용한다.
// WAL(Write-Ahead Log) 모드로 전환하면 다수의 reader와 1개의 writer가 동시에 동작할 수 있어
// 파이프라인 실행 중 대시보드에서도 DB를 조회할 수 있다.
if (process.env.DB_TYPE === 'sqlite' || !process.env.DB_TYPE) {
    prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;').catch((e: any) => console.error("WAL error:", e));
}

// 프로덕션이 아닌 환경에서만 global에 저장해 HMR로 인한 중복 인스턴스를 방지한다.
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
