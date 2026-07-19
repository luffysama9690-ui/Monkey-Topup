// telegram.js
// Sends messages to Telegram chats using the Bot API.
//
// Needs these environment variables on Render:
//   TELEGRAM_BOT_TOKEN   — from @BotFather
//   ADMIN_TELEGRAM_ID    — your personal numeric Telegram ID (from @userinfobot)
//   MINI_APP_URL         — the link that the "OPEN" button should open.
//                          Best value: https://t.me/<your_bot_username>/<your_app_short_name>
//                          (this opens the Mini App itself, inside Telegram).
//                          If you don't have that set up yet, you can use your
//                          Vercel URL instead (https://money-topup-front-azure.vercel.app) —
//                          it will just open in an in-app browser instead of as a Mini App.
//
// If required variables are missing, these functions quietly do nothing
// instead of crashing the request that triggered them — notifications are a
// nice-to-have, not something that should ever block a deposit/order from
// being saved.

// Low-level helper: sends one message to one chat, with an optional
// inline keyboard. Returns true/false so callers (like the broadcast loop
// in admin.js) can count successes/failures without throwing.
async function sendTelegramMessage(chatId, text, options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || !chatId) {
    console.warn("sendTelegramMessage skipped — missing TELEGRAM_BOT_TOKEN or chatId.");
    return false;
  }

  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  };

  if (options.replyMarkup) {
    body.reply_markup = options.replyMarkup;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error("sendTelegramMessage failed:", chatId, res.status, errBody);
      return false;
    }
    return true;
  } catch (err) {
    console.error("sendTelegramMessage error:", chatId, err.message);
    return false;
  }
}

// Builds the inline "OPEN" button shown under admin notifications, e.g.
// New order / New deposit alerts — same idea as the SAKURA Game Shop bot.
function openAppButton(label = "OPEN") {
  const url = process.env.MINI_APP_URL;
  if (!url) return undefined;
  return {
    inline_keyboard: [[{ text: label, url }]],
  };
}

// Sends a plain text message to the admin's Telegram chat, with an OPEN
// button attached (if MINI_APP_URL is configured) so tapping it jumps
// straight into the Mini App to review the new order/deposit.
async function notifyAdmin(text, options = {}) {
  const chatId = process.env.ADMIN_TELEGRAM_ID;

  if (!chatId) {
    console.warn("notifyAdmin skipped — ADMIN_TELEGRAM_ID is not set.");
    return;
  }

  await sendTelegramMessage(chatId, text, {
    replyMarkup: options.replyMarkup !== undefined ? options.replyMarkup : openAppButton(),
  });
}

module.exports = { notifyAdmin, sendTelegramMessage, openAppButton };
