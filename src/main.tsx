import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Bell, Building2, CheckCircle2, Eye, EyeOff, Fingerprint,
  Home, Inbox, Lock, LogOut, Menu, MoreHorizontal, PiggyBank, Send,
  Settings, ShieldCheck, Smartphone, UserRound, WalletCards, Zap
} from "lucide-react";
import "./index.css";
import { api, getAccessToken, setAccessToken } from "./api";

type User = {
  firstName: string; lastName: string; username: string; phone: string;
  email: string; accountNumber: string; balance: string;
};

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/*" element={<Protected />} />
      </Routes>
    </BrowserRouter>
  );
}

function Protected() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getAccessToken()) { setLoading(false); return; }
    api.me().then(r => setUser(r.user)).catch(() => setAccessToken("")).finally(() => setLoading(false));
  }, []);

  if (loading) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <Shell user={user} onUser={setUser}>
      <Routes>
        <Route index element={<HomePage user={user} />} />
        <Route path="send" element={<SendPage />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="savings" element={<SavingsPage />} />
        <Route path="cards" element={<CardsPage />} />
        <Route path="loans" element={<LoansPage />} />
        <Route path="profile" element={<ProfilePage user={user} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function Splash() {
  return <div className="min-h-screen bg-[#090b0a] text-white grid place-items-center"><div className="animate-pulse text-2xl font-black">Wallet</div></div>;
}

function Shell({ user, onUser, children }: { user: User; onUser: (u: User) => void; children: React.ReactNode }) {
  const navigate = useNavigate();
  const logout = async () => { await api.logout().catch(() => {}); setAccessToken(""); navigate("/login"); };

  return (
    <div className="min-h-screen bg-[#090b0a] text-white">
      <div className="mx-auto min-h-screen max-w-md bg-[#101312] shadow-2xl">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-white/10 bg-[#101312]/95 px-4 py-3 backdrop-blur">
          <button onClick={() => navigate("/")} className="font-black tracking-tight">WALLET</button>
          <div className="flex gap-3 text-gray-300">
            <button onClick={() => navigate("/notifications")}><Bell size={19}/></button>
            <button onClick={logout}><LogOut size={19}/></button>
          </div>
        </header>
        <main className="pb-24">{children}</main>
        <nav className="fixed bottom-0 left-1/2 z-20 flex w-full max-w-md -translate-x-1/2 justify-around border-t border-white/10 bg-[#101312]/95 p-2 backdrop-blur">
          <NavItem to="/" icon={<Home size={18}/>} label="Home"/>
          <NavItem to="/history" icon={<WalletCards size={18}/>} label="History"/>
          <NavItem to="/notifications" icon={<Inbox size={18}/>} label="Inbox"/>
          <NavItem to="/profile" icon={<UserRound size={18}/>} label="Me"/>
        </nav>
      </div>
    </div>
  );
}

function NavItem({to, icon, label}: any) {
  return <Link to={to} className="flex flex-col items-center gap-1 px-4 py-1 text-[10px] text-gray-400 hover:text-[#00d084]">{icon}{label}</Link>;
}

function Login() {
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("08000000001");
  const [password, setPassword] = useState("DemoPass123!");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    try {
      const r = await api.login(identifier, password);
      setAccessToken(r.accessToken);
      navigate("/");
      location.reload();
    } catch (e: any) { setError(e.message); }
  }

  return <AuthCard title="Welcome back" subtitle="Sign in to your internal wallet">
    <form onSubmit={submit} className="space-y-4">
      <Input label="Phone or email" value={identifier} onChange={setIdentifier}/>
      <Input label="Password" type="password" value={password} onChange={setPassword}/>
      {error && <ErrorText>{error}</ErrorText>}
      <Primary>Sign in</Primary>
    </form>
    <button onClick={() => navigate("/register")} className="mt-5 w-full text-sm text-[#00d084]">Create account</button>
  </AuthCard>;
}

function Register() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    firstName:"",lastName:"",username:"",phone:"",email:"",password:"",pin:""
  });
  const [error, setError] = useState("");

  const set = (k:string) => (v:string) => setForm(f => ({...f,[k]:v}));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    try {
      const r = await api.register(form);
      setAccessToken(r.accessToken);
      navigate("/");
      location.reload();
    } catch (e:any) { setError(e.message); }
  }

  return <AuthCard title="Create your wallet" subtitle="Internal network account">
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Input label="First name" value={form.firstName} onChange={set("firstName")}/>
        <Input label="Last name" value={form.lastName} onChange={set("lastName")}/>
      </div>
      <Input label="Username" value={form.username} onChange={set("username")}/>
      <Input label="Phone" value={form.phone} onChange={set("phone")} placeholder="08012345678"/>
      <Input label="Email" type="email" value={form.email} onChange={set("email")}/>
      <Input label="Password" type="password" value={form.password} onChange={set("password")}/>
      <Input label="4-digit transaction PIN" inputMode="numeric" value={form.pin} onChange={set("pin")}/>
      {error && <ErrorText>{error}</ErrorText>}
      <Primary>Create account</Primary>
    </form>
    <button onClick={() => navigate("/login")} className="mt-5 w-full text-sm text-gray-400">Back to sign in</button>
  </AuthCard>;
}

function AuthCard({title,subtitle,children}:any) {
  return <div className="min-h-screen bg-[#090b0a] px-5 py-10 text-white">
    <div className="mx-auto max-w-md rounded-3xl border border-white/10 bg-[#101312] p-6 shadow-2xl">
      <div className="mb-8">
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-[#00d084] text-black"><ShieldCheck/></div>
        <h1 className="text-2xl font-black">{title}</h1>
        <p className="mt-1 text-sm text-gray-400">{subtitle}</p>
      </div>
      {children}
    </div>
  </div>;
}

function HomePage({user}:{user:User}) {
  const [hide, setHide] = useState(false);
  const money = Number(user.balance);
  const actions = [
    ["/send","Send",Send],["/services","Bills",Zap],["/savings","Save",PiggyBank],["/cards","Cards",WalletCards],
    ["/loans","Loans",Building2],["/history","History",WalletCards],["/profile","Security",Lock],["/services","More",MoreHorizontal]
  ];
  return <div className="p-4">
    <div className="mb-5 flex items-center justify-between">
      <div><p className="text-sm text-gray-400">Hi, {user.firstName}</p><p className="font-bold">@{user.username}</p></div>
      <Link to="/profile" className="grid h-10 w-10 place-items-center rounded-full bg-[#00d084]/15 text-[#00d084]"><UserRound size={19}/></Link>
    </div>
    <section className="rounded-3xl bg-[#00d084] p-5 text-black shadow-xl">
      <div className="flex items-center justify-between text-xs font-bold">
        <span>Available balance</span>
        <button onClick={()=>setHide(!hide)}>{hide?<EyeOff size={17}/>:<Eye size={17}/>}</button>
      </div>
      <div className="mt-2 text-3xl font-black">{hide ? "₦••••••••" : `₦${money.toLocaleString("en-NG",{minimumFractionDigits:2})}`}</div>
      <div className="mt-5 border-t border-black/10 pt-3 text-xs font-bold">Account {user.accountNumber}</div>
    </section>
    <div className="mt-5 grid grid-cols-4 gap-3">
      {actions.map(([to,label,Icon]:any)=><Link key={label} to={to} className="rounded-2xl bg-[#181c1a] p-3 text-center hover:bg-[#202522]"><div className="mx-auto mb-2 grid h-10 w-10 place-items-center rounded-xl bg-[#00d084]/10 text-[#00d084]"><Icon size={18}/></div><span className="text-[11px] text-gray-300">{label}</span></Link>)}
    </div>
    <div className="mt-6 rounded-2xl border border-white/10 bg-[#151917] p-4">
      <p className="text-xs text-gray-400">Internal network</p>
      <p className="mt-1 text-sm">Transfers stay inside this application's simulated ledger.</p>
    </div>
  </div>;
}

function SendPage() {
  const [target,setTarget] = useState("");
  const [recipient,setRecipient] = useState<any>(null);
  const [amount,setAmount] = useState("");
  const [narration,setNarration] = useState("");
  const [pin,setPin] = useState("");
  const [error,setError] = useState("");
  const [done,setDone] = useState<any>(null);

  async function lookup() {
    try { const r=await api.lookup(target); setRecipient(r.recipient); setError(""); }
    catch(e:any){setRecipient(null);setError(e.message);}
  }

  async function submit(e:React.FormEvent) {
    e.preventDefault(); setError("");
    try {
      const r=await api.transfer({recipientId:recipient.id,amount,narration,pin});
      setDone(r.transaction);
    } catch(e:any){setError(e.message);}
  }

  if (done) return <div className="p-6 text-center"><div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-[#00d084]/15 text-[#00d084]"><CheckCircle2 size={44}/></div><h2 className="mt-5 text-2xl font-black">Transfer successful</h2><p className="mt-2 text-gray-400">₦{Number(done.amount).toLocaleString()} sent successfully.</p><p className="mt-4 rounded-xl bg-[#181c1a] p-3 text-xs">Reference: {done.reference}</p><Link to="/" className="mt-5 block rounded-xl bg-[#00d084] p-3 font-bold text-black">Done</Link></div>;

  return <Page title="Send money"><form onSubmit={submit} className="space-y-4">
    <Input label="Recipient phone, username or account number" value={target} onChange={setTarget} placeholder="080... / username / 81..."/>
    <button type="button" onClick={lookup} className="w-full rounded-xl bg-[#202522] p-3 text-sm font-bold">Find recipient</button>
    {recipient && <div className="rounded-2xl border border-[#00d084]/30 bg-[#00d084]/5 p-4"><p className="text-xs text-gray-400">Recipient</p><p className="font-bold">{recipient.firstName} {recipient.lastName}</p><p className="text-xs text-gray-400">{recipient.accountNumber} · @{recipient.username}</p></div>}
    <Input label="Amount" type="number" value={amount} onChange={setAmount} placeholder="1000"/>
    <Input label="Narration (optional)" value={narration} onChange={setNarration} placeholder="What's this for?"/>
    <Input label="Transaction PIN" type="password" inputMode="numeric" value={pin} onChange={setPin}/>
    {error && <ErrorText>{error}</ErrorText>}
    <Primary disabled={!recipient}>Send securely</Primary>
  </form></Page>;
}

function HistoryPage() {
  const [rows,setRows]=useState<any[]>([]);
  useEffect(()=>{api.transactions().then(r=>setRows(r.transactions)).catch(()=>{});},[]);
  return <Page title="Transaction history"><div className="space-y-2">{rows.length===0?<Empty text="No transactions yet."/>:rows.map(t=><div key={t.id} className="rounded-2xl bg-[#181c1a] p-4"><div className="flex justify-between gap-4"><div><p className="text-sm font-bold">{t.type.replaceAll("_"," ")}</p><p className="text-[11px] text-gray-500">{new Date(t.createdAt).toLocaleString()} · {t.reference}</p></div><p className={t.senderId ? "text-red-300 font-bold":"text-[#00d084] font-bold"}>{t.senderId?"-":"+"}₦{Number(t.amount).toLocaleString()}</p></div></div>)}</div></Page>;
}

function NotificationsPage() {
  const [rows,setRows]=useState<any[]>([]);
  useEffect(()=>{api.notifications().then(r=>setRows(r.notifications)).catch(()=>{});},[]);
  return <Page title="Inbox"><button onClick={async()=>{await api.readNotifications();setRows(r=>r.map(x=>({...x,read:true})))}} className="mb-4 text-xs text-[#00d084]">Mark all read</button><div className="space-y-2">{rows.length===0?<Empty text="No notifications."/>:rows.map(n=><div key={n.id} className={`rounded-2xl border p-4 ${n.read?"border-white/5 bg-[#181c1a]":"border-[#00d084]/30 bg-[#00d084]/5"}`}><p className="font-bold text-sm">{n.title}</p><p className="mt-1 text-xs text-gray-400">{n.message}</p><p className="mt-2 text-[10px] text-gray-600">{new Date(n.createdAt).toLocaleString()}</p></div>)}</div></Page>;
}

function ServicesPage() {
  const [type,setType]=useState("AIRTIME"); const [target,setTarget]=useState(""); const [amount,setAmount]=useState(""); const [pin,setPin]=useState(""); const [msg,setMsg]=useState("");
  async function pay(e:React.FormEvent){e.preventDefault();setMsg("");try{await api.payment({type,target,amount,pin});setMsg("Payment successful.");setTarget("");setAmount("");setPin("");}catch(e:any){setMsg(e.message);}}
  return <Page title="Bills & services"><div className="grid grid-cols-2 gap-3 mb-5">{["AIRTIME","DATA","ELECTRICITY","TV","INTERNET","WATER","EDUCATION"].map(x=><button key={x} onClick={()=>setType(x)} className={`rounded-xl p-3 text-xs font-bold ${type===x?"bg-[#00d084] text-black":"bg-[#181c1a] text-gray-300"}`}>{x}</button>)}</div><form onSubmit={pay} className="space-y-3"><Input label="Target" value={target} onChange={setTarget} placeholder="Phone / meter / smartcard"/><Input label="Amount" type="number" value={amount} onChange={setAmount}/><Input label="PIN" type="password" inputMode="numeric" value={pin} onChange={setPin}/>{msg&&<p className="text-sm text-gray-300">{msg}</p>}<Primary>Pay {type}</Primary></form></Page>;
}

function SavingsPage() {
  const [rows,setRows]=useState<any[]>([]); const [name,setName]=useState(""); const [type,setType]=useState("TARGET");
  const load=()=>api.savings().then(r=>setRows(r.savings)); useEffect(load,[]);
  async function create(e:React.FormEvent){e.preventDefault();await api.createSavings({name,type});setName("");load();}
  return <Page title="Savings"><form onSubmit={create} className="space-y-3 mb-6"><Input label="Savings name" value={name} onChange={setName}/><select value={type} onChange={e=>setType(e.target.value)} className="w-full rounded-xl border border-white/10 bg-[#181c1a] p-3 text-sm"><option>TARGET</option><option>DAILY</option><option>FIXED</option><option>SAFEBOX</option></select><Primary>Create savings</Primary></form><div className="space-y-2">{rows.map(s=><div key={s.id} className="rounded-2xl bg-[#181c1a] p-4"><p className="font-bold">{s.name}</p><p className="text-xs text-gray-400">{s.type} · ₦{Number(s.balance).toLocaleString()}</p></div>)}</div></Page>;
}

function CardsPage() {
  const [rows,setRows]=useState<any[]>([]); useEffect(()=>{api.cards().then(r=>setRows(r.cards)).catch(()=>{});},[]);
  return <Page title="Cards"><div className="space-y-3">{rows.length===0?<Empty text="No simulated cards yet. Create card functionality can be added to the admin/test module."/>:rows.map(c=><div key={c.id} className="rounded-3xl bg-gradient-to-br from-[#00d084] to-[#075b3d] p-5 text-black"><p className="text-xs font-bold">WALLET CARD</p><p className="mt-8 text-lg font-black tracking-widest">{c.maskedNumber}</p><p className="mt-4 text-xs">EXP {c.expiryMonth}/{c.expiryYear} · {c.status}</p><button onClick={async()=>{await api.freezeCard(c.id);location.reload()}} className="mt-4 rounded-lg bg-black/20 px-3 py-2 text-xs font-bold">{c.status==="FROZEN"?"Unfreeze":"Freeze"} card</button></div>)}</div></Page>;
}

function LoansPage() {
  const [amount,setAmount]=useState("100000"); const [duration,setDuration]=useState("6"); const [rows,setRows]=useState<any[]>([]); const load=()=>api.loans().then(r=>setRows(r.loans)); useEffect(load,[]);
  async function apply(e:React.FormEvent){e.preventDefault();await api.applyLoan({amount,durationMonths:duration});load();}
  return <Page title="Loans"><form onSubmit={apply} className="space-y-3 mb-6"><Input label="Amount" type="number" value={amount} onChange={setAmount}/><Input label="Duration (months)" type="number" value={duration} onChange={setDuration}/><Primary>Apply for simulated loan</Primary></form><div className="space-y-2">{rows.map(l=><div key={l.id} className="rounded-2xl bg-[#181c1a] p-4"><p className="font-bold">₦{Number(l.amount).toLocaleString()}</p><p className="text-xs text-gray-400">{l.status} · total repayment ₦{Number(l.totalRepayable).toLocaleString()}</p></div>)}</div></Page>;
}

function ProfilePage({user}:{user:User}) {
  return <Page title="Security & profile"><div className="rounded-2xl bg-[#181c1a] p-4"><p className="font-bold">{user.firstName} {user.lastName}</p><p className="text-xs text-gray-400">@{user.username}</p><p className="mt-3 text-xs text-gray-400">{user.phone} · {user.email}</p><p className="mt-2 text-xs text-gray-400">Account: {user.accountNumber}</p></div><div className="mt-4 space-y-2"><div className="rounded-2xl bg-[#181c1a] p-4"><div className="flex items-center gap-3"><Fingerprint className="text-[#00d084]"/><div><p className="font-bold text-sm">Biometric-ready security</p><p className="text-xs text-gray-500">Use WebAuthn/native biometrics when packaging this app.</p></div></div></div><div className="rounded-2xl bg-[#181c1a] p-4"><div className="flex items-center gap-3"><Settings className="text-[#00d084]"/><div><p className="font-bold text-sm">NightGuard / Large Transaction Shield</p><p className="text-xs text-gray-500">Server-side rules should trigger additional verification for protected transactions.</p></div></div></div></div></Page>;
}

function Page({title,children}:{title:string;children:React.ReactNode}) {
  const navigate=useNavigate(); return <div className="p-4"><div className="mb-5 flex items-center gap-3"><button onClick={()=>navigate(-1)}><ArrowLeft size={20}/></button><h1 className="text-xl font-black">{title}</h1></div>{children}</div>;
}
function Input({label,value,onChange,type="text",placeholder="",inputMode}:any){return <label className="block"><span className="mb-1 block text-xs font-semibold text-gray-400">{label}</span><input type={type} inputMode={inputMode} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} className="w-full rounded-xl border border-white/10 bg-[#181c1a] p-3 text-sm text-white outline-none focus:border-[#00d084]"/></label>}
function Primary({children,disabled=false}:any){return <button disabled={disabled} className="w-full rounded-xl bg-[#00d084] p-3.5 font-black text-black disabled:cursor-not-allowed disabled:opacity-40">{children}</button>}
function ErrorText({children}:any){return <p className="rounded-xl bg-red-500/10 p-3 text-xs text-red-300">{children}</p>}
function Empty({text}:any){return <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-gray-500">{text}</div>}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
