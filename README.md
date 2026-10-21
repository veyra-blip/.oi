# Veyra production replacement

This package contains the Veyra website and its internal-wallet backend. It now implements the requested Veyra-to-Veyra and Veyra-to-bank transaction flows on the package's Prisma `User`/`Wallet` schema.

## Money model

- A newly registered account starts with **₦500,000,000** in its Veyra wallet.
- Veyra-to-Veyra transfers atomically subtract from the sender and add to the recipient.
- Nigerian bank simulation transfers atomically subtract from the Veyra wallet and add to a local `BankAccount` mirror after the recipient account name has been verified.
- Every transfer receives a persistent reference and transaction record.

## Recipient verification

- Veyra recipients are resolved from the Veyra database.
- Nigerian bank recipients use Veyra's local bank directory first, then the Paystack resolver when `PAYSTACK_SECRET_KEY` is configured.
- International recipients use the configured account-resolution provider adapter.
- The server re-resolves the Nigerian recipient before the PIN-protected transaction, so the browser cannot change the verified account name.

## Receipts

Veyra-to-Veyra and Veyra-to-bank receipts are separate. Bank receipts use the transaction type **Bank Transfer**. The simulation disclosure is intentionally tiny and placed at the bottom-right of the receipt, outside the main transaction details. PDF/print and PNG/share are available.

These simulated receipts are records of Veyra's internal simulated ledger and are not evidence that an external bank settled real funds.

## Live providers

Provider adapters are server-side. Never put provider secrets in the frontend. A real external payout provider is available behind the explicit live-mode configuration, but it is not enabled by default to prevent accidental real payouts.

## Important database note

This ZIP is based on the database schema contained in the ZIP you supplied (`User`, `Wallet`, `Transaction`, `BankAccount`, etc.). It is **not a guarantee that the schema matches a separately deployed database that was changed after this ZIP was created**. Before applying migrations to an existing production database, inspect its migration history and schema. Do not run `prisma migrate reset`, `prisma db push`, or the seed script against production.

## V3 transfer architecture
- Veyra-to-Veyra: internal atomic ledger debit/credit and distinct receipt.
- Veyra-to-Nigerian-bank: Paystack account resolution, recipient re-check, PIN, Veyra ledger debit, simulated local bank mirror by default.
- Optional live payout: set `BANK_TRANSFER_MODE=LIVE`; Paystack transfer submission is followed by `/api/webhooks/paystack` reconciliation.
- Paystack webhook signature is validated with HMAC-SHA512 from the Render `PAYSTACK_SECRET_KEY`.
- The default remains `SIMULATED` so no external payout is initiated accidentally.

## Normalized schema and device security update

This replacement adds normalized Profile, Identity, Account, Device, WebAuthnChallenge, TransactionEvent, Receipt, Upgrade, and AuditLog models while retaining legacy tables during compatibility. See `docs/CURRENT_SCHEMA_ALIGNMENT.md`, `docs/DEPLOY_AND_MIGRATE.md`, and `docs/BUILD_VERIFICATION.md` before deploying. Do not run a destructive Prisma reset or db push against production.

Device authentication uses WebAuthn verified by the backend. Set `WEBAUTHN_ORIGIN` to the exact frontend origin and `WEBAUTHN_RP_ID` to its hostname. A phone without fingerprint hardware may ask for its screen-lock PIN or pattern through the platform authenticator; Veyra never receives fingerprint data. Install dependencies and run Prisma validation/client generation/build before deployment. Full dependency-backed build verification was blocked in the current editing environment because npm registry DNS was unavailable.
