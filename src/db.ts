import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  pool: Pool | undefined
};

export const prisma =
  globalForPrisma.prisma ??
  (() => {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });

    const adapter = new PrismaPg(pool);

    globalForPrisma.pool = pool;

    return new PrismaClient({
      adapter,
      log: ['error'],
    });
  })();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function shutdownPrisma() {
  await prisma.$disconnect();
  await globalForPrisma.pool?.end();
}
