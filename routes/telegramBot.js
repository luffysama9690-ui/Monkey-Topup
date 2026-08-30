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
const {
  sendTelegramMessage,
  answerCallbackQuery,
  editMessageReplyMarkup,
  editMessageText,
  mainMenuKeyboard,
  backToMenuKeyboard,
  openAppButton,
} = require("./telegram");

const router = express.Router();

function isAdmin(telegramId) {
  return (
    !!process.env.ADMIN_TELEGRAM_ID &&
    !!telegramId &&
    String(telegramId) === String(process.env.ADMIN_TELEGRAM_ID)
  );
}

const WELCOME_TEXT = "🐒 <b>Monkey Topup</b>\n\nအောက်က menu ထဲက တစ်ခုခုကို ရွေးပါ 👇";

async function getOrCreateUser(telegramId, username) {
  let result = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegramId]);
  if (result.rows.length === 0) {
    result = await pool.query(
      "INSERT INTO users (telegram_id, username, balance_mmk) VALUES ($1, $2, 0) RETURNING *",
      [telegramId, username || null]
    );
  }
  return result.rows[0];
}

function formatProfileMessage(user) {
  return (
    `👤 <b>Profile</b>\n\n` +
    `Telegram ID: <code>${user.telegram_id}</code>\n` +
    `Username: ${user.username ? "@" + user.username : "-"}\n\n` +
    `🇲🇲 Balance (MMK): ${Number(user.balance_mmk || 0).toLocaleString()} ကျပ်\n` +
    `🇹🇭 Balance (THB): ${Number(user.balance_thb || 0).toLocaleString()} ဘတ်\n\n` +
    `${user.is_reseller ? "✅ Reseller" : "Reseller status: -"}`
  );
}

async function formatHistoryMessage(telegramId) {
  const res = await pool.query(
    "SELECT id, item, price, currency, status, created_at FROM orders WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 5",
    [telegramId]
  );
  if (res.rows.length === 0) {
    return "📦 <b>History</b>\n\nအော်ဒါ မှတ်တမ်း မရှိသေးပါ။";
  }
  const lines = res.rows.map(
    (o) =>
      `#${o.id} — ${o.item}\n` +
      `${Number(o.price).toLocaleString()} ${String(o.currency).toUpperCase()} · ${o.status || "pending"}`
  );
  return `📦 <b>History</b> (အသစ်ဆုံး ၅ ခု)\n\n` + lines.join("\n\n");
}

// POST /api/telegram/webhook
router.post("/webhook", async (req, res) => {
  // Acknowledge immediately — Telegram doesn't care what we do after this,
  // it just wants a fast 200 so it doesn't retry/resend the update.
  res.sendStatus(200);

  try {
    const msg = req.body?.message;
    if (msg?.text === "/start") {
      await sendTelegramMessage(msg.chat.id, WELCOME_TEXT, { replyMarkup: mainMenuKeyboard() });
      return;
    }

    const cq = req.body?.callback_query;
    if (!cq) return; // not a button press or /start, ignore

    // Admin-only: the "✅ Done ပို့ရန်" button under New Order notifications.
    const doneMatch = /^order_done_(\d+)$/.exec(cq.data || "");
    if (doneMatch) {
      if (!isAdmin(cq.from?.id)) {
        await answerCallbackQuery(cq.id, "Not authorized");
        return;
      }
      const orderId = doneMatch[1];

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
      return;
    }

    // Customer-facing main menu (open to everyone, not just admin).
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    if (!chatId || !messageId) {
      await answerCallbackQuery(cq.id);
      return;
    }

    if (cq.data === "menu_main") {
      await answerCallbackQuery(cq.id);
      await editMessageText(chatId, messageId, WELCOME_TEXT, { replyMarkup: mainMenuKeyboard() });
      return;
    }

    if (cq.data === "menu_uc") {
      await answerCallbackQuery(cq.id);
      await editMessageText(
        chatId,
        messageId,
        "💵 <b>UC Management</b>\n\nဂိမ်း package ရွေးချယ်ဖို့ Monkey Topup app ကို ဖွင့်ပါ 👇",
        { replyMarkup: openAppButton("📲 App ဖွင့်ရန်") || backToMenuKeyboard() }
      );
      return;
    }

    if (cq.data === "menu_profile") {
      await answerCallbackQuery(cq.id);
      const user = await getOrCreateUser(cq.from?.id, cq.from?.username);
      await editMessageText(chatId, messageId, formatProfileMessage(user), { replyMarkup: backToMenuKeyboard() });
      return;
    }

    if (cq.data === "menu_history") {
      await answerCallbackQuery(cq.id);
      const text = await formatHistoryMessage(cq.from?.id);
      await editMessageText(chatId, messageId, text, { replyMarkup: backToMenuKeyboard() });
      return;
    }

    if (cq.data === "menu_support") {
      await answerCallbackQuery(cq.id);
      const supportHandle = process.env.SUPPORT_TELEGRAM_USERNAME || "your_support_username";
      await editMessageText(
        chatId,
        messageId,
        `📞 <b>Contact Support</b>\n\n@${supportHandle} ကို message ပို့ပါ။`,
        { replyMarkup: backToMenuKeyboard() }
      );
      return;
    }

    await answerCallbackQuery(cq.id);
  } catch (err) {
    console.error("telegramBot webhook error:", err.message);
    try {
      if (req.body?.callback_query?.id) {
        await answerCallbackQuery(req.body.callback_query.id, "Error — check server logs");
      }
    } catch (_) {}
  }
});

module.exports = router;
