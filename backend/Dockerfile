FROM node:20-alpine
WORKDIR /app

COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY backend ./
RUN npm run build

EXPOSE 4000
CMD ["node", "dist/server.js"]