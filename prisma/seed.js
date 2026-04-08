const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();

// Fixed UUIDs so re-running seed is idempotent
const PKG_50_ID  = '00000000-0000-0000-0000-000000000050';
const PKG_100_ID = '00000000-0000-0000-0000-000000000100';
const PKG_200_ID = '00000000-0000-0000-0000-000000000200';

async function main() {
  // Seed trip packages
  await prisma.tripPackage.upsert({
    where: { id: PKG_50_ID },
    update: { name: '50 Trips', tripCount: 50, priceEtb: 500.00, isActive: true },
    create: { id: PKG_50_ID, name: '50 Trips', tripCount: 50, priceEtb: 500.00, isActive: true },
  });
  await prisma.tripPackage.upsert({
    where: { id: PKG_100_ID },
    update: { name: '100 Trips', tripCount: 100, priceEtb: 1000.00, isActive: true },
    create: { id: PKG_100_ID, name: '100 Trips', tripCount: 100, priceEtb: 1000.00, isActive: true },
  });
  await prisma.tripPackage.upsert({
    where: { id: PKG_200_ID },
    update: { name: '200 Trips', tripCount: 200, priceEtb: 2000.00, isActive: true },
    create: { id: PKG_200_ID, name: '200 Trips', tripCount: 200, priceEtb: 2000.00, isActive: true },
  });

  // Seed default admin
  const hash = await bcrypt.hash('Admin@1234', 12);
  await prisma.admin.upsert({
    where: { phone: '+251900000000' },
    update: {},
    create: {
      fullName: 'System Admin',
      phone: '+251900000000',
      passwordHash: hash,
      role: 'MILKIWAY_ADMIN',
    },
  });

  console.log('Seed complete');
}

main().catch(console.error).finally(() => prisma.$disconnect());
