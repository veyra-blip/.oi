import { Prisma, TransactionStatus, TransactionType, NotificationType } from "@prisma/client";
import { prisma } from "./db.js";
import { hashRequest } from "./auth.js";
import { reference } from "./utils.js";
import { sendTermiiSms } from "./sms.js";

function money(value: Prisma.Decimal) { return `₦${value.toFixed(2)}`; }
function lagosDate() { return new Intl.DateTimeFormat("en-NG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" }).format(new Date()); }
function maskAccount(value: string) { return value.length >= 4 ? `****${value.slice(-4)}` : value; }

function senderSms(receiverName: string, receiverAccount: string, amount: Prisma.Decimal, balance: Prisma.Decimal, ref: string) {
  return [
    "DEBIT ALERT", "",
    `DR: Acct: ${maskAccount(receiverAccount)}`,
    `Amt: ${money(amount)}`,
    `Descr: TRFR TO ${receiverName}`,
    `Remaining Bal: ${money(balance)}`,
    `Date: ${lagosDate()}`,
    `Ref: ${ref}`,
    "",
    "Veyra simulated wallet alert.",
    "No real bank transfer occurred."
  ].join("\n");
}

function receiverSms(senderName: string, senderAccount: string, amount: Prisma.Decimal, balance: Prisma.Decimal, ref: string) {
  return [
    "CREDIT ALERT", "",
    `CR: Acct: ${maskAccount(senderAccount)}`,
    `Amt: ${money(amount)}`,
    `Descr: TRFR FROM ${senderName}`,
    `Available Bal: ${money(balance)}`,
    `Date: ${lagosDate()}`,
    `Ref: ${ref}`,
    "",
    "Veyra simulated wallet alert.",
    "No real bank transfer occurred."
  ].join("\n");
}

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
      tx.user.findUnique({ where: { id: senderId }, include: { wallet: true } }),
      tx.user.findUnique({ where: { id: recipientId }, include: { wallet: true } })
    ]);

    if (!sender || !receiver || !sender.wallet || !receiver.wallet) throw new Error("ACCOUNT_NOT_FOUND");
    if (sender.status !== "ACTIVE" || receiver.status !== "ACTIVE") throw new Error("ACCOUNT_NOT_ACTIVE");
    if (sender.wallet.status !== "ACTIVE" || receiver.wallet.status !== "ACTIVE") throw new Error("WALLET_NOT_ACTIVE");

    const debit = await tx.wallet.updateMany({
      where: { userId: senderId, status: "ACTIVE", balance: { gte: amount } },
      data: { balance: { decrement: amount } }
    });
    if (debit.count !== 1) throw new Error("INSUFFICIENT_BALANCE");

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

  if (result.created) {
    const [senderSmsResult, receiverSmsResult] = await Promise.allSettled([
      sendTermiiSms(result.senderPhone, senderSms(result.receiverName, result.receiverAccount, amount, result.senderBalance, result.transaction.reference), smsSenderId),
      sendTermiiSms(result.receiverPhone, receiverSms(result.senderName, result.senderAccount, amount, result.receiverBalance, result.transaction.reference), smsSenderId)
    ]);
    for (const item of [senderSmsResult, receiverSmsResult]) {
      if (item.status === "rejected") console.warn("Veyra transfer SMS failed:", item.reason?.name || "unknown error");
      else if (!item.value.ok) console.warn("Veyra transfer SMS not accepted:", item.value.reason || "unknown Termii error");
    }
  }

  return result;
}
