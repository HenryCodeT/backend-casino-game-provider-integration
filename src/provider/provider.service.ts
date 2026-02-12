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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-casino-signature": signature,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
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
    minBet: game.minBet.toString(),
    maxBet: game.maxBet.toString(),
    playerId: casinoUser.id,
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

  const gameRound = await prisma.providerGameRound.create({
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
  const balanceResponse = await callCasino(casino, "/getBalance", {
    sessionToken: input.sessionToken,
    userId: input.userId,
  });
  if (!balanceResponse.ok) {
    throw { status: 502, error: "Balance check failed", details: balanceResponse.data };
  }
  steps.push({ step: "balance_check", data: balanceResponse.data });

  // ── Step 2: First bet (debit)
  const firstBetTransactionId = randomUUID();
  const firstBetAmount = Number(game.minBet);

  const firstBetResponse = await callCasino(casino, "/debit", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: firstBetTransactionId,
    roundId,
    amount: firstBetAmount,
  });

  await prisma.providerBet.create({
    data: {
      transactionId: firstBetTransactionId,
      providerGameRoundId: gameRound.id,
      providerCasinoId: casino.id,
      casinoUserId: Number(input.userId),
      betType: "debit",
      amount: BigInt(firstBetAmount),
      casinoBalanceAfter: firstBetResponse.ok ? BigInt(firstBetResponse.data.balance) : null,
      status: firstBetResponse.ok ? "accepted" : "failed",
      responseCache: firstBetResponse.data,
    },
  });
  if (!firstBetResponse.ok) {
    throw { status: 502, error: "First bet failed", details: firstBetResponse.data };
  }
  steps.push({ step: "first_bet_debit", data: firstBetResponse.data });

  // ── Step 3: Second bet (debit)
  const secondBetTransactionId = randomUUID();
  const secondBetAmount = Number(game.minBet);

  const secondBetResponse = await callCasino(casino, "/debit", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: secondBetTransactionId,
    roundId,
    amount: secondBetAmount,
  });

  await prisma.providerBet.create({
    data: {
      transactionId: secondBetTransactionId,
      providerGameRoundId: gameRound.id,
      providerCasinoId: casino.id,
      casinoUserId: Number(input.userId),
      betType: "debit",
      amount: BigInt(secondBetAmount),
      casinoBalanceAfter: secondBetResponse.ok ? BigInt(secondBetResponse.data.balance) : null,
      status: secondBetResponse.ok ? "accepted" : "failed",
      responseCache: secondBetResponse.data,
    },
  });
  steps.push({ step: "second_bet_debit", data: secondBetResponse.data });

  // ── Step 4: Rollback second bet
  const rollbackTransactionId = randomUUID();

  const rollbackResponse = await callCasino(casino, "/rollback", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: rollbackTransactionId,
    roundId,
    originalTransactionId: secondBetTransactionId,
  });

  await prisma.providerBet.create({
    data: {
      transactionId: rollbackTransactionId,
      providerGameRoundId: gameRound.id,
      providerCasinoId: casino.id,
      casinoUserId: Number(input.userId),
      betType: "rollback",
      amount: BigInt(secondBetAmount),
      casinoBalanceAfter: rollbackResponse.ok ? BigInt(rollbackResponse.data.balance) : null,
      status: rollbackResponse.ok ? "accepted" : "failed",
      responseCache: rollbackResponse.data,
    },
  });
  steps.push({ step: "second_bet_rollback", data: rollbackResponse.data });

  // ── Step 5: Payout (credit)
  const payoutTransactionId = randomUUID();
  const payoutAmount = firstBetAmount * 2;

  const payoutResponse = await callCasino(casino, "/credit", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: payoutTransactionId,
    roundId,
    amount: payoutAmount,
    relatedTransactionId: firstBetTransactionId,
  });

  await prisma.providerBet.create({
    data: {
      transactionId: payoutTransactionId,
      providerGameRoundId: gameRound.id,
      providerCasinoId: casino.id,
      casinoUserId: Number(input.userId),
      betType: "credit",
      amount: BigInt(payoutAmount),
      casinoBalanceAfter: payoutResponse.ok ? BigInt(payoutResponse.data.balance) : null,
      status: payoutResponse.ok ? "accepted" : "failed",
      responseCache: payoutResponse.data,
    },
  });
  steps.push({ step: "payout_credit", data: payoutResponse.data });

  // ── Step 6: Final balance check
  const finalBalanceResponse = await callCasino(casino, "/getBalance", {
    sessionToken: input.sessionToken,
    userId: input.userId,
  });
  steps.push({ step: "final_balance_check", data: finalBalanceResponse.data });

  // ── Step 7: Idempotency retry — resend first bet with same transactionId
  const idempotencyRetryResponse = await callCasino(casino, "/debit", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: firstBetTransactionId,
    roundId,
    amount: firstBetAmount,
  });

  // Verify actual balance didn't change after the retry
  const postRetryBalanceResponse = await callCasino(casino, "/getBalance", {
    sessionToken: input.sessionToken,
    userId: input.userId,
  });

  steps.push({
    step: "idempotency_retry_first_bet",
    data: {
      ...idempotencyRetryResponse.data,
      cachedResponse: true,
      actualBalanceAfterRetry: postRetryBalanceResponse.data.balance,
      balanceUnchanged: postRetryBalanceResponse.data.balance === finalBalanceResponse.data.balance,
    },
  });

  // ── Step 8: Tombstone — rollback a non-existent original transaction
  const tombstoneTransactionId = randomUUID();
  const tombstoneResponse = await callCasino(casino, "/rollback", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: tombstoneTransactionId,
    roundId,
    originalTransactionId: "non-existent-transaction-id",
  });
  steps.push({
    step: "tombstone_rollback",
    data: { ...tombstoneResponse.data, balanceUnchanged: tombstoneResponse.data.balance === finalBalanceResponse.data.balance },
  });

  // ── Step 9: Rollback rejected after payout — try to rollback first bet (round already has credit)
  const rejectedRollbackTransactionId = randomUUID();
  const rejectedRollbackResponse = await callCasino(casino, "/rollback", {
    sessionToken: input.sessionToken,
    userId: input.userId,
    transactionId: rejectedRollbackTransactionId,
    roundId,
    originalTransactionId: firstBetTransactionId,
  });
  steps.push({
    step: "rollback_rejected_after_payout",
    data: { rejected: !rejectedRollbackResponse.ok, ...rejectedRollbackResponse.data },
  });

  // Update round totals
  const totalBet = BigInt(firstBetAmount);
  const totalPayout = BigInt(payoutAmount);

  await prisma.providerGameRound.update({
    where: { id: gameRound.id },
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
