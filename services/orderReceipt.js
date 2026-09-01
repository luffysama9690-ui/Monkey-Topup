// services/orderReceipt.js
//
// One shared place for "tell the customer their order is fulfilled" so the
// message looks the same whether it was sent automatically (FazerCards
// orders, right after a successful relay -- see routes/orders.js) or by an
// admin manually pressing "✅ Done ပို့ရန်" (non-automated games -- see
// routes/telegramBot.js).

const pool = require("../db");
const { sendTelegramMessage } = require("../routes/telegram");

function formatOrderReceipt(order) {
  return (
    `Order ID: #${order.id}\n` +
    `Item: ${order.item}\n` +
    (order.game_id ? `GameID: ${order.game_id}${order.server_id ? ` [${order.server_id}]` : ""}\n` : "") +
    `Qty: ${order.qty}\n` +
    `Price: ${order.price} ${String(order.currency).toUpperCase()}\n` +
    `Pay method: ${order.pay_method || "-"}\n\n` +
    `ဝယ်ယူအားပေးမှုအတွက် ကျေးဇူးတင်ပါသည် 🙏`
  );
}

// Sends the receipt as a Telegram DM and drops a copy into the customer's
// in-app inbox (messages table) so it's visible even if they don't check
// Telegram right away.
async function sendOrderReceipt(order) {
  const receipt = formatOrderReceipt(order);
  await sendTelegramMessage(order.telegram_id, receipt);
  try {
    await pool.query(`INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`, [
      order.telegram_id,
      receipt,
      "✅",
    ]);
  } catch (err) {
    console.error(`orderReceipt: failed to save in-app receipt for order #${order.id}`, err.message);
  }
}

module.exports = { formatOrderReceipt, sendOrderReceipt };
