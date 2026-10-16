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


## Paystack account-name resolution

The backend now exposes:

- `GET /api/paystack/banks` - fetches Paystack's Nigerian bank directory and bank codes.
- `GET /api/paystack/resolve?accountNumber=XXXXXXXXXX&bankCode=XXX` - resolves a Nigerian account number to the registered account name through Paystack.

Set `PAYSTACK_SECRET_KEY` in Render Environment Variables. Do not place the secret key in the HTML or commit it to GitHub. Paystack's Resolve Account Number endpoint requires the account number and bank code and returns the resolved account name.

The supplied `sk_test_...` key is for Paystack test mode. Paystack test and live environments are separate, so live account verification requires the live secret key when the integration is ready for production.

## Termii carrier SMS configuration

Set these Render environment variables:

- `TERMII_API_KEY` = your private Termii API key
- `TERMII_BASE_URL` = your account-specific Termii base URL, normally `https://api.ng.termii.com/api`
- `TERMII_CHANNEL` = `dnd` for transactional SMS, if enabled for your Termii account
- `TERMII_SENDER_IDS` = comma-separated Sender IDs approved for this Veyra account, for example `VEYRA,VEYRA ALERT`

The first Sender ID in `TERMII_SENDER_IDS` is the backend fallback. The HTML can request a Sender ID, but the backend will only accept one that appears in this environment variable. HTML cannot change Render environment variables.

For internal Veyra transfers, the backend sends two carrier SMS messages after a successful database transfer: one debit alert to the sender and one credit alert to the receiver. A Termii/carrier failure does not reverse the wallet transfer.

Use only Sender IDs that Termii has approved for your account. Carrier delivery cannot be guaranteed by the application alone; Termii must accept the message and the carrier must deliver it.
