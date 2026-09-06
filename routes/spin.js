// spin.js
// The "ကံစမ်းမဲ" (Lucky Spin) feature — spin for a random MMK cashback
// amount, credited straight to the wallet balance automatically (no admin
// approval needed).
//
// Changed 2569-09-06: this used to be a flat 24h-cooldown freebie anyone
// could use, order or not. Now it's earned — a user gets 1 spin credit per
// completed order (see routes/orders.js and the PATCH
// /admin/orders/:id/status handler, both of which increment
// users.spin_credits by 1 whenever an order reaches 'success'). Someone
// who has never ordered has 0 credits and can't spin at all.
//
// Reward table is a weighted random pick — bigger prizes are rarer. Tweak
// REWARDS below any time to change the odds/amounts; weights don't need to
// add up to any particular number, they're just relative.
const express = require("express");
const pool = require("../db");

const router = express.Router();

const REWARDS = [
  { amount: 100, weight: 35 },
  { amount: 200, weight: 25 },
  { amount: 300, weight: 15 },
  { amount: 500, weight: 12 },
  { amount: 1000, weight: 8 },
  { amount: 2000, weight: 5 },
];

function pickReward() {
  const totalWeight = REWARDS.reduce((sum, r) => sum + r.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const r of REWARDS) {
    if (roll < r.weight) return r.amount;
    roll -= r.weight;
  }
  return REWARDS[0].amount; // fallback, should never hit
}

// GET /api/spin/status/:telegramId
// Tells the frontend whether the Spin button should be enabled, and how
// many spin credits are left waiting to be used.
router.get("/status/:telegramId", async (req, res) => {
  try {
    const result = await pool.query("SELECT spin_credits FROM users WHERE telegram_id = $1", [req.params.telegramId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const spinCredits = result.rows[0].spin_credits;
    res.json({ canSpin: spinCredits > 0, spinCredits, rewards: REWARDS.map((r) => r.amount) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load spin status" });
  }
});

// POST /api/spin
// body: { telegramId }
// Performs the spin: picks a reward, credits it to balance_mmk, and
// consumes one spin credit. Rejects if the user has none left.
router.post("/", async (req, res) => {
  const { telegramId } = req.body;
  if (!telegramId) {
    return res.status(400).json({ error: "telegramId is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query(
      "SELECT balance_mmk, spin_credits FROM users WHERE telegram_id = $1 FOR UPDATE",
      [telegramId]
    );
    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }
    const { balance_mmk: currentBalance, spin_credits: spinCredits } = userRes.rows[0];
    if (spinCredits <= 0) {
      await client.query("ROLLBACK");
      return res.status(429).json({ error: "no_spins_left" });
    }

    const reward = pickReward();
    const newBalance = Number(currentBalance) + reward;

    await client.query(
      "UPDATE users SET balance_mmk = $1, spin_credits = spin_credits - 1, last_spin_at = NOW() WHERE telegram_id = $2",
      [newBalance, telegramId]
    );

    await client.query(`INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`, [
      telegramId,
      `🎉 ကံစမ်းမဲကနေ ${reward} MMK ရရှိပါသည်! Balance ထဲ ရောက်ရှိပြီးပါပြီ။`,
      "🎡",
    ]);

    await client.query("COMMIT");
    res.json({ ok: true, reward, newBalance, spinCredits: spinCredits - 1 });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to spin" });
  } finally {
    client.release();
  }
});

module.exports = router;
