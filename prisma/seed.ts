import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  // ── Casino Domain seed ──────────────────────────────────────────

  const user = await prisma.casinoUser.upsert({
    where: { id: 1 },
    update: {},
    create: {
      username: "player1",
      email: "player1@example.com",
    },
  });

  await prisma.casinoWallet.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      currencyCode: "USD",
      playableBalance: BigInt(100000), // $1000.00 in cents
      redeemableBalance: BigInt(0),
    },
  });

  const provider = await prisma.casinoGameProvider.upsert({
    where: { code: "jaqpot" },
    update: {},
    create: {
      code: "jaqpot",
      name: "Jaqpot Games",
      apiEndpoint: BASE_URL,
      secretKey: process.env.PROVIDER_SECRET || "provider_secret_key_change_in_production",
      isDisabled: false,
    },
  });

  await prisma.casinoGame.upsert({
    where: { id: 1 },
    update: {},
    create: {
      providerId: provider.id,
      providerGameId: "slots-mega-fortune",
      isActive: true,
      minBet: BigInt(100), // $1.00
      maxBet: BigInt(100000), // $1000.00
    },
  });

  // ── Provider Domain seed ────────────────────────────────────────

  await prisma.providerGame.upsert({
    where: { gameId: "slots-mega-fortune" },
    update: {},
    create: {
      gameId: "slots-mega-fortune",
      isActive: true,
      minBet: BigInt(100),
      maxBet: BigInt(100000),
    },
  });

  await prisma.providerCasino.upsert({
    where: { casinoCode: "jaqpot" },
    update: {},
    create: {
      casinoCode: "jaqpot",
      name: "Jaqpot Casino",
      casinoApiEndpoint: BASE_URL,
      casinoSecret: process.env.CASINO_SECRET || "casino_secret_key_change_in_production",
      isActive: true,
    },
  });

  console.log("Seed completed successfully");
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
