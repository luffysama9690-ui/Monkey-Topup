const express = require("express");
const pool = require("../db");

const router = express.Router();

// GET /api/messages/:telegramId
router.get("/:telegramId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM messages WHERE telegram_id = $1 ORDER BY created_at DESC",
      [req.params.telegramId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load messages" });
  }
});

// GET /api/messages/:telegramId/unread-count
router.get("/:telegramId/unread-count", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM messages WHERE telegram_id = $1 AND is_read = false",
      [req.params.telegramId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load unread count" });
  }
});

// POST /api/messages/:telegramId/mark-read
router.post("/:telegramId/mark-read", async (req, res) => {
  try {
    await pool.query("UPDATE messages SET is_read = true WHERE telegram_id = $1", [req.params.telegramId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to mark messages read" });
  }
});

module.exports = router;
