// spin.js
// The "ကံစမ်းမဲ" (Lucky Spin) feature — once every 24 hours, a user can
// spin for a random MMK cashback amount that's credited straight to their
// wallet balance automatically (no admin approval needed).
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

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

function pickReward() {
  const totalWeight = REWARDS.reduce((sum, r) => sum + r.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const r of REWARDS) {
    if (roll < r.weight) return r.amount;
    roll -= r.weight;
  }
  return REWARDS[0].amount; // fallback, should never hit
}

function nextSpinTime(lastSpinAt) {
  if (!lastSpinAt) return null;
  return new Date(new Date(lastSpinAt).getTime() + COOLDOWN_MS);
}

// GET /api/spin/status/:telegramId
// Tells the frontend whether the Spin button should be enabled, and if not,
// when it will be.
router.get("/status/:telegramId", async (req, res) => {
  try {
    const result = await pool.query("SELECT last_spin_at FROM users WHERE telegram_id = $1", [req.params.telegramId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const lastSpinAt = result.rows[0].last_spin_at;
    const nextAt = nextSpinTime(lastSpinAt);
    const canSpin = !nextAt || nextAt <= new Date();
    res.json({ canSpin, nextSpinAt: canSpin ? null : nextAt, rewards: REWARDS.map((r) => r.amount) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load spin status" });
  }
});

// POST /api/spin
// body: { telegramId }
// Performs the spin: picks a reward, credits it to balance_mmk, and resets
// the 24h cooldown. Rejects if the user already spun within the last 24h.
router.post("/", async (req, res) => {
  const { telegramId } = req.body;
  if (!telegramId) {
    return res.status(400).json({ error: "telegramId is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const userRes = await client.query(
      "SELECT balance_mmk, last_spin_at FROM users WHERE telegram_id = $1 FOR UPDATE",
      [telegramId]
    );
    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "User not found" });
    }
    const { balance_mmk: currentBalance, last_spin_at: lastSpinAt } = userRes.rows[0];
    const nextAt = nextSpinTime(lastSpinAt);
    if (nextAt && nextAt > new Date()) {
      await client.query("ROLLBACK");
      return res.status(429).json({ error: "already_spun", nextSpinAt: nextAt });
    }

    const reward = pickReward();
    const newBalance = Number(currentBalance) + reward;

    await client.query("UPDATE users SET balance_mmk = $1, last_spin_at = NOW() WHERE telegram_id = $2", [
      newBalance,
      telegramId,
    ]);

    await client.query(`INSERT INTO messages (telegram_id, text, icon) VALUES ($1, $2, $3)`, [
      telegramId,
      `🎉 ကံစမ်းမဲကနေ ${reward} MMK ရရှိပါသည်! Balance ထဲ ရောက်ရှိပြီးပါပြီ။`,
      "🎡",
    ]);

    await client.query("COMMIT");
    res.json({ ok: true, reward, newBalance, nextSpinAt: nextSpinTime(new Date()) });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to spin" });
  } finally {
    client.release();
  }
});

module.exports = router;
