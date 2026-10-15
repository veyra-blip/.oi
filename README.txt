VEYRA COMPLETE FIXED BUILD

frontend/veyra-index.html
- Single working frontend file.
- Registration creates an account, logs the user in, loads the wallet and opens the dashboard.
- Login accepts username, email or phone.
- Friendly connection errors only. No raw GitHub/Render error text is shown in the app.
- Forgot password works with a one-time reset code for this simulation.
- Face enrollment captures a reduced camera template and sends only the template to the backend.
- Face recovery compares a new camera template with the encrypted saved template.
- NightGuard uses the same face verification.
- Transfers, history, notifications, services, savings, cards, loans and security settings use backend endpoints.
- Beneficiaries work per account in the browser.

backend/
- Express + Prisma + PostgreSQL.
- Registration and login.
- Shared isolated wallets.
- Atomic internal transfers with idempotency.
- Password reset.
- Encrypted face-template storage and matching.
- Password/PIN change.
- Savings deposit/withdraw.
- Virtual cards.
- Loan request/repayment.
- Simulated service payments.
- CORS configured for the frontend.

RENDER
Root Directory: backend
Build Command:
npm install && npx prisma generate && npm run build && npx prisma db push
Start Command:
npm start

Environment variables:
DATABASE_URL=<your Render PostgreSQL internal URL>
JWT_SECRET=<long random secret>
REFRESH_SECRET=<different long random secret>
FACE_ENCRYPTION_KEY=<long random secret>
FRONTEND_ORIGINS=*
RESET_DELIVERY_MODE=display
FACE_MATCH_THRESHOLD=0.32

After deployment, the API health endpoint should return JSON from /api/health.

IMPORTANT PRIVACY NOTE
The face feature stores an encrypted reduced template rather than the raw camera photo. The matching method in this simulation is an app-level template comparison. It is not real biometric KYC, liveness detection, or government identity verification and should not be used for real banking.
