// migrate.js
// Run with: npm run migrate
// Reads schema.sql and executes it against the database in DATABASE_URL.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./db");

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Running schema.sql against the database...");
  await pool.query(sql);
  console.log("Done. Tables are ready.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
