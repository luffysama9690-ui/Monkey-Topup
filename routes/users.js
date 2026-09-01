const express = require("express");
const pool = require("../db");

const router = express.Router();

// GET /api/users/:telegramId
// Returns the user's balance, creating the user row on first visit. Also
// doubles as a heartbeat: every call (including the frontend's periodic
// background ping) bumps last_active_at, which the admin panel's "active
// now" count reads from.
router.get("/:telegramId", async (req, res) => {
  const { telegramId } = req.params;
  try {
    let result = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegramId]);

    if (result.rows.length === 0) {
      result = await pool.query(
        "INSERT INTO users (telegram_id, username, balance_mmk, last_active_at) VALUES ($1, $2, 0, now()) RETURNING *",
        [telegramId, req.query.username || null]
      );
    } else {
      result = await pool.query(
        "UPDATE users SET last_active_at = now() WHERE telegram_id = $1 RETURNING *",
        [telegramId]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load user" });
  }
});

module.exports = router;
