import React, { useEffect, useState } from "react";
import { api } from "./api";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Home from "./pages/Home";

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [view, setView] = useState<"loading" | "auth" | "home">("loading");

  useEffect(() => {
    (async () => {
      try {
        const me = await api.me();
        setUser(me.user);
        setView("home");
      } catch {
        setView("auth");
      }
    })();
  }, []);

  if (view === "loading") return <div className="center">Waking Veyra securely…</div>;

  if (view === "auth")
    return (
      <div className="auth-shell">
        <div className="brand-row">
          <div className="brand-mark">V</div>
          <div>
            <div className="brand-name">Veyra</div>
            <div className="brand-subtitle">Internal Wallet</div>
          </div>
        </div>

        <div className="auth-card">
          <Login onLogin={(u) => { setUser(u); setView("home"); }} />
          <div className="divider" />
          <Register onRegister={(u) => { setUser(u); setView("home"); }} />
        </div>
      </div>
    );

  return <Home user={user} onLogout={() => { setUser(null); setView("auth"); }} />;
}