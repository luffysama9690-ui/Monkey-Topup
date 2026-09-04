const express = require("express");
const { sendAndWaitForReply } = require("../services/relay/telegramUserbot");
const { buildNicknameCommand, detectError } = require("../services/relay/orderCommand");
const { validateGamePlayerId } = require("../services/relay/relayFazercards");

const SUPPLIER_BOT_USERNAME = process.env.SUPPLIER_BOT_USERNAME || "easytopup4ubot";

const router = express.Router();

/**
 * Pulls a player name out of the supplier bot's `.n` reply. The exact
 * wording isn't confirmed yet (see README) — this tries a few common
 * label patterns and falls back to returning the raw reply so the
 * frontend can at least show *something* useful while this gets tuned.
 */
function parseNicknameReply(text) {
  const patterns = [
    /Name\s*[:\.]?\s*(.+)/i,
    /Nickname\s*[:\.]?\s*(.+)/i,
    /Player\s*[:\.]?\s*(.+)/i,
    /နာမည်\s*[:\.]?\s*(.+)/,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[1].trim();
  }
  return null;
}

// Legacy path: relays a `.n <gameId> <serverId>` command through a Telegram
// userbot logged into the old supplier's bot chat and parses its reply.
// Kept only as a fallback for games/regions FazerCards doesn't cover yet
// (see the isFazercardsUnsupported branch below) -- requires TG_API_ID,
// TG_API_HASH and TG_SESSION_STRING to be configured, which they may not
// be, since this isn't the primary path anymore.
async function verifyViaUserbot(gameId, serverId) {
  if (!process.env.TG_API_ID || !process.env.TG_API_HASH || !process.env.TG_SESSION_STRING) {
    return { ok: false, status: 503, error: "Player name lookup မရရှိသေးပါ (userbot မချိတ်ဆက်ရသေးပါ)" };
  }
  const command = buildNicknameCommand({ gameId, serverId });
  const reply = await sendAndWaitForReply(SUPPLIER_BOT_USERNAME, command);
  const errorType = detectError(reply);
  if (errorType) {
    return { ok: false, status: 404, error: "Game ID ရှာမတွေ့ပါ", detail: errorType };
  }
  const name = parseNicknameReply(reply);
  return { ok: true, name, raw: reply };
}

// POST /api/verify-player  { gameId, serverId, game, item }
// `game` (e.g. "Mobile Legends") and `item` (the selected package label,
// e.g. "Global 86 Diamonds") are optional but strongly recommended --
// without them this can only fall back to the old userbot method, which
// only ever supported Mobile Legends and needs TG_API_ID/HASH/SESSION set.
//
// Primary path: FazerCards' own /topups/validate-id (via
// validateGamePlayerId, the same check routes/orders.js already runs
// before creating an order) -- it's already connected for every FazerCards
// game (ML all regions, MCGG, PUBG, Racing Master, Sausage Man, Where Winds
// Meet, Blood Strike, Free Fire TH, Honor of Kings) and returns the real
// player_name directly, no separate userbot/session setup needed.
router.post("/verify-player", async (req, res) => {
  const { gameId, serverId, game, item } = req.body;

  if (!gameId || !/^\d+$/.test(gameId)) {
    return res.status(400).json({ error: "Game ID ပုံစံ မှားနေပါသည်" });
  }
  if (serverId && !/^\d+$/.test(serverId)) {
    return res.status(400).json({ error: "Server ID ပုံစံ မှားနေပါသည်" });
  }

  if (game) {
    try {
      const result = await validateGamePlayerId(game, gameId, serverId, item);
      if (result.checked) {
        if (result.valid === false) {
          return res.status(404).json({ error: "Game ID ရှာမတွေ့ပါ" });
        }
        if (result.valid === null) {
          // FazerCards itself errored (network/API issue) -- fail open,
          // same policy as order creation: let the customer proceed with a
          // format-only check rather than blocking them entirely.
          return res.json({ name: null });
        }
        return res.json({ name: result.playerName || null });
      }
      // result.checked === false -- this game/region isn't one FazerCards
      // covers (e.g. Mobile Legends RU, Clash of Clans, Free Fire Global).
      // Fall through to the legacy userbot path below, which only knows
      // Mobile Legends; anything else just gets format-only validation.
    } catch (err) {
      console.error("[verify-player] FazerCards check failed:", err.message);
      // Fall through to the userbot path rather than failing the request.
    }
  }

  if (game && game !== "Mobile Legends") {
    return res.json({ name: null });
  }
  if (!serverId) {
    return res.status(400).json({ error: "Server ID ပုံစံ မှားနေပါသည်" });
  }

  try {
    const result = await verifyViaUserbot(gameId, serverId);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, detail: result.detail });
    }
    res.json({ name: result.name, raw: result.raw });
  } catch (err) {
    console.error("[verify-player] userbot check failed:", err.message);
    res.status(502).json({ error: "Player name စစ်ဆေးရာတွင် အမှားဖြစ်သွားသည်", detail: err.message });
  }
});

module.exports = router;
