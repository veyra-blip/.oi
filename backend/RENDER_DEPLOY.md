# Render deployment

Root Directory: `backend`

Build Command:
```sh
npm install && npx prisma generate && npm run build
```

Start Command: `npm start`

Required Render environment variables: `DATABASE_URL`, `JWT_SECRET` (32+ random chars), `REFRESH_SECRET` (different 32+ random chars), `FRONTEND_ORIGIN`. Optional provider endpoints and keys are listed in `.env.example`.

Health check: `/api/health`. Do not run `prisma migrate dev`, `prisma db push`, reset, or seed on production. Review `../docs/DEPLOY_AND_MIGRATE.md` and the read-only SQL before any migration.
