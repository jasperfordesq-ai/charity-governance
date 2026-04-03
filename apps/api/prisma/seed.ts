import { PrismaClient } from '@prisma/client';
import { GOVERNANCE_PRINCIPLES } from '@charitypilot/shared';

const prisma = new PrismaClient();

async function main() {
  // Clear existing governance data (standards first due to FK constraint)
  await prisma.governanceStandard.deleteMany();
  await prisma.governancePrinciple.deleteMany();

  let principleCount = 0;
  let standardCount = 0;
  let globalSortOrder = 1;

  for (const principle of GOVERNANCE_PRINCIPLES) {
    const created = await prisma.governancePrinciple.create({
      data: {
        number: principle.number,
        title: principle.title,
        description: principle.description,
        sortOrder: principle.number,
      },
    });
    principleCount++;

    for (const standard of principle.standards) {
      await prisma.governanceStandard.create({
        data: {
          principleId: created.id,
          code: standard.code,
          title: standard.title,
          isCore: standard.isCore,
          isAdditional: standard.isAdditional,
          sortOrder: globalSortOrder,
        },
      });
      globalSortOrder++;
      standardCount++;
    }
  }

  console.log(
    `Seeded ${principleCount} governance principles and ${standardCount} governance standards.`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
