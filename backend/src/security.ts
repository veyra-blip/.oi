
import argon2 from "argon2";
import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

type PinCheckResult =
  | { ok: true }
  | {
      ok: false;
      code: "USER_NOT_FOUND" | "PIN_LOCKED" | "PIN_NOT_SET" | "INVALID_PIN";
    };

export async function verifyTransactionPin(userId: string, pin: string) {
  const result: PinCheckResult = await prisma.$transaction(
    async (tx: Prisma.TransactionClient): Promise<PinCheckResult> => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          pinHash: string;
          pinFailures: number;
          pinLockedUntil: Date | null;
        }>
      >(Prisma.sql`
        SELECT "id", "pinHash", "pinFailures", "pinLockedUntil"
        FROM "User"
        WHERE "id" = ${userId}
        FOR UPDATE
      `);

      const user = rows[0];

      if (!user) {
        return { ok: false, code: "USER_NOT_FOUND" };
      }

      if (
        user.pinLockedUntil &&
        user.pinLockedUntil.getTime() > Date.now()
      ) {
        return { ok: false, code: "PIN_LOCKED" };
      }

      if (!user.pinHash) {
        return { ok: false, code: "PIN_NOT_SET" };
      }

      const valid = await argon2.verify(user.pinHash, pin);

      if (!valid) {
        const failures = user.pinFailures + 1;
        const locked = failures >= 5;

        await tx.user.update({
          where: { id: userId },
          data: {
            pinFailures: locked ? 0 : failures,
            pinLockedUntil: locked
              ? new Date(Date.now() + 15 * 60 * 1000)
              : null
          }
        });

        // Return instead of throwing here, so the failed-attempt
        // counter and lockout are committed by the transaction.
        return { ok: false, code: "INVALID_PIN" };
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          pinFailures: 0,
          pinLockedUntil: null
        }
      });

      return { ok: true };
    }
  );

  // Throw only after the transaction commits.
  if (!result.ok) {
    throw new Error(result.code);
  }

  return true;
}

export function friendlyPinError(code: string) {
  if (code === "PIN_LOCKED") {
    return "Transaction PIN is temporarily locked.";
  }

  if (code === "PIN_NOT_SET") {
    return "Set your transaction PIN before making PIN-protected transactions.";
  }

  if (code === "INVALID_PIN") {
    return "Incorrect transaction PIN.";
  }

  if (code === "USER_NOT_FOUND") {
    return "User account could not be found.";
  }

  return "Transaction PIN verification failed.";
}
