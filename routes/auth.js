// routes/auth.js
// Email/password login for the website (as opposed to the Telegram Mini App,
// which authenticates automatically via Telegram's own login data).
//
// Website accounts are stored in the same `users` table as Telegram
// accounts, using the same telegram_id column as their universal ID — see
// the comment in schema.sql for why. That's what makes every other route
// (deposits, orders, messages, admin, Google Sheets logging) work
// unchanged for both kinds of accounts.
//
// Needs one environment variable on Render:
//   JWT_SECRET — any long random string, used to sign login tokens.
//                Generate one with: openssl rand -hex 32
//
// Needs two packages: `npm install bcryptjs jsonwebtoken`

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

const JWT_EXPIRES_IN = "30d";

function signToken(user) {
  return jwt.sign(
    { telegramId: user.telegram_id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function publicUser(user) {
  return { telegramId: user.telegram_id, email: user.email, username: user.username };
}

// POST /api/auth/register
// body: { email, password, username }
router.post("/register", async (req, res) => {
  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET is not set");
    return res.status(500).json({ error: "Server is not configured for website login yet" });
  }

  const { email, password, username } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Synthetic negative id — see schema.sql comment. Real Telegram ids are
    // always positive, so this can never collide with one.
    const seq = await pool.query("SELECT nextval('web_user_id_seq') AS n");
    const syntheticId = -Number(seq.rows[0].n);

    const result = await pool.query(
      `INSERT INTO users (telegram_id, username, email, password_hash, balance_mmk)
       VALUES ($1, $2, $3, $4, 0) RETURNING *`,
      [syntheticId, username || null, normalizedEmail, passwordHash]
    );

    const user = result.rows[0];
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to register" });
  }
});

// POST /api/auth/login
// body: { email, password }
router.post("/login", async (req, res) => {
  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET is not set");
    return res.status(500).json({ error: "Server is not configured for website login yet" });
  }

  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
    const user = result.rows[0];

    // Same error for "no such account" and "wrong password" so we don't
    // reveal which emails are registered.
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log in" });
  }
});

module.exports = router;
