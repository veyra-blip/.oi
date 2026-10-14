const API = import.meta.env.VITE_API_URL || "http://localhost:4000/api";

let accessToken = sessionStorage.getItem("accessToken") || "";

export function setAccessToken(token: string) {
  accessToken = token;
  if (token) sessionStorage.setItem("accessToken", token);
  else sessionStorage.removeItem("accessToken");
}

export function getAccessToken() {
  return accessToken;
}

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const res = await fetch(`${API}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) throw new Error(data.message || "Request failed");
  return data;
}

export const api = {
  login: (identifier: string, password: string) =>
    request("/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) }),
  register: (body: any) =>
    request("/auth/register", { method: "POST", body: JSON.stringify(body) }),
  me: () => request("/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
  lookup: (q: string) => request(`/users/lookup?q=${encodeURIComponent(q)}`),
  transfer: (body: any) =>
    request("/transfers/internal", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body)
    }),
  transactions: () => request("/transactions"),
  notifications: () => request("/notifications"),
  readNotifications: () => request("/notifications/read-all", { method: "POST" }),
  banks: () => request("/banks"),
  bankLookup: (bankCode: string, accountNumber: string) =>
    request(`/banks/lookup?bankCode=${encodeURIComponent(bankCode)}&accountNumber=${encodeURIComponent(accountNumber)}`),
  payment: (body: any) =>
    request("/services/payment", { method: "POST", body: JSON.stringify(body) }),
  savings: () => request("/savings"),
  createSavings: (body: any) => request("/savings", { method: "POST", body: JSON.stringify(body) }),
  cards: () => request("/cards"),
  freezeCard: (id: string) => request(`/cards/${id}/freeze`, { method: "POST" }),
  loans: () => request("/loans"),
  applyLoan: (body: any) => request("/loans", { method: "POST", body: JSON.stringify(body) })
};
