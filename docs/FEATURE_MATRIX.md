# Veyra replacement feature matrix

Status below describes code present in this replacement package. Provider-dependent features remain disabled until the relevant production credentials, database migration, and provider tests are complete.

| Requirement | Current replacement status | Important boundary |
|---|---|---|
| Normalized Prisma models | Added | `Profile`, `Identity`, `Account`, `Device`, `WebAuthnChallenge`, `TransactionEvent`, `Receipt`, `Notification`, `Upgrade`, `AuditLog`, plus retained `User`, `Session`, and legacy models. |
| New-account balance | Implemented in code | Registration creates a ₦500,000,000 legacy wallet and normalized account balance of 50,000,000,000 kobo in one database transaction. |
| Existing accounts | Additive backfill included | Migration copies existing Wallet balances into Account; it has not been run against production. |
| Unique account numbers | Cryptographic generation + database uniqueness | Registration checks both User and Account tables; database unique constraints prevent duplicate persisted numbers. |
| Veyra-to-Veyra transfer | Implemented in code | PIN, idempotency, serializable DB transaction, debit/credit, transaction entries, notifications, receipt snapshots, transaction event and audit log. |
| Receipt lookup | Implemented in code | Authenticated lookup by receipt reference or transaction reference. Existing transaction receipt endpoint remains available. |
| Bank account-name resolution | Implemented in code | Uses Paystack resolution when configured; otherwise only known local simulation-directory accounts can resolve. |
| Veyra-to-bank simulated transfer | Implemented in code | Debits Veyra ledger and credits the local bank mirror only in simulation mode; creates bank receipt and event. This does not move external money. |
| Paystack live payout | Guarded/provider-dependent | Requires `BANK_TRANSFER_MODE=LIVE`, server-side Paystack secret, valid provider funding/permissions, and reconciliation. Not tested with live funds. |
| Paystack webhook | Signature + event-key dedupe in code | Validates HMAC-SHA512 signature, records unique event keys, handles success/failure/reversal and refunds once under the transaction lock. Must be integration-tested against real Paystack event payloads. |
| Screen fingerprint / no-fingerprint fallback | Server-verified WebAuthn flow added | Device platform authenticator may use fingerprint or phone screen-lock PIN/pattern. Challenges expire and are single-use; credentials/public keys and counters are server-stored. No fingerprint data is sent to Veyra. Requires WebAuthn dependency installation and correct origin/RP configuration. |
| Profile | Implemented in code | User and normalized Profile persist updates; legal name edits are blocked after verified identity. |
| NIN and face verification | Fail-closed provider adapters | No claim of verified status without provider confirmation; NIN requires provider-confirmed name match. Full NIN and face template are not stored by Veyra. |
| Account recovery | Provider-dependent | Recovery requires a configured challenge provider and invalidates existing sessions after successful confirmation. |
| Upgrade levels | Separate screens added | Basic, Verified, and Premium detail views have distinct visual treatment; entitlement changes still require backend approval. |
| Premium support/reporting | Backend report endpoint added | Premium-only reports are stored as pending audit records; this is a basic internal queue, not a full support-ticket system. |
| PDF/print and PNG/share receipts | Present in frontend | Uses browser print/save-to-PDF and image/share APIs when supported by the device. |
| Owner rule | One-time bootstrap + DB index | `OWNER_SETUP_KEY` required, only one OWNER allowed by partial unique index; remove setup key after use. |
| Full build verification | **Not completed in this environment** | npm registry was unreachable (`EAI_AGAIN`), so Prisma generation, dependency install, full TypeScript build, and DB migration tests could not run. See `BUILD_VERIFICATION.md`. |
