const API = (import.meta.env.VITE_API_URL as string) || "/api";

let accessToken = sessionStorage.getItem("accessToken") || "";

export function setAccessToken(token: string) {
  accessToken = token;
  if (token) sessionStorage.setItem("accessToken", token);
  else sessionStorage.removeItem("accessToken");
}

async function refreshAccessToken(): Promise<string> {
  const res = await fetch(`${API}/auth/refresh`, {
    method: "POST",
    credentials: "include"
  });

  if (!res.ok) throw new Error("Refresh failed");

  const data = await res.json().catch(() => ({}));
  if (!data.accessToken) throw new Error("No access token returned");

  setAccessToken(data.accessToken);
  return data.accessToken;
}

async function request(path: string, options: RequestInit = {}, retry = true): Promise<any> {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");

  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  const res = await fetch(`${API}${path}`, {
    ...options,
    headers,
    credentials: "include"
  });

  if (res.status === 401 && retry) {
    try {
      const nextToken = await refreshAccessToken();
      headers.set("Authorization", `Bearer ${nextToken}`);

      const retryRes = await fetch(`${API}${path}`, {
        ...options,
        headers,
        credentials: "include"
      });

      const retryData = await retryRes.json().catch(() => ({}));
      if (!retryRes.ok) throw new Error(retryData.message || "Request failed");
      return retryData;
    } catch {
      throw new Error("Unauthenticated");
    }
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Request failed");
  return data;
}

export const api = {
  login: (identifier: string, password: string) =>
    request("/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) }),
  register: (body: any) => request("/auth/register", { method: "POST", body: JSON.stringify(body) }),
  me: () => request("/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
  usersLookup: (q: string) => request(`/users/lookup?q=${encodeURIComponent(q)}`),
  internalTransfer: (body: any) => request("/transfers/internal", { method: "POST", body: JSON.stringify(body) }),
  externalSimulate: (body: any) => request("/transfers/external/simulate", { method: "POST", body: JSON.stringify(body) }),
  transactions: () => request("/transactions"),
  notifications: () => request("/notifications"),
  banks: () => request("/banks"),
  payment: (body: any) => request("/services/payment", { method: "POST", body: JSON.stringify(body) }),
  banksLookup: (bankCode: string, accountNumber: string) =>
    request(`/banks/lookup?bankCode=${encodeURIComponent(bankCode)}&accountNumber=${encodeURIComponent(accountNumber)}`)
};