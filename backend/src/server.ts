import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(helmet());

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? "*",
  })
);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "veyra-api",
    version: "2.0.0",
  });
});

app.get("/api", (_req, res) => {
  res.json({
    name: "Veyra API",
    version: "2.0.0",
    status: "foundation-ready",
  });
});

app.get("/api/db-test", async (_req, res) => {
  try {
    const result = await prisma.$queryRaw`SELECT 1 AS connected`;

    res.json({
      ok: true,
      database: "connected",
      result,
    });
  } catch (error) {
    console.error("Database test failed:", error);

    res.status(500).json({
      ok: false,
      database: "connection_failed",
    });
  }
});

for (const path of [
  "/api/auth",
  "/api/transactions",
  "/api/services",
  "/api/identity",
]) {
  app.use(path, (_req, res) =>
    res.status(501).json({
      error: "MODULE_NOT_IMPLEMENTED_YET",
    })
  );
}

app.use((_req, res) =>
  res.status(404).json({
    error: "NOT_FOUND",
  })
);

const port = Number(process.env.PORT || 10000);

app.listen(port, () => {
  console.log(`Veyra API listening on ${port}`);
});
