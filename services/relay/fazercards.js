/**
 * Thin client for the FazerCards reseller API (reseller.fazercards.com).
 * Docs: https://reseller.fazercards.com/en/docs
 *
 * Replaces the old Telegram-userbot relay for games where FazerCards has
 * a confirmed matching catalog (Mobile Legends, Magic Chess Go Go, PUBG
 * Mobile as of this writing — see relayFazercards.js for the per-game
 * category IDs and status notes).
 */

const BASE_URL = "https://api.fzr.cards/api/v2";
const API_KEY = process.env.FAZERCARDS_API_KEY;

async function fazerFetch(path, { method = "GET", body, idempotencyKey } = {}) {
  if (!API_KEY) {
    throw new Error("FAZERCARDS_API_KEY is not set");
  }

  const headers = { "X-API-Key": API_KEY };
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`FazerCards ${method} ${path} returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok || json.ok === false) {
    const err = new Error(json.error || `FazerCards ${method} ${path} failed (HTTP ${res.status})`);
    err.httpStatus = res.status;
    err.code = json.code;
    throw err;
  }

  return json;
}

// ---- Offers cache ----
// Docs recommend caching catalog reads for 5–15 min instead of refetching
// per order (catalog-read rate limit is 120/min, shared across the app).
const OFFERS_CACHE_TTL_MS = 10 * 60 * 1000;
const offersCache = new Map(); // category_id -> { data, fetchedAt }

async function getOffers(categoryId, { forceRefresh = false } = {}) {
  const cached = offersCache.get(categoryId);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < OFFERS_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fazerFetch(`/topups/offers?category_id=${encodeURIComponent(categoryId)}`);
  offersCache.set(categoryId, { data, fetchedAt: Date.now() });
  return data;
}

// Full topup category list -- category_id + display name + note, no offers
// (see getOffers for that, per category). limit=500 covers the whole
// catalog in one call as of 2569-09-05 (316 categories).
async function listCategories() {
  const data = await fazerFetch(`/topups?limit=500`);
  return data.items;
}

async function validatePlayerId(categoryId, fields) {
  return fazerFetch("/topups/validate-id", {
    method: "POST",
    body: { category_id: categoryId, fields },
  });
}

async function createTopupOrder({ categoryId, offerId, fields, idempotencyKey }) {
  return fazerFetch("/topups/order", {
    method: "POST",
    idempotencyKey,
    body: { category_id: categoryId, offer_id: offerId, fields },
  });
}

async function getOrderStatus(orderId) {
  return fazerFetch(`/orders/${encodeURIComponent(orderId)}`);
}

async function getBalance() {
  return fazerFetch("/balance");
}

// ---- Telegram Stars & Premium ----
// Separate from the /topups family entirely -- see reseller.fazercards.com
// /en/docs, "Telegram" section.
async function buyTelegramStars(telegramUsername, quantity) {
  return fazerFetch("/telegram/stars/buy", {
    method: "POST",
    body: { telegram_username: telegramUsername, quantity },
  });
}

async function buyTelegramPremium(telegramUsername, months) {
  return fazerFetch("/telegram/premium/buy", {
    method: "POST",
    body: { telegram_username: telegramUsername, months },
  });
}

// ---- Steam wallet top-up ----
// Docs: reseller.fazercards.com/en/docs, "Steam" section (steam-topup
// routes -- not steam-gifts, which is a different product: gifting a
// specific game via a trade invite link rather than crediting a wallet).
async function checkSteamLogin(steamLogin) {
  return fazerFetch("/steam-topup/check-login", {
    method: "POST",
    body: { steamLogin },
  });
}

async function buySteamTopup(steamLogin, currency, amount, idempotencyKey) {
  return fazerFetch("/steam-topup/order", {
    method: "POST",
    idempotencyKey,
    body: { steamLogin, currency, amount },
  });
}

module.exports = {
  getOffers,
  listCategories,
  validatePlayerId,
  createTopupOrder,
  getOrderStatus,
  getBalance,
  buyTelegramStars,
  buyTelegramPremium,
  checkSteamLogin,
  buySteamTopup,
};
