# Veyra backend deployment

Root Directory: `backend`

Build Command:
`npm install && npx prisma generate && npm run build && npx prisma db push`

Start Command:
`npm start`

Required Render environment variables:
- DATABASE_URL = Render PostgreSQL internal URL
- JWT_SECRET = long random secret
- REFRESH_SECRET = different long random secret
- FACE_ENCRYPTION_KEY = long random secret
- FRONTEND_ORIGINS = `*` for the internal simulation, or a comma-separated list of exact frontend origins
- RESET_DELIVERY_MODE = `display` for this simulation's on-screen one-time reset code
- FACE_MATCH_THRESHOLD = `0.32`

Health check:
`/api/health`

The service is a simulated internal wallet. It does not move real bank money.
