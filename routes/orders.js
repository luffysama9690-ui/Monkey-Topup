const express = require("express");
const pool = require("../db");
const { notifyAdmin, orderDoneButton } = require("./telegram");
const { logOrder, updateOrderProfitAndBalance } = require("./sheets");
const { getBalance } = require("../services/relay/fazercards");
const { scheduleOrderStatusCheck } = require("../services/orderStatusChecker");
const { sendOrderReceipt } = require("../services/orderReceipt");
const {
  relayMlOrderFazercards,
  relayMcOrderFazercards,
  relayPubgOrderFazercards,
  relayNewStateOrderFazercards,
  relayRacingOrderFazercards,
  relayCapcutOrderFazercards,
  relaySausageOrderFazercards,
  relayWwmOrderFazercards,
  relayBloodstrikeOrderFazercards,
  relayFreeFireOrderFazercards,
  relayHokOrderFazercards,
  relaySkyCotlOrderFazercards,
  relayValorantOrderFazercards,
  relayLolOrderFazercards,
  relayCodmOrderFazercards,
  relayGenshinGlobalOrderFazercards,
  relayHonkaiStarRailOrderFazercards,
  relayHonkaiImpact3rdOrderFazercards,
  relayArenaBreakoutOrderFazercards,
  relayDeltaForceOrderFazercards,
  relayEafcMobileOrderFazercards,
  relayIdentityVOrderFazercards,
  relayLordsMobileOrderFazercards,
  relayStumbleGuysOrderFazercards,
  relayStateOfSurvivalOrderFazercards,
  relayWatcherOfRealmsOrderFazercards,
  relayBlockmanGoOrderFazercards,
  relayGrowtopiaOrderFazercards,
  relayEggyPartyOrderFazercards,
  relayEightBallPoolOrderFazercards,
  relayR6MobileOrderFazercards,
  relayTftMobileOrderFazercards,
  relayTelegramOrderFazercards,
  relaySteamOrderFazercards,
  validateGamePlayerId,
  isAutoFulfilled,
} = require("../services/relay/relayFazercards");

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

  const banCheck = await pool.query("SELECT is_banned FROM users WHERE telegram_id = $1", [telegramId]);
  if (banCheck.rows[0]?.is_banned) {
    return res.status(403).json({ error: "account_banned", message: "သင့် account ကို ယာယီ ဆိုင်းငံ့ထားပါသည် — Admin ကို ဆက်သွယ်ပါ" });
  }

  // Catch a mistyped Player ID / Server ID before we touch the customer's
  // wallet balance. Only runs for games FazerCards covers (ML/MCGG/PUBG);
  // other games just skip straight through (checked: false).
  const idCheck = await validateGamePlayerId(game, gameId, serverId, item);
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

    const autoFulfilled = isAutoFulfilled(game, item);

    notifyAdmin(
      `🛒 <b>New order</b>\n` +
        `Order ID: #${orderRes.rows[0].id}\n` +
        `Telegram ID: ${telegramId}\n` +
        `Game: ${game}\n` +
        `Item: ${item}${gameId ? ` (GameID: ${gameId}${serverId ? ` / ${serverId}` : ""})` : ""}\n` +
        `Qty: ${qty || 1}\n` +
        `Price: ${price} ${currency.toUpperCase()}\n` +
        `Pay method: ${payMethod}` +
        (screenshotUrl ? `\nScreenshot: ${screenshotUrl}` : "") +
        (autoFulfilled ? `\n\n🤖 FazerCards auto-processing — receipt ကို customer ဆီ auto ပို့ပေးပါမယ်, manual ပို့စရာ မလိုပါ။` : ""),
      // Auto-fulfilled orders skip the manual button entirely -- the
      // receipt goes out on its own once the relay succeeds (see below),
      // so a stray admin click here would just send it twice.
      autoFulfilled ? {} : { replyMarkup: orderDoneButton(orderRes.rows[0].id) }
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

    // Fire-and-forget: relay orders to FazerCards for the games it covers.
    // Doesn't block the customer's response; failures are logged, not thrown.
    (async () => {
      const order = orderRes.rows[0];
      const results = await Promise.all([
        relayMlOrderFazercards(order),
        relayMcOrderFazercards(order),
        relayPubgOrderFazercards(order),
        relayNewStateOrderFazercards(order),
        relayRacingOrderFazercards(order),
        relayCapcutOrderFazercards(order),
        relaySausageOrderFazercards(order),
        relayWwmOrderFazercards(order),
        relayBloodstrikeOrderFazercards(order),
        relayFreeFireOrderFazercards(order),
        relayHokOrderFazercards(order),
        relaySkyCotlOrderFazercards(order),
        relayValorantOrderFazercards(order),
        relayLolOrderFazercards(order),
        relayCodmOrderFazercards(order),
        relayGenshinGlobalOrderFazercards(order),
        relayHonkaiStarRailOrderFazercards(order),
        relayHonkaiImpact3rdOrderFazercards(order),
        relayArenaBreakoutOrderFazercards(order),
        relayDeltaForceOrderFazercards(order),
        relayEafcMobileOrderFazercards(order),
        relayIdentityVOrderFazercards(order),
        relayLordsMobileOrderFazercards(order),
        relayStumbleGuysOrderFazercards(order),
        relayStateOfSurvivalOrderFazercards(order),
        relayWatcherOfRealmsOrderFazercards(order),
        relayBlockmanGoOrderFazercards(order),
        relayGrowtopiaOrderFazercards(order),
        relayEggyPartyOrderFazercards(order),
        relayEightBallPoolOrderFazercards(order),
        relayR6MobileOrderFazercards(order),
        relayTftMobileOrderFazercards(order),
        relayTelegramOrderFazercards(order),
        relaySteamOrderFazercards(order),
      ]);

      const attempted = results.find((r) => r.reason !== undefined && !r.reason.startsWith("not_"));
      if (attempted && !attempted.ok) {
        console.warn(`[relay] Order #${order.id} not relayed: ${attempted.reason}`);
        // This game was supposed to auto-fulfill but the relay itself
        // failed (as opposed to a later refund, which orderStatusChecker
        // handles) -- fall back to notifying admin with the manual Done
        // button so the receipt still goes out once it's sorted out by hand.
        if (isAutoFulfilled(order.game, order.item)) {
          notifyAdmin(
            `⚠️ <b>Auto-relay failed</b>\nOrder #${order.id} (${order.item}) — reason: ${attempted.reason}\n` +
              `FazerCards ကို relay လုပ်ရာမှာ error တက်ပါတယ် — sort ပြီးရင် "Done" ခလုတ်နှိပ်ပြီး customer ဆီ receipt ကို manual ပို့ပေးပါ။`,
            { replyMarkup: orderDoneButton(order.id) }
          );
        }
      }

      // If the relay succeeded, save FazerCards' own order id and schedule
      // a follow-up check ~60s later — the initial "created" response
      // doesn't guarantee the order actually goes through on FazerCards'
      // end (e.g. a per-account purchase limit can auto-refund it a few
      // seconds in). See services/orderStatusChecker.js.
      const succeeded = results.find((r) => r.ok && r.fazercardsOrder && r.fazercardsOrder.id);
      if (succeeded) {
        try {
          await pool.query("UPDATE orders SET fazercards_order_id = $1 WHERE id = $2", [
            succeeded.fazercardsOrder.id,
            order.id,
          ]);
          scheduleOrderStatusCheck(order.id);
        } catch (err) {
          console.error(`[relay] Order #${order.id}: failed to save fazercards_order_id: ${err.message}`);
        }

        // Bookkeeping: log this order's profit (customer price minus
        // FazerCards' own cost, in the order's currency) and the FazerCards
        // account balance right after this purchase, into the "Orders"
        // sheet (columns M/N). Uses the live /balance endpoint rather than
        // computing a running total locally, so it can't drift out of sync
        // with FazerCards' side (e.g. from the monthly subscription charge).
        // Best-effort — never blocks the receipt or throws into the outer flow.
        try {
          const usdToCurrency = order.currency === "mmk" ? 4193 : 33.03; // same rate used across the pricing sheets
          const costInOrderCurrency = parseFloat(succeeded.offer.price_usd) * usdToCurrency;
          const profit = Math.round(order.price - costInOrderCurrency);
          const balanceResult = await getBalance();
          // ⚠️ Field name unconfirmed — never tested this endpoint's actual
          // response shape. Check Render logs after the first live order;
          // if fundBalanceUsd logs as null, inspect balanceResult here and
          // fix the field name.
          const fundBalanceUsd = balanceResult?.balance ?? balanceResult?.balance_usd ?? null;
          await updateOrderProfitAndBalance(order.id, profit, fundBalanceUsd);
        } catch (err) {
          console.error(`[relay] Order #${order.id}: failed to log profit/balance: ${err.message}`);
        }

        // The relay went through -- send the fulfillment receipt right
        // away instead of waiting on an admin to click "Done" manually.
        // If FazerCards ends up refunding this a bit later (rare -- e.g. a
        // per-account purchase limit), orderStatusChecker sends a separate
        // refund notice; the two messages together are still clearer than
        // silence, and this covers the overwhelmingly common instant-success case.
        try {
          await sendOrderReceipt(order);
        } catch (err) {
          console.error(`[relay] Order #${order.id}: failed to send auto-receipt: ${err.message}`);
        }
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
