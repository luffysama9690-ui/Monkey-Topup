// db.js
// Sets up a single shared PostgreSQL connection pool.
// Render's PostgreSQL gives you a DATABASE_URL — put it in your .env file
// (locally) or in Render's Environment settings (in production).
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false } // Render's managed Postgres needs this
      : false,
});

module.exports = pool;
