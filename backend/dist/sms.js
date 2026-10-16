/**
 * Termii SMS integration for Veyra.
 *
 * TERMII_API_KEY and TERMII_BASE_URL stay on the backend/Render only.
 * The Sender ID is selected by the backend from TERMII_SENDER_IDS.
 * SMS failures never reverse a completed simulated wallet transaction.
 */
function normalizeNigerianPhone(value) {
    const raw = String(value || "").trim().replace(/[\s()-]/g, "");
    if (/^0\d{10}$/.test(raw))
        return `234${raw.slice(1)}`;
    if (/^234\d{10}$/.test(raw))
        return raw;
    if (/^\+234\d{10}$/.test(raw))
        return raw.slice(1);
    return null;
}
function termiiApiBase() {
    const configured = (process.env.TERMII_BASE_URL || "https://api.ng.termii.com/api")
        .trim()
        .replace(/\/+$/, "");
    return /\/api$/i.test(configured) ? configured : `${configured}/api`;
}
function cleanSenderId(value) {
    const sender = String(value || "")
        .replace(/[\r\n\t]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return sender || null;
}
export async function sendTermiiSms(to, sms, senderId) {
    const apiKey = process.env.TERMII_API_KEY?.trim();
    const configuredSenderId = cleanSenderId(senderId);
    const channel = (process.env.TERMII_CHANNEL || "dnd").trim();
    const normalizedTo = normalizeNigerianPhone(to);
    if (!apiKey || !configuredSenderId) {
        console.warn("Termii SMS skipped: API key or approved Sender ID is not configured.");
        return { ok: false, reason: "TERMII_NOT_CONFIGURED" };
    }
    if (!normalizedTo) {
        console.warn("Termii SMS skipped: invalid Nigerian recipient phone number.");
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
                from: configuredSenderId,
                sms,
                type: "plain",
                channel
            }),
            signal: AbortSignal.timeout(12000)
        });
        let data = {};
        try {
            data = await response.json();
        }
        catch {
            data = {};
        }
        if (!response.ok || data?.code === "error" || data?.status === false) {
            console.warn("Termii SMS request failed. HTTP status:", response.status);
            if (data?.message) {
                console.warn("Termii response message:", String(data.message).slice(0, 300));
            }
            return {
                ok: false,
                reason: data?.message
                    ? `TERMII_REQUEST_FAILED:${String(data.message).slice(0, 200)}`
                    : "TERMII_REQUEST_FAILED"
            };
        }
        return {
            ok: true,
            messageId: data?.message_id ? String(data.message_id) : undefined
        };
    }
    catch (error) {
        console.warn("Termii SMS request could not be completed:", error?.name || "network error");
        return { ok: false, reason: "TERMII_NETWORK_ERROR" };
    }
}
