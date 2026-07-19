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

// Same idea as sendTelegramMessage, but sends a photo (with an optional
// caption) using Telegram's sendPhoto endpoint — used for broadcasts that
// include an image.
async function sendTelegramPhoto(chatId, photoUrl, caption = "", options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token || !chatId) {
    console.warn("sendTelegramPhoto skipped — missing TELEGRAM_BOT_TOKEN or chatId.");
    return false;
  }

  const body = {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: "HTML",
  };

  if (options.replyMarkup) {
    body.reply_markup = options.replyMarkup;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error("sendTelegramPhoto failed:", chatId, res.status, errBody);
      return false;
    }
    return true;
  } catch (err) {
    console.error("sendTelegramPhoto error:", chatId, err.message);
    return false;
  }
}

// Tells Telegram "we've handled this button press" — stops the button's
// loading spinner. `text`, if given, shows briefly as a small popup/toast
// on the admin's screen.
async function answerCallbackQuery(callbackQueryId, text = "") {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
    return res.ok;
  } catch (err) {
    console.error("answerCallbackQuery error:", err.message);
    return false;
  }
}

// Replaces the inline keyboard under an existing message — used to remove
// the "Done" button (or swap it for a disabled-looking one) once the admin
// has already tapped it, so it can't be pressed twice.
async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup || { inline_keyboard: [] },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("editMessageReplyMarkup error:", err.message);
    return false;
  }
}

// Builds the inline "OPEN" button shown under admin notifications, e.g.
// New order / New deposit alerts — same idea as the SAKURA Game Shop bot.
//
// Two styles, controlled by the MINI_APP_BUTTON_TYPE env var:
//   "url"     (default) — always works, but opens the link in an external/
//              in-app browser and shows a small ↗ "leaving Telegram" icon.
//   "web_app" — opens the Mini App natively inside Telegram, no ↗ icon,
//              feels like part of the app. Requires MINI_APP_URL's domain
//              to be registered as the bot's Mini App domain first
//              (BotFather → your bot → Bot Settings → Configure Mini App,
//              or /setdomain). If the domain isn't registered, Telegram
//              will reject the message, so only switch this on after
//              that's set up.
function openAppButton(label = "OPEN") {
  const url = process.env.MINI_APP_URL;
  if (!url) return undefined;
  const useWebApp = process.env.MINI_APP_BUTTON_TYPE === "web_app";
  return {
    inline_keyboard: [[useWebApp ? { text: label, web_app: { url } } : { text: label, url }]],
  };
}

// Builds the inline "✅ Done ပို့ရန်" button shown under New Order
// notifications. Tapping it is handled by routes/telegramBot.js (the
// webhook), which sends the customer their receipt and removes the button.
function orderDoneButton(orderId, label = "✅ Done ပို့ရန်") {
  return {
    inline_keyboard: [[{ text: label, callback_data: `order_done_${orderId}` }]],
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

module.exports = {
  notifyAdmin,
  sendTelegramMessage,
  sendTelegramPhoto,
  openAppButton,
  orderDoneButton,
  answerCallbackQuery,
  editMessageReplyMarkup,
};
