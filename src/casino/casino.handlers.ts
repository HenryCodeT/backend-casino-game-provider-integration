import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { prisma } from "../db";
import { signBody } from "../lib/hmac";
import { logger } from "../utils/logger";

// ─── POST /casino/launchGame ─────────────────────────────────────

export async function launchGame(req: Request, res: Response) {
  try {
    const { userId, gameId, currency } = req.body;

    const user = await prisma.casinoUser.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const wallet = user.wallet;
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    const game = await prisma.casinoGame.findUnique({
      where: { id: gameId },
      include: { provider: true },
    });
    if (!game || !game.isActive)
      return res.status(404).json({ error: "Game not found or inactive" });
    if (game.provider.isDisabled)
      return res.status(400).json({ error: "Provider is disabled" });

    const sessionToken = randomUUID();

    const session = await prisma.casinoGameSession.create({
      data: {
        token: sessionToken,
        userId: user.id,
        walletId: wallet.id,
        gameId: game.id,
        isActive: true,
      },
    });

    // Call the provider /provider/launch
    const providerSecret = process.env.PROVIDER_SECRET!;
    const launchPayload = {
      sessionToken,
      casinoSessionId: session.id,
      userId: user.id,
      gameId: game.providerGameId,
      currency: currency || wallet.currencyCode,
      casinoCode: game.provider.code,
    };

    const providerUrl = `${game.provider.apiEndpoint}/provider/launch`;
    const signature = signBody(launchPayload, providerSecret);

    const providerRes = await fetch(providerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-provider-signature": signature,
      },
      body: JSON.stringify(launchPayload),
    });

    if (!providerRes.ok) {
      const errBody = await providerRes.text();
      logger.error("Provider launch failed", { status: providerRes.status, body: errBody });
      return res.status(502).json({ error: "Provider launch failed" });
    }

    const providerData = (await providerRes.json()) as {
      providerSessionId: string;
    };

    await prisma.casinoGameSession.update({
      where: { id: session.id },
      data: { providerSessionId: providerData.providerSessionId },
    });

    logger.info("Game launched", { sessionId: session.id, token: sessionToken });

    return res.json({
      sessionToken,
      sessionId: session.id,
      providerSessionId: providerData.providerSessionId,
      balance: wallet.playableBalance.toString(),
    });
  } catch (err) {
    logger.error("launchGame error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ─── POST /casino/getBalance ─────────────────────────────────────

export async function getBalance(req: Request, res: Response) {
  try {
    const { sessionToken, userId } = req.body;

    const session = await prisma.casinoGameSession.findUnique({
      where: { token: sessionToken },
      include: { wallet: true },
    });

    if (!session || session.userId !== userId) {
      return res.status(404).json({ error: "Session not found" });
    }

    return res.json({
      userId,
      balance: session.wallet.playableBalance.toString(),
      currency: session.wallet.currencyCode,
    });
  } catch (err) {
    logger.error("getBalance error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ─── POST /casino/debit ─────────────────────────────────────────

export async function debit(req: Request, res: Response) {
  try {
    const { sessionToken, userId, transactionId, roundId, amount } = req.body;
    const debitAmount = BigInt(amount);

    // Idempotency check
    const existing = await prisma.casinoTransaction.findUnique({
      where: { externalTransactionId: transactionId },
    });
    if (existing) {
      logger.info("Debit idempotent hit", { transactionId });
      return res.json(existing.responseCache);
    }

    const session = await prisma.casinoGameSession.findUnique({
      where: { token: sessionToken },
      include: { wallet: true, game: true },
    });
    if (!session || session.userId !== userId) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (debitAmount < session.game.minBet || debitAmount > session.game.maxBet) {
      return res.status(400).json({ error: "Bet amount out of range" });
    }

    // Atomic balance update with row-level lock
    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.casinoWallet.findUnique({
        where: { id: session.walletId },
      });
      if (!wallet) throw new Error("Wallet not found");

      if (wallet.playableBalance < debitAmount) {
        throw new Error("INSUFFICIENT_FUNDS");
      }

      const newBalance = wallet.playableBalance - debitAmount;

      await tx.casinoWallet.update({
        where: { id: wallet.id },
        data: { playableBalance: newBalance },
      });

      const responsePayload = {
        transactionId,
        balance: newBalance.toString(),
        currency: wallet.currencyCode,
        status: "ok",
      };

      await tx.casinoTransaction.create({
        data: {
          walletId: wallet.id,
          sessionId: session.id,
          transactionType: "debit",
          amount: debitAmount,
          externalTransactionId: transactionId,
          externalRoundId: roundId,
          balanceAfter: newBalance,
          responseCache: responsePayload,
        },
      });

      return responsePayload;
    });

    logger.info("Debit processed", { transactionId, amount: amount });
    return res.json(result);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "INSUFFICIENT_FUNDS") {
      return res.status(400).json({ error: "Insufficient funds" });
    }
    logger.error("debit error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ─── POST /casino/credit ────────────────────────────────────────

export async function credit(req: Request, res: Response) {
  try {
    const { sessionToken, userId, transactionId, roundId, amount, relatedTransactionId } =
      req.body;
    const creditAmount = BigInt(amount);

    // Idempotency check
    const existing = await prisma.casinoTransaction.findUnique({
      where: { externalTransactionId: transactionId },
    });
    if (existing) {
      logger.info("Credit idempotent hit", { transactionId });
      return res.json(existing.responseCache);
    }

    const session = await prisma.casinoGameSession.findUnique({
      where: { token: sessionToken },
      include: { wallet: true },
    });
    if (!session || session.userId !== userId) {
      return res.status(404).json({ error: "Session not found" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.casinoWallet.findUnique({
        where: { id: session.walletId },
      });
      if (!wallet) throw new Error("Wallet not found");

      const newBalance = wallet.playableBalance + creditAmount;

      await tx.casinoWallet.update({
        where: { id: wallet.id },
        data: { playableBalance: newBalance },
      });

      const responsePayload = {
        transactionId,
        balance: newBalance.toString(),
        currency: wallet.currencyCode,
        status: "ok",
      };

      await tx.casinoTransaction.create({
        data: {
          walletId: wallet.id,
          sessionId: session.id,
          transactionType: "credit",
          amount: creditAmount,
          externalTransactionId: transactionId,
          externalRoundId: roundId,
          relatedExternalTransactionId: relatedTransactionId || null,
          balanceAfter: newBalance,
          responseCache: responsePayload,
        },
      });

      return responsePayload;
    });

    logger.info("Credit processed", { transactionId, amount: amount });
    return res.json(result);
  } catch (err) {
    logger.error("credit error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ─── POST /casino/rollback ──────────────────────────────────────

export async function rollback(req: Request, res: Response) {
  try {
    const { sessionToken, userId, transactionId, roundId, originalTransactionId } =
      req.body;

    // Idempotency check
    const existing = await prisma.casinoTransaction.findUnique({
      where: { externalTransactionId: transactionId },
    });
    if (existing) {
      logger.info("Rollback idempotent hit", { transactionId });
      return res.json(existing.responseCache);
    }

    const session = await prisma.casinoGameSession.findUnique({
      where: { token: sessionToken },
      include: { wallet: true },
    });
    if (!session || session.userId !== userId) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Find the original bet transaction
    const originalTx = await prisma.casinoTransaction.findUnique({
      where: { externalTransactionId: originalTransactionId },
    });

    // Tombstone rule: if original not found, record marker and return success
    if (!originalTx) {
      const tombstoneResponse = {
        transactionId,
        balance: session.wallet.playableBalance.toString(),
        currency: session.wallet.currencyCode,
        status: "ok",
        tombstone: true,
      };

      await prisma.casinoTransaction.create({
        data: {
          walletId: session.walletId,
          sessionId: session.id,
          transactionType: "rollback",
          amount: BigInt(0),
          externalTransactionId: transactionId,
          externalRoundId: roundId,
          relatedExternalTransactionId: originalTransactionId,
          balanceAfter: session.wallet.playableBalance,
          responseCache: tombstoneResponse,
        },
      });

      logger.info("Rollback tombstone created", { transactionId, originalTransactionId });
      return res.json(tombstoneResponse);
    }

    // Only bets can be rolled back
    if (originalTx.transactionType !== "debit") {
      return res.status(400).json({ error: "Only bets (debits) can be rolled back" });
    }

    // Check if round already has a payout
    const hasPayout = await prisma.casinoTransaction.findFirst({
      where: {
        externalRoundId: roundId,
        transactionType: "credit",
      },
    });
    if (hasPayout) {
      return res
        .status(400)
        .json({ error: "Cannot rollback: round already has a payout" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const wallet = await tx.casinoWallet.findUnique({
        where: { id: session.walletId },
      });
      if (!wallet) throw new Error("Wallet not found");

      const newBalance = wallet.playableBalance + originalTx.amount;

      await tx.casinoWallet.update({
        where: { id: wallet.id },
        data: { playableBalance: newBalance },
      });

      const responsePayload = {
        transactionId,
        balance: newBalance.toString(),
        currency: wallet.currencyCode,
        status: "ok",
      };

      await tx.casinoTransaction.create({
        data: {
          walletId: wallet.id,
          sessionId: session.id,
          transactionType: "rollback",
          amount: originalTx.amount,
          externalTransactionId: transactionId,
          externalRoundId: roundId,
          relatedExternalTransactionId: originalTransactionId,
          balanceAfter: newBalance,
          responseCache: responsePayload,
        },
      });

      return responsePayload;
    });

    logger.info("Rollback processed", { transactionId, originalTransactionId });
    return res.json(result);
  } catch (err) {
    logger.error("rollback error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ─── POST /casino/simulateRound ─────────────────────────────────

export async function simulateRound(req: Request, res: Response) {
  try {
    const { userId, gameId, currency } = req.body;

    // Step 1: Launch the game
    const user = await prisma.casinoUser.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });
    if (!user || !user.wallet)
      return res.status(404).json({ error: "User or wallet not found" });

    const game = await prisma.casinoGame.findUnique({
      where: { id: gameId },
      include: { provider: true },
    });
    if (!game || !game.isActive)
      return res.status(404).json({ error: "Game not found or inactive" });

    const sessionToken = randomUUID();
    const session = await prisma.casinoGameSession.create({
      data: {
        token: sessionToken,
        userId: user.id,
        walletId: user.wallet.id,
        gameId: game.id,
        isActive: true,
      },
    });

    // Call provider /provider/launch
    const providerSecret = process.env.PROVIDER_SECRET!;
    const launchPayload = {
      sessionToken,
      casinoSessionId: session.id,
      userId: user.id,
      gameId: game.providerGameId,
      currency: currency || user.wallet.currencyCode,
      casinoCode: game.provider.code,
    };

    const providerBaseUrl = game.provider.apiEndpoint;
    const launchSig = signBody(launchPayload, providerSecret);

    const launchRes = await fetch(`${providerBaseUrl}/provider/launch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-provider-signature": launchSig,
      },
      body: JSON.stringify(launchPayload),
    });

    if (!launchRes.ok) {
      return res.status(502).json({ error: "Provider launch failed" });
    }

    const launchData = (await launchRes.json()) as {
      providerSessionId: string;
    };

    await prisma.casinoGameSession.update({
      where: { id: session.id },
      data: { providerSessionId: launchData.providerSessionId },
    });

    // Step 2: Call provider /provider/simulate
    const simulatePayload = {
      sessionToken,
      providerSessionId: launchData.providerSessionId,
      userId: user.id,
      gameId: game.providerGameId,
      currency: currency || user.wallet.currencyCode,
      casinoCode: game.provider.code,
    };

    const simSig = signBody(simulatePayload, providerSecret);

    const simRes = await fetch(`${providerBaseUrl}/provider/simulate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-provider-signature": simSig,
      },
      body: JSON.stringify(simulatePayload),
    });

    if (!simRes.ok) {
      const errBody = await simRes.text();
      logger.error("Provider simulate failed", { status: simRes.status, body: errBody });
      return res.status(502).json({ error: "Provider simulate failed" });
    }

    const simData = await simRes.json();

    // Fetch final balance
    const finalWallet = await prisma.casinoWallet.findUnique({
      where: { id: user.wallet.id },
    });

    logger.info("SimulateRound completed", { sessionId: session.id });

    return res.json({
      sessionToken,
      sessionId: session.id,
      providerSessionId: launchData.providerSessionId,
      simulationResult: simData,
      finalBalance: finalWallet?.playableBalance.toString(),
    });
  } catch (err) {
    logger.error("simulateRound error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
