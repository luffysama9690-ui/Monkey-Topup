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
