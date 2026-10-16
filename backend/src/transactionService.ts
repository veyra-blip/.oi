import { Prisma, TransactionStatus, TransactionType, NotificationType } from '@prisma/client';
import { prisma } from './db.js';
import { reference } from './utils.js';
import { sendTermiiSms } from './sms.js';

function money(amount: Prisma.Decimal): string {
  return `₦${amount.toFixed(2)}`;
}

function maskedAccount(accountNumber: string): string {
  const clean = String(accountNumber || '');
  if (clean.length <= 4) return clean;
  return `${'*'.repeat(Math.max(0, clean.length - 4))}${clean.slice(-4)}`;
}

function cleanSenderId(value: string | undefined): string | undefined {
  const senderId = String(value || '')
    .replace(/[\r\n\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
  return senderId || undefined;
}

function cleanRecipientAlias(value: string | undefined): string | undefined {
  const alias = String(value || '')
    .replace(/[\r\n\t]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return alias || undefined;
}

function lagosDate(): string {
  return new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos'
  }).toUpperCase();
}

function buildReceiverSms(
  senderName: string,
  receiverAccount: string,
  amount: Prisma.Decimal,
  receiverBalance: Prisma.Decimal,
  ref: string,
  recipientAlias?: string
): string {
  const aliasPart = recipientAlias ? ` (${recipientAlias})` : '';
  return [
    'CREDIT ALERT', '',
    `CR: Acct: ${maskedAccount(receiverAccount)}`,
    `Amt: ${money(amount)}`,
    `Descr: TRFR FROM ${senderName}${aliasPart}`,
    `Received: ${money(amount)}`,
    `Received Bal: ${money(receiverBalance)}`,
    `Date: ${lagosDate()}`,
    `Ref: ${ref}`,
    '',
    'This is a Veyra simulated wallet alert.',
    'No real bank credit occurred.'
  ].join('\n');
}

function buildSenderSms(
  receiverName: string,
  receiverAccount: string,
  amount: Prisma.Decimal,
  senderBalance: Prisma.Decimal,
  ref: string,
  recipientAlias?: string
): string {
  const aliasPart = recipientAlias ? ` (${recipientAlias})` : '';
  return [
    'DEBIT ALERT', '',
    `DR: Acct: ${maskedAccount(receiverAccount)}`,
    `Amt: ${money(amount)}`,
    `Descr: TRFR TO ${receiverName}${aliasPart}`,
    `Remaining Bal: ${money(senderBalance)}`,
    `Date: ${lagosDate()}`,
    `Ref: ${ref}`,
    '',
    'This is a Veyra simulated wallet alert.',
    'No real bank transfer occurred.'
  ].join('\n');
}

export async function internalTransfer(
  senderId: string,
  recipientId: string,
  amount: Prisma.Decimal,
  narration: string | undefined,
  key: string,
  smsSenderId?: string,
  recipientAlias?: string
) {
  if (!key) throw new Error('IDEMPOTENCY_KEY_REQUIRED');
  if (amount.lte(0)) throw new Error('INVALID_AMOUNT');
  if (senderId === recipientId) throw new Error('SELF_TRANSFER');

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.idempotencyKey.findUnique({ where: { key }, include: { transaction: true } });
    if (existing) return { transaction: existing.transaction, created: false };

    const sender = await tx.user.findUnique({ where: { id: senderId }, include: { wallet: true } });
    const receiver = await tx.user.findUnique({ where: { id: recipientId }, include: { wallet: true } });

    if (!sender || !receiver || !sender.wallet || !receiver.wallet) throw new Error('ACCOUNT_NOT_FOUND');
    if (sender.status !== 'ACTIVE' || receiver.status !== 'ACTIVE') throw new Error('ACCOUNT_NOT_ACTIVE');
    if (sender.wallet.balance.lt(amount)) throw new Error('INSUFFICIENT_BALANCE');

    const ref = reference('INT');
    const txRecord = await tx.transaction.create({
      data: {
        reference: ref, senderId, receiverId: recipientId,
        type: TransactionType.INTERNAL_TRANSFER,
        status: TransactionStatus.PROCESSING,
        amount, fee: 0, vat: 0, total: amount, narration,
        recipientName: `${receiver.firstName} ${receiver.lastName}`,
        recipientAccount: receiver.accountNumber
      }
    });

    await tx.wallet.update({ where: { userId: senderId }, data: { balance: { decrement: amount } } });
    await tx.wallet.update({ where: { userId: recipientId }, data: { balance: { increment: amount } } });

    await tx.transactionEntry.createMany({
      data: [
        { transactionId: txRecord.id, userId: senderId, type: 'DEBIT', amount },
        { transactionId: txRecord.id, userId: recipientId, type: 'CREDIT', amount }
      ]
    });

    const completed = await tx.transaction.update({
      where: { id: txRecord.id },
      data: { status: TransactionStatus.SUCCESS, completedAt: new Date() }
    });

    await tx.notification.createMany({
      data: [
        { userId: senderId, type: NotificationType.TRANSFER_SENT, title: 'Transfer Successful', message: `₦${amount.toFixed(2)} was sent to ${receiver.firstName} ${receiver.lastName}.` },
        { userId: recipientId, type: NotificationType.TRANSFER_RECEIVED, title: 'Money Received', message: `₦${amount.toFixed(2)} was received from ${sender.firstName} ${sender.lastName}.` }
      ]
    });

    await tx.idempotencyKey.create({ data: { key, userId: senderId, transactionId: completed.id } });
    return { transaction: completed, created: true };
  });

  if (result.created) {
    try {
      const [senderAfter, receiverAfter] = await Promise.all([
        prisma.user.findUnique({ where: { id: senderId }, include: { wallet: true } }),
        prisma.user.findUnique({ where: { id: recipientId }, include: { wallet: true } })
      ]);

      if (senderAfter?.wallet && receiverAfter?.wallet) {
        const senderPhone = senderAfter.phone;
        const receiverPhone = receiverAfter.phone;

        if (!senderPhone || !receiverPhone) {
          console.warn('Veyra transfer SMS skipped: sender or receiver phone is missing.');
        } else {
        const senderName = `${senderAfter.firstName} ${senderAfter.lastName}`.trim();
        const receiverName = `${receiverAfter.firstName} ${receiverAfter.lastName}`.trim();
        const selectedSenderId = cleanSenderId(smsSenderId) || process.env.TERMII_SENDER_ID?.trim() || 'VEYRA';
        const alias = cleanRecipientAlias(recipientAlias);

        const senderMessage = buildSenderSms(receiverName, receiverAfter.accountNumber, amount, senderAfter.wallet.balance, result.transaction.reference, alias);
        const receiverMessage = buildReceiverSms(senderName, receiverAfter.accountNumber, amount, receiverAfter.wallet.balance, result.transaction.reference, alias);

        const smsResults = await Promise.allSettled([
          sendTermiiSms(senderPhone, senderMessage, selectedSenderId),
          sendTermiiSms(receiverPhone, receiverMessage, selectedSenderId)
        ]);

        for (const item of smsResults) {
          if (item.status === 'rejected') console.warn('Veyra transfer SMS failed:', item.reason?.name || 'unknown error');
          else if (!item.value.ok) console.warn('Veyra transfer SMS was not accepted:', item.value.reason || 'unknown Termii error');
        }
        }
      }
    } catch (error: any) {
      console.warn('Veyra transfer SMS preparation failed:', error?.name || 'unknown error');
    }
  }

  return result.transaction;
}
