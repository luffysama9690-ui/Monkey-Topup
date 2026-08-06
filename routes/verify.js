const express = require("express");
const { sendAndWaitForReply } = require("../services/relay/telegramUserbot");
const { buildNicknameCommand, detectError } = require("../services/relay/orderCommand");

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

// POST /api/verify-player  { gameId, serverId }
router.post("/verify-player", async (req, res) => {
  const { gameId, serverId } = req.body;

  if (!gameId || !/^\d+$/.test(gameId)) {
    return res.status(400).json({ error: "Game ID ပုံစံ မှားနေပါသည်" });
  }
  if (!serverId || !/^\d+$/.test(serverId)) {
    return res.status(400).json({ error: "Server ID ပုံစံ မှားနေပါသည်" });
  }

  if (!process.env.TG_API_ID || !process.env.TG_API_HASH || !process.env.TG_SESSION_STRING) {
    return res.status(503).json({ error: "Player name lookup မရရှိသေးပါ (userbot မချိတ်ဆက်ရသေးပါ)" });
  }

  try {
    const command = buildNicknameCommand({ gameId, serverId });
    const reply = await sendAndWaitForReply(SUPPLIER_BOT_USERNAME, command);

    const errorType = detectError(reply);
    if (errorType) {
      return res.status(404).json({ error: "Game ID ရှာမတွေ့ပါ", detail: errorType });
    }

    const name = parseNicknameReply(reply);
    if (!name) {
      // Couldn't confidently parse a name — still return the raw reply so
      // the frontend/admin can see what actually came back and we can
      // tighten parseNicknameReply() once the real format is confirmed.
      return res.json({ name: null, raw: reply });
    }

    res.json({ name, raw: reply });
  } catch (err) {
    console.error("[verify-player] failed:", err.message);
    res.status(502).json({ error: "Player name စစ်ဆေးရာတွင် အမှားဖြစ်သွားသည်", detail: err.message });
  }
});

module.exports = router;
