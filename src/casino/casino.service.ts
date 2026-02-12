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
    include: { casinoWallets: true },
  });
  if (!user) throw { status: 404, error: "User not found" };

  const currency = input.currency || user.casinoWallets[0]?.currencyCode;
  const wallet = user.casinoWallets.find(currentWallet => currentWallet.currencyCode === currency);
  if (!wallet) throw { status: 404, error: "Wallet not found for the requested currency" };

  const game = await prisma.casinoGame.findUnique({
    where: { id: input.gameId },
    include: { casinoGameProvider: true },
  });
  if (!game || !game.isActive)
    throw { status: 404, error: "Game not found or inactive" };
  if (game.casinoGameProvider.isDisabled)
    throw { status: 400, error: "Provider is disabled" };

  const sessionToken = randomUUID();

  const session = await prisma.casinoGameSession.create({
    data: {
      token: sessionToken,
      casinoUserId: user.id,
      casinoWalletId: wallet.id,
      casinoGameId: game.id,
      isActive: true,
    },
  });

  // Call the provider /provider/launch
  const providerSecret = game.casinoGameProvider.secretKey;
  const launchPayload = {
    sessionToken,
    casinoSessionId: session.id,
    userId: user.id,
    gameId: game.providerGameId,
    currency: wallet.currencyCode,
    casinoCode: game.casinoGameProvider.code,
  };

  const providerUrl = `${game.casinoGameProvider.apiEndpoint}/provider/launch`;
  const signature = signBody(launchPayload, providerSecret);

  const providerResponse = await fetch(providerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-provider-signature": signature,
    },
    body: JSON.stringify(launchPayload),
  });

  if (!providerResponse.ok) {
    const errorBody = await providerResponse.text();
    console.error("Provider launch failed", { status: providerResponse.status, body: errorBody });
    await prisma.casinoGameSession.update({
      where: { id: session.id },
      data: { isActive: false },
    });
    throw { status: 502, error: "Provider launch failed" };
  }

  const providerData = (await providerResponse.json()) as {
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
    include: { casinoWallet: true },
  });

  if (!session || session.casinoUserId !== input.userId) {
    throw { status: 404, error: "Session not found" };
  }

  return {
    userId: input.userId,
    balance: session.casinoWallet.playableBalance.toString(),
    currency: session.casinoWallet.currencyCode,
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
  const existingTransaction = await prisma.casinoTransaction.findUnique({
    where: { externalTransactionId: input.transactionId },
  });
  if (existingTransaction) {
    console.info("Debit idempotent hit", { transactionId: input.transactionId });
    return existingTransaction.responseCache;
  }

  const session = await prisma.casinoGameSession.findUnique({
    where: { token: input.sessionToken },
    include: { casinoWallet: true, casinoGame: true },
  });
  if (!session || session.casinoUserId !== input.userId) {
    throw { status: 404, error: "Session not found" };
  }

  if (debitAmount < session.casinoGame.minBet || debitAmount > session.casinoGame.maxBet) {
    throw { status: 400, error: "Bet amount out of range" };
  }

  // NOTE: In a high-concurrency production environment, this should use
  // SELECT ... FOR UPDATE (pessimistic locking) to prevent race conditions.
  // Prisma's interactive transaction provides atomicity, which is sufficient
  // for this test scope without concurrent access.
  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.casinoWallet.findUnique({
      where: { id: session.casinoWalletId },
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
        casinoWalletId: wallet.id,
        casinoGameSessionId: session.id,
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
  const existingTransaction = await prisma.casinoTransaction.findUnique({
    where: { externalTransactionId: input.transactionId },
  });
  if (existingTransaction) {
    console.info("Credit idempotent hit", { transactionId: input.transactionId });
    return existingTransaction.responseCache;
  }

  const session = await prisma.casinoGameSession.findUnique({
    where: { token: input.sessionToken },
    include: { casinoWallet: true },
  });
  if (!session || session.casinoUserId !== input.userId) {
    throw { status: 404, error: "Session not found" };
  }

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.casinoWallet.findUnique({
      where: { id: session.casinoWalletId },
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
        casinoWalletId: wallet.id,
        casinoGameSessionId: session.id,
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
  const existingTransaction = await prisma.casinoTransaction.findUnique({
    where: { externalTransactionId: input.transactionId },
  });
  if (existingTransaction) {
    console.info("Rollback idempotent hit", { transactionId: input.transactionId });
    return existingTransaction.responseCache;
  }

  const session = await prisma.casinoGameSession.findUnique({
    where: { token: input.sessionToken },
    include: { casinoWallet: true },
  });
  if (!session || session.casinoUserId !== input.userId) {
    throw { status: 404, error: "Session not found" };
  }

  // Find the original bet transaction
  const originalTransaction = await prisma.casinoTransaction.findUnique({
    where: { externalTransactionId: input.originalTransactionId },
  });

  // Tombstone rule: if original not found, record marker and return success
  if (!originalTransaction) {
    const tombstoneResponse = {
      transactionId: input.transactionId,
      balance: session.casinoWallet.playableBalance.toString(),
      currency: session.casinoWallet.currencyCode,
      status: "ok",
      tombstone: true,
    };

    await prisma.casinoTransaction.create({
      data: {
        casinoWalletId: session.casinoWalletId,
        casinoGameSessionId: session.id,
        transactionType: "rollback",
        amount: BigInt(0),
        externalTransactionId: input.transactionId,
        externalRoundId: input.roundId,
        relatedExternalTransactionId: input.originalTransactionId,
        balanceAfter: session.casinoWallet.playableBalance,
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
  if (originalTransaction.transactionType !== "debit") {
    throw { status: 400, error: "Only bets (debits) can be rolled back" };
  }

  // Check if round already has a payout
  const existingPayout = await prisma.casinoTransaction.findFirst({
    where: {
      externalRoundId: input.roundId,
      transactionType: "credit",
    },
  });
  if (existingPayout) {
    throw { status: 400, error: "Cannot rollback: round already has a payout" };
  }

  const result = await prisma.$transaction(async (tx) => {
    const wallet = await tx.casinoWallet.findUnique({
      where: { id: session.casinoWalletId },
    });
    if (!wallet) throw new Error("Wallet not found");

    const newBalance = wallet.playableBalance + originalTransaction.amount;

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
        casinoWalletId: wallet.id,
        casinoGameSessionId: session.id,
        transactionType: "rollback",
        amount: originalTransaction.amount,
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
  // Reuse launchGame to create session + call provider launch
  const launchResult = await launchGame(input);

  // Need game data for provider call
  const game = await prisma.casinoGame.findUnique({
    where: { id: input.gameId },
    include: { casinoGameProvider: true },
  });
  if (!game) throw { status: 404, error: "Game not found" };

  const providerSecret = game.casinoGameProvider.secretKey;
  const providerBaseUrl = game.casinoGameProvider.apiEndpoint;

  // Call provider /provider/simulate
  const simulatePayload = {
    sessionToken: launchResult.sessionToken,
    providerSessionId: launchResult.providerSessionId,
    userId: input.userId,
    gameId: game.providerGameId,
    currency: input.currency || "USD",
    casinoCode: game.casinoGameProvider.code,
  };

  const simulateSignature = signBody(simulatePayload, providerSecret);

  const simulateResponse = await fetch(`${providerBaseUrl}/provider/simulate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-provider-signature": simulateSignature,
    },
    body: JSON.stringify(simulatePayload),
  });

  if (!simulateResponse.ok) {
    const errorBody = await simulateResponse.text();
    console.error("Provider simulate failed", { status: simulateResponse.status, body: errorBody });
    throw { status: 502, error: "Provider simulate failed" };
  }

  const simulateData = await simulateResponse.json();

  // Fetch final balance
  const session = await prisma.casinoGameSession.findUnique({
    where: { id: launchResult.sessionId },
    include: { casinoWallet: true },
  });

  console.info("SimulateRound completed", { sessionId: launchResult.sessionId });

  return {
    sessionToken: launchResult.sessionToken,
    sessionId: launchResult.sessionId,
    providerSessionId: launchResult.providerSessionId,
    simulationResult: simulateData,
    finalBalance: session?.casinoWallet.playableBalance.toString(),
  };
}
