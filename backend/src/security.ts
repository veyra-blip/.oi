import argon2 from "argon2";
import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

export async function verifyTransactionPin(userId: string, pin: string) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<Array<{
      id: string;
      pinHash: string;
      pinFailures: number;
      pinLockedUntil: Date | null;
    }>>(Prisma.sql`
      SELECT "id", "pinHash", "pinFailures", "pinLockedUntil"
      FROM "User"
      WHERE "id" = ${userId}
      FOR UPDATE
    `);

    const user = rows[0];
    if (!user) throw new Error("USER_NOT_FOUND");
    if (user.pinLockedUntil && user.pinLockedUntil > new Date()) throw new Error("PIN_LOCKED");
    if (!user.pinHash) throw new Error("PIN_NOT_SET");

    const valid = await argon2.verify(user.pinHash, pin);
    if (!valid) {
      const failures = user.pinFailures + 1;
      await tx.user.update({
        where: { id: userId },
        data: {
          pinFailures: failures >= 5 ? 0 : failures,
          pinLockedUntil: failures >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null
        }
      });
      throw new Error("INVALID_PIN");
    }

    await tx.user.update({
      where: { id: userId },
      data: { pinFailures: 0, pinLockedUntil: null }
    });
    return true;
  });
}

export function friendlyPinError(code: string) {
  if (code === "PIN_LOCKED") return "Transaction PIN is temporarily locked.";
  if (code === "PIN_NOT_SET") return "Set your transaction PIN before making PIN-protected transactions.";
  if (code === "INVALID_PIN") return "Incorrect transaction PIN.";
  return "Transaction PIN verification failed.";
}
