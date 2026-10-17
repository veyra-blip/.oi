import React, { useEffect, useState } from "react";
import { api } from "../api";

export default function Home({ user, onLogout }: { user: any; onLogout: () => void; }) {
  const [balance, setBalance] = useState("0");
  const [transactions, setTransactions] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [recipient, setRecipient] = useState<any>(null);
  const [amount, setAmount] = useState("");
  const [narration, setNarration] = useState("");
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => { loadDashboard(); }, []);

  async function loadDashboard() {
    try {
      const me = await api.me();
      setBalance(me.user.balance || "0");
      const txData = await api.transactions();
      setTransactions(txData.transactions || []);
      const noteData = await api.notifications();
      setNotifications(noteData.notifications || []);
    } catch { setStatus("Unable to load dashboard."); }
  }

  async function handleLookup() {
    if (!search.trim()) return;
    try {
      const data = await api.usersLookup(search);
      setRecipient(data.recipient);
      setStatus("Recipient found.");
    } catch {
      setRecipient(null);
      setStatus("Recipient not found.");
    }
  }

  async function handleTransfer(e?: React.FormEvent) {
    e?.preventDefault();
    if (!recipient) { setStatus("Choose a valid recipient first."); return; }
    try {
      await api.internalTransfer({ recipientId: recipient.id, amount: Number(amount), narration, pin });
      setStatus("Transfer sent successfully.");
      setAmount(""); setNarration(""); setPin(""); setRecipient(null); setSearch("");
      await loadDashboard();
    } catch (err: any) { setStatus(err?.message || "Transfer failed"); }
  }

  async function logout() { try { await api.logout(); } catch {} onLogout(); }

  return (
    <div className="home-shell">
      <div className="topbar">
        <div>
          <div className="eyebrow">My account</div>
          <h1>{user.firstName} {user.lastName}</h1>
        </div>
        <button className="outline-btn" onClick={logout}>Logout</button>
      </div>

      <div className="wallet-card">
        <div className="wallet-label">Available balance</div>
        <div className="wallet-balance">₦{Number(balance).toLocaleString()}</div>
      </div>

      <div className="card-grid">
        <div className="card-panel">
          <h3>Transfer</h3>
          <div className="search-box">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by username / phone / account number" />
            <button className="accent-btn" onClick={handleLookup}>Lookup</button>
          </div>

          {recipient && (
            <div className="recipient-box">
              <div><strong>{recipient.firstName} {recipient.lastName}</strong></div>
              <div>@{recipient.username}</div>
              <div>{recipient.accountNumber}</div>
            </div>
          )}

          <form className="transfer-form" onSubmit={handleTransfer}>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" />
            <input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Narration (optional)" />
            <input value={pin} onChange={(e) => setPin(e.target.value)} type="password" placeholder="Transaction PIN" />
            <button type="submit" className="primary-btn">Send transfer</button>
          </form>
        </div>

        <div className="card-panel">
          <h3>Notifications</h3>
          <div className="notification-list">
            {notifications.length ? notifications.map((n: any) => (
              <div key={n.id} className="notification-item">
                <div className="notification-title">{n.title}</div>
                <div className="notification-message">{n.message}</div>
              </div>
            )) : <div className="empty-state">No notifications</div>}
          </div>
        </div>
      </div>

      <div className="card-panel full-width">
        <h3>Recent transactions</h3>
        <div className="transaction-list">
          {transactions.length ? transactions.map((tx: any) => (
            <div className="transaction-row" key={tx.id}>
              <div>
                <div className="transaction-label">{tx.type}</div>
                <div className="transaction-meta">{new Date(tx.createdAt).toLocaleString()}</div>
              </div>
              <div className={`transaction-amount ${tx.type?.toLowerCase().includes("credit") ? "up" : "down"}`}>
                ₦{Number(tx.amount).toLocaleString()}
              </div>
            </div>
          )) : <div className="empty-state">No transactions yet</div>}
        </div>
      </div>

      <div className="receipt-watermark">SIMULATED</div>
      {status && <div className="status-bar">{status}</div>}
    </div>
  );
}