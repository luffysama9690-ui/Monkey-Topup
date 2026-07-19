// server.js
// Entry point for the Monkey Topup backend API.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const pool = require("./db");

const usersRouter = require("./routes/users");
const depositsRouter = require("./routes/deposits");
const ordersRouter = require("./routes/orders");
const messagesRouter = require("./routes/messages");
const authRouter = require("./routes/auth");
const telegramBotRouter = require("./routes/telegramBot");

const app = express();

app.use(cors()); // allow the Mini App's frontend to call this API
app.use(express.json());

// Simple health check — visiting this URL should show "ok"
app.get("/", (req, res) => {
  res.send("Monkey Topup backend is running ✅");
});

app.use("/api/admin", require("./routes/admin"));
app.use("/api/users", usersRouter);
app.use("/api/deposits", depositsRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/auth", authRouter);
// Receives Telegram button-press updates (e.g. the "Done" button on order
// notifications). See routes/telegramBot.js for the one-time setWebhook
// step you need to run after this is deployed.
app.use("/api/telegram", telegramBotRouter);
app.use("/api/spin", require("./routes/spin"));

// Creates the tables automatically on boot if they don't exist yet.
// schema.sql uses "CREATE TABLE IF NOT EXISTS", so this is safe to run
// every single time the server restarts — it only does work the first time.
async function ensureSchema() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(sql);
    console.log("Database schema is ready.");
  } catch (err) {
    console.error("Failed to set up database schema:", err.message);
  }

  // Small one-off migrations for columns added after the initial schema.sql
  // was written. Safe to run every boot — IF NOT EXISTS makes each a no-op
  // once it's already been applied.
  try {
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_method TEXT");
    console.log("Migration check: orders.pay_method is ready.");
  } catch (err) {
    console.error("Failed to migrate orders.pay_method:", err.message);
  }

  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_reseller BOOLEAN NOT NULL DEFAULT false");
    console.log("Migration check: users.is_reseller is ready.");
  } catch (err) {
    console.error("Failed to migrate users.is_reseller:", err.message);
  }

  try {
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_spin_at TIMESTAMPTZ");
    console.log("Migration check: users.last_spin_at is ready.");
  } catch (err) {
    console.error("Failed to migrate users.last_spin_at:", err.message);
  }
}

const PORT = process.env.PORT || 3000;
ensureSchema().then(() => {
  app.listen(PORT, () => {
    console.log(`Monkey Topup backend listening on port ${PORT}`);
  });
});
