import { Prisma, TransactionStatus, TransactionType, NotificationType } from "@prisma/client";
import { prisma } from "./db.js";
import { reference } from "./utils.js";

export async function internalTransfer(
  senderId: string,
  recipientId: string,
  amount: Prisma.Decimal,
  narration: string | undefined,
  key: string
) {
  if (!key) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  if (amount.lte(0)) throw new Error("INVALID_AMOUNT");
  if (senderId === recipientId) throw new Error("SELF_TRANSFER");

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.idempotencyKey.findUnique({
      where: { key },
      include: { transaction: true }
    });
    if (existing) return existing.transaction;

    const sender = await tx.user.findUnique({
      where: { id: senderId },
      include: { wallet: true }
    });
    const receiver = await tx.user.findUnique({
      where: { id: recipientId },
      include: { wallet: true }
    });

    if (!sender || !receiver || !sender.wallet || !receiver.wallet) throw new Error("ACCOUNT_NOT_FOUND");
    if (sender.status !== "ACTIVE" || receiver.status !== "ACTIVE") throw new Error("ACCOUNT_NOT_ACTIVE");
    if (sender.wallet.balance.lt(amount)) throw new Error("INSUFFICIENT_BALANCE");

    const ref = reference("INT");
    const txRecord = await tx.transaction.create({
      data: {
        reference: ref,
        senderId,
        receiverId: recipientId,
        type: TransactionType.INTERNAL_TRANSFER,
        status: TransactionStatus.PROCESSING,
        amount,
        fee: 0,
        vat: 0,
        total: amount,
        narration,
        recipientName: `${receiver.firstName} ${receiver.lastName}`,
        recipientAccount: receiver.accountNumber
      }
    });

    await tx.wallet.update({
      where: { userId: senderId },
      data: { balance: { decrement: amount } }
    });

    await tx.wallet.update({
      where: { userId: recipientId },
      data: { balance: { increment: amount } }
    });

    await tx.transactionEntry.createMany({
      data: [
        { transactionId: txRecord.id, userId: senderId, type: "DEBIT", amount },
        { transactionId: txRecord.id, userId: recipientId, type: "CREDIT", amount }
      ]
    });

    const completed = await tx.transaction.update({
      where: { id: txRecord.id },
      data: { status: TransactionStatus.SUCCESS, completedAt: new Date() }
    });

    await tx.notification.createMany({
      data: [
        {
          userId: senderId,
          type: NotificationType.TRANSFER_SENT,
          title: "Transfer Successful",
          message: `₦${amount.toFixed(2)} was sent to ${receiver.firstName} ${receiver.lastName}.`
        },
        {
          userId: recipientId,
          type: NotificationType.TRANSFER_RECEIVED,
          title: "Money Received",
          message: `₦${amount.toFixed(2)} was received from ${sender.firstName} ${sender.lastName}.`
        }
      ]
    });

    await tx.idempotencyKey.create({
      data: { key, userId: senderId, transactionId: completed.id }
    });

    return completed;
  });
}
