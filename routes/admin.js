const express = require("express");
const pool = require("../db");
const { updateDepositStatus, updateOrderStatus } = require("./sheets");

const router = express.Router();

// Simple authorization check: only the Telegram ID configured in
// ADMIN_TELEGRAM_ID (Render env var) may use these endpoints. The real check
// always happens here on the server — the frontend only decides whether to
// *show* the Admin tab, it never grants access on its own.
function isAdmin(telegramId) {
  return (
    !!process.env.ADMIN_TELEGRAM_ID &&
    !!telegramId &&
    String(telegramId) === String(process.env.ADMIN_TELEGRAM_ID)
  );
}

// GET /api/admin/check?telegramId=...
// Used by the frontend to decide whether to show the Admin tab at all.
router.get("/check", (req, res) => {
  res.json({ isAdmin: isAdmin(req.query.telegramId) });
});

// GET /api/admin/pending?telegramId=...
// Returns everything currently waiting on admin review.
router.get("/pending", async (req, res) => {
  if (!isAdmin(req.query.telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  try {
    const [deposits, orders] = await Promise.all([
      pool.query("SELECT * FROM deposits WHERE status = 'pending' ORDER BY created_at ASC"),
      pool.query("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at ASC"),
    ]);
    res.json({ deposits: deposits.rows, orders: orders.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load pending items" });
  }
});

// PATCH /api/admin/deposits/:id/status
// body: { telegramId, status: "success" | "rejected" }
// Approving a deposit credits the user's wallet (MMK or THB, whichever the
// deposit was in). Rejecting it just marks it rejected — no balance change.
router.patch("/deposits/:id/status", async (req, res) => {
  const { telegramId, status } = req.body;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  if (!["success", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be 'success' or 'rejected'" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dep = await client.query("SELECT * FROM deposits WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (dep.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Deposit not found" });
    }
    const deposit = dep.rows[0];
    if (deposit.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Deposit already processed" });
    }
    await client.query("UPDATE deposits SET status = $1 WHERE id = $2", [status, req.params.id]);
    if (status === "success") {
      const balanceColumn = deposit.currency === "mmk" ? "balance_mmk" : "balance_thb";
      await client.query(
        `UPDATE users SET ${balanceColumn} = ${balanceColumn} + $1 WHERE telegram_id = $2`,
        [deposit.amount, deposit.telegram_id]
      );
    }
    await client.query(
      `INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`,
      [
        deposit.telegram_id,
        status === "success"
          ? `သင့်ရဲ့ ငွေဖြည့်သွင်းမှု #${deposit.id} (${deposit.amount} ${deposit.currency.toUpperCase()}) အောင်မြင်ပါပြီ`
          : `သင့်ရဲ့ ငွေဖြည့်သွင်းမှု #${deposit.id} ကို ငြင်းပယ်လိုက်ပါသည်`,
        status === "success" ? "✅" : "❌",
      ]
    );
    await client.query("COMMIT");

    updateDepositStatus(req.params.id, status);

    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to update deposit" });
  } finally {
    client.release();
  }
});

// PATCH /api/admin/orders/:id/status
// body: { telegramId, status: "success" | "failed" }
// Note: orders.status only allows 'pending' | 'success' | 'failed' in the
// database (see schema.sql), so "reject" is stored as "failed" here — the
// Admin Panel UI can still label the button "Reject" for the person using it.
router.patch("/orders/:id/status", async (req, res) => {
  const { telegramId, status } = req.body;
  if (!isAdmin(telegramId)) {
    return res.status(403).json({ error: "Not authorized" });
  }
  if (!["success", "failed"].includes(status)) {
    return res.status(400).json({ error: "status must be 'success' or 'failed'" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ord = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (ord.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Order not found" });
    }
    const order = ord.rows[0];
    if (order.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Order already processed" });
    }
    await client.query("UPDATE orders SET status = $1 WHERE id = $2", [status, req.params.id]);
    await client.query(
      `INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`,
      [
        order.telegram_id,
        status === "success"
          ? `သင့်ရဲ့ အော်ဒါ #${order.id} (${order.item}) အောင်မြင်ပါပြီ`
          : `သင့်ရဲ့ အော်ဒါ #${order.id} (${order.item}) ကို ငြင်းပယ်လိုက်ပါသည်`,
        status === "success" ? "✅" : "❌",
      ]
    );
    await client.query("COMMIT");

    updateOrderStatus(req.params.id, status);

    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to update order" });
  } finally {
    client.release();
  }
});

module.exports = router;
