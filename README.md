# Casino & Game Provider Integration

Bidirectional API integration between an online Casino Platform and an external Game Provider (Jaqpot Games). Both systems coexist in a single codebase with logical separation: namespaced endpoints (`/casino/*`, `/provider/*`) and prefixed database tables (`casino_*`, `provider_*`).

The Casino is the **sole source of truth** for wallet balances. The Provider never reads or writes balances directly — all balance mutations happen exclusively through signed Casino callback APIs (`/casino/debit`, `/casino/credit`, `/casino/rollback`). Every money-moving operation is **atomic** (Prisma interactive transactions) and **strictly idempotent** (unique `external_transaction_id` per request with cached responses).

## Tech Stack

- **Runtime:** Node.js v20.12+ (required by Prisma 7)
- **Language:** TypeScript
- **Framework:** Express.js
- **Database:** PostgreSQL
- **ORM:** Prisma 7
- **Package Manager:** pnpm

## Setup

### Option A: Docker

```bash
# 1. Build and start PostgreSQL + app
docker compose up --build

# 2. Seed demo data (in a separate terminal)
docker compose exec app pnpm seed

# 3. Run simulation
docker compose exec app pnpm simulate

# 4. Dump database state
docker compose exec app pnpm db:dump

# Stop and remove containers
docker compose down

# Stop and remove containers + delete database volume
docker compose down -v
```

### Option B: Local

Prerequisites:
- PostgreSQL running locally
- Configure the connection string in `.env` with format: `postgresql://<user>:<password>@<host>:<port>/<database>?schema=public`

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env

# 3. Generate Prisma client
pnpm prisma:generate

# 4. Run database migrations
pnpm prisma:migrate

# 5. Seed demo data (2 users, 2 games, provider config)
pnpm seed

# 6. Start the server
pnpm dev

# 7. Run simulation (in a separate terminal)
pnpm simulate

# 8. Dump database state
pnpm db:dump
```

## Environment Variables

| Variable             | Description                                                        |
|----------------------|--------------------------------------------------------------------|
| `DATABASE_URL`       | PostgreSQL connection string                                       |
| `PORT`               | Server port (default: `3000`)                                      |
| `CASINO_SECRET`      | HMAC secret for casino callbacks                                   |
| `PROVIDER_SECRET`    | HMAC secret for provider endpoints                                 |
| `CASINO_BASE_URL`    | Base URL of the Casino API (used by seed to configure Provider)    |
| `PROVIDER_BASE_URL`  | Base URL of the Provider API (used by seed to configure Casino)    |

## Run a Full Simulation

With the server running:

```bash
pnpm simulate
```

Or with curl:

```bash
curl -X POST http://localhost:3000/casino/simulateRound \
  -H "Content-Type: application/json" \
  -d '{"userId": 1, "gameId": 1}'
```

### Expected Simulation Output

Starting balance: `1,000,000` cents ($10,000.00)

| Step | Action | Amount | Balance After | Validates |
|------|--------|--------|---------------|-----------|
| 1 | Balance check | -- | 1,000,000 | Read-only query |
| 2 | Bet 1 (debit) | -1,000 | 999,000 | Atomic debit |
| 3 | Bet 2 (debit) | -1,000 | 998,000 | Atomic debit |
| 4 | Rollback bet 2 | +1,000 | 999,000 | Reversal of bet 2 |
| 5 | Payout (credit) | +2,000 | 1,001,000 | 2x bet 1 winnings |
| 6 | Final balance check | -- | 1,001,000 | Confirms integrity |
| 7 | Idempotency retry (bet 1) | 0 | 1,001,000 | Cached response, no double-charge |
| 8 | Tombstone rollback | 0 | 1,001,000 | Marker for non-existent original |
| 9 | Rejected rollback | -- | 1,001,000 | Denied: round has payout |

Final balance: `1,001,000` cents ($10,010.00) — net profit of $10.00.

## API Endpoints

### Casino APIs

| Endpoint | Description | Auth |
|----------|-------------|------|
| `POST /casino/launchGame` | Validates player/wallet, creates session, calls `/provider/launch` | None (client) |
| `POST /casino/simulateRound` | Orchestrates launch + full provider simulation | None (client) |
| `POST /casino/getBalance` | Returns authoritative player balance (read-only) | HMAC `x-casino-signature` |
| `POST /casino/debit` | Deducts funds for a bet (atomic, idempotent) | HMAC `x-casino-signature` |
| `POST /casino/credit` | Credits funds for a payout (atomic, idempotent) | HMAC `x-casino-signature` |
| `POST /casino/rollback` | Reverses a previously accepted bet (atomic, idempotent) | HMAC `x-casino-signature` |

### Provider APIs

| Endpoint | Description | Auth |
|----------|-------------|------|
| `POST /provider/launch` | Creates provider-side session and player mapping | HMAC `x-provider-signature` |
| `POST /provider/simulate` | Runs scripted demo round calling casino callbacks | HMAC `x-provider-signature` |

## Security Model (HMAC-SHA256)

Each direction of communication uses its own dedicated secret and header:

| Direction | Header | Secret |
|-----------|--------|--------|
| Provider -> Casino (`/casino/*`) | `x-casino-signature` | `CASINO_SECRET` |
| Casino -> Provider (`/provider/*`) | `x-provider-signature` | `PROVIDER_SECRET` |

The request body is serialized with `JSON.stringify()` and signed using HMAC-SHA256. Verification uses `crypto.timingSafeEqual()` for constant-time comparison, preventing timing attacks.

## Idempotency

All money-moving endpoints (`/casino/debit`, `/casino/credit`, `/casino/rollback`) enforce strict idempotency:

- Each request carries a unique `transactionId` generated by the Provider.
- Before processing, the Casino checks `casino_transactions.external_transaction_id` (UNIQUE constraint).
- If found, the original cached response (`response_cache` JSONB column) is returned immediately — no balance mutation occurs.
- If not found, the transaction is processed atomically and the response is cached.

This guarantees that provider retries (due to timeouts or network errors) never cause double-charges or double-payouts. The simulation can be safely re-run since each invocation generates new UUIDs for all transaction IDs.

## Rollback Rules

- **Only bets (debits) can be rolled back.** Attempting to rollback a credit returns HTTP 400.
- **No rollback after payout.** If the round already has a credit transaction, rollback is denied with HTTP 400.
- **Tombstone rule:** If the original bet transaction cannot be found, a rollback marker is recorded with `amount=0` and the response includes `"tombstone": true`. Balance remains unchanged. This provides auditability and prevents inconsistent retry behavior.
- **Idempotent:** Duplicate rollback requests (same `transactionId`) return the cached first response.

## Full Round Flow

### Step 0: Client triggers simulation

**`POST /casino/simulateRound`** (no auth — client-initiated)

```json
// Request
{ "userId": 1, "gameId": 1 }
```

Casino creates a game session and calls the Provider:

### Step 0a: Casino calls Provider launch

**`POST /provider/launch`** | Header: `x-provider-signature`

```json
// Request
{
  "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79",
  "casinoSessionId": 1,
  "userId": 1,
  "gameId": "SLOTS_001",
  "currency": "USD",
  "casinoCode": "JAQPOT"
}

// Response 200
{
  "providerSessionId": "4f9ac4c2-2001-440c-b025-8ca60db0e6b6",
  "gameId": "SLOTS_001",
  "currency": "USD",
  "minBet": "1000",
  "maxBet": "100000",
  "playerId": 1
}
```

Casino stores `providerSessionId` in `casino_game_sessions.providerSessionId`, then calls Provider simulate:

### Step 0b: Casino calls Provider simulate

**`POST /provider/simulate`** | Header: `x-provider-signature`

```json
// Request
{
  "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79",
  "providerSessionId": "4f9ac4c2-2001-440c-b025-8ca60db0e6b6",
  "userId": 1,
  "gameId": "SLOTS_001",
  "currency": "USD",
  "casinoCode": "JAQPOT"
}

// Response 200
{
  "roundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
  "providerSessionId": "4f9ac4c2-2001-440c-b025-8ca60db0e6b6",
  "status": "completed",
  "steps": [
    { "step": "balance_check", "data": "..." },
    { "step": "first_bet_debit", "data": "..." },
    { "step": "second_bet_debit", "data": "..." },
    { "step": "second_bet_rollback", "data": "..." },
    { "step": "payout_credit", "data": "..." },
    { "step": "final_balance_check", "data": "..." },
    { "step": "idempotency_retry_first_bet", "data": "..." },
    { "step": "tombstone_rollback", "data": "..." },
    { "step": "rollback_rejected_after_payout", "data": "..." }
  ]
}
```

Provider creates a game round (storing `providerSessionId` as `sessionId` — see [Cross-Domain Field Mappings](#cross-domain-field-mappings)) and executes the following steps:

---

### Step 1: Balance check

**`POST /casino/getBalance`** | Header: `x-casino-signature`

```json
// Request
{ "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79", "userId": 1 }

// Response 200
{ "userId": 1, "balance": "1000000", "currency": "USD" }
```

Balance: **1,000,000** (no mutation)

---

### Step 2: Bet 1 (debit)

**`POST /casino/debit`** | Header: `x-casino-signature`

```json
// Request
{
  "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79",
  "userId": 1,
  "transactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd",
  "roundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
  "amount": 1000
}

// Response 200
{
  "transactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd",
  "balance": "999000",
  "currency": "USD",
  "status": "ok"
}
```

Balance: 1,000,000 - 1,000 = **999,000**

---

### Step 3: Bet 2 (debit)

**`POST /casino/debit`** | Header: `x-casino-signature`

```json
// Request
{
  "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79",
  "userId": 1,
  "transactionId": "79c31332-1eb5-48eb-b659-246c2c45f581",
  "roundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
  "amount": 1000
}

// Response 200
{
  "transactionId": "79c31332-1eb5-48eb-b659-246c2c45f581",
  "balance": "998000",
  "currency": "USD",
  "status": "ok"
}
```

Balance: 999,000 - 1,000 = **998,000**

---

### Step 4: Rollback bet 2

**`POST /casino/rollback`** | Header: `x-casino-signature`

```json
// Request
{
  "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79",
  "userId": 1,
  "transactionId": "ca23b91b-b02d-4cac-9c6b-70b2cfd00a71",
  "roundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
  "originalTransactionId": "79c31332-1eb5-48eb-b659-246c2c45f581"
}

// Response 200
{
  "transactionId": "ca23b91b-b02d-4cac-9c6b-70b2cfd00a71",
  "balance": "999000",
  "currency": "USD",
  "status": "ok"
}
```

Balance: 998,000 + 1,000 = **999,000** (bet 2 reversed)

---

### Step 5: Payout (credit)

**`POST /casino/credit`** | Header: `x-casino-signature`

```json
// Request
{
  "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79",
  "userId": 1,
  "transactionId": "2b24a995-afec-47e5-88ef-819c922a7af9",
  "roundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
  "amount": 2000,
  "relatedTransactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd"
}

// Response 200
{
  "transactionId": "2b24a995-afec-47e5-88ef-819c922a7af9",
  "balance": "1001000",
  "currency": "USD",
  "status": "ok"
}
```

Balance: 999,000 + 2,000 = **1,001,000** (2x bet 1 winnings)

---

### Step 6: Final balance check

**`POST /casino/getBalance`** | Header: `x-casino-signature`

```json
// Request
{ "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79", "userId": 1 }

// Response 200
{ "userId": 1, "balance": "1001000", "currency": "USD" }
```

Balance confirmed: **1,001,000**

---

### Step 7: Idempotency test — retry bet 1

**`POST /casino/debit`** | Header: `x-casino-signature`

Same `transactionId` as Step 2. Casino detects the duplicate and returns the cached response without mutating the balance.

```json
// Request (identical to Step 2)
{
  "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79",
  "userId": 1,
  "transactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd",
  "roundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
  "amount": 1000
}

// Response 200 (cached from Step 2)
{
  "transactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd",
  "balance": "999000",
  "currency": "USD",
  "status": "ok"
}
```

Actual balance after retry: **1,001,000** (unchanged — idempotency verified)

---

### Step 8: Tombstone rollback

**`POST /casino/rollback`** | Header: `x-casino-signature`

Rollback references a non-existent `originalTransactionId`. Casino records a tombstone marker with `amount=0` and returns success.

```json
// Request
{
  "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79",
  "userId": 1,
  "transactionId": "30d50745-cc21-415d-9b46-2c2dd64f3784",
  "roundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
  "originalTransactionId": "non-existent-transaction-id"
}

// Response 200
{
  "transactionId": "30d50745-cc21-415d-9b46-2c2dd64f3784",
  "balance": "1001000",
  "currency": "USD",
  "status": "ok",
  "tombstone": true
}
```

Balance: **1,001,000** (unchanged — tombstone recorded for auditability)

---

### Step 9: Rollback rejected after payout

**`POST /casino/rollback`** | Header: `x-casino-signature`

Attempts to rollback bet 1, but the round already has a credit (Step 5). Casino rejects with HTTP 400.

```json
// Request
{
  "sessionToken": "44269c7c-76c5-4a98-b261-02ab16b97b79",
  "userId": 1,
  "transactionId": "d1e2f3a4-b5c6-7d8e-9f0a-1b2c3d4e5f6a",
  "roundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
  "originalTransactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd"
}

// Response 400
{ "error": "Cannot rollback: round already has a payout" }
```

Balance: **1,001,000** (unchanged — rollback denied)

## Database State After Simulation

Run `pnpm db:dump` to verify. Below is the expected state after seeding + one simulation run:

```json
{
  "casino_users": [
    {
      "id": 1,
      "username": "player1",
      "email": "player1@example.com",
      "createdAt": "2026-02-11T22:54:17.571Z"
    },
    {
      "id": 2,
      "username": "player2",
      "email": "player2@example.com",
      "createdAt": "2026-02-11T22:54:17.576Z"
    }
  ],
  "casino_wallets": [
    {
      "id": 1,
      "casinoUserId": 1,
      "currencyCode": "USD",
      "playableBalance": "1001000",
      "redeemableBalance": "500000",
      "updatedAt": "2026-02-11T23:22:36.362Z"
    },
    {
      "id": 2,
      "casinoUserId": 2,
      "currencyCode": "USD",
      "playableBalance": "500000",
      "redeemableBalance": "250000",
      "updatedAt": "2026-02-11T22:54:17.581Z"
    }
  ],
  "casino_game_providers": [
    {
      "id": 1,
      "code": "JAQPOT",
      "name": "Jaqpot Games",
      "apiEndpoint": "http://localhost:3000",
      "secretKey": "provider_secret_key_change_in_production",
      "isDisabled": false,
      "createdAt": "2026-02-11T22:54:17.583Z"
    }
  ],
  "casino_games": [
    {
      "id": 1,
      "casinoGameProviderId": 1,
      "providerGameId": "SLOTS_001",
      "isActive": true,
      "minBet": "1000",
      "maxBet": "100000",
      "createdAt": "2026-02-11T22:54:17.585Z"
    },
    {
      "id": 2,
      "casinoGameProviderId": 1,
      "providerGameId": "ROULETTE_001",
      "isActive": true,
      "minBet": "1000",
      "maxBet": "500000",
      "createdAt": "2026-02-11T22:54:17.586Z"
    }
  ],
  "casino_game_sessions": [
    {
      "id": 1,
      "token": "44269c7c-76c5-4a98-b261-02ab16b97b79",
      "casinoUserId": 1,
      "casinoWalletId": 1,
      "casinoGameId": 1,
      "providerSessionId": "4f9ac4c2-2001-440c-b025-8ca60db0e6b6",
      "isActive": true,
      "createdAt": "2026-02-11T23:21:40.199Z"
    }
  ],
  "casino_transactions": [
    {
      "id": 1,
      "casinoWalletId": 1,
      "casinoGameSessionId": 1,
      "transactionType": "debit",
      "amount": "1000",
      "externalTransactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd",
      "externalRoundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
      "relatedExternalTransactionId": null,
      "balanceAfter": "999000",
      "responseCache": {
        "status": "ok",
        "balance": "999000",
        "currency": "USD",
        "transactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd"
      },
      "createdAt": "2026-02-11T23:21:54.463Z"
    },
    {
      "id": 2,
      "casinoWalletId": 1,
      "casinoGameSessionId": 1,
      "transactionType": "debit",
      "amount": "1000",
      "externalTransactionId": "79c31332-1eb5-48eb-b659-246c2c45f581",
      "externalRoundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
      "relatedExternalTransactionId": null,
      "balanceAfter": "998000",
      "responseCache": {
        "status": "ok",
        "balance": "998000",
        "currency": "USD",
        "transactionId": "79c31332-1eb5-48eb-b659-246c2c45f581"
      },
      "createdAt": "2026-02-11T23:22:22.146Z"
    },
    {
      "id": 3,
      "casinoWalletId": 1,
      "casinoGameSessionId": 1,
      "transactionType": "rollback",
      "amount": "1000",
      "externalTransactionId": "ca23b91b-b02d-4cac-9c6b-70b2cfd00a71",
      "externalRoundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
      "relatedExternalTransactionId": "79c31332-1eb5-48eb-b659-246c2c45f581",
      "balanceAfter": "999000",
      "responseCache": {
        "status": "ok",
        "balance": "999000",
        "currency": "USD",
        "transactionId": "ca23b91b-b02d-4cac-9c6b-70b2cfd00a71"
      },
      "createdAt": "2026-02-11T23:22:33.299Z"
    },
    {
      "id": 4,
      "casinoWalletId": 1,
      "casinoGameSessionId": 1,
      "transactionType": "credit",
      "amount": "2000",
      "externalTransactionId": "2b24a995-afec-47e5-88ef-819c922a7af9",
      "externalRoundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
      "relatedExternalTransactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd",
      "balanceAfter": "1001000",
      "responseCache": {
        "status": "ok",
        "balance": "1001000",
        "currency": "USD",
        "transactionId": "2b24a995-afec-47e5-88ef-819c922a7af9"
      },
      "createdAt": "2026-02-11T23:22:36.364Z"
    },
    {
      "id": 5,
      "casinoWalletId": 1,
      "casinoGameSessionId": 1,
      "transactionType": "rollback",
      "amount": "0",
      "externalTransactionId": "30d50745-cc21-415d-9b46-2c2dd64f3784",
      "externalRoundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
      "relatedExternalTransactionId": "non-existent-transaction-id",
      "balanceAfter": "1001000",
      "responseCache": {
        "status": "ok",
        "balance": "1001000",
        "currency": "USD",
        "tombstone": true,
        "transactionId": "30d50745-cc21-415d-9b46-2c2dd64f3784"
      },
      "createdAt": "2026-02-11T23:22:42.555Z"
    }
  ],
  "provider_games": [
    {
      "id": 1,
      "gameId": "SLOTS_001",
      "isActive": true,
      "minBet": "1000",
      "maxBet": "100000",
      "createdAt": "2026-02-11T22:54:17.588Z"
    },
    {
      "id": 2,
      "gameId": "ROULETTE_001",
      "isActive": true,
      "minBet": "1000",
      "maxBet": "500000",
      "createdAt": "2026-02-11T22:54:17.589Z"
    }
  ],
  "provider_casinos": [
    {
      "id": 1,
      "casinoCode": "JAQPOT",
      "name": "Jaqpot Casino",
      "casinoApiEndpoint": "http://localhost:3000",
      "casinoSecret": "casino_secret_key_change_in_production",
      "isActive": true,
      "createdAt": "2026-02-11T22:54:17.591Z"
    }
  ],
  "provider_casino_users": [
    {
      "id": 1,
      "providerCasinoId": 1,
      "casinoUserId": 1,
      "playerKey": "JAQPOT:1",
      "createdAt": "2026-02-11T23:18:55.394Z"
    }
  ],
  "provider_game_rounds": [
    {
      "id": 1,
      "roundId": "67376984-1ce3-441a-ac4e-ab87bbfd8592",
      "sessionId": "4f9ac4c2-2001-440c-b025-8ca60db0e6b6",
      "providerCasinoId": 1,
      "providerCasinoUserId": 1,
      "providerGameId": 1,
      "casinoUserId": 1,
      "currency": "USD",
      "status": "closed",
      "totalBetAmount": "1000",
      "totalPayoutAmount": "2000",
      "createdAt": "2026-02-11T23:21:44.404Z"
    }
  ],
  "provider_bets": [
    {
      "id": 1,
      "transactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd",
      "providerGameRoundId": 1,
      "providerCasinoId": 1,
      "casinoUserId": 1,
      "betType": "debit",
      "amount": "1000",
      "casinoBalanceAfter": "999000",
      "status": "accepted",
      "responseCache": {
        "status": "ok",
        "balance": "999000",
        "currency": "USD",
        "transactionId": "ef472e6b-042a-42d0-bb5f-17f4f75dc9cd"
      },
      "createdAt": "2026-02-11T23:22:01.657Z"
    },
    {
      "id": 2,
      "transactionId": "79c31332-1eb5-48eb-b659-246c2c45f581",
      "providerGameRoundId": 1,
      "providerCasinoId": 1,
      "casinoUserId": 1,
      "betType": "debit",
      "amount": "1000",
      "casinoBalanceAfter": "998000",
      "status": "accepted",
      "responseCache": {
        "status": "ok",
        "balance": "998000",
        "currency": "USD",
        "transactionId": "79c31332-1eb5-48eb-b659-246c2c45f581"
      },
      "createdAt": "2026-02-11T23:22:30.786Z"
    },
    {
      "id": 3,
      "transactionId": "ca23b91b-b02d-4cac-9c6b-70b2cfd00a71",
      "providerGameRoundId": 1,
      "providerCasinoId": 1,
      "casinoUserId": 1,
      "betType": "rollback",
      "amount": "1000",
      "casinoBalanceAfter": "999000",
      "status": "accepted",
      "responseCache": {
        "status": "ok",
        "balance": "999000",
        "currency": "USD",
        "transactionId": "ca23b91b-b02d-4cac-9c6b-70b2cfd00a71"
      },
      "createdAt": "2026-02-11T23:22:34.312Z"
    },
    {
      "id": 4,
      "transactionId": "2b24a995-afec-47e5-88ef-819c922a7af9",
      "providerGameRoundId": 1,
      "providerCasinoId": 1,
      "casinoUserId": 1,
      "betType": "credit",
      "amount": "2000",
      "casinoBalanceAfter": "1001000",
      "status": "accepted",
      "responseCache": {
        "status": "ok",
        "balance": "1001000",
        "currency": "USD",
        "transactionId": "2b24a995-afec-47e5-88ef-819c922a7af9"
      },
      "createdAt": "2026-02-11T23:22:37.183Z"
    }
  ]
}
```

## Cross-Domain Field Mappings

Casino and Provider are logically isolated — they never read or write each other's tables. However, both sides must agree on shared identifiers to correlate sessions, rounds, transactions, users, and games across the boundary. These identifiers are exchanged exclusively through HTTP requests and stored independently on each side.

| Shared Identifier | Generated By | Direction | Why It Crosses the Boundary |
|----|----|----|----|
| Session ID | Provider (during `/provider/launch`) | Casino → Provider (via `/provider/simulate`) | Casino needs it to link its session to the provider's round. Provider uses it as `providerGameRounds.sessionId` to group bets under a session. |
| Round ID | Provider (during `/provider/simulate`) | Provider → Casino (via `/casino/debit`, `/credit`, `/rollback`) | Casino stores it as `casinoTransactions.externalRoundId` to group transactions per round and enforce rollback rules (e.g., no rollback after payout within the same round). |
| Transaction ID | Provider (per bet/payout/rollback) | Provider → Casino (via `/casino/debit`, `/credit`, `/rollback`) | Casino stores it as `casinoTransactions.externalTransactionId` (UNIQUE) to guarantee idempotency — duplicate requests return the cached response without mutating the balance. |
| User ID | Casino (during registration) | Casino → Provider (via `/provider/launch`) | Provider stores it as `casinoUserId` across multiple tables to correlate its internal records back to the casino player without direct DB access. |
| Game ID | Seeded on both sides | Casino → Provider (via `/provider/launch`) | Maps `casinoGames.providerGameId` to `providerGames.gameId` so the provider knows which game to load for the session. |
| Casino Code | Seeded on both sides | Casino → Provider (via `/provider/launch`) | Maps `casinoGameProviders.code` to `providerCasinos.casinoCode` so the provider identifies which casino is calling and retrieves the correct callback URL and secret. |

Each side names these fields from its own perspective: what the Casino calls `externalTransactionId` (because it originates outside), the Provider calls `transactionId` (because it generated it). Neither side holds a foreign key to the other's tables — the link exists only through matching values.

## Design Decisions

- **Single codebase:** As specified by the test. Both domains remain logically isolated — Casino never writes to Provider tables and vice versa. All cross-domain communication happens through HTTP.
- **PostgreSQL:** Required by the test. BigInt columns store monetary values in cents to avoid floating-point precision issues.
- **Atomic transactions:** All wallet mutations run inside Prisma interactive transactions (`$transaction`). Balance read + update + ledger insert succeed or fail as a unit, preventing partial writes.
- **Idempotency is mandatory:** In gaming and fintech systems, network failures and retries are expected. Without idempotency, a retried debit could double-charge a player. The `external_transaction_id` UNIQUE constraint combined with response caching eliminates this risk entirely.
