import React, { useState } from "react";
import { api, setAccessToken } from "../api";

export default function Register({ onRegister }: { onRegister: (user: any) => void }) {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    username: "",
    phone: "",
    email: "",
    password: "",
    pin: ""
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    setLoading(true);

    try {
      const data = await api.register({
        firstName: form.firstName,
        lastName: form.lastName,
        username: form.username,
        phone: form.phone,
        email: form.email,
        password: form.password,
        pin: form.pin
      });

      if (!data.accessToken) {
        setError("Registration did not return a token.");
        return;
      }

      setAccessToken(data.accessToken);
      const me = await api.me();
      onRegister(me.user);
    } catch (err: any) {
      setError(err?.message || "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <h2>Create account</h2>
      <input placeholder="First name" value={form.firstName} onChange={(e) => update("firstName", e.target.value)} />
      <input placeholder="Last name" value={form.lastName} onChange={(e) => update("lastName", e.target.value)} />
      <input placeholder="Username" value={form.username} onChange={(e) => update("username", e.target.value)} />
      <input placeholder="Phone (080...)" value={form.phone} onChange={(e) => update("phone", e.target.value)} />
      <input placeholder="Email" value={form.email} onChange={(e) => update("email", e.target.value)} />
      <input placeholder="Password" type="password" value={form.password} onChange={(e) => update("password", e.target.value)} />
      <input placeholder="4-digit PIN" value={form.pin} onChange={(e) => update("pin", e.target.value)} />
      <button type="submit" disabled={loading}>{loading ? "Creating..." : "Create account"}</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}