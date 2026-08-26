const express = require("express");
const pool = require("../db");
const { notifyAdmin, orderDoneButton } = require("./telegram");
const { logOrder } = require("./sheets");
const { relayMlOrderFazercards, relayMcOrderFazercards, relayPubgOrderFazercards, validateGamePlayerId } = require("../services/relay/relayFazercards");
const { relayMlOrder } = require("../services/relay/relayOrder"); // easytopup4ubot fallback for ML items FazerCards doesn't sell (2x Diamonds bundles, and diamond amounts outside FazerCards' catalog)

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

  // Catch a mistyped Player ID / Server ID before we touch the customer's
  // wallet balance. Only runs for games FazerCards covers (ML/MCGG/PUBG);
  // other games just skip straight through (checked: false).
  const idCheck = await validateGamePlayerId(game, gameId, serverId);
  if (idCheck.checked && idCheck.valid === false) {
    return res.status(400).json({ error: "invalid_player_id", message: "Player ID သို့မဟုတ် Server ID မှားနေပါသည် — ပြန်စစ်ပေးပါ" });
  }
  // idCheck.valid === null (FazerCards unreachable) intentionally falls
  // through — we don't want an unrelated API outage to block every sale.

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
      `INSERT INTO orders (telegram_id, game, item, game_id, server_id, qty, price, currency, status, screenshot_url, pay_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'success', $9, $10) RETURNING *`,
      [telegramId, game, item, gameId || null, serverId || null, qty || 1, price, currency, screenshotUrl || null, payMethod || null]
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
        `Game: ${game}\n` +
        `Item: ${item}${gameId ? ` (GameID: ${gameId}${serverId ? ` / ${serverId}` : ""})` : ""}\n` +
        `Qty: ${qty || 1}\n` +
        `Price: ${price} ${currency.toUpperCase()}\n` +
        `Pay method: ${payMethod}` +
        (screenshotUrl ? `\nScreenshot: ${screenshotUrl}` : ""),
      { replyMarkup: orderDoneButton(orderRes.rows[0].id) }
    );

    logOrder({
      id: orderRes.rows[0].id,
      telegramId,
      game,
      item,
      gameId,
      serverId,
      qty: qty || 1,
      price,
      currency,
      payMethod,
      status: orderRes.rows[0].status,
    });

    res.status(201).json(orderRes.rows[0]);

    // Fire-and-forget: relay orders to whichever supplier covers this
    // game/item. Doesn't block the customer's response; failures are
    // logged, not thrown.
    (async () => {
      const order = orderRes.rows[0];
      const results = await Promise.all([
        relayMlOrderFazercards(order),
        relayMcOrderFazercards(order),
        relayPubgOrderFazercards(order),
      ]);

      // Mobile Legends hybrid: FazerCards doesn't sell every ML item (2x
      // Diamonds bundles, and several diamond amounts) — fall back to the
      // easytopup4ubot Telegram relay for exactly those.
      const mlResult = results[0];
      let finalMlResult = mlResult;
      if (order.game === "Mobile Legends" && mlResult.reason === "not_on_fazercards") {
        finalMlResult = await relayMlOrder(order);
      }

      const allResults = [finalMlResult, results[1], results[2]];
      const attempted = allResults.find((r) => r.reason !== undefined && !r.reason.startsWith("not_"));
      if (attempted && !attempted.ok) {
        console.warn(`[relay] Order #${order.id} not relayed: ${attempted.reason}`);
        // TODO: consider notifyAdmin() here so a failed relay doesn't go unnoticed.
      }
    })();
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
