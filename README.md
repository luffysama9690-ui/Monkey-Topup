# Monkey Topup — Backend API

This is the backend server for the Monkey Topup Mini App. It stores users,
balances, deposits, and orders in a real database so the app works the same
way for every user, every time — not just inside one browser tab.

## What's inside
- `server.js` — the Express app and its routes
- `db.js` — the database connection
- `schema.sql` — the database tables
- `routes/` — one file per feature (users, deposits, orders, messages)

## How to put this on GitHub (step-by-step)

1. Go to **github.com**, log in, and click the **+** icon (top right) → **New repository**.
2. Name it `monkey-topup-backend`, leave it **Public** or **Private** (either is fine), and click **Create repository**.
3. On the next page, look for **"uploading an existing file"** (a blue link).
4. Drag every file from this folder into that upload box — including the ones
   inside `routes/` (you'll need to create a `routes` folder in the GitHub
   upload UI first, or upload the repo via GitHub Desktop, which is easier
   for folders — see note below).
5. Scroll down, click **Commit changes**.

**Easier alternative:** install **GitHub Desktop** (desktop.github.com),
sign in with your GitHub account, choose "Add Local Repository", pick this
folder, and click **Publish repository**. This handles subfolders correctly
in one click.

## How to deploy it on Render (step-by-step)

1. Log into **render.com** (the account you made with GitHub).
2. Click **New +** → **PostgreSQL**. Name it `monkey-topup-db`, choose the
   free plan, click **Create Database**. Wait for it to say "Available".
3. Open that database, find **"Internal Database URL"**, click to copy it.
4. Click **New +** → **Web Service**. Choose **"Build and deploy from a Git
   repository"**, then pick the `monkey-topup-backend` repo you just pushed.
5. Fill in:
   - **Name:** `monkey-topup-backend`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
6. Under **Environment Variables**, click **Add Environment Variable** and add:
   - `DATABASE_URL` → paste the Internal Database URL from step 3
   - `NODE_ENV` → `production`
7. Click **Create Web Service**. Render will build and start it — watch the
   logs; when it says `Monkey Topup backend listening on port ...` it's live.
8. Copy the service's URL at the top of the page (something like
   `https://monkey-topup-backend.onrender.com`) — you'll need this URL for
   the frontend to talk to.

## One-time step: create the database tables

After the web service is live, you need to run the migration **once** so the
tables exist. The easiest way on Render's free tier:
1. Open your Web Service page → **Shell** tab (top menu).
2. Run: `npm run migrate`
3. You should see `Done. Tables are ready.`

## Testing it worked

Visit your Render URL in a browser (e.g. `https://monkey-topup-backend.onrender.com`).
You should see: `Monkey Topup backend is running ✅`

---

Next step after this: connect the React frontend to this API (replace the
in-memory `useState` data with real `fetch()` calls to these endpoints), then
wire up the Telegram Bot + Mini App URL.

## Supplier bot relay (Mobile Legends diamond orders)

New orders for `game === "Mobile Legends"` are automatically relayed to
`@easytopup4ubot` via `services/relay/relayOrder.js`, called from
`routes/orders.js` right after an order is created. This uses a Telegram
**userbot** (your own account, not a regular Bot API bot) since bots
can't message other bots first — see `services/relay/telegramUserbot.js`.

### Setup

1. Get `api_id` / `api_hash` from https://my.telegram.org
2. `npm install` (pulls in the new `telegram` + `input` deps)
3. Generate a session string (one-time, locally):
   ```bash
   TG_API_ID=your_id TG_API_HASH=your_hash npm run generate-session
   ```
   Follow the prompts, then copy the printed session string.
4. Add these env vars on Render (same place as `DATABASE_URL`):
   - `TG_API_ID`
   - `TG_API_HASH`
   - `TG_SESSION_STRING` — from step 3. **Keep this secret** — it's
     equivalent to your account password. If leaked, revoke it from
     Telegram → Settings → Devices.
   - `SUPPLIER_BOT_USERNAME` — defaults to `easytopup4ubot` if unset

### ⚠️ Still needs manual confirmation before relying on it in production

`services/relay/relayOrder.js`'s `MONKEY_ITEM_MAP` maps your `item`
column values to the supplier's item codes. Everything is filled in
**except** the "2x Diamonds" bundles (`50+50 အပိုရ`, `150+150 အပိုရ`,
`250+250 အပိုရ`, `500+500 အပိုရ`) — these are commented out because I
couldn't confidently match them to a supplier code from the data
available. To confirm: send a candidate `.p`/`.m` command with a real
test player ID, check the delivered diamond count in-game, and match it
against the bundle. Wrong codes mean under/over-delivering diamonds to
a paying customer — don't guess.

Also note: the supplier bot deducts a **0.4% fee** on any Mobile
Legends order that auto-retries after a server error within 24 hours
(1,000 coins → -4, 10,000 → -40) — factor this into margin if you ever
add retry logic.
