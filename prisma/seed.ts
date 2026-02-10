import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const CASINO_BASE_URL =
    process.env.CASINO_BASE_URL || "http://localhost:3000";
  const PROVIDER_BASE_URL =
    process.env.PROVIDER_BASE_URL || "http://localhost:3000";

  console.log("Starting database seed...");

  // ── Clear existing data (child tables first) ─────────────────────

  await prisma.providerBet.deleteMany();
  await prisma.providerGameRound.deleteMany();
  await prisma.providerCasinoUser.deleteMany();
  await prisma.providerCasino.deleteMany();
  await prisma.providerGame.deleteMany();

  await prisma.casinoTransaction.deleteMany();
  await prisma.casinoGameSession.deleteMany();
  await prisma.casinoGame.deleteMany();
  await prisma.casinoGameProvider.deleteMany();
  await prisma.casinoWallet.deleteMany();
  await prisma.casinoUser.deleteMany();

  console.log("Cleared existing data");

  // ── Casino Domain ─────────────────────────────────────────────────

  const user1 = await prisma.casinoUser.create({
    data: {
      username: "player1",
      email: "player1@example.com",
    },
  });

  const user2 = await prisma.casinoUser.create({
    data: {
      username: "player2",
      email: "player2@example.com",
    },
  });

  console.log("Created casino users");

  const wallet1 = await prisma.casinoWallet.create({
    data: {
      userId: user1.id,
      currencyCode: "USD",
      playableBalance: BigInt(1000000), // $10,000.00
      redeemableBalance: BigInt(500000), // $5,000.00
    },
  });

  const wallet2 = await prisma.casinoWallet.create({
    data: {
      userId: user2.id,
      currencyCode: "USD",
      playableBalance: BigInt(500000), // $5,000.00
      redeemableBalance: BigInt(250000), // $2,500.00
    },
  });

  console.log("Created casino wallets");

  const provider = await prisma.casinoGameProvider.create({
    data: {
      code: "JAQPOT",
      name: "Jaqpot Games",
      apiEndpoint: PROVIDER_BASE_URL,
      secretKey:
        process.env.PROVIDER_SECRET ||
        "provider_secret_key_change_in_production",
      isDisabled: false,
    },
  });

  console.log("Created game provider");

  const game1 = await prisma.casinoGame.create({
    data: {
      providerId: provider.id,
      providerGameId: "SLOTS_001",
      isActive: true,
      minBet: BigInt(10), // $0.10
      maxBet: BigInt(100000), // $1,000.00
    },
  });

  const game2 = await prisma.casinoGame.create({
    data: {
      providerId: provider.id,
      providerGameId: "ROULETTE_001",
      isActive: true,
      minBet: BigInt(50), // $0.50
      maxBet: BigInt(500000), // $5,000.00
    },
  });

  console.log("Created casino games");

  // ── Provider Domain ───────────────────────────────────────────────

  await prisma.providerGame.create({
    data: {
      gameId: "SLOTS_001",
      isActive: true,
      minBet: BigInt(10),
      maxBet: BigInt(100000),
    },
  });

  await prisma.providerGame.create({
    data: {
      gameId: "ROULETTE_001",
      isActive: true,
      minBet: BigInt(50),
      maxBet: BigInt(500000),
    },
  });

  console.log("Created provider games");

  await prisma.providerCasino.create({
    data: {
      casinoCode: "JAQPOT",
      name: "Jaqpot Casino",
      casinoApiEndpoint: CASINO_BASE_URL,
      casinoSecret:
        process.env.CASINO_SECRET ||
        "casino_secret_key_change_in_production",
      isActive: true,
    },
  });

  console.log("Created provider casino");

  // ── Summary ───────────────────────────────────────────────────────

  console.log("\nSeed completed successfully!");
  console.log("\nTest Data Summary:");
  console.log("==================");
  console.log(
    `Casino Users: ${user1.username} (ID: ${user1.id}), ${user2.username} (ID: ${user2.id})`
  );
  console.log(
    `Casino Games: ${game1.id} (${game1.providerGameId}), ${game2.id} (${game2.providerGameId})`
  );
  console.log("Initial Balances:");
  console.log(
    `  - ${user1.username}: $${Number(wallet1.playableBalance) / 100}`
  );
  console.log(
    `  - ${user2.username}: $${Number(wallet2.playableBalance) / 100}`
  );
  console.log("\nYou can now test with:");
  console.log(
    `  curl -X POST http://localhost:${process.env.PORT || 3000}/casino/simulateRound \\`
  );
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(
    `    -d '{"userId": ${user1.id}, "gameId": ${game1.id}}'`
  );
}

main()
  .catch((e) => {
    console.error("Seed error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
