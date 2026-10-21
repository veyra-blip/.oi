
/* ==========================================
   VEYRA WEBSITE
   Welcome, authentication and dashboard
   API: Veyra backend
   ========================================== */

const API_BASE = "https://veyra-api-etnq.onrender.com";
const app = document.getElementById("app");


function readSavedSession() {
  try {
    const saved = localStorage.getItem("veyra_session");
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

const savedSession = readSavedSession();

const state = {
  screen: savedSession?.accessToken && savedSession?.user
    ? "home"
    : "welcome",
  history: [],
  user: savedSession?.user || null,
  account: savedSession?.account || null,
  accessToken: savedSession?.accessToken || null,
  busy: false,
  error: "",
  notice: ""
};


function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function moneyFromKobo(value) {
  const kobo = Number(value ?? 0);
  if (!Number.isFinite(kobo)) return "Unavailable";

  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(kobo / 100);
}

function go(screen) {
  state.history.push(state.screen);
  state.screen = screen;
  state.error = "";
  state.notice = "";
  render();
}

function back() {
  state.screen = state.history.pop() || (
    state.user ? "home" : "welcome"
  );
  state.error = "";
  state.notice = "";
  render();
}

function showMessage(message, type = "error") {
  state.error = type === "error" ? message : "";
  state.notice = type === "success" ? message : "";
  render();
}

function messageMarkup() {
  if (state.error) {
    return `<div class="card" role="alert"
      style="border-color:#a94442;color:#a94442">
      ${escapeHTML(state.error)}
    </div>`;
  }

  if (state.notice) {
    return `<div class="card" role="status"
      style="border-color:#31785b;color:#31785b">
      ${escapeHTML(state.notice)}
    </div>`;
  }

  return "";
}

function brand() {
  return `<div class="brand">Veyra<span
    style="color:#c5a15b">.</span></div>`;
}

function button(label, action, extra = "") {
  return `<button class="primary" type="button"
    data-action="${escapeHTML(action)}" ${extra}>
    ${escapeHTML(label)}
  </button>`;
}

function welcomeScreen() {
  return `
    <section class="center">
      <div class="login">
        ${brand()}
        <p class="muted">A more considered way to manage your money.</p>

        <div class="card" style="margin-top:32px">
          <div style="color:#c5a15b;font-size:12px;
            font-weight:800;letter-spacing:2px">
            WELCOME TO VEYRA
          </div>

          <h1 class="title">Your money.<br>Your direction.</h1>

          <p class="sub">
            Access your account, manage your details and explore
            the services available to you.
          </p>

          ${button("Log in", "login")}
          <button class="primary" type="button"
            data-action="register"
            style="background:#fff;color:#171714;
              border-color:#e9e5dc">
            Create an account
          </button>
        </div>

        <p class="muted" style="text-align:center;margin-top:22px">
          Secure access to your Veyra account
        </p>
      </div>
    </section>
  `;
}

function loginScreen() {
  return `
    <section class="center">
      <div class="login">
        <button class="back" type="button"
          data-action="back" aria-label="Go back">←</button>

        ${brand()}
        <h1 class="title">Welcome back</h1>
        <p class="sub">Log in to continue to your account.</p>

        ${messageMarkup()}

        <form id="login-form" class="card">
          <label for="login-identifier">Email or phone number</label>
          <input class="input" id="login-identifier"
            name="identifier" autocomplete="username"
            placeholder="Enter your email or phone number"
            required>

          <label for="login-password">Password</label>
          <input class="input" id="login-password"
            name="password" type="password"
            autocomplete="current-password"
            placeholder="Enter your password" required>

          <button class="primary" type="submit"
            ${state.busy ? "disabled" : ""}>
            ${state.busy ? "Logging in..." : "Log in securely"}
          </button>

          <p class="sub" style="margin-top:18px">
            Forgot your password? Password recovery is not yet
            connected. Contact the service administrator for now.
          </p>
        </form>

        <p class="sub" style="text-align:center;margin-top:18px">
          New to Veyra?
          <button type="button" data-action="register"
            style="border:0;background:none;color:#8b6c31;
              font-weight:800">
            Create an account
          </button>
        </p>
      </div>
    </section>
  `;
}

function registerScreen() {
  return `
    <section class="center">
      <div class="login">
        <button class="back" type="button"
          data-action="back" aria-label="Go back">←</button>

        ${brand()}
        <h1 class="title">Create your account</h1>
        <p class="sub">
          Enter your details to create your Veyra account.
        </p>

        ${messageMarkup()}

        <form id="register-form" class="card">
          <label for="firstName">First name</label>
          <input class="input" id="firstName"
            name="firstName" autocomplete="given-name"
            required>

          <label for="lastName">Last name</label>
          <input class="input" id="lastName"
            name="lastName" autocomplete="family-name"
            required>

          <label for="username">Username</label>
          <input class="input" id="username"
            name="username" autocomplete="username"
            placeholder="Choose a username" required>

          <label for="register-email">Email address</label>
          <input class="input" id="register-email"
            name="email" type="email" autocomplete="email"
            placeholder="you@example.com" required>

          <label for="register-phone">Phone number</label>
          <input class="input" id="register-phone"
            name="phone" type="tel" autocomplete="tel"
            placeholder="08012345678" required>

          <label for="register-password">Password</label>
          <input class="input" id="register-password"
            name="password" type="password"
            autocomplete="new-password" minlength="8"
            placeholder="At least 8 characters" required>

          <p class="sub">
            Use a strong, unique password. Identity verification
            and password recovery are separate features that
            still need to be implemented.
          </p>

          <button class="primary" type="submit"
            ${state.busy ? "disabled" : ""}>
            ${state.busy ? "Creating account..." : "Create account"}
          </button>
        </form>

        <p class="sub" style="text-align:center;margin-top:18px">
          Already registered?
          <button type="button" data-action="login"
            style="border:0;background:none;color:#8b6c31;
              font-weight:800">
            Log in
          </button>
        </p>
      </div>
    </section>
  `;
}

function nav(active) {
  const items = [
    ["home", "⌂", "Home"],
    ["send", "↗", "Send"],
    ["services", "◈", "Services"],
    ["history", "▤", "History"],
    ["profile", "◯", "Profile"]
  ];

  return `<nav class="nav" aria-label="Main navigation">
    ${items.map(([key, symbol, label]) => `
      <button type="button"
        class="${active === key ? "active" : ""}"
        data-action="navigate" data-screen="${key}">
        ${symbol}<br>${label}
      </button>
    `).join("")}
  </nav>`;
}

function dashboardScreen() {
  const user = state.user || {};
  const account = state.account || {};
  const name = user.firstName || user.username ||
    user.email || "there";

  const accountNumber = account.accountNumber || "Unavailable";

  return `
    <header class="top">
      ${brand()}
      <button class="icon-btn" type="button"
        data-action="navigate" data-screen="profile"
        aria-label="Open profile">◯</button>
    </header>

    <main class="content">
      <p class="sub">Good to see you, ${escapeHTML(name)}.</p>

      <section class="balance">
        <div class="muted">Available balance</div>
        <h1>${moneyFromKobo(account.balanceKobo)}</h1>
        <div class="muted">
          Veyra account · ${escapeHTML(accountNumber)}
        </div>
      </section>

      ${messageMarkup()}

      <h2 class="section">Quick actions</h2>
      <div class="grid">
        <button class="action" data-action="navigate"
          data-screen="send">↗<span>Send</span></button>
        <button class="action" data-action="navigate"
          data-screen="airtime">☎<span>Airtime</span></button>
        <button class="action" data-action="navigate"
          data-screen="data">⌁<span>Data</span></button>
        <button class="action" data-action="navigate"
          data-screen="history">▤<span>History</span></button>
      </div>

      <h2 class="section">Explore services</h2>
      ${serviceButton("⚡", "Electricity", "Electricity bill payments", "electricity")}
      ${serviceButton("▣", "Television", "TV subscriptions", "tv")}
      ${serviceButton("◎", "Internet", "Internet bill payments", "internet")}
      ${serviceButton("⌂", "Water", "Water bill payments", "water")}
      ${serviceButton("▤", "Education", "Education payments", "education")}

      <p class="sub" style="margin-top:24px">
        Your balance above comes from the account information
        returned by the authentication API. Refreshing the
        balance from the server requires a dedicated account
        endpoint, which has not yet been verified.
      </p>
    </main>

    ${nav("home")}
  `;
}

function serviceButton(symbol, title, description, screen) {
  return `
    <button class="service" type="button"
      data-action="navigate" data-screen="${escapeHTML(screen)}">
      <div class="ico">${symbol}</div>
      <div>
        <b>${escapeHTML(title)}</b>
        <small>${escapeHTML(description)}</small>
      </div>
      <b aria-hidden="true">›</b>
    </button>
  `;
}

function basicScreen(title, description, active) {
  return `
    <header class="top">
      ${brand()}
      <button class="icon-btn" type="button"
        data-action="navigate" data-screen="profile"
        aria-label="Open profile">◯</button>
    </header>

    <main class="screen">
      <button class="back" type="button"
        data-action="back" aria-label="Go back">←</button>

      <h1 class="title">${escapeHTML(title)}</h1>
      <p class="sub">${escapeHTML(description)}</p>

      ${messageMarkup()}

      <div class="card">
        <b>Service availability</b>
        <p>
          This section is not connected to a working service
          endpoint yet. No payment or transfer will be reported
          as successful from this screen.
        </p>
      </div>
    </main>

    ${nav(active)}
  `;
}

function profileScreen() {
  const user = state.user || {};
  const account = state.account || {};

  return `
<header class="top">
  ${brand()}
  <button class="icon-btn" type="button"
    data-action="navigate"
    data-screen="home"
    aria-label="Return to Home">←</button>
</header>

    <main class="screen">
      <h1 class="title">Your profile</h1>
      <p class="sub">Your current account information.</p>

      <div class="card">
        <p><b>Name</b><br>
          ${escapeHTML(
            [user.firstName, user.lastName].filter(Boolean).join(" ")
            || "Not provided"
          )}
        </p>

        <p><b>Username</b><br>
          ${escapeHTML(user.username || "Not provided")}
        </p>

        <p><b>Email</b><br>
          ${escapeHTML(user.email || "Not provided")}
        </p>

        <p><b>Phone</b><br>
          ${escapeHTML(user.phone || "Not provided")}
        </p>

        <p><b>Account number</b><br>
          ${escapeHTML(account.accountNumber || "Unavailable")}
        </p>

        <p><b>Account balance</b><br>
          ${moneyFromKobo(account.balanceKobo)}
        </p>

        <p class="sub">
          Profile editing, identity verification, and password
          recovery are not connected yet.
        </p>

        ${button("Log out", "logout")}
      </div>
    </main>

    ${nav("profile")}
  `;
}

function render() {
  if (!app) {
    console.error("Veyra app root element was not found.");
    return;
  }

  if (state.user && ["welcome", "login", "register"].includes(state.screen)) {
    state.screen = "home";
  }

  switch (state.screen) {
    case "welcome":
      app.innerHTML = welcomeScreen();
      break;
    case "login":
      app.innerHTML = loginScreen();
      break;
    case "register":
      app.innerHTML = registerScreen();
      break;
    case "home":
      app.innerHTML = dashboardScreen();
      break;
    case "profile":
      app.innerHTML = profileScreen();
      break;
    case "send":
      app.innerHTML = basicScreen(
        "Send money",
        "Review recipient and transfer details before authorisation.",
        "send"
      );
      break;
    case "services":
      app.innerHTML = basicScreen(
        "Services",
        "Explore available payment and account services.",
        "services"
      );
      break;
    case "airtime":
      app.innerHTML = basicScreen(
        "Airtime",
        "Airtime purchases will be enabled after provider integration.",
        "services"
      );
      break;
    case "data":
      app.innerHTML = basicScreen(
        "Data",
        "Data purchases will be enabled after provider integration.",
        "services"
      );
      break;
    case "history":
      app.innerHTML = basicScreen(
        "Transactions",
        "Transaction history will appear here after the history API is connected.",
        "history"
      );
      break;
    case "electricity":
    case "tv":
    case "internet":
    case "water":
    case "education":
      app.innerHTML = basicScreen(
        state.screen.charAt(0).toUpperCase() + state.screen.slice(1),
        "This payment service is not connected yet.",
        "services"
      );
      break;
    default:
      state.screen = state.user ? "home" : "welcome";
      render();
      return;
  }

  attachFormHandlers();
}

function attachFormHandlers() {
  const loginForm = document.getElementById("login-form");
  if (loginForm) loginForm.addEventListener("submit", handleLogin);

  const registerForm = document.getElementById("register-form");
  if (registerForm) registerForm.addEventListener("submit", handleRegister);
}

async function apiRequest(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }

  if (!response.ok) {
    const messages = {
      INVALID_CREDENTIALS: "Email/phone or password is incorrect.",
      ACCOUNT_NOT_ACTIVE: "This account is not active.",
      USER_ALREADY_EXISTS: "An account with this email or phone already exists.",
      USERNAME_ALREADY_EXISTS: "That username is already taken.",
      PASSWORD_TOO_SHORT: "Your password must contain at least 8 characters.",
      MISSING_REQUIRED_FIELDS: "Please complete all required fields.",
      MISSING_LOGIN_FIELDS: "Enter your email/phone and password."
    };

    throw new Error(
      messages[data.error] ||
      data.message ||
      "The request failed. Please try again."
    );
  }

  return data;
}

function saveAuthenticatedSession(data) {
  if (!data || !data.accessToken || !data.user) {
    throw new Error("The server response did not contain the required account session.");
  }

  state.user = data.user;
  state.account = data.account || null;
  state.accessToken = data.accessToken;

  // Temporary session storage for this website phase.
  // This is not a substitute for a secure production session design.
  localStorage.setItem("veyra_session", JSON.stringify({
  accessToken: data.accessToken,
  user: data.user,
  account: data.account || null
}));
   
  state.history = [];
  state.screen = "home";
  state.error = "";
  state.notice = "";
  render();
}

async function handleLogin(event) {
  event.preventDefault();
  if (state.busy) return;

  const form = new FormData(event.currentTarget);
  const identifier = String(form.get("identifier") || "").trim();
  const password = String(form.get("password") || "");

  state.busy = true;
  state.error = "";
  render();

  try {
    const data = await apiRequest("/api/auth/login", {
      identifier,
      password
    });

    saveAuthenticatedSession(data);
  } catch (error) {
    state.error = error.message || "Login failed.";
    state.screen = "login";
  } finally {
    state.busy = false;
    render();
  }
}

async function handleRegister(event) {
  event.preventDefault();
  if (state.busy) return;

  const form = new FormData(event.currentTarget);
  const payload = {
    firstName: String(form.get("firstName") || "").trim(),
    lastName: String(form.get("lastName") || "").trim(),
    username: String(form.get("username") || "").trim(),
    email: String(form.get("email") || "").trim().toLowerCase(),
    phone: String(form.get("phone") || "").trim(),
    password: String(form.get("password") || "")
  };

  if (payload.password.length < 8) {
    showMessage("Your password must contain at least 8 characters.");
    return;
  }

  state.busy = true;
  state.error = "";
  render();

  try {
    const data = await apiRequest("/api/auth/register", payload);

    if (!data.user || !data.accessToken) {
      throw new Error("The server did not return the expected registration response.");
    }

    // Registration returns basic user details. Add the submitted
    // profile fields locally until a profile-reading endpoint exists.
    data.user = {
      ...data.user,
      firstName: payload.firstName,
      lastName: payload.lastName,
      username: payload.username.toLowerCase()
    };

    saveAuthenticatedSession(data);
  } catch (error) {
    state.error = error.message || "Registration failed.";
    state.screen = "register";
  } finally {
    state.busy = false;
    render();
  }
}

function logout() {
  state.user = null;
  state.account = null;
  state.accessToken = null;
  state.history = [];
  state.screen = "welcome";
  state.error = "";
  state.notice = "";

  sessionStorage.removeItem("veyra_access_token");
  render();
}

app.addEventListener("click", event => {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;

  if (action === "welcome") {
    state.screen = "welcome";
    render();
  } else if (action === "login") {
    state.screen = "login";
    state.error = "";
    state.notice = "";
    render();
  } else if (action === "register") {
    state.screen = "register";
    state.error = "";
    state.notice = "";
    render();
  } else if (action === "back") {
    back();
  } else if (action === "navigate") {
    const destination = target.dataset.screen;
    const allowed = [
      "home", "send", "services", "history", "profile",
      "airtime", "data", "electricity", "tv",
      "internet", "water", "education"
    ];

    if (allowed.includes(destination)) {
      go(destination);
    }
  } else if (action === "logout") {
    logout();
  }
});

// The existing backend does not yet expose a verified refresh-session
// or current-account endpoint. Do not restore an old token as if it
// proved a valid login after the page is reloaded.

render();
