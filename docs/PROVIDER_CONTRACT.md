# Provider adapter contract

The website can deploy without any provider keys. Until configured, live provider routes return a non-success status and a clear unavailable response.

## Environment variables
- `ACCOUNT_RESOLUTION_API_URL`, `ACCOUNT_RESOLUTION_API_KEY`
- `PAYOUT_API_URL`, `PAYOUT_API_KEY`
- `BILL_PAYMENT_API_URL`, `BILL_PAYMENT_API_KEY`
- `RECOVERY_API_URL`, `RECOVERY_API_KEY`

Each base URL is server-side and must use HTTPS in production. Keys must never appear in frontend HTML, JavaScript, GitHub Pages, screenshots, or logs.

## Account resolution
`POST /api/providers/account-resolution` (Bearer access token)
```json
{
  "countryCode": "GB",
  "accountNumber": "12345678",
  "sortCode": "123456"
}
```
Backend sends the request to `${ACCOUNT_RESOLUTION_API_URL}/resolve`. Expected provider JSON: `accountName` (required), optional `bankName`, `verificationStatus`, `providerReference`. Country-specific fields are validated loosely here; implement strict validation per supported rail before launch.

## Payout
`POST /api/providers/bank-transfer` with `Idempotency-Key` header and recipient/currency/country/account/name/bank/amount/PIN. Backend calls `${PAYOUT_API_URL}/transfers`. Provider response must contain `status` equal to `SUCCESS`, `FAILED`, or `PENDING`; optional `reference`, `providerReference`, and `message`.

## Bills
`POST /api/providers/bill-payment` with service, target, amount, PIN and optional providerCode. Backend calls `${BILL_PAYMENT_API_URL}/payments`; response status must reflect the actual provider outcome.

## Before live launch
The current generic adapter is a connection point, not a claim that every country is supported. Build a provider-specific adapter, signature validation, webhook reconciliation, transaction persistence, retries, idempotency enforcement at the provider, fee/limit policy, reversal handling, and settlement reconciliation before enabling real money movement. Never mark success based on an HTTP 200 alone.


## Identity and face verification
- `IDENTITY_API_URL` + `IDENTITY_API_KEY`: backend calls `/nin/verify` with the supplied NIN and user ID. The provider must return `{ "verified": true }` only after its real checks. Veyra stores only the last four NIN digits and verification status.
- `FACE_API_URL` + `FACE_API_KEY`: backend calls `/face/enroll` and `/face/verify` with the camera template. The provider must return `{ "enrolled": true }` or `{ "verified": true }`. Veyra does not persist the submitted face template.
- Recovery uses `/challenge` and `/confirm`; `/confirm` must return `{ "verified": true }` only after a valid unexpired challenge.
- Do not configure these endpoints to a placeholder domain. Use a contracted, security-reviewed provider over HTTPS.
