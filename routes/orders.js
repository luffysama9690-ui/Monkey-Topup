const express = require("express");
const pool = require("../db");
const { notifyAdmin } = require("./telegram");

const router = express.Router();

// POST /api/orders
// body: { telegramId, game, item, gameId, serverId, qty, price, currency, payMethod, screenshotUrl }
// Creates an order. If paying from wallet balance (MMK or THB), the balance is
// deducted here, inside a transaction, so it can never go negative.
router.post("/", async (req, res) => {
  const { telegramId, game, item, gameId, serverId, qty, price, currency, payMethod, screenshotUrl } = req.body;

  if (!telegramId || !game || !item || !price || !currency) {
    return res.status(400).json({ error: "telegramId, game, item, price, and currency are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (payMethod === "wallet") {
      const balanceColumn = currency === "mmk" ? "balance_mmk" : "balance_thb";
      const userRes = await client.query(
        `SELECT ${balanceColumn} FROM users WHERE telegram_id = $1 FOR UPDATE`,
        [telegramId]
      );
      const balance = userRes.rows[0]?.[balanceColumn] ?? 0;
      if (balance < price) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "insufficient_balance" });
      }
      await client.query(
        `UPDATE users SET ${balanceColumn} = ${balanceColumn} - $1 WHERE telegram_id = $2`,
        [price, telegramId]
      );
    }

    const orderRes = await client.query(
      `INSERT INTO orders (telegram_id, game, item, game_id, server_id, qty, price, currency, status, screenshot_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'success', $9) RETURNING *`,
      [telegramId, game, item, gameId || null, serverId || null, qty || 1, price, currency, screenshotUrl || null]
    );

    await client.query(
      `INSERT INTO messages (telegram_id, text, icon)
       VALUES ($1, $2, '🛒')`,
      [telegramId, `အော်ဒါ #${orderRes.rows[0].id} (${item}) ဝယ်ယူမှု အောင်မြင်ပါသည်`]
    );

    await client.query("COMMIT");

    notifyAdmin(
      `🛒 <b>New order</b>\n` +
        `Order ID: #${orderRes.rows[0].id}\n` +
        `Telegram ID: ${telegramId}\n` +
        `Item: ${item}${gameId ? ` (GameID: ${gameId}${serverId ? ` / ${serverId}` : ""})` : ""}\n` +
        `Qty: ${qty || 1}\n` +
        `Price: ${price} ${currency.toUpperCase()}\n` +
        `Pay method: ${payMethod}` +
        (screenshotUrl ? `\nScreenshot: ${screenshotUrl}` : "")
    );

    res.status(201).json(orderRes.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to create order" });
  } finally {
    client.release();
  }
});

// GET /api/orders/:telegramId
router.get("/:telegramId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE telegram_id = $1 ORDER BY created_at DESC",
      [req.params.telegramId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load orders" });
  }
});

// GET /api/orders/detail/:id
router.get("/detail/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Order not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load order" });
  }
});

module.exports = router;
