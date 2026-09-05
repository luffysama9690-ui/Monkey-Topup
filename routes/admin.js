const express = require("express");
const pool = require("../db");
const { updateDepositStatus, updateOrderStatus } = require("./sheets");
const { sendTelegramMessage, sendTelegramPhoto } = require("./telegram");
const fazercards = require("../services/relay/fazercards");

const router = express.Router();

// Simple authorization check: any Telegram ID listed in ADMIN_TELEGRAM_IDS
// (Render env var, comma-separated -- supports negative IDs too, for
// website accounts) may use these endpoints. ADMIN_TELEGRAM_ID (singular)
// still works on its own for backward compatibility; both can be set
// together. The real check always happens here on the server — the
// frontend only decides whether to *show* the Admin tab, it never grants
// access on its own.
function adminIdSet() {
  const raw = [process.env.ADMIN_TELEGRAM_IDS, process.env.ADMIN_TELEGRAM_ID]
    .filter(Boolean)
    .join(",");
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function isAdmin(telegramId) {
  if (!telegramId) return false;
  return adminIdSet().has(String(telegramId));
}

// GET /api/admin/check?telegramId=...
// Used by the frontend to decide whether to show the Admin tab at all.
router.get("/check", (req, res) => {
  res.json({ isAdmin: isAdmin(req.query.telegramId) });
});

// GET /api/admin/pending?telegramId=...
// Returns everything currently waiting on admin review.
router.get("/pending", async (req, res) => {
  if (!isAdmin(req.query.telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  try {
    const [deposits, orders] = await Promise.all([
      pool.query("SELECT * FROM deposits WHERE status = 'pending' ORDER BY created_at ASC"),
      pool.query("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at ASC"),
    ]);
    res.json({ deposits: deposits.rows, orders: orders.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load pending items" });
  }
});

// PATCH /api/admin/deposits/:id/status
// body: { telegramId, status: "success" | "rejected" }
// Approving a deposit credits the user's wallet (MMK or THB, whichever the
// deposit was in). Rejecting it just marks it rejected — no balance change.
router.patch("/deposits/:id/status", async (req, res) => {
  const { telegramId, status } = req.body;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  if (!["success", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be 'success' or 'rejected'" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dep = await client.query("SELECT * FROM deposits WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (dep.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deposit not found" });
    }
    const deposit = dep.rows[0];
    if (deposit.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Deposit already processed" });
    }
    await client.query("UPDATE deposits SET status = $1 WHERE id = $2", [status, req.params.id]);
    if (status === "success") {
      const balanceColumn = deposit.currency === "mmk" ? "balance_mmk" : "balance_thb";
      await client.query(
        `UPDATE users SET ${balanceColumn} = ${balanceColumn} + $1 WHERE telegram_id = $2`,
        [deposit.amount, deposit.telegram_id]
      );
    }
    await client.query(
      `INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`,
      [
        deposit.telegram_id,
        status === "success"
          ? `သင့်ရဲ့ ငွေဖြည့်သွင်းမှု #${deposit.id} (${deposit.amount} ${deposit.currency.toUpperCase()}) အောင်မြင်ပါပြီ`
          : `သင့်ရဲ့ ငွေဖြည့်သွင်းမှု #${deposit.id} ကို ငြင်းပယ်လိုက်ပါသည်`,
        status === "success" ? "✅" : "❌",
      ]
    );
    await client.query("COMMIT");

    updateDepositStatus(req.params.id, status);

    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to update deposit" });
  } finally {
    client.release();
  }
});

// PATCH /api/admin/orders/:id/status
// body: { telegramId, status: "success" | "failed" }
// Note: orders.status only allows 'pending' | 'success' | 'failed' in the
// database (see schema.sql), so "reject" is stored as "failed" here — the
// Admin Panel UI can still label the button "Reject" for the person using it.
router.patch("/orders/:id/status", async (req, res) => {
  const { telegramId, status } = req.body;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  if (!["success", "failed"].includes(status)) {
    return res.status(400).json({ error: "status must be 'success' or 'failed'" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ord = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (ord.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }
    const order = ord.rows[0];
    if (order.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Order already processed" });
    }
    await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, req.params.id]);
    await client.query(
      `INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`,
      [
        order.telegram_id,
        status === "success"
          ? `သင့်ရဲ့ အော်ဒါ #${order.id} (${order.item}) အောင်မြင်ပါပြီ`
          : `သင့်ရဲ့ အော်ဒါ #${order.id} (${order.item}) ကို ငြင်းပယ်လိုက်ပါသည်`,
        status === "success" ? "✅" : "❌",
      ]
    );
    await client.query("COMMIT");

    updateOrderStatus(req.params.id, status);

    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to update order" });
  } finally {
    client.release();
  }
});

// Small helper so the broadcast loop doesn't fire all messages at once —
// Telegram will start rejecting/throttling if you send too fast.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST /api/admin/broadcast
// body: { telegramId, message, imageUrl }
// Sends `message` (and optionally a photo) to every user who has ever used
// the app, both as a Telegram DM (via the bot) and as an in-app inbox
// message (messages table), so people see it even if they've muted/blocked
// the bot. At least one of message/imageUrl is required.
router.post("/broadcast", async (req, res) => {
  const { telegramId, message, imageUrl } = req.body;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  const text = (message || "").trim();
  const photoUrl = (imageUrl || "").trim();
  if (!text && !photoUrl) {
    return res.status(400).json({ error: "message or imageUrl is required" });
  }

  const caption = `📢 Monkey Topup${text ? `\n\n${text}` : ""}`;
  // What gets saved to the in-app inbox — messages table only stores text,
  // so if there's a photo we include the link in the text itself.
  const inAppText = photoUrl ? `${text}${text ? "\n" : ""}📷 ${photoUrl}` : text;

  try {
    const usersRes = await pool.query("SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL");
    const recipients = usersRes.rows.map((r) => r.telegram_id);

    let sent = 0;
    let failed = 0;

    for (const uid of recipients) {
      const ok = photoUrl
        ? await sendTelegramPhoto(uid, photoUrl, caption)
        : await sendTelegramMessage(uid, caption);
      if (ok) sent++;
      else failed++;

      // Also drop a copy into their in-app message inbox so it's visible
      // even if the Telegram DM didn't go through (e.g. bot was blocked).
      try {
        await pool.query(
          `INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`,
          [uid, inAppText, "📢"]
        );
      } catch (err) {
        console.error("broadcast: failed to save in-app message for", uid, err.message);
      }

      // Stay well under Telegram's rate limits.
      await sleep(40);
    }

    res.json({ ok: true, totalRecipients: recipients.length, sent, failed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to broadcast message" });
  }
});

// POST /api/admin/set-reseller
// body: { telegramId, targetTelegramId, isReseller }
// Marks (or unmarks) a user as a reseller. `targetTelegramId` accepts
// either a numeric Telegram ID or a Telegram @username (with or without
// the "@") -- admins usually only know the username, not the numeric id,
// so username lookup is the primary path; numeric ids still work too.
// Reseller pricing itself is a flat app-wide discount applied on the
// frontend (see RESELLER_DISCOUNT_PERCENT in App.jsx /
// VITE_RESELLER_DISCOUNT_PERCENT) — this endpoint just flips the flag that
// turns that discount on for a given user.
router.post("/set-reseller", async (req, res) => {
  const { telegramId, targetTelegramId, isReseller } = req.body;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  const target = String(targetTelegramId || "").trim();
  if (!target) {
    return res.status(400).json({ error: "targetTelegramId is required" });
  }
  const isNumericId = /^\d+$/.test(target);
  try {
    const result = isNumericId
      ? await pool.query(
          "UPDATE users SET is_reseller = $1 WHERE telegram_id = $2 RETURNING telegram_id, username, is_reseller",
          [!!isReseller, target]
        )
      : await pool.query(
          "UPDATE users SET is_reseller = $1 WHERE username ILIKE $2 RETURNING telegram_id, username, is_reseller",
          [!!isReseller, target.replace(/^@/, "")]
        );
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: isNumericId
          ? "User not found — they need to have opened the app at least once"
          : "Username not found — check the spelling, or they need to have opened the app at least once (username is only known once they've visited)",
      });
    }
    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update reseller status" });
  }
});

// POST /api/admin/set-banned
// body: { telegramId, targetTelegramId, isBanned, reason }
// Blocks (or unblocks) a user from placing new orders or deposits, without
// deleting their account or history. `targetTelegramId` accepts either a
// numeric Telegram ID or a Telegram @username, same lookup rules as
// set-reseller above. Banned users still see the app itself, but
// routes/orders.js and routes/deposits.js reject any new order/deposit for
// them, and the frontend shows a full "account suspended" screen instead of
// the shop as soon as GET /api/users/:telegramId reports is_banned: true.
router.post("/set-banned", async (req, res) => {
  const { telegramId, targetTelegramId, isBanned, reason } = req.body;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  const target = String(targetTelegramId || "").trim();
  if (!target) {
    return res.status(400).json({ error: "targetTelegramId is required" });
  }
  const isNumericId = /^\d+$/.test(target);
  try {
    const result = isNumericId
      ? await pool.query(
          "UPDATE users SET is_banned = $1, banned_reason = $2 WHERE telegram_id = $3 RETURNING telegram_id, username, is_banned, banned_reason",
          [!!isBanned, isBanned ? reason || null : null, target]
        )
      : await pool.query(
          "UPDATE users SET is_banned = $1, banned_reason = $2 WHERE username ILIKE $3 RETURNING telegram_id, username, is_banned, banned_reason",
          [!!isBanned, isBanned ? reason || null : null, target.replace(/^@/, "")]
        );
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: isNumericId
          ? "User not found — they need to have opened the app at least once"
          : "Username not found — check the spelling, or they need to have opened the app at least once (username is only known once they've visited)",
      });
    }
    res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update banned status" });
  }
});

// GET /api/admin/fazercards-catalog?telegramId=...
// One-off bulk export: fetches FazerCards' full topup category list (all
// ~316 as of 2569-09-05) plus every category's offers (name, price_usd,
// required fields), in one request. Meant for figuring out which games are
// worth adding to the app next -- NOT called by the frontend during normal
// use. Concurrency-limited (10 at a time) so 316 categories finish in
// roughly 15-30s instead of timing out doing them one at a time. Admin-only,
// same as every other /admin route.
router.get("/fazercards-catalog", async (req, res) => {
  const { telegramId } = req.query;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }

  try {
    const categories = await fazercards.listCategories();
    const results = new Array(categories.length);
    const CONCURRENCY = 10;
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < categories.length) {
        const i = nextIndex++;
        const cat = categories[i];
        try {
          const offerData = await fazercards.getOffers(cat.category_id);
          results[i] = {
            category_id: cat.category_id,
            name: cat.name,
            offers: offerData.offers,
            fields: offerData.fields,
          };
        } catch (err) {
          results[i] = { category_id: cat.category_id, name: cat.name, error: err.message };
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    res.setHeader("Content-Disposition", 'attachment; filename="fazercards-catalog.json"');
    res.json({ ok: true, count: results.length, categories: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch FazerCards catalog", detail: err.message });
  }
});

// POST /api/admin/adjust-balance
// body: { telegramId, targetTelegramId, currency: "mmk"|"thb", amount, reason }
// `amount` can be positive (add) or negative (deduct) — use this to fix
// mistakes, e.g. a deposit that was approved for the wrong amount.
// Refuses to push a balance below zero, to avoid data corruption.
router.post("/adjust-balance", async (req, res) => {
  const { telegramId, targetTelegramId, currency, amount, reason } = req.body;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  if (!targetTelegramId || !["mmk", "thb"].includes(currency)) {
    return res.status(400).json({ error: "targetTelegramId and a valid currency ('mmk' or 'thb') are required" });
  }
  const delta = Number(amount);
  if (!delta || Number.isNaN(delta)) {
    return res.status(400).json({ error: "amount must be a non-zero number" });
  }

  const balanceColumn = currency === "mmk" ? "balance_mmk" : "balance_thb";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Accepts either a numeric Telegram ID or a Telegram @username, same
    // lookup rule as set-reseller/set-banned above.
    const isNumericId = /^\d+$/.test(String(targetTelegramId).trim());
    const userRes = isNumericId
      ? await client.query(`SELECT telegram_id, ${balanceColumn} FROM users WHERE telegram_id = $1 FOR UPDATE`, [
          targetTelegramId,
        ])
      : await client.query(
          `SELECT telegram_id, ${balanceColumn} FROM users WHERE username ILIKE $1 FOR UPDATE`,
          [String(targetTelegramId).trim().replace(/^@/, "")]
        );
    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: isNumericId
          ? "User not found — they need to have opened the app at least once"
          : "Username not found — check the spelling, or they need to have opened the app at least once (username is only known once they've visited)",
      });
    }
    const resolvedTelegramId = userRes.rows[0].telegram_id;
    const currentBalance = Number(userRes.rows[0][balanceColumn]);
    const newBalance = currentBalance + delta;
    if (newBalance < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Balance မလုံလောက်ပါ (လက်ရှိ: ${currentBalance})` });
    }

    await client.query(`UPDATE users SET ${balanceColumn} = $1 WHERE telegram_id = $2`, [newBalance, resolvedTelegramId]);

    await client.query(`INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`, [
      resolvedTelegramId,
      `Admin မှ သင့် balance ကို ${delta > 0 ? "+" : ""}${delta} ${currency.toUpperCase()} ပြင်ဆင်ပေးလိုက်ပါသည်${reason ? ` (${reason})` : ""}။ လက်ရှိ balance: ${newBalance} ${currency.toUpperCase()}`,
      "🛠️",
    ]);

    await client.query("COMMIT");
    res.json({ ok: true, telegramId: resolvedTelegramId, currency, previousBalance: currentBalance, newBalance });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to adjust balance" });
  } finally {
    client.release();
  }
});

// GET /api/admin/users?telegramId=...
// Returns every user's balance (admin-only) — used by the Admin Panel's
// "User အားလုံး Balance" list.
router.get("/users", async (req, res) => {
  const { telegramId } = req.query;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  try {
    const result = await pool.query(
      `SELECT telegram_id, username, balance_mmk, balance_thb, is_reseller, is_banned
       FROM users ORDER BY balance_mmk DESC, telegram_id ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load users" });
  }
});

// GET /api/admin/active-users?telegramId=...&minutes=5
// "Active now" means the user's last_active_at (bumped on every
// GET /api/users/:telegramId call, including the frontend's periodic
// heartbeat) falls within the last `minutes` (default 5). Admin-only.
router.get("/active-users", async (req, res) => {
  const { telegramId } = req.query;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  const minutes = Math.max(1, Math.min(60, parseInt(req.query.minutes, 10) || 5));
  try {
    const result = await pool.query(
      `SELECT telegram_id, username, last_active_at
       FROM users
       WHERE last_active_at > now() - ($1 || ' minutes')::interval
       ORDER BY last_active_at DESC`,
      [minutes]
    );
    res.json({ minutes, count: result.rows.length, users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load active users" });
  }
});

// GET /api/admin/user-counts?telegramId=...
// Total registered users, split by how they signed up: Telegram (real,
// positive telegram_id) vs website (synthetic negative telegram_id -- see
// schema.sql). Admin-only.
router.get("/user-counts", async (req, res) => {
  const { telegramId } = req.query;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  try {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE telegram_id > 0) AS telegram_count,
         COUNT(*) FILTER (WHERE telegram_id < 0) AS website_count,
         COUNT(*) AS total
       FROM users`
    );
    const row = result.rows[0];
    res.json({
      total: Number(row.total),
      telegramCount: Number(row.telegram_count),
      websiteCount: Number(row.website_count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load user counts" });
  }
});

// POST /api/admin/reset-spin
// body: { telegramId, targetTelegramId }
// Clears a user's last_spin_at so they can use the Lucky Spin (ကံစမ်းမဲ)
// again immediately, instead of waiting for the normal 24h cooldown.
router.post("/reset-spin", async (req, res) => {
  const { telegramId, targetTelegramId } = req.body;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  if (!targetTelegramId) {
    return res.status(400).json({ error: "targetTelegramId is required" });
  }
  try {
    const result = await pool.query(
      "UPDATE users SET last_spin_at = NULL WHERE telegram_id = $1 RETURNING telegram_id",
      [targetTelegramId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found — they need to have opened the app at least once" });
    }
    res.json({ ok: true, telegramId: targetTelegramId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset spin" });
  }
});

module.exports = router;
