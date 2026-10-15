# Veyra backend - Render deployment

This folder is the corrected backend for the Veyra shared-wallet project.

## Render settings

**Root Directory:** `backend`

**Build Command:**
```text
npm install && npx prisma generate && npm run build && npx prisma db push
```

**Start Command:**
```text
npm start
```

## Environment variables

Add these in the Render Web Service:

```text
DATABASE_URL=<PostgreSQL Internal Database URL>
JWT_SECRET=<Render-generated secret>
FRONTEND_ORIGIN=<your deployed frontend URL>
```

`PORT` does not need to be added. Render supplies it automatically.

## Health check

After deployment, open:

```text
https://YOUR-RENDER-SERVICE.onrender.com/api/health
```

It should return JSON similar to:

```json
{"success":true,"service":"internal-wallet"}
```

## Demo seed data

If you want the two seeded test accounts, run the seed command once after the database has been created:

```text
npm run seed
```

Demo sender:
- phone: `08000000001`
- email: `demo@example.com`
- password: `DemoPass123!`
- transaction PIN: `2580`
- account: `8100000001`

Demo receiver:
- phone: `08000000002`
- email: `receiver@example.com`
- password: `DemoPass123!`
- transaction PIN: `1357`
- account: `8100000002`

Admin seed:
- email: `admin@example.com`
- password: `AdminPass123!`
- transaction PIN: `8642`

These are demo credentials. Change/remove them before treating the system as production.

## Important

This backend is for Veyra's internal simulated wallet. Bank accounts and bill services are simulated unless a real provider is connected.
