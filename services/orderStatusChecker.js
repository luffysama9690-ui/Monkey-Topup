// services/orderStatusChecker.js
//
// Safety net for FazerCards orders: some failures only show up *after* the
// initial "order created" response -- e.g. a per-account purchase limit
// (see the 2569-09-01 Weekly Pass incident: FazerCards accepted the order,
// then auto-refunded it seconds later once it discovered the Moonton
// account had already used its weekly claim). relayViaFazercards() only
// sees that first "created" response and has no way to know about the
// later refund -- nobody does, unless something goes back and checks.
//
// scheduleOrderStatusCheck() polls FazerCards ~60s after an order is
// placed. If FazerCards' status by then indicates the order didn't
// actually go through, we credit the customer's Monkey Topup wallet back
// and mark our own order row as failed, so this doesn't require a human to
// notice and fix by hand.

const pool = require("../db");
const { getOrderStatus } = require("./relay/fazercards");
const { sendTelegramMessage, notifyAdmin } = require("../routes/telegram");

const CHECK_DELAY_MS = 60 * 1000; // 60 seconds after order creation

// FazerCards status strings that mean "this didn't actually go through" --
// matched case-insensitively (substring) against whatever `status` the
// order-status response returns, since we don't have their full status
// enum documented anywhere we can see.
const FAILURE_STATUSES = ["refund", "fail", "cancel", "reject"];

function isFailureStatus(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  return FAILURE_STATUSES.some((bad) => s.includes(bad));
}

function scheduleOrderStatusCheck(orderId) {
  setTimeout(() => {
    checkAndRefundIfFailed(orderId).catch((err) => {
      console.error(`[orderStatusChecker] Order #${orderId} check crashed: ${err.message}`);
    });
  }, CHECK_DELAY_MS);
}

async function checkAndRefundIfFailed(orderId) {
  const orderRes = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  if (orderRes.rows.length === 0) return;
  const order = orderRes.rows[0];

  // Nothing to check (relay never got a FazerCards order id), or someone
  // (admin, or this checker on a re-run) already resolved it.
  if (!order.fazercards_order_id || order.status !== "success") return;

  let statusRes;
  try {
    statusRes = await getOrderStatus(order.fazercards_order_id);
  } catch (err) {
    // Network hiccup or FazerCards outage -- don't guess, don't refund.
    // This is a one-shot check (no retry), so a failure here just means an
    // admin needs to look at it manually, same as before this existed.
    console.error(`[orderStatusChecker] Order #${orderId}: status check failed: ${err.message}`);
    return;
  }

  const fcOrder = statusRes.order || statusRes;
  const status = fcOrder.status;

  if (!isFailureStatus(status)) return; // still processing, or it succeeded -- nothing to do

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const column = order.currency === "thb" ? "balance_thb" : "balance_mmk";
    await client.query(`UPDATE users SET ${column} = ${column} + $1 WHERE telegram_id = $2`, [
      order.price,
      order.telegram_id,
    ]);
    await client.query("UPDATE orders SET status = 'failed' WHERE id = $1", [order.id]);
    await client.query(`INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`, [
      order.telegram_id,
      `Order #${order.id} (${order.item}) ကို ပေးသွင်း၍ မရသဖြင့် ${order.price} ${String(order.currency).toUpperCase()} ကို wallet ထဲ ပြန်အမ်းပေးလိုက်ပါသည်။`,
      "↩️",
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[orderStatusChecker] Order #${orderId}: refund transaction failed: ${err.message}`);
    return;
  } finally {
    client.release();
  }

  console.log(`[orderStatusChecker] Order #${orderId} auto-refunded (FazerCards status: "${status}")`);

  const priceLabel = `${order.price} ${String(order.currency).toUpperCase()}`;
  try {
    await notifyAdmin(
      `↩️ <b>Auto-refunded</b>\nOrder #${order.id} (${order.item}) — FazerCards status: "${status}"\n` +
        `${priceLabel} ကို customer wallet ထဲ ပြန်အမ်းပေးလိုက်ပါပြီ (Telegram ID: ${order.telegram_id})။`
    );
  } catch (_) {}
  try {
    await sendTelegramMessage(
      order.telegram_id,
      `↩️ Order #${order.id} (${order.item}) ကို ပေးသွင်း၍ မရသဖြင့် ${priceLabel} ကို wallet ထဲ ပြန်အမ်းပေးလိုက်ပါသည်။`
    );
  } catch (_) {}
}

module.exports = { scheduleOrderStatusCheck };
