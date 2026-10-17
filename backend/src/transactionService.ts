import { prisma } from "./db.js";
import { Prisma } from "@prisma/client";

/**
 * internalTransfer
 * Moves funds between two wallets atomically.
 * Accepts optional metadata which will be stored as a JSON string.
 */
export async function internalTransfer(
  senderId: string,
  recipientId: string,
  amount: Prisma.Decimal,
  narration: string | undefined,
  idempotency: string | null,
  senderReference?: string,
  metadata?: any
) {
  if (senderId === recipientId) throw new Error("SELF_TRANSFER");

  return await prisma.$transaction(
    async (tx) => {
      const sender = await tx.user.findUnique({ where: { id: senderId }, include: { wallet: true } });
      const recipient = await tx.user.findUnique({ where: { id: recipientId }, include: { wallet: true } });
      if (!sender || !recipient) throw new Error("ACCOUNT_NOT_FOUND");

      const sWallet = await tx.wallet.findUnique({ where: { userId: senderId } });
      if (!sWallet) throw new Error("WALLET_NOT_FOUND");

      // ensure sufficient balance
      if (sWallet.balance.lt(amount)) throw new Error("INSUFFICIENT_BALANCE");

      const updated = await tx.wallet.updateMany({
        where: { userId: senderId, status: "ACTIVE", balance: { gte: amount } },
        data: { balance: { decrement: amount } }
      });
      if (updated.count === 0) throw new Error("INSUFFICIENT_BALANCE");

      await tx.wallet.update({ where: { userId: recipientId }, data: { balance: { increment: amount } } });

      const txr = await tx.transaction.create({
        data: {
          reference: `INT_${Date.now().toString(36)}`,
          senderId,
          receiverId: recipientId,
          type: "INTERNAL_TRANSFER",
          status: "SUCCESS",
          amount,
          total: amount,
          narration,
          metadata: metadata ? JSON.stringify(metadata) : null
        }
      });

      return txr;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}