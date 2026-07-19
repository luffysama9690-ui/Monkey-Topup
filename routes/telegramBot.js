// telegramBot.js
// Receives updates from Telegram (button presses) via a webhook.
//
// One-time setup after this is deployed — visit this URL once in your
// browser (with your real bot token and Render URL filled in):
//
//   https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://monkey-topup.onrender.com/api/telegram/webhook
//
// You should see {"ok":true,"result":true,...}. That's it — Telegram will
// now call our /webhook endpoint every time a button on one of our bot's
// messages is pressed. You only need to do this once (or again if you ever
// change the backend's URL).

const express = require("express");
const pool = require("../db");
const { sendTelegramMessage, answerCallbackQuery, editMessageReplyMarkup } = require("./telegram");

const router = express.Router();

function isAdmin(telegramId) {
  return (
    !!process.env.ADMIN_TELEGRAM_ID &&
    !!telegramId &&
    String(telegramId) === String(process.env.ADMIN_TELEGRAM_ID)
  );
}

// POST /api/telegram/webhook
router.post("/webhook", async (req, res) => {
  // Acknowledge immediately — Telegram doesn't care what we do after this,
  // it just wants a fast 200 so it doesn't retry/resend the update.
  res.sendStatus(200);

  const cq = req.body?.callback_query;
  if (!cq) return; // not a button press, ignore (e.g. a plain text message)

  try {
    const fromId = cq.from?.id;
    if (!isAdmin(fromId)) {
      await answerCallbackQuery(cq.id, "Not authorized");
      return;
    }

    const match = /^order_done_(\d+)$/.exec(cq.data || "");
    if (!match) {
      await answerCallbackQuery(cq.id);
      return;
    }
    const orderId = match[1];

    const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    if (orderRes.rows.length === 0) {
      await answerCallbackQuery(cq.id, "Order not found");
      return;
    }
    const order = orderRes.rows[0];

    const receipt =
      `Order ID: #${order.id}\n` +
      `Item: ${order.item}\n` +
      (order.game_id ? `GameID: ${order.game_id}${order.server_id ? ` [${order.server_id}]` : ""}\n` : "") +
      `Qty: ${order.qty}\n` +
      `Price: ${order.price} ${String(order.currency).toUpperCase()}\n` +
      `Pay method: ${order.pay_method || "-"}\n\n` +
      `ဝယ်ယူအားပေးမှုအတွက် ကျေးဇူးတင်ပါသည် 🙏`;

    await sendTelegramMessage(order.telegram_id, receipt);

    // Drop a copy into the customer's in-app inbox too.
    try {
      await pool.query(`INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`, [
        order.telegram_id,
        receipt,
        "✅",
      ]);
    } catch (err) {
      console.error("telegramBot: failed to save in-app receipt message", err.message);
    }

    // Remove the button so it can't be pressed twice, and let the admin
    // know it went through.
    if (cq.message?.chat?.id && cq.message?.message_id) {
      await editMessageReplyMarkup(cq.message.chat.id, cq.message.message_id, {
        inline_keyboard: [[{ text: "✅ ပို့ပြီးပါပြီ", callback_data: "noop" }]],
      });
    }
    await answerCallbackQuery(cq.id, "✅ Customer ဆီ ပို့ပြီးပါပြီ");
  } catch (err) {
    console.error("telegramBot webhook error:", err.message);
    try {
      await answerCallbackQuery(cq.id, "Error — check server logs");
    } catch (_) {}
  }
});

module.exports = router;
