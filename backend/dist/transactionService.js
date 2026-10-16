import { TransactionStatus, TransactionType, NotificationType } from "@prisma/client";
import { prisma } from "./db.js";
import { reference } from "./utils.js";
import { sendTermiiSms } from "./sms.js";
function maskedAccount(account) {
    const value = String(account || "");
    if (value.length <= 4)
        return value;
    return `${value.slice(0, 2)}****${value.slice(-4)}`;
}
function lagosDate() {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Lagos",
        day: "2-digit",
        month: "short",
        year: "numeric"
    })
        .format(new Date())
        .toUpperCase();
}
function money(amount) {
    return `₦${amount.toFixed(2)}`;
}
function buildSenderSms(senderName, senderAccount, receiverName, amount, balance, ref) {
    return [
        "DEBIT ALERT",
        `DR: Acct: ${maskedAccount(senderAccount)}`,
        `Amt: ${money(amount)}`,
        `Descr: TRFR TO ${receiverName}`,
        `Avail Bal: ${money(balance)}`,
        `Date: ${lagosDate()}`,
        `Ref: ${ref}`,
        `From: ${senderName}`
    ].join(" | ");
}
function buildReceiverSms(receiverAccount, senderName, amount, balance, ref) {
    return [
        "CREDIT ALERT",
        `CR: Acct: ${maskedAccount(receiverAccount)}`,
        `Amt: ${money(amount)}`,
        `Descr: TRFR FROM ${senderName}`,
        `Avail Bal: ${money(balance)}`,
        `Date: ${lagosDate()}`,
        `Ref: ${ref}`
    ].join(" | ");
}
export async function internalTransfer(senderId, recipientId, amount, narration, key, smsSenderId) {
    if (!key)
        throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    if (amount.lte(0))
        throw new Error("INVALID_AMOUNT");
    if (senderId === recipientId)
        throw new Error("SELF_TRANSFER");
    const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.idempotencyKey.findUnique({
            where: { key },
            include: { transaction: true }
        });
        if (existing)
            return { transaction: existing.transaction, created: false };
        const sender = await tx.user.findUnique({
            where: { id: senderId },
            include: { wallet: true }
        });
        const receiver = await tx.user.findUnique({
            where: { id: recipientId },
            include: { wallet: true }
        });
        if (!sender || !receiver || !sender.wallet || !receiver.wallet)
            throw new Error("ACCOUNT_NOT_FOUND");
        if (sender.status !== "ACTIVE" || receiver.status !== "ACTIVE")
            throw new Error("ACCOUNT_NOT_ACTIVE");
        if (sender.wallet.balance.lt(amount))
            throw new Error("INSUFFICIENT_BALANCE");
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
        return { transaction: completed, created: true };
    });
    // SMS is deliberately outside the database transaction. A carrier/API
    // failure must never undo a completed wallet transfer.
    if (result.created) {
        try {
            const [senderAfter, receiverAfter] = await Promise.all([
                prisma.user.findUnique({ where: { id: senderId }, include: { wallet: true } }),
                prisma.user.findUnique({ where: { id: recipientId }, include: { wallet: true } })
            ]);
            if (senderAfter?.wallet && receiverAfter?.wallet) {
                const senderName = `${senderAfter.firstName} ${senderAfter.lastName}`.trim();
                const receiverName = `${receiverAfter.firstName} ${receiverAfter.lastName}`.trim();
                const senderMessage = buildSenderSms(senderName, senderAfter.accountNumber, receiverName, amount, senderAfter.wallet.balance, result.transaction.reference);
                const receiverMessage = buildReceiverSms(receiverAfter.accountNumber, senderName, amount, receiverAfter.wallet.balance, result.transaction.reference);
                // Both parties receive a carrier SMS. The receiver is not dependent
                // on the sender SMS succeeding because the sends are independent.
                const smsResults = await Promise.allSettled([
                    sendTermiiSms(senderAfter.phone, senderMessage, smsSenderId),
                    sendTermiiSms(receiverAfter.phone, receiverMessage, smsSenderId)
                ]);
                for (const item of smsResults) {
                    if (item.status === "rejected") {
                        console.warn("Veyra transfer SMS failed:", item.reason?.name || "unknown error");
                    }
                    else if (!item.value.ok) {
                        console.warn("Veyra transfer SMS was not accepted by Termii:", item.value.reason || "unknown Termii error");
                    }
                }
            }
        }
        catch (error) {
            console.warn("Veyra transfer SMS preparation failed:", error?.name || "unknown error");
        }
    }
    return result.transaction;
}
