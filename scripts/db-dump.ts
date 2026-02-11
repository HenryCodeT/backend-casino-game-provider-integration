/**
 * Dumps all database tables as formatted JSON.
 * Usage: pnpm db:dump
 */

import "dotenv/config";
import { prisma } from "../src/db";

const serialize = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

async function main() {
  const [
    casinoUsers,
    casinoWallets,
    casinoGameProviders,
    casinoGames,
    casinoGameSessions,
    casinoTransactions,
    providerGames,
    providerCasinos,
    providerCasinoUsers,
    providerGameRounds,
    providerBets,
  ] = await Promise.all([
    prisma.casinoUser.findMany({ orderBy: { id: "asc" } }),
    prisma.casinoWallet.findMany({ orderBy: { id: "asc" } }),
    prisma.casinoGameProvider.findMany({ orderBy: { id: "asc" } }),
    prisma.casinoGame.findMany({ orderBy: { id: "asc" } }),
    prisma.casinoGameSession.findMany({ orderBy: { id: "asc" } }),
    prisma.casinoTransaction.findMany({ orderBy: { id: "asc" } }),
    prisma.providerGame.findMany({ orderBy: { id: "asc" } }),
    prisma.providerCasino.findMany({ orderBy: { id: "asc" } }),
    prisma.providerCasinoUser.findMany({ orderBy: { id: "asc" } }),
    prisma.providerGameRound.findMany({ orderBy: { id: "asc" } }),
    prisma.providerBet.findMany({ orderBy: { id: "asc" } }),
  ]);

  const dump = {
    casino_users: casinoUsers,
    casino_wallets: casinoWallets,
    casino_game_providers: casinoGameProviders,
    casino_games: casinoGames,
    casino_game_sessions: casinoGameSessions,
    casino_transactions: casinoTransactions,
    provider_games: providerGames,
    provider_casinos: providerCasinos,
    provider_casino_users: providerCasinoUsers,
    provider_game_rounds: providerGameRounds,
    provider_bets: providerBets,
  };

  console.log(JSON.stringify(dump, serialize, 2));
}

main()
  .catch((e) => {
    console.error("Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
