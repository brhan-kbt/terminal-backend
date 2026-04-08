const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const result = await prisma.tripPackage.deleteMany({
    where: { id: { in: ['pkg-50', 'pkg-100', 'pkg-200'] } },
  });
  console.log('Deleted old packages:', result.count);
}

main().catch(console.error).finally(() => prisma.$disconnect());
