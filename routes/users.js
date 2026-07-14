const express = require("express");
const pool = require("../db");

const router = express.Router();

// GET /api/users/:telegramId
// Returns the user's balance, creating the user row on first visit.
router.get("/:telegramId", async (req, res) => {
  const { telegramId } = req.params;
  try {
    let result = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegramId]);

    if (result.rows.length === 0) {
      result = await pool.query(
        "INSERT INTO users (telegram_id, username, balance_mmk) VALUES ($1, $2, 0) RETURNING *",
        [telegramId, req.query.username || null]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load user" });
  }
});

module.exports = router;
