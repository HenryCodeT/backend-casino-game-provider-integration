import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { prisma } from "../db";
import { signBody } from "../lib/hmac";
import { logger } from "../utils/logger";

// ─── Helper: call a Casino callback endpoint ─────────────────────

async function callCasino(
  casino: { casinoApiEndpoint: string; casinoSecret: string },
  path: string,
  body: Record<string, unknown>
) {
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

// ─── POST /provider/launch ───────────────────────────────────────

export async function launch(req: Request, res: Response) {
  try {
    const { sessionToken, casinoSessionId, userId, gameId, currency, casinoCode } =
      req.body;

    // Find or validate the casino
    const casino = await prisma.providerCasino.findUnique({
      where: { casinoCode },
    });
    if (!casino || !casino.isActive) {
      return res.status(404).json({ error: "Casino not found or inactive" });
    }

    // Find the game
    const game = await prisma.providerGame.findUnique({
      where: { gameId },
    });
    if (!game || !game.isActive) {
      return res.status(404).json({ error: "Game not found or inactive" });
    }

    // Find or create the provider-side user mapping
    const playerKey = `${casinoCode}:${userId}`;
    let casinoUser = await prisma.providerCasinoUser.findUnique({
      where: { playerKey },
    });
    if (!casinoUser) {
      casinoUser = await prisma.providerCasinoUser.create({
        data: {
          casinoId: casino.id,
          casinoUserId: userId,
          playerKey,
        },
      });
    }

    const providerSessionId = randomUUID();

    logger.info("Provider session created", {
      providerSessionId,
      casinoSessionId,
      gameId,
    });

    return res.json({
      providerSessionId,
      gameId,
      currency,
    });
  } catch (err) {
    logger.error("provider launch error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ─── POST /provider/simulate ─────────────────────────────────────

export async function simulate(req: Request, res: Response) {
  try {
    const { sessionToken, providerSessionId, userId, gameId, currency, casinoCode } =
      req.body;

    const casino = await prisma.providerCasino.findUnique({
      where: { casinoCode },
    });
    if (!casino || !casino.isActive) {
      return res.status(404).json({ error: "Casino not found" });
    }

    const game = await prisma.providerGame.findUnique({
      where: { gameId },
    });
    if (!game) {
      return res.status(404).json({ error: "Game not found" });
    }

    const playerKey = `${casinoCode}:${userId}`;
    const casinoUser = await prisma.providerCasinoUser.findUnique({
      where: { playerKey },
    });
    if (!casinoUser) {
      return res.status(404).json({ error: "Player not found" });
    }

    const roundId = randomUUID();
    const steps: Array<{ step: string; data: unknown }> = [];

    // Create the game round
    const round = await prisma.providerGameRound.create({
      data: {
        roundId,
        sessionId: providerSessionId,
        casinoId: casino.id,
        casinoUserId: userId,
        providerCasinoUserId: casinoUser.id,
        gameId: game.id,
        currency: currency || "USD",
        status: "open",
      },
    });

    // ── Step 1: Balance check ────────────────────────────────────
    const balanceRes = await callCasino(casino, "/getBalance", {
      sessionToken,
      userId,
    });
    steps.push({ step: "balance_check", data: balanceRes.data });

    if (!balanceRes.ok) {
      return res.status(502).json({ error: "Balance check failed", details: balanceRes.data });
    }

    // ── Step 2: First bet (debit) ────────────────────────────────
    const bet1TxId = randomUUID();
    const bet1Amount = Number(game.minBet);

    const bet1Res = await callCasino(casino, "/debit", {
      sessionToken,
      userId,
      transactionId: bet1TxId,
      roundId,
      amount: bet1Amount,
    });

    await prisma.providerBet.create({
      data: {
        transactionId: bet1TxId,
        roundId: round.id,
        casinoId: casino.id,
        casinoUserId: userId,
        betType: "debit",
        amount: BigInt(bet1Amount),
        casinoBalanceAfter: bet1Res.ok ? BigInt(bet1Res.data.balance) : null,
        status: bet1Res.ok ? "accepted" : "failed",
        responseCache: bet1Res.data,
      },
    });
    steps.push({ step: "bet_1_debit", data: bet1Res.data });

    if (!bet1Res.ok) {
      return res.status(502).json({ error: "First bet failed", details: bet1Res.data });
    }

    // ── Step 3: Second bet (debit) ───────────────────────────────
    const bet2TxId = randomUUID();
    const bet2Amount = Number(game.minBet);

    const bet2Res = await callCasino(casino, "/debit", {
      sessionToken,
      userId,
      transactionId: bet2TxId,
      roundId,
      amount: bet2Amount,
    });

    await prisma.providerBet.create({
      data: {
        transactionId: bet2TxId,
        roundId: round.id,
        casinoId: casino.id,
        casinoUserId: userId,
        betType: "debit",
        amount: BigInt(bet2Amount),
        casinoBalanceAfter: bet2Res.ok ? BigInt(bet2Res.data.balance) : null,
        status: bet2Res.ok ? "accepted" : "failed",
        responseCache: bet2Res.data,
      },
    });
    steps.push({ step: "bet_2_debit", data: bet2Res.data });

    // ── Step 4: Rollback second bet ──────────────────────────────
    const rollbackTxId = randomUUID();

    const rollbackRes = await callCasino(casino, "/rollback", {
      sessionToken,
      userId,
      transactionId: rollbackTxId,
      roundId,
      originalTransactionId: bet2TxId,
    });

    await prisma.providerBet.create({
      data: {
        transactionId: rollbackTxId,
        roundId: round.id,
        casinoId: casino.id,
        casinoUserId: userId,
        betType: "rollback",
        amount: BigInt(bet2Amount),
        casinoBalanceAfter: rollbackRes.ok ? BigInt(rollbackRes.data.balance) : null,
        status: rollbackRes.ok ? "accepted" : "failed",
        responseCache: rollbackRes.data,
      },
    });
    steps.push({ step: "rollback_bet_2", data: rollbackRes.data });

    // ── Step 5: Payout (credit) ──────────────────────────────────
    const payoutTxId = randomUUID();
    const payoutAmount = bet1Amount * 2; // 2x payout

    const payoutRes = await callCasino(casino, "/credit", {
      sessionToken,
      userId,
      transactionId: payoutTxId,
      roundId,
      amount: payoutAmount,
      relatedTransactionId: bet1TxId,
    });

    await prisma.providerBet.create({
      data: {
        transactionId: payoutTxId,
        roundId: round.id,
        casinoId: casino.id,
        casinoUserId: userId,
        betType: "credit",
        amount: BigInt(payoutAmount),
        casinoBalanceAfter: payoutRes.ok ? BigInt(payoutRes.data.balance) : null,
        status: payoutRes.ok ? "accepted" : "failed",
        responseCache: payoutRes.data,
      },
    });
    steps.push({ step: "payout_credit", data: payoutRes.data });

    // ── Step 6: Final balance check ──────────────────────────────
    const finalBalanceRes = await callCasino(casino, "/getBalance", {
      sessionToken,
      userId,
    });
    steps.push({ step: "final_balance_check", data: finalBalanceRes.data });

    // Update round totals
    const totalBet = BigInt(bet1Amount); // only bet1 kept (bet2 was rolled back)
    const totalPayout = BigInt(payoutAmount);

    await prisma.providerGameRound.update({
      where: { id: round.id },
      data: {
        status: "closed",
        totalBetAmount: totalBet,
        totalPayoutAmount: totalPayout,
      },
    });

    logger.info("Simulation completed", { roundId, steps: steps.length });

    return res.json({
      roundId,
      providerSessionId,
      status: "completed",
      steps,
    });
  } catch (err) {
    logger.error("provider simulate error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
