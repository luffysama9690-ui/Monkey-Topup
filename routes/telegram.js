// // telegram.js
// // Sends a plain text message to the admin's Telegram chat using the Bot API.
// // Needs two environment variables on Render:
// //   TELEGRAM_BOT_TOKEN   — from @BotFather
// //   ADMIN_TELEGRAM_ID    — your personal numeric Telegram ID (from @userinfobot)
// //
// // If either variable is missing, this quietly does nothing instead of
// // crashing the request that triggered it — notifications are a nice-to-have,
// // not something that should ever block a deposit/order from being saved.
// async function notifyAdmin(text) {
//   const token = process.env.TELEGRAM_BOT_TOKEN;
//   const chatId = process.env.ADMIN_TELEGRAM_ID;

//   if (!token || !chatId) {
//     console.warn("notifyAdmin skipped — TELEGRAM_BOT_TOKEN or ADMIN_TELEGRAM_ID is not set.");
//     return;
//   }

//   try {
//     const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
//     });
//     if (!res.ok) {
//       const body = await res.text();
//       console.error("notifyAdmin failed:", res.status, body);
//     }
//   } catch (err) {
//     console.error("notifyAdmin error:", err.message);
//   }
// }

// module.exports = { notifyAdmin };
