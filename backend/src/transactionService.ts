import {
  Prisma,
  TransactionStatus,
  TransactionType,
  NotificationType
} from "@prisma/client";
import { prisma } from "./db.js";
import { reference } from "./utils.js";

export async function internalTransfer(
  senderId: string,
  recipientId: string,
  amount: Prisma.Decimal,
  narration: string | undefined,
  key: string
) {
  if (!key) {
    throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  }

  if (amount.lte(0)) {
    throw new Error("INVALID_AMOUNT");
  }

  if (senderId === recipientId) {
    throw new Error("SELF_TRANSFER");
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Prevent the same transfer from being processed twice.
    const existing = await tx.idempotencyKey.findUnique({
      where: { key },
      include: { transaction: true }
    });

    if (existing) {
      return existing.transaction;
    }

    // Find the sender and receiver.
    const sender = await tx.user.findUnique({
      where: { id: senderId },
      include: { wallet: true }
    });

    const receiver = await tx.user.findUnique({
      where: { id: recipientId },
      include: { wallet: true }
    });

    if (
      !sender ||
      !receiver ||
      !sender.wallet ||
      !receiver.wallet
    ) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }

    if (
      sender.status !== "ACTIVE" ||
      receiver.status !== "ACTIVE"
    ) {
      throw new Error("ACCOUNT_NOT_ACTIVE");
    }

    // Make sure the sender has enough money.
    if (sender.wallet.balance.lt(amount)) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    // Create the transaction record.
    const ref = reference("INT");

    const txRecord = await tx.transaction.create({
      data: {
        reference: ref,
        senderId: senderId,
        receiverId: recipientId,
        type: TransactionType.INTERNAL_TRANSFER,
        status: TransactionStatus.PROCESSING,
        amount: amount,
        fee: 0,
        vat: 0,
        total: amount,
        narration: narration,
        recipientName: `${receiver.firstName} ${receiver.lastName}`,
        recipientAccount: receiver.accountNumber
      }
    });

    // Remove money from sender.
    await tx.wallet.update({
      where: { userId: senderId },
      data: {
        balance: {
          decrement: amount
        }
      }
    });

    // Add the same money to receiver.
    await tx.wallet.update({
      where: { userId: recipientId },
      data: {
        balance: {
          increment: amount
        }
      }
    });

    // Record both sides of the transaction.
    await tx.transactionEntry.createMany({
      data: [
        {
          transactionId: txRecord.id,
          userId: senderId,
          type: "DEBIT",
          amount: amount
        },
        {
          transactionId: txRecord.id,
          userId: recipientId,
          type: "CREDIT",
          amount: amount
        }
      ]
    });

    // Mark transaction as successful.
    const completed = await tx.transaction.update({
      where: { id: txRecord.id },
      data: {
        status: TransactionStatus.SUCCESS,
        completedAt: new Date()
      }
    });

    // Notify both users.
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

    // Save the idempotency key so the same request cannot
    // accidentally create another transfer.
    await tx.idempotencyKey.create({
      data: {
        key: key,
        userId: senderId,
        transactionId: completed.id
      }
    });

    return completed;
  });
            }
