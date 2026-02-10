import { randomUUID } from "crypto";
import { prisma } from "../db";
import { signBody } from "../lib/hmac";

// ─── Launch Game ─────────────────────────────────────────────────

interface LaunchGameInput {
  userId: number;
  gameId: number;
  currency?: string;
}

export async function launchGame(input: LaunchGameInput) {
  const user = await prisma.casinoUser.findUnique({
    where: { id: input.userId },
    include: { wallet: true },
  });
  if (!user) throw { status: 404, error: "User not found" };

  const wallet = user.wallet;
  if (!wallet) throw { status: 404, error: "Wallet not found" };

  const game = await prisma.casinoGame.findUnique({
    where: { id: input.gameId },
    include: { provider: true },
  });
  if (!game || !game.isActive)
    throw { status: 404, error: "Game not found or inactive" };
  if (game.provider.isDisabled)
    throw { status: 400, error: "Provider is disabled" };

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
    currency: input.currency || wallet.currencyCode,
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
    console.error("Provider launch failed", { status: providerRes.status, body: errBody });
    throw { status: 502, error: "Provider launch failed" };
  }

  const providerData = (await providerRes.json()) as {
    providerSessionId: string;
  };

  await prisma.casinoGameSession.update({
    where: { id: session.id },
    data: { providerSessionId: providerData.providerSessionId },
  });

  console.info("Game launched", { sessionId: session.id, token: sessionToken });

  return {
    sessionToken,
    sessionId: session.id,
    providerSessionId: providerData.providerSessionId,
    balance: wallet.playableBalance.toString(),
  };
}

// ─── Get Balance ─────────────────────────────────────────────────

interface GetBalanceInput {
  sessionToken: string;
  userId: number;
}

export async function getBalance(input: GetBalanceInput) {
  const session = await prisma.casinoGameSession.findUnique({
    where: { token: input.sessionToken },
    include: { wallet: true },
  });

  if (!session || session.userId !== input.userId) {
    throw { status: 404, error: "Session not found" };
  }

  return {
    userId: input.userId,
    balance: session.wallet.playableBalance.toString(),
    currency: session.wallet.currencyCode,
  };
}

// ─── Debit ───────────────────────────────────────────────────────

interface DebitInput {
  sessionToken: string;
  userId: number;
  transactionId: string;
  roundId: string;
  amount: number;
}

export async function debit(input: DebitInput) {
  const debitAmount = BigInt(input.amount);

  // Idempotency check
  const existing = await prisma.casinoTransaction.findUnique({
    where: { externalTransactionId: input.transactionId },
  });
  if (existing) {
    console.info("Debit idempotent hit", { transactionId: input.transactionId });
    return existing.responseCache;
  }

  const session = await prisma.casinoGameSession.findUnique({
    where: { token: input.sessionToken },
    include: { wallet: true, game: true },
  });
  if (!session || session.userId !== input.userId) {
    throw { status: 404, error: "Session not found" };
  }

  if (debitAmount < session.game.minBet || debitAmount > session.game.maxBet) {
    throw { status: 400, error: "Bet amount out of range" };
  }

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
      transactionId: input.transactionId,
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
        externalTransactionId: input.transactionId,
        externalRoundId: input.roundId,
        balanceAfter: newBalance,
        responseCache: responsePayload,
      },
    });

    return responsePayload;
  });

  console.info("Debit processed", { transactionId: input.transactionId, amount: input.amount });
  return result;
}

// ─── Credit ──────────────────────────────────────────────────────

interface CreditInput {
  sessionToken: string;
  userId: number;
  transactionId: string;
  roundId: string;
  amount: number;
  relatedTransactionId?: string;
}

export async function credit(input: CreditInput) {
  const creditAmount = BigInt(input.amount);

  // Idempotency check
  const existing = await prisma.casinoTransaction.findUnique({
    where: { externalTransactionId: input.transactionId },
  });
  if (existing) {
    console.info("Credit idempotent hit", { transactionId: input.transactionId });
    return existing.responseCache;
  }

  const session = await prisma.casinoGameSession.findUnique({
    where: { token: input.sessionToken },
    include: { wallet: true },
  });
  if (!session || session.userId !== input.userId) {
    throw { status: 404, error: "Session not found" };
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
      transactionId: input.transactionId,
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
        externalTransactionId: input.transactionId,
        externalRoundId: input.roundId,
        relatedExternalTransactionId: input.relatedTransactionId || null,
        balanceAfter: newBalance,
        responseCache: responsePayload,
      },
    });

    return responsePayload;
  });

  console.info("Credit processed", { transactionId: input.transactionId, amount: input.amount });
  return result;
}

// ─── Rollback ────────────────────────────────────────────────────

interface RollbackInput {
  sessionToken: string;
  userId: number;
  transactionId: string;
  roundId: string;
  originalTransactionId: string;
}

export async function rollback(input: RollbackInput) {
  // Idempotency check
  const existing = await prisma.casinoTransaction.findUnique({
    where: { externalTransactionId: input.transactionId },
  });
  if (existing) {
    console.info("Rollback idempotent hit", { transactionId: input.transactionId });
    return existing.responseCache;
  }

  const session = await prisma.casinoGameSession.findUnique({
    where: { token: input.sessionToken },
    include: { wallet: true },
  });
  if (!session || session.userId !== input.userId) {
    throw { status: 404, error: "Session not found" };
  }

  // Find the original bet transaction
  const originalTx = await prisma.casinoTransaction.findUnique({
    where: { externalTransactionId: input.originalTransactionId },
  });

  // Tombstone rule: if original not found, record marker and return success
  if (!originalTx) {
    const tombstoneResponse = {
      transactionId: input.transactionId,
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
        externalTransactionId: input.transactionId,
        externalRoundId: input.roundId,
        relatedExternalTransactionId: input.originalTransactionId,
        balanceAfter: session.wallet.playableBalance,
        responseCache: tombstoneResponse,
      },
    });

    console.info("Rollback tombstone created", {
      transactionId: input.transactionId,
      originalTransactionId: input.originalTransactionId,
    });
    return tombstoneResponse;
  }

  // Only bets can be rolled back
  if (originalTx.transactionType !== "debit") {
    throw { status: 400, error: "Only bets (debits) can be rolled back" };
  }

  // Check if round already has a payout
  const hasPayout = await prisma.casinoTransaction.findFirst({
    where: {
      externalRoundId: input.roundId,
      transactionType: "credit",
    },
  });
  if (hasPayout) {
    throw { status: 400, error: "Cannot rollback: round already has a payout" };
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
      transactionId: input.transactionId,
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
        externalTransactionId: input.transactionId,
        externalRoundId: input.roundId,
        relatedExternalTransactionId: input.originalTransactionId,
        balanceAfter: newBalance,
        responseCache: responsePayload,
      },
    });

    return responsePayload;
  });

  console.info("Rollback processed", {
    transactionId: input.transactionId,
    originalTransactionId: input.originalTransactionId,
  });
  return result;
}

// ─── Simulate Round ──────────────────────────────────────────────

interface SimulateRoundInput {
  userId: number;
  gameId: number;
  currency?: string;
}

export async function simulateRound(input: SimulateRoundInput) {
  const user = await prisma.casinoUser.findUnique({
    where: { id: input.userId },
    include: { wallet: true },
  });
  if (!user || !user.wallet)
    throw { status: 404, error: "User or wallet not found" };

  const game = await prisma.casinoGame.findUnique({
    where: { id: input.gameId },
    include: { provider: true },
  });
  if (!game || !game.isActive)
    throw { status: 404, error: "Game not found or inactive" };

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
    currency: input.currency || user.wallet.currencyCode,
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
    throw { status: 502, error: "Provider launch failed" };
  }

  const launchData = (await launchRes.json()) as {
    providerSessionId: string;
  };

  await prisma.casinoGameSession.update({
    where: { id: session.id },
    data: { providerSessionId: launchData.providerSessionId },
  });

  // Call provider /provider/simulate
  const simulatePayload = {
    sessionToken,
    providerSessionId: launchData.providerSessionId,
    userId: user.id,
    gameId: game.providerGameId,
    currency: input.currency || user.wallet.currencyCode,
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
    console.error("Provider simulate failed", { status: simRes.status, body: errBody });
    throw { status: 502, error: "Provider simulate failed" };
  }

  const simData = await simRes.json();

  // Fetch final balance
  const finalWallet = await prisma.casinoWallet.findUnique({
    where: { id: user.wallet.id },
  });

  console.info("SimulateRound completed", { sessionId: session.id });

  return {
    sessionToken,
    sessionId: session.id,
    providerSessionId: launchData.providerSessionId,
    simulationResult: simData,
    finalBalance: finalWallet?.playableBalance.toString(),
  };
}
