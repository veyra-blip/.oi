# Internal Fintech Wallet

A full-stack, multi-user **internal wallet simulation**. It is not connected to OPay, banks, card networks, payment gateways, or real money.

## Stack

- Frontend: React + Vite + TypeScript + Tailwind CSS
- Backend: Node.js + Express + TypeScript
- Database: PostgreSQL + Prisma
- Auth: JWT access token + refresh token
- Password/PIN hashing: Argon2
- Validation: Zod
- Security: Helmet, CORS, rate limiting
- Internal transaction engine with atomic transfers and idempotency
- Simulated bank directory, airtime, data, bills, savings, cards and loans
- Admin endpoints

## Requirements

- Node.js 20+
- PostgreSQL 15+

## Setup

### 1. Database

Create a PostgreSQL database, for example:

`createdb internal_wallet`

Copy:

`backend/.env.example` -> `backend/.env`

Set `DATABASE_URL`.

### 2. Backend

```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm run dev
```

Backend runs on `http://localhost:4000`.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on the Vite URL, normally `http://localhost:5173`.

## Seed accounts

User:
- phone: `08000000001`
- email: `demo@example.com`
- password: `DemoPass123!`
- PIN: `2580`

Second user:
- phone: `08000000002`
- email: `receiver@example.com`
- password: `DemoPass123!`
- PIN: `1357`

Admin:
- email: `admin@example.com`
- password: `AdminPass123!`

The seed creates simulated bank accounts for internal bank-transfer testing.

## Important security note

This project is designed as an internal simulation. It must not be represented as a real OPay application or used to process real money. It intentionally uses fake balances and simulated bank accounts.

## Core transfer invariant

For an internal transfer:

- sender is debited exactly once
- receiver is credited exactly once
- both transaction records are created
- both notifications are created
- the operation is atomic
- repeating the same idempotency key does not repeat the transfer

If any part fails, the database transaction rolls back.
