const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log("--- Red Hat (redhat) DATA ---");
  const pre = await prisma.preprocessedPatch.findMany({
    where: { vendor: { in: ['redhat', 'Red Hat'] } }
  });
  console.log("Preprocessed Count:", pre.length);

  const rev = await prisma.reviewedPatch.findMany({
    where: { vendor: { in: ['redhat', 'Red Hat'] } }
  });
  console.log("Reviewed Count:", rev.length);
  
  if (rev.length > 0) {
      console.log("Reviewed Sample 1:", rev[0]);
  }

  const lowVars = await prisma.reviewedPatch.findMany({
    where: {
      vendor: { in: ['redhat', 'Red Hat'] },
      criticality: { in: ['Moderate', 'Low', 'moderate', 'low'] }
    }
  });
  console.log("Low severity reviewed count:", lowVars.length);
  if (lowVars.length > 0) {
      console.log("Low severity sample:", lowVars[0]);
      console.log("Low severity patch IDs:", lowVars.map(x => x.issueId).join(", "));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
