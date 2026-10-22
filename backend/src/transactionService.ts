import { Prisma, TransactionStatus, TransactionType, NotificationType } from "@prisma/client";
import { prisma } from "./db.js";
import { hashRequest } from "./auth.js";
import { reference } from "./utils.js";

function money(value: Prisma.Decimal) { return `₦${value.toFixed(2)}`; }
function lagosDate() { return new Intl.DateTimeFormat("en-NG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }).format(new Date()); }
function maskAccount(value: string) { return value.length >= 4 ? `****${value.slice(-4)}` : value; }

export async function internalTransfer(
  senderId: string,
  recipientId: string,
  amount: Prisma.Decimal,
  narration: string | undefined,
  key: string,
  smsSenderId?: string
) {
  if (!key) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
  if (amount.lte(0)) throw new Error("INVALID_AMOUNT");
  if (senderId === recipientId) throw new Error("SELF_TRANSFER");

  const requestHash = hashRequest({ recipientId, amount: amount.toFixed(2), narration: narration || null });

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.idempotencyKey.findFirst({ where: { key }, include: { transaction: true } });
    if (existing) {
      if (existing.userId !== senderId || existing.requestHash !== requestHash) throw new Error("IDEMPOTENCY_CONFLICT");
      return { transaction: existing.transaction, created: false };
    }

    const [sender, receiver] = await Promise.all([
      tx.user.findUnique({ where: { id: senderId }, include: { wallet: true, account: true } }),
      tx.user.findUnique({ where: { id: recipientId }, include: { wallet: true, account: true } })
    ]);

    if (!sender || !receiver || !sender.wallet || !receiver.wallet || !sender.account || !receiver.account) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }
    if (sender.status !== "ACTIVE" || receiver.status !== "ACTIVE") throw new Error("ACCOUNT_NOT_ACTIVE");
    if (sender.wallet.status !== "ACTIVE" || receiver.wallet.status !== "ACTIVE" ||
        sender.account.status !== "ACTIVE" || receiver.account.status !== "ACTIVE") {
      throw new Error("WALLET_NOT_ACTIVE");
    }

    // Account.balanceKobo is authoritative. Wallet is retained as a legacy
    // mirror while older service endpoints are being migrated. Stop safely
    // rather than moving money if the two representations have drifted.
    const amountKobo = BigInt(amount.mul(100).toFixed(0));
    const senderWalletKobo = BigInt(sender.wallet.balance.mul(100).toFixed(0));
    const receiverWalletKobo = BigInt(receiver.wallet.balance.mul(100).toFixed(0));
    if (senderWalletKobo !== sender.account.balanceKobo ||
        receiverWalletKobo !== receiver.account.balanceKobo) {
      throw new Error("ACCOUNT_BALANCE_MISMATCH");
    }

    const accountDebit = await tx.account.updateMany({
      where: { userId: senderId, status: "ACTIVE", balanceKobo: { gte: amountKobo } },
      data: { balanceKobo: { decrement: amountKobo } }
    });
    if (accountDebit.count !== 1) throw new Error("INSUFFICIENT_BALANCE");

    const debit = await tx.wallet.updateMany({
      where: { userId: senderId, status: "ACTIVE", balance: { gte: amount } },
      data: { balance: { decrement: amount } }
    });
    if (debit.count !== 1) throw new Error("ACCOUNT_BALANCE_MISMATCH");

    await tx.account.update({ where: { userId: recipientId }, data: { balanceKobo: { increment: amountKobo } } });
    await tx.wallet.update({ where: { userId: recipientId }, data: { balance: { increment: amount } } });

    const [senderWalletAfter, receiverWalletAfter] = await Promise.all([
      tx.wallet.findUnique({ where: { userId: senderId }, select: { balance: true } }),
      tx.wallet.findUnique({ where: { userId: recipientId }, select: { balance: true } })
    ]);

    const txRecord = await tx.transaction.create({
      data: {
        reference: reference("INT"),
        senderId,
        receiverId: recipientId,
        type: TransactionType.INTERNAL_TRANSFER,
        status: TransactionStatus.SUCCESS,
        amount,
        fee: 0,
        vat: 0,
        total: amount,
        narration,
        recipientName: `${receiver.firstName} ${receiver.lastName}`.trim(),
        recipientAccount: receiver.accountNumber,
        completedAt: new Date()
      }
    });

    await tx.transactionEntry.createMany({
      data: [
        { transactionId: txRecord.id, userId: senderId, type: "DEBIT", amount },
        { transactionId: txRecord.id, userId: recipientId, type: "CREDIT", amount }
      ]
    });
    await tx.transactionEvent.create({ data: { transactionId: txRecord.id, actorUserId: senderId, eventType: "INTERNAL_TRANSFER_COMPLETED", fromStatus: "PROCESSING", toStatus: "SUCCESS", eventKey: `internal:${txRecord.reference}:success`, metadata: { amountKobo: amountKobo.toString() } } });
    const receiptSnapshot = { kind: "VEYRA_TRANSFER", reference: txRecord.reference, status: "SUCCESS", amount: amount.toFixed(2), currency: "NGN", senderName: `${sender.firstName} ${sender.lastName}`.trim(), senderAccount: sender.accountNumber, recipientName: `${receiver.firstName} ${receiver.lastName}`.trim(), recipientAccount: receiver.accountNumber, createdAt: txRecord.createdAt.toISOString() };
    await tx.receipt.createMany({ data: [ { userId: senderId, transactionId: txRecord.id, reference: `${txRecord.reference}-S`, kind: "VEYRA_TRANSFER", snapshot: receiptSnapshot }, { userId: recipientId, transactionId: txRecord.id, reference: `${txRecord.reference}-R`, kind: "VEYRA_TRANSFER", snapshot: receiptSnapshot } ] });
    await tx.auditLog.create({ data: { actorUserId: senderId, targetUserId: recipientId, action: "INTERNAL_TRANSFER_COMPLETED", entityType: "Transaction", entityId: txRecord.id, metadata: { reference: txRecord.reference, amountKobo: amountKobo.toString() } } });

    await tx.notification.createMany({
      data: [
        { userId: senderId, type: NotificationType.TRANSFER_SENT, title: "Transfer Successful", message: `₦${amount.toFixed(2)} was sent to ${receiver.firstName} ${receiver.lastName}.` },
        { userId: recipientId, type: NotificationType.TRANSFER_RECEIVED, title: "Money Received", message: `₦${amount.toFixed(2)} was received from ${sender.firstName} ${sender.lastName}.` }
      ]
    });

    await tx.idempotencyKey.create({ data: { key, userId: senderId, requestHash, transactionId: txRecord.id } });

    return {
      transaction: txRecord,
      created: true,
      senderName: `${sender.firstName} ${sender.lastName}`.trim(),
      receiverName: `${receiver.firstName} ${receiver.lastName}`.trim(),
      senderPhone: sender.phone,
      receiverPhone: receiver.phone,
      senderAccount: sender.accountNumber,
      receiverAccount: receiver.accountNumber,
      senderBalance: senderWalletAfter?.balance || new Prisma.Decimal(0),
      receiverBalance: receiverWalletAfter?.balance || new Prisma.Decimal(0)
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });


  return result;
}
