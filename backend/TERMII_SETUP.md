# Veyra + Termii SMS setup

This backend is configured for the Termii account-specific Base URL supplied for Veyra:

```text
https://v4.api.termii.com
```

The SMS helper normalizes that to the messaging API path:

```text
https://v4.api.termii.com/api/sms/send
```

## Render environment variables

Set these on the Render Web Service. Do not put the API key in GitHub, the frontend, or this ZIP.

```text
TERMII_API_KEY=<your Termii API key>
TERMII_BASE_URL=https://v4.api.termii.com
TERMII_SENDER_ID=VEYRA
TERMII_CHANNEL=dnd
```

`VEYRA` must be a sender ID that is actually approved/available for the Termii account. If your account uses a different approved sender ID, set that value instead.

## What is integrated

### Veyra-to-Veyra transfer
After the database transaction commits:
- sender receives a Veyra simulation SMS
- recipient receives a Veyra simulation SMS
- the message contains the amount, reference, account ending, and updated simulated balance
- the message explicitly says that it is a simulation and not a real bank credit
- retrying the same internal-transfer idempotency key does not send duplicate SMS

### Simulated external bank transfer
After the simulated debit commits:
- sender receives a Veyra simulation SMS
- an optional `recipientPhone` can receive a separately labelled simulation message
- Paystack account-name lookup does not automatically provide a recipient phone number
- SMS failure never reverses the completed simulated debit

### Simulated bill/service payments
The existing service-payment route remains simulated and does not claim that a real utility, airtime, TV, data, or other provider was paid.

## Frontend

No frontend change is required just to enable the Termii integration. The existing transfer requests already reach the backend, and the backend sends the SMS after the simulated transaction succeeds.

The external-transfer recipient SMS remains optional because a bank account-name lookup does not supply the recipient's phone number. The existing frontend can continue working without that field; sender SMS still works.

## Security

Never hard-code the Termii API key into the repository. If a live key was pasted into chat or any public code repository, rotate/revoke it and use the new key only in Render environment variables.
