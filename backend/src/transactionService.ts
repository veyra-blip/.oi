import { prisma } from "./db.js";
import { Prisma } from "@prisma/client";

export async function internalTransfer(senderId: string, recipientId: string, amount: Prisma.Decimal, narration: string | undefined, idempotency: string | null, senderReference?: string) {
  // Simplified implementation: checks balances and moves funds atomically
  if (senderId === recipientId) throw new Error("SELF_TRANSFER");
  return await prisma.$transaction(async (tx) => {
    const sender = await tx.user.findUnique({ where: { id: senderId }, include: { wallet: true } });
    const recipient = await tx.user.findUnique({ where: { id: recipientId }, include: { wallet: true } });
    if (!sender || !recipient) throw new Error("ACCOUNT_NOT_FOUND");
    const sWallet = await tx.wallet.findUnique({ where: { userId: senderId } });
    if (!sWallet) throw new Error("WALLET_NOT_FOUND");
    if (sWallet.balance.lt(amount)) throw new Error("INSUFFICIENT_BALANCE");
    await tx.wallet.updateMany({ where: { userId: senderId, status: "ACTIVE", balance: { gte: amount } }, data: { balance: { decrement: amount } } });
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
        narration
      }
    });
    return txr;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}