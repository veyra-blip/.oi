# Veyra backend - Render deployment

This folder is the corrected backend for the Veyra shared-wallet project.

## Render settings

**Root Directory:** `backend`

**Build Command:**
```text
npm install && npx prisma generate && npx prisma migrate deploy && npm run build
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
REFRESH_SECRET=<a different Render-generated secret>
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

The security migration must run before the new backend starts. Render uses `npx prisma migrate deploy` in the build command. Do not run `prisma db push` against production.

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


## Paystack account-name resolution

The backend now exposes:

- `GET /api/paystack/banks` - fetches Paystack's Nigerian bank directory and bank codes.
- `GET /api/paystack/resolve?accountNumber=XXXXXXXXXX&bankCode=XXX` - resolves a Nigerian account number to the registered account name through Paystack.

Set `PAYSTACK_SECRET_KEY` in Render Environment Variables. Do not place the secret key in the HTML or commit it to GitHub. Paystack's Resolve Account Number endpoint requires the account number and bank code and returns the resolved account name.

The supplied `sk_test_...` key is for Paystack test mode. Paystack test and live environments are separate, so live account verification requires the live secret key when the integration is ready for production.
