# Casino & Game Provider Integration

Backend integration between an online Casino Platform and an external Game Provider (Jaqpot Games).

## Architecture

```
src/
├── app.ts                  ← Express app configuration
├── index.ts                ← Server entry point
├── db.ts                   ← Prisma client singleton
│
├── lib/
│   └── hmac.ts             ← signBody / verifySignature (shared HMAC logic)
│
├── casino/
│   ├── casino.routes.ts    ← /casino/* endpoints
│   ├── casino.handlers.ts  ← Casino business logic
│   └── casino.hmac.ts      ← Validates x-casino-signature (CASINO_SECRET)
│
├── provider/
│   ├── provider.routes.ts  ← /provider/* endpoints
│   ├── provider.handlers.ts← Provider business logic
│   └── provider.hmac.ts    ← Validates x-provider-signature (PROVIDER_SECRET)
│
├── prisma/
│   ├── schema.prisma       ← Database schema (CASINO_* and PROVIDER_* tables)
│   └── seed.ts             ← Seed data for demo
│
└── utils/
    └── logger.ts           ← Structured logger
```

## Tech Stack

- **Runtime**: Node.js v22
- **Language**: TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL
- **ORM**: Prisma 7
- **Package Manager**: pnpm

## Prerequisites

- Node.js v18+
- PostgreSQL running on `localhost:5432`
- pnpm installed (`npm install -g pnpm`)

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment variables
cp .env.example .env

# 3. Create the database and run migrations
pnpm prisma:migrate

# 4. Seed the database with demo data
pnpm seed

# 5. Generate Prisma client
pnpm prisma:generate
```

## Running

```bash
# Development (hot reload)
pnpm dev

# Production
pnpm build
pnpm start
```

## Running with Docker

```bash
# Start PostgreSQL + API
docker compose up -d

# Run migrations inside the container
docker compose exec api npx prisma migrate dev

# Seed the database
docker compose exec api npx tsx prisma/seed.ts
```

## API Endpoints

### Casino APIs

| Method | Endpoint                | Description                              | Auth           |
|--------|------------------------|------------------------------------------|----------------|
| POST   | `/casino/launchGame`    | Launch a game session                    | Client-initiated |
| POST   | `/casino/simulateRound` | Full end-to-end round simulation         | Client-initiated |
| POST   | `/casino/getBalance`    | Get player balance (provider callback)   | HMAC `x-casino-signature` |
| POST   | `/casino/debit`         | Debit funds for a bet (provider callback)| HMAC `x-casino-signature` |
| POST   | `/casino/credit`        | Credit funds for payout (provider callback)| HMAC `x-casino-signature` |
| POST   | `/casino/rollback`      | Rollback a bet (provider callback)       | HMAC `x-casino-signature` |

### Provider APIs

| Method | Endpoint              | Description                              | Auth           |
|--------|-----------------------|------------------------------------------|----------------|
| POST   | `/provider/launch`    | Initialize provider-side session         | HMAC `x-provider-signature` |
| POST   | `/provider/simulate`  | Run scripted demo round                  | HMAC `x-provider-signature` |

## Running a Full Simulation

With the server running:

```bash
pnpm simulate
```

Or manually with curl:

```bash
curl -X POST http://localhost:3000/casino/simulateRound \
  -H "Content-Type: application/json" \
  -d '{"userId": 1, "gameId": 1, "currency": "USD"}'
```

This executes a complete round: launch → balance check → 2 bets → rollback of 1 bet → payout → final balance check.

## Environment Variables

| Variable          | Description                        | Default                    |
|-------------------|------------------------------------|----------------------------|
| `DATABASE_URL`    | PostgreSQL connection string       | `postgresql://postgres:postgres@localhost:5432/casino_integration` |
| `PORT`            | Server port                        | `3000`                     |
| `CASINO_SECRET`   | HMAC secret for casino callbacks   | `casino-secret-key`        |
| `PROVIDER_SECRET` | HMAC secret for provider endpoints | `provider-secret-key`      |

## Key Design Decisions

- **Idempotency**: All money-moving endpoints (`/casino/debit`, `/casino/credit`, `/casino/rollback`) use `externalTransactionId` as idempotency key. Duplicate requests return the cached first response.
- **Atomic balance updates**: All wallet mutations happen inside Prisma `$transaction` blocks.
- **Rollback rules**: Only debits (bets) can be rolled back. Tombstone markers are created for unknown original transactions.
- **HMAC-SHA256 authentication**: Provider→Casino uses `x-casino-signature` + `CASINO_SECRET`. Casino→Provider uses `x-provider-signature` + `PROVIDER_SECRET`.
- **Logical separation**: Casino and Provider domains are fully separated in code (`/casino/*`, `/provider/*`) and database (`casino_*`, `provider_*` tables).
