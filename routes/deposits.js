const express = require("express");
const pool = require("../db");
const { notifyAdmin } = require("./telegram");

const router = express.Router();

// POST /api/deposits
// body: { telegramId, amount, currency, screenshotUrl }
// Creates a "pending" deposit for an admin to approve later.
router.post("/", async (req, res) => {
  const { telegramId, amount, currency, screenshotUrl } = req.body;

  if (!telegramId || !amount || !currency) {
    return res.status(400).json({ error: "telegramId, amount, and currency are required" });
  }
  if (!["mmk", "thb"].includes(currency)) {
    return res.status(400).json({ error: "currency must be 'mmk' or 'thb'" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO deposits (telegram_id, amount, currency, screenshot_url, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
      [telegramId, amount, currency, screenshotUrl || null]
    );
    const deposit = result.rows[0];

    await pool.query(
      `INSERT INTO messages (telegram_id, text, icon)
       VALUES ($1, $2, '💰')`,
      [telegramId, `ငွေဖြည့်သွင်းမှု ${amount} ${currency.toUpperCase()} တင်ပြီးပါပြီ`]
    );

    notifyAdmin(
      `💰 <b>New deposit request</b>\n` +
        `Deposit ID: #${deposit.id}\n` +
        `Telegram ID: ${telegramId}\n` +
        `Amount: ${amount} ${currency.toUpperCase()}\n` +
        (screenshotUrl ? `Screenshot: ${screenshotUrl}` : "Screenshot: (none)")
    );

    res.status(201).json(deposit);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create deposit" });
  }
});

// GET /api/deposits/:telegramId
router.get("/:telegramId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM deposits WHERE telegram_id = $1 ORDER BY created_at DESC",
      [req.params.telegramId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load deposits" });
  }
});

// PATCH /api/deposits/:id/status   (used by the admin panel later)
// body: { status: "success" | "rejected" }
router.patch("/:id/status", async (req, res) => {
  const { status } = req.body;
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
    await client.query("UPDATE deposits SET status = $1 WHERE id = $2", [status, req.params.id]);

    if (status === "success" && deposit.currency === "mmk") {
      await client.query("UPDATE users SET balance_mmk = balance_mmk + $1 WHERE telegram_id = $2", [
        deposit.amount,
        deposit.telegram_id,
      ]);
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to update deposit" });
  } finally {
    client.release();
  }
});

module.exports = router;
