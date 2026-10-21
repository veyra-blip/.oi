type TermiiResult = { ok: boolean; messageId?: string; reason?: string };

function normalizeNigerianPhone(value: string): string | null {
  const raw = String(value || '').trim().replace(/[\s()-]/g, '');
  if (/^0\d{10}$/.test(raw)) return `234${raw.slice(1)}`;
  if (/^234\d{10}$/.test(raw)) return raw;
  if (/^\+234\d{10}$/.test(raw)) return raw.slice(1);
  return null;
}

function cleanSenderId(value: string | undefined): string | null {
  const sender = String(value || '').trim().replace(/\s+/g, ' ');
  if (!sender) return null;
  return sender.replace(/[\r\n\t]/g, '').slice(0, 30).trim() || null;
}

function selectedSenderId(requested?: string) {
  const allowed = (process.env.TERMII_SENDER_IDS || '')
    .split(',')
    .map(x => cleanSenderId(x))
    .filter((x): x is string => Boolean(x));
  if (!allowed.length) return cleanSenderId(requested) || cleanSenderId(process.env.TERMII_SENDER_ID);
  const requestedClean = cleanSenderId(requested);
  return (requestedClean && allowed.includes(requestedClean)) ? requestedClean : allowed[0];
}

function termiiApiBase() {
  const configured = (process.env.TERMII_BASE_URL || 'https://api.ng.termii.com/api').trim().replace(/\/+$/, '');
  return /\/api$/i.test(configured) ? configured : `${configured}/api`;
}

export async function sendTermiiSms(to: string, sms: string, requestedSenderId?: string): Promise<TermiiResult> {
  const apiKey = process.env.TERMII_API_KEY?.trim();
  const senderId = selectedSenderId(requestedSenderId);
  const channel = (process.env.TERMII_CHANNEL || 'dnd').trim();
  const normalizedTo = normalizeNigerianPhone(to);
  if (!apiKey || !senderId) return { ok: false, reason: 'TERMII_NOT_CONFIGURED' };
  if (!normalizedTo) return { ok: false, reason: 'INVALID_RECIPIENT_PHONE' };
  if (!sms.trim()) return { ok: false, reason: 'EMPTY_SMS' };

  try {
    const response = await fetch(`${termiiApiBase()}/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, to: normalizedTo, from: senderId, sms, type: 'plain', channel }),
      signal: AbortSignal.timeout(12000)
    });
    let data: any = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data?.code === 'error' || data?.status === false) {
      return { ok: false, reason: 'TERMII_REQUEST_FAILED' };
    }
    return { ok: true, messageId: data?.message_id ? String(data.message_id) : undefined };
  } catch {
    return { ok: false, reason: 'TERMII_NETWORK_ERROR' };
  }
}
