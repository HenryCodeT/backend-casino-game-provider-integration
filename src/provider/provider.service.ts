import { randomUUID } from "crypto";
import { prisma } from "../db";
import { signBody } from "../lib/hmac";

// ─── Helper: call a Casino callback endpoint ─────────────────────

async function callCasino(
  casino: { casinoApiEndpoint: string; casinoSecret: string },
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${casino.casinoApiEndpoint}/casino${path}`;
  const signature = signBody(body, casino.casinoSecret);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-casino-signature": signature,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// ─── Launch ──────────────────────────────────────────────────────

interface LaunchInput {
  sessionToken: string;
  casinoSessionId: string;
  userId: string;
  gameId: string;
  currency: string;
  casinoCode: string;
}

export async function launchSession(input: LaunchInput) {
  const casino = await prisma.providerCasino.findUnique({
    where: { casinoCode: input.casinoCode },
  });
  if (!casino || !casino.isActive) {
    throw { status: 404, error: "Casino not found or inactive" };
  }

  const game = await prisma.providerGame.findUnique({
    where: { gameId: input.gameId },
  });
  if (!game || !game.isActive) {
    throw { status: 404, error: "Game not found or inactive" };
  }

  const playerKey = `${input.casinoCode}:${input.userId}`;
  let casinoUser = await prisma.providerCasinoUser.findUnique({
    where: { playerKey },
  });
  if (!casinoUser) {
    casinoUser = await prisma.providerCasinoUser.create({
      data: {
        providerCasinoId: casino.id,
        casinoUserId: Number(input.userId),
        playerKey,
      },
    });
  }

  const providerSessionId = randomUUID();

  console.info("Provider session created", {
    providerSessionId,
    casinoSessionId: input.casinoSessionId,
    gameId: input.gameId,
  });

  return {
    providerSessionId,
    gameId: input.gameId,
    currency: input.currency,
  };
}

// ─── Simulate ────────────────────────────────────────────────────

interface SimulateInput {
  sessionToken: string;
  providerSessionId: string;
  userId: string;
  gameId: string;
  currency: string;
  casinoCode: string;
}

export async function simulateRound(input: SimulateInput) {
  const casino = await prisma.providerCasino.findUnique({
    where: { casinoCode: input.casinoCode },
  });
  if (!casino || !casino.isActive) {
    throw { status: 404, error: "Casino not found" };
  }

  const game = await prisma.providerGame.findUnique({
    where: { gameId: input.gameId },
  });
  if (!game) {
    throw { status: 404, error: "Game not found" };
  }

  const playerKey = `${input.casinoCode}:${input.userId}`;
  
  const casinoUser = await prisma.providerCasinoUser.findUnique({
    where: { playerKey },
  });
  if (!casinoUser) {
    throw { status: 404, error: "Player not found" };
  }

  const roundId = randomUUID();
  const steps: Array<{ step: string; data: unknown }> = [];

  const round = await prisma.providerGameRound.create({
    data: {
      roundId,
      sessionId: input.providerSessionId,
      providerCasinoId: casino.id,
      casinoUserId: Number(input.userId),
      providerCasinoUserId: casinoUser.id,
      providerGameId: game.id,
      currency: input.currency || "USD",
      status: "open",
    },
  });

  // ── Step 1: Balance check
  const balanceRes = await callCasino(casino, "/getBalance", {
    sessionToken: input.sessionToken,
    userId: input.userId,
  });
  steps.push({ step: "balance_check", data: balanceRes.data });

  if (!balanceRes.ok) {
    throw { status: 502, error: "Balance check failed", details: balanceRes.data };
  }

  // ── Step 2: First bet (debit)
  const bet1TxId = randomUUID();
  const bet1Amount = Number(game.minBet);

  const bet1Res = await callCasino(casino, "/debit", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: bet1TxId,
    roundId,
    amount: bet1Amount,
  });

  await prisma.providerBet.create({
    data: {
      transactionId: bet1TxId,
      providerGameRoundId: round.id,
      providerCasinoId: casino.id,
      casinoUserId: Number(input.userId),
      betType: "debit",
      amount: BigInt(bet1Amount),
      casinoBalanceAfter: bet1Res.ok ? BigInt(bet1Res.data.balance) : null,
      status: bet1Res.ok ? "accepted" : "failed",
      responseCache: bet1Res.data,
    },
  });
  steps.push({ step: "bet_1_debit", data: bet1Res.data });

  if (!bet1Res.ok) {
    throw { status: 502, error: "First bet failed", details: bet1Res.data };
  }

  // ── Step 3: Second bet (debit)
  const bet2TxId = randomUUID();
  const bet2Amount = Number(game.minBet);

  const bet2Res = await callCasino(casino, "/debit", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: bet2TxId,
    roundId,
    amount: bet2Amount,
  });

  await prisma.providerBet.create({
    data: {
      transactionId: bet2TxId,
      providerGameRoundId: round.id,
      providerCasinoId: casino.id,
      casinoUserId: Number(input.userId),
      betType: "debit",
      amount: BigInt(bet2Amount),
      casinoBalanceAfter: bet2Res.ok ? BigInt(bet2Res.data.balance) : null,
      status: bet2Res.ok ? "accepted" : "failed",
      responseCache: bet2Res.data,
    },
  });
  steps.push({ step: "bet_2_debit", data: bet2Res.data });

  // ── Step 4: Rollback second bet
  const rollbackTxId = randomUUID();

  const rollbackRes = await callCasino(casino, "/rollback", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: rollbackTxId,
    roundId,
    originalTransactionId: bet2TxId,
  });

  await prisma.providerBet.create({
    data: {
      transactionId: rollbackTxId,
      providerGameRoundId: round.id,
      providerCasinoId: casino.id,
      casinoUserId: Number(input.userId),
      betType: "rollback",
      amount: BigInt(bet2Amount),
      casinoBalanceAfter: rollbackRes.ok ? BigInt(rollbackRes.data.balance) : null,
      status: rollbackRes.ok ? "accepted" : "failed",
      responseCache: rollbackRes.data,
    },
  });
  steps.push({ step: "rollback_bet_2", data: rollbackRes.data });

  // ── Step 5: Payout (credit)
  const payoutTxId = randomUUID();
  const payoutAmount = bet1Amount * 2;

  const payoutRes = await callCasino(casino, "/credit", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: payoutTxId,
    roundId,
    amount: payoutAmount,
    relatedTransactionId: bet1TxId,
  });

  await prisma.providerBet.create({
    data: {
      transactionId: payoutTxId,
      providerGameRoundId: round.id,
      providerCasinoId: casino.id,
      casinoUserId: Number(input.userId),
      betType: "credit",
      amount: BigInt(payoutAmount),
      casinoBalanceAfter: payoutRes.ok ? BigInt(payoutRes.data.balance) : null,
      status: payoutRes.ok ? "accepted" : "failed",
      responseCache: payoutRes.data,
    },
  });
  steps.push({ step: "payout_credit", data: payoutRes.data });

  // ── Step 6: Final balance check
  const finalBalanceRes = await callCasino(casino, "/getBalance", {
    sessionToken: input.sessionToken,
    userId: input.userId,
  });
  steps.push({ step: "final_balance_check", data: finalBalanceRes.data });

  // Update round totals
  const totalBet = BigInt(bet1Amount);
  const totalPayout = BigInt(payoutAmount);

  await prisma.providerGameRound.update({
    where: { id: round.id },
    data: {
      status: "closed",
      totalBetAmount: totalBet,
      totalPayoutAmount: totalPayout,
    },
  });

  console.info("Simulation completed", { roundId, steps: steps.length });

  return {
    roundId,
    providerSessionId: input.providerSessionId,
    status: "completed",
    steps,
  };
}
