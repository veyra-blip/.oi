import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import crypto from "crypto";
import jwt from "jsonwebtoken";
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

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is not configured");
}

/* =========================================================
   SECURITY HELPERS
========================================================= */

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(
  password: string,
  storedHash: string
): boolean {
  const [salt, originalHash] = storedHash.split(":");

  if (!salt || !originalHash) {
    return false;
  }

  const hash = crypto
    .scryptSync(password, salt, 64)
    .toString("hex");

  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(originalHash, "hex")
  );
}

function createAccessToken(userId: string, role: string) {
  return jwt.sign(
    {
      sub: userId,
      role,
    },
    JWT_SECRET as string,
    {
      expiresIn: "15m",
    }
  );
}

function createRefreshToken() {
  return crypto.randomBytes(48).toString("hex");
}

function hashToken(token: string): string {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}
type AuthRequest = express.Request & {
  authUser?: {
    id: string;
    role: string;
  };
};

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  try {
    const authReq = req as AuthRequest;
    const header = req.headers.authorization;

    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({
        ok: false,
        message: "Please log in first."
      });
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET!);

    if (
      typeof decoded === "string" ||
      typeof decoded.sub !== "string"
    ) {
      return res.status(401).json({
        ok: false,
        message: "Invalid access token."
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true,
        role: true,
        status: true
      }
    });

    if (!user || user.status !== "ACTIVE") {
      return res.status(401).json({
        ok: false,
        message: "Account is unavailable."
      });
    }

    authReq.authUser = {
      id: user.id,
      role: user.role
    };

    next();
  } catch {
    return res.status(401).json({
      ok: false,
      message: "Access token is invalid or expired."
    });
  }
}

function generateAccountNumber(): string {
  const digits = Math.floor(
    1000000000 + Math.random() * 9000000000
  );

  return `01${digits}`;
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "veyra-api",
    version: "2.0.0",
  });
});

/* =========================================================
   API
========================================================= */

app.get("/api", (_req, res) => {
  res.json({
    name: "Veyra API",
    version: "2.0.0",
    status: "foundation-ready",
  });
});

/* =========================================================
   DATABASE TEST
========================================================= */

app.get("/api/db-test", async (_req, res) => {
  try {
    const result =
      await prisma.$queryRaw`SELECT 1 AS connected`;

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

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/auth/register", async (req, res) => {
  try {
    const {
      email,
      phone,
      password,
      username,
      firstName,
      lastName,
    } = req.body;

    if (
      !email ||
      !phone ||
      !password ||
      !username ||
      !firstName ||
      !lastName
    ) {
      return res.status(400).json({
        error: "MISSING_REQUIRED_FIELDS",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: "PASSWORD_TOO_SHORT",
        message: "Password must contain at least 8 characters.",
      });
    }

    const normalizedEmail = String(email)
      .trim()
      .toLowerCase();

    const normalizedPhone = String(phone).trim();

    const normalizedUsername = String(username)
      .trim()
      .toLowerCase();

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          { phone: normalizedPhone },
        ],
      },
    });

    if (existingUser) {
      return res.status(409).json({
        error: "USER_ALREADY_EXISTS",
        message:
          "An account with this email or phone already exists.",
      });
    }

    const existingUsername = await prisma.profile.findUnique({
      where: {
        username: normalizedUsername,
      },
    });

    if (existingUsername) {
      return res.status(409).json({
        error: "USERNAME_ALREADY_EXISTS",
        message: "That username is already taken.",
      });
    }

    const passwordHash = hashPassword(password);

    let accountNumber = generateAccountNumber();

    for (let attempt = 0; attempt < 5; attempt++) {
      const existingAccount =
        await prisma.account.findUnique({
          where: {
            accountNumber,
          },
        });

      if (!existingAccount) {
        break;
      }

      accountNumber = generateAccountNumber();
    }

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          phone: normalizedPhone,
          passwordHash,
        },
      });

      await tx.profile.create({
        data: {
          userId: user.id,
          username: normalizedUsername,
          firstName: String(firstName).trim(),
          lastName: String(lastName).trim(),
        },
      });

      await tx.identity.create({
        data: {
          userId: user.id,
          status: "UNVERIFIED",
        },
      });

      const account = await tx.account.create({
        data: {
          userId: user.id,
          accountNumber,
          balanceKobo: BigInt(0),
          currency: "NGN",
        },
      });

      return {
        user,
        account,
      };
    });

    const accessToken = createAccessToken(
      result.user.id,
      result.user.role
    );

    const refreshToken = createRefreshToken();

    await prisma.session.create({
      data: {
        userId: result.user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ),
      },
    });

    return res.status(201).json({
      ok: true,
      message: "Account created successfully.",
      user: {
        id: result.user.id,
        email: result.user.email,
        phone: result.user.phone,
        role: result.user.role,
      },
      account: {
        accountNumber: result.account.accountNumber,
        balanceKobo: "0",
        currency: result.account.currency,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error("Registration failed:", error);

    return res.status(500).json({
      error: "REGISTRATION_FAILED",
    });
  }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/auth/login", async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({
        error: "MISSING_LOGIN_FIELDS",
      });
    }

    const normalizedIdentifier = String(identifier)
      .trim()
      .toLowerCase();

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          {
            email: normalizedIdentifier,
          },
          {
            phone: String(identifier).trim(),
          },
        ],
      },
      include: {
        profile: true,
        account: true,
      },
    });

    if (!user) {
      return res.status(401).json({
        error: "INVALID_CREDENTIALS",
      });
    }

    if (user.status !== "ACTIVE") {
      return res.status(403).json({
        error: "ACCOUNT_NOT_ACTIVE",
      });
    }

    const passwordValid = verifyPassword(
      String(password),
      user.passwordHash
    );

    if (!passwordValid) {
      return res.status(401).json({
        error: "INVALID_CREDENTIALS",
      });
    }

    const accessToken = createAccessToken(
      user.id,
      user.role
    );

    const refreshToken = createRefreshToken();

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ),
      },
    });

    return res.json({
      ok: true,
      message: "Login successful.",
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        role: user.role,
        username: user.profile?.username ?? null,
        firstName: user.profile?.firstName ?? null,
        lastName: user.profile?.lastName ?? null,
      },
      account: user.account
        ? {
            accountNumber: user.account.accountNumber,
            balanceKobo: user.account.balanceKobo.toString(),
            currency: user.account.currency,
          }
        : null,
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error("Login failed:", error);

    return res.status(500).json({
      error: "LOGIN_FAILED",
    });
  }
});
app.post(
  "/api/auth/change-password",
  requireAuth,
  async (req, res) => {
    const authReq = req as AuthRequest;
    const userId = authReq.authUser!.id;

    const { currentPassword, newPassword } = req.body;

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      newPassword.length < 12
    ) {
      return res.status(400).json({
        ok: false,
        message: "Enter your current password and a new password of at least 12 characters."
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (
      !user ||
      !verifyPassword(currentPassword, user.passwordHash)
    ) {
      return res.status(400).json({
        ok: false,
        message: "Current password is incorrect."
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        ok: false,
        message: "Choose a different password."
      });
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: hashPassword(newPassword)
        }
      }),
      prisma.session.updateMany({
        where: {
          userId,
          revokedAt: null
        },
        data: {
          revokedAt: new Date()
        }
      })
    ]);

    return res.json({
      ok: true,
      message: "Password changed. Please log in again."
    });
  }
);

app.post(
  "/api/auth/logout-all",
  requireAuth,
  async (req, res) => {
    const authReq = req as AuthRequest;

    await prisma.session.updateMany({
      where: {
        userId: authReq.authUser!.id,
        revokedAt: null
      },
      data: {
        revokedAt: new Date()
      }
    });

    return res.json({
      ok: true,
      message: "All refresh sessions have been revoked. Log in again."
    });
  }
);

/* =========================================================
   OWNER BOOTSTRAP
========================================================= */

app.post("/api/auth/owner-bootstrap", async (req, res) => {
  try {
    const setupKey = req.headers["x-owner-setup-key"];

    if (
      typeof setupKey !== "string" ||
      setupKey !== process.env.OWNER_SETUP_KEY
    ) {
      return res.status(401).json({
        error: "INVALID_OWNER_SETUP_KEY",
      });
    }

    const existingOwner = await prisma.user.findFirst({
      where: {
        role: "OWNER",
      },
    });

    if (existingOwner) {
      return res.status(409).json({
        error: "OWNER_ALREADY_EXISTS",
        message:
          "The Veyra owner account has already been created.",
      });
    }

    const email = "admin@veyra.test";
    const phone = "08147263851";
    const username = "veyraowner";
    const firstName = "Veyra";
    const lastName = "Owner";
    const password = "VeyraOwner@2026!X9";

    const passwordHash = hashPassword(password);

    let accountNumber = generateAccountNumber();

    for (let attempt = 0; attempt < 10; attempt++) {
      const existingAccount =
        await prisma.account.findUnique({
          where: {
            accountNumber,
          },
        });

      if (!existingAccount) {
        break;
      }

      accountNumber = generateAccountNumber();
    }

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          phone,
          passwordHash,
          role: "OWNER",
          status: "ACTIVE",
        },
      });

      await tx.profile.create({
        data: {
          userId: user.id,
          username,
          firstName,
          lastName,
          showUsername: true,
          allowPhoneReceiving: true,
          emailNotifications: true,
          loginAlerts: true,
        },
      });

      await tx.identity.create({
        data: {
          userId: user.id,
          status: "UNVERIFIED",
        },
      });

      const account = await tx.account.create({
        data: {
          userId: user.id,
          accountNumber,
          balanceKobo: BigInt(0),
          currency: "NGN",
          level: "LEVEL_1",
        },
      });

      return {
        user,
        account,
      };
    });

    const accessToken = createAccessToken(
      result.user.id,
      result.user.role
    );

    const refreshToken = createRefreshToken();

    await prisma.session.create({
      data: {
        userId: result.user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ),
      },
    });

    return res.status(201).json({
      ok: true,
      message: "Veyra owner account created successfully.",
      credentials: {
        email,
        phone,
        username,
        password,
      },
      user: {
        id: result.user.id,
        role: result.user.role,
        status: result.user.status,
      },
      account: {
        accountNumber: result.account.accountNumber,
        balanceKobo: "0",
        currency: result.account.currency,
        level: result.account.level,
      },
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error("Owner bootstrap failed:", error);

    return res.status(500).json({
      error: "OWNER_BOOTSTRAP_FAILED",
    });
  }
});

/* =========================================================
   FALLBACK
========================================================= */

app.use((_req, res) => {
  res.status(404).json({
    error: "NOT_FOUND",
  });
});

/* =========================================================
   SERVER
========================================================= */

const port = Number(process.env.PORT || 10000);

app.listen(port, () => {
  console.log(`Veyra API listening on ${port}`);
});
