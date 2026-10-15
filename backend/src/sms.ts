/**
 * Termii SMS integration for Veyra.
 *
 * IMPORTANT:
 * - TERMII_API_KEY must stay in Render environment variables.
 * - TERMII_BASE_URL is the account-specific base URL from the Termii dashboard.
 * - This helper accepts either a root base URL (https://v4.api.termii.com)
 *   or a base URL that already ends in /api.
 * - SMS failures never reverse a completed simulated wallet transaction.
 */

type TermiiResult = {
  ok: boolean;
  messageId?: string;
  reason?: string;
};

function normalizeNigerianPhone(value: string): string | null {
  const raw = String(value || "").trim().replace(/[\s()-]/g, "");
  if (/^0\d{10}$/.test(raw)) return `234${raw.slice(1)}`;
  if (/^234\d{10}$/.test(raw)) return raw;
  if (/^\+234\d{10}$/.test(raw)) return raw.slice(1);
  return null;
}

function termiiApiBase(): string {
  const configured = (process.env.TERMII_BASE_URL || "https://api.ng.termii.com/api").trim().replace(/\/+$/, "");
  return /\/api$/i.test(configured) ? configured : `${configured}/api`;
}

export async function sendTermiiSms(to: string, sms: string): Promise<TermiiResult> {
  const apiKey = process.env.TERMII_API_KEY?.trim();
  const senderId = process.env.TERMII_SENDER_ID?.trim();
  const channel = (process.env.TERMII_CHANNEL || "dnd").trim();
  const normalizedTo = normalizeNigerianPhone(to);

  if (!apiKey || !senderId) {
    console.warn("Termii SMS skipped: TERMII_API_KEY or TERMII_SENDER_ID is not configured.");
    return { ok: false, reason: "TERMII_NOT_CONFIGURED" };
  }

  if (!normalizedTo) {
    console.warn("Termii SMS skipped: recipient phone number is not a valid Nigerian mobile number.");
    return { ok: false, reason: "INVALID_RECIPIENT_PHONE" };
  }

  if (!sms.trim()) {
    return { ok: false, reason: "EMPTY_SMS" };
  }

  try {
    const response = await fetch(`${termiiApiBase()}/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        to: normalizedTo,
        from: senderId,
        sms,
        type: "plain",
        channel
      }),
      signal: AbortSignal.timeout(12000)
    });

    let data: any = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok || data?.code === "error" || data?.status === false) {
      // Do not log the API key, destination phone, or SMS body.
      console.warn("Termii SMS request failed. HTTP status:", response.status);
      return { ok: false, reason: "TERMII_REQUEST_FAILED" };
    }

    return {
      ok: true,
      messageId: data?.message_id ? String(data.message_id) : undefined
    };
  } catch (error: any) {
    // Do not log credentials, phone numbers, or message content.
    console.warn("Termii SMS request could not be completed:", error?.name || "network error");
    return { ok: false, reason: "TERMII_NETWORK_ERROR" };
  }
}
