VEYRA 90-DAY PERSISTENT LOGIN FIX

What changed:
1. Refresh JWT lifetime: 90 days.
2. Database session lifetime: 90 days.
3. Frontend now stores the NEW refreshToken returned by /api/auth/refresh.
4. Username/email/phone login remains supported by the corrected server.
5. The frontend never stores the user's password. It stores only access/refresh session tokens.
6. Explicit Sign out still removes the saved session.

Render environment variables required:
JWT_SECRET=<at least 32 random characters>
REFRESH_SECRET=<at least 32 different random characters>

Build:
npm install && npx prisma generate && npm run build && npx prisma migrate deploy

Start:
npm start

Important:
After deploying this version, an old refresh token from the previous configuration may be invalid. If the app still shows a stale login state, sign in once again. After that, the new refresh token is retained across reloads and refreshes for up to 90 days.
