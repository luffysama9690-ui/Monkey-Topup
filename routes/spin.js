// src/api.js
// All calls to the Monkey Topup backend go through here.
//
// The backend URL comes from an environment variable so it's easy to change
// without touching code (set VITE_API_URL in Vercel's project settings).
// If it's not set, it falls back to the Render URL from setup.
const API_BASE = import.meta.env.VITE_API_URL || "https://monkey-topup.onrender.com/api";

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  getUser: (telegramId) => request(`/users/${telegramId}`),

  getOrders: (telegramId) => request(`/orders/${telegramId}`),
  createOrder: (payload) => request(`/orders`, { method: "POST", body: JSON.stringify(payload) }),

  getDeposits: (telegramId) => request(`/deposits/${telegramId}`),
  createDeposit: (payload) => request(`/deposits`, { method: "POST", body: JSON.stringify(payload) }),

  getMessages: (telegramId) => request(`/messages/${telegramId}`),
  getUnreadCount: (telegramId) => request(`/messages/${telegramId}/unread-count`),
  markMessagesRead: (telegramId) => request(`/messages/${telegramId}/mark-read`, { method: "POST" }),

  // Website-only (email/password) accounts. Not used inside the Telegram
  // Mini App, which authenticates automatically via Telegram's login data.
  register: (email, password, username) =>
    request(`/auth/register`, { method: "POST", body: JSON.stringify({ email, password, username }) }),
  login: (email, password) =>
    request(`/auth/login`, { method: "POST", body: JSON.stringify({ email, password }) }),

  // Admin-only. The backend re-checks the telegramId against
  // ADMIN_TELEGRAM_ID on every one of these calls — nothing here is trusted
  // just because the frontend calls it.
  checkAdmin: (telegramId) => request(`/admin/check?telegramId=${telegramId}`),
  getPendingItems: (telegramId) => request(`/admin/pending?telegramId=${telegramId}`),
  updateDepositStatus: (telegramId, id, status) =>
    request(`/admin/deposits/${id}/status`, { method: "PATCH", body: JSON.stringify({ telegramId, status }) }),
  updateOrderStatus: (telegramId, id, status) =>
    request(`/admin/orders/${id}/status`, { method: "PATCH", body: JSON.stringify({ telegramId, status }) }),
  // Sends `message` (and an optional photo) to every user, both as a
  // Telegram DM (via the bot) and as an in-app inbox message. Returns
  // { ok, totalRecipients, sent, failed }.
  broadcastMessage: (telegramId, message, imageUrl) =>
    request(`/admin/broadcast`, { method: "POST", body: JSON.stringify({ telegramId, message, imageUrl }) }),
  // Marks/unmarks targetTelegramId as a reseller (flat app-wide discount).
  setReseller: (telegramId, targetTelegramId, isReseller) =>
    request(`/admin/set-reseller`, {
      method: "POST",
      body: JSON.stringify({ telegramId, targetTelegramId, isReseller }),
    }),
  // Manually adjusts a user's balance by `amount` (positive to add, negative
  // to deduct). Used to fix mistakes like an incorrectly-approved deposit.
  adjustBalance: (telegramId, targetTelegramId, currency, amount, reason) =>
    request(`/admin/adjust-balance`, {
      method: "POST",
      body: JSON.stringify({ telegramId, targetTelegramId, currency, amount, reason }),
    }),
  // Lists every user's balance — admin-only.
  getAllUsers: (telegramId) => request(`/admin/users?telegramId=${telegramId}`),

  // Lucky Spin (ကံစမ်းမဲ) — once every 24h, random MMK cashback.
  getSpinStatus: (telegramId) => request(`/spin/status/${telegramId}`),
  spin: (telegramId) => request(`/spin`, { method: "POST", body: JSON.stringify({ telegramId }) }),
};

// ---------------------------------------------------------------------
// Identity: the app can be opened two ways —
//   1. Inside the Telegram Mini App — Telegram supplies the user's id
//      automatically, no login screen needed.
//   2. As a plain website — the person logs in with email/password
//      (see api.login / api.register above); their session (a JWT plus
//      their synthetic negative telegram_id — see backend schema.sql) is
//      kept in localStorage so they stay logged in across visits.
// Every other part of the app (orders, deposits, messages, admin panel)
// only ever deals with a "telegramId" string, so once we have one — from
// either source — the rest of the app doesn't need to know which it was.
// ---------------------------------------------------------------------

const AUTH_STORAGE_KEY = "monkeyTopupWebAuth";

function loadWebSession() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// Called after a successful api.login()/api.register() to remember the
// session. `user` is the `{ telegramId, email, username }` object the
// backend returns.
export function saveWebSession(token, user) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, user }));
}

export function logoutWeb() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

// True when the app is running inside the Telegram Mini App (as opposed to
// a plain browser tab on the website).
export function isTelegramContext() {
  return !!window?.Telegram?.WebApp?.initDataUnsafe?.user?.id;
}

// Returns the current user's id, or null if nobody is logged in yet (only
// possible on the website — Telegram always supplies one).
export function getTelegramId() {
  const tgUser = window?.Telegram?.WebApp?.initDataUnsafe?.user;
  if (tgUser?.id) return String(tgUser.id);

  const session = loadWebSession();
  return session?.user?.telegramId != null ? String(session.user.telegramId) : null;
}

// Reads display info (name, username, avatar) for the Profile page.
export function getTelegramUser() {
  const tgUser = window?.Telegram?.WebApp?.initDataUnsafe?.user;
  if (tgUser) {
    return {
      firstName: tgUser.first_name || "",
      lastName: tgUser.last_name || "",
      username: tgUser.username || "",
      photoUrl: tgUser.photo_url || "",
    };
  }

  const session = loadWebSession();
  if (session?.user) {
    return {
      firstName: session.user.username || session.user.email.split("@")[0],
      lastName: "",
      username: session.user.email || "",
      photoUrl: "",
    };
  }
  return null;
}
