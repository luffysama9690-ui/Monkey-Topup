-- schema.sql
-- Run this once against your database to create the tables the app needs.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  balance_mmk BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deposits (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('mmk', 'thb')),
  screenshot_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  game TEXT NOT NULL,
  item TEXT NOT NULL,
  game_id TEXT,
  server_id TEXT,
  qty INT NOT NULL DEFAULT 1,
  price BIGINT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('mmk', 'thb')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added later: lets a customer attach a transfer screenshot when paying for
-- an order directly (instead of from wallet balance). Safe to run again —
-- it's a no-op if the column already exists.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS screenshot_url TEXT;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  balance_mmk BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added later: THB wallet balance, separate from MMK. Safe to re-run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_thb BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  text TEXT NOT NULL,
  icon TEXT DEFAULT '🔔',
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Added later: website (email/password) accounts.
--
-- Website users share this same `users` table and the same telegram_id
-- column that deposits/orders/messages/admin/sheets already key off of —
-- so none of that code needs to change. Real Telegram ids are always
-- positive, so a website account is given a synthetic *negative*
-- telegram_id (via web_user_id_seq below), which can never collide with a
-- real one. All of it is safe to run again.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS web_user_id_seq START 1;

ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_identity_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_identity_check
      CHECK (telegram_id IS NOT NULL OR email IS NOT NULL);
  END IF;
END $$;
