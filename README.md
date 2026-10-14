# Internal Wallet

A self-contained mobile-friendly internal wallet frontend plus the original Node/Prisma backend starter.

## Frontend

The complete browser frontend is now in:

- `index.html` (repository root, suitable for GitHub Pages)
- `frontend/index.html` (same complete frontend)

It does not require Vite, React, Tailwind, or an external CDN. Open `index.html` directly for the frontend UI.

## GitHub Pages

This repository includes `.github/workflows/pages.yml`. Set GitHub Pages source to **GitHub Actions**. The workflow publishes the repository root, so `index.html` is the top-level entry file.

## Important

This frontend stores prototype data in browser localStorage. It is useful for UI testing, not production financial security. Real deployment should use the backend with server-side authentication, password/PIN hashing, atomic transactions, rate limiting, WebAuthn/biometric verification, audit logging, and a real database.

All balances and payments in this project are internal simulated wallet transactions and do not move real bank funds.
