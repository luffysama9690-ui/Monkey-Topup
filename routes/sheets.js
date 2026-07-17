// sheets.js
// Appends a row to Google Sheets every time an order or deposit is created,
// using a Google Cloud service account (no OAuth login flow needed).
//
// Needs three environment variables on Render:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL — the "client_email" field from the service account JSON key
//   GOOGLE_PRIVATE_KEY           — the "private_key" field from that same JSON key
//   GOOGLE_SHEET_ID              — the spreadsheet ID (the long string in the sheet's URL,
//                                  between /d/ and /edit)
//
// One spreadsheet is used for both, with two tabs named exactly:
//   "Orders"    — for package purchases
//   "Deposits"  — for wallet top-ups
//
// Setup (one time):
//   1. Google Cloud Console → create/select a project → enable "Google Sheets API".
//   2. IAM & Admin → Service Accounts → create one → create a JSON key → download it.
//   3. Open the JSON key file: copy "client_email" into GOOGLE_SERVICE_ACCOUNT_EMAIL,
//      and copy "private_key" (the whole "-----BEGIN PRIVATE KEY-----...” block) into
//      GOOGLE_PRIVATE_KEY on Render. Render's env var editor accepts the literal
//      newlines fine; if it ever gets flattened to "\n" text, the replace() below
//      converts it back.
//   4. Open your Google Sheet, click Share, and share it with the service account's
//      email address (the one in GOOGLE_SERVICE_ACCOUNT_EMAIL) as an Editor.
//   5. In that Sheet, create two tabs named exactly "Orders" and "Deposits" (bottom
//      tab bar, right-click → rename). The first row of each can hold your own
//      header labels — this script only ever appends below whatever is already there.
//   6. Copy the Sheet ID from the URL into GOOGLE_SHEET_ID on Render.
//   7. `npm install googleapis` in the backend project (adds it to package.json).
//
// If any variable is missing, this quietly does nothing instead of crashing the
// request that triggered it — sheet logging is a nice-to-have, not something that
// should ever block an order/deposit from being saved.

const { google } = require("googleapis");

let cachedClient = null;

function getSheetsClient() {
  if (cachedClient) return cachedClient;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) return null;

  const auth = new google.auth.JWT({
    email,
    key: key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

async function appendRow(sheetName, row) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = getSheetsClient();

  if (!sheets || !sheetId) {
    console.warn(
      `appendRow(${sheetName}) skipped — GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, or GOOGLE_SHEET_ID is not set.`
    );
    return;
  }

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.error(`appendRow(${sheetName}) failed:`, err.message);
  }
}

// One row per package purchase, into the "Orders" tab.
function logOrder({ id, telegramId, game, item, gameId, serverId, qty, price, currency, payMethod, status }) {
  const row = [
    new Date().toISOString(),
    id,
    telegramId,
    game || "",
    item || "",
    gameId || "",
    serverId || "",
    qty ?? 1,
    price,
    (currency || "").toUpperCase(),
    payMethod || "",
    status || "",
  ];
  return appendRow("Orders", row);
}

// One row per wallet top-up request, into the "Deposits" tab.
function logDeposit({ id, telegramId, amount, currency, status }) {
  const row = [new Date().toISOString(), id, telegramId, amount, (currency || "").toUpperCase(), status || ""];
  return appendRow("Deposits", row);
}

// Finds the row whose ID column (column B) matches `id`, and overwrites its
// status cell. Used when an admin approves/rejects a deposit or order, so the
// sheet doesn't stay stuck showing "pending" forever.
async function updateStatus(sheetName, statusColumnLetter, id, status) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = getSheetsClient();

  if (!sheets || !sheetId) {
    console.warn(`updateStatus(${sheetName}) skipped — Google Sheets env vars are not set.`);
    return;
  }

  try {
    const idColumn = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!B:B`,
    });
    const rows = idColumn.data.values || [];
    const rowIndex = rows.findIndex((r) => String(r[0]) === String(id));
    if (rowIndex === -1) {
      console.warn(`updateStatus(${sheetName}) — no row found for id ${id}`);
      return;
    }

    const rowNumber = rowIndex + 1; // sheet rows are 1-indexed, matching the B:B range directly
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${sheetName}!${statusColumnLetter}${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[status]] },
    });
  } catch (err) {
    console.error(`updateStatus(${sheetName}) failed:`, err.message);
  }
}

// Deposits layout: A=timestamp, B=id, C=telegramId, D=amount, E=currency, F=status
function updateDepositStatus(id, status) {
  return updateStatus("Deposits", "F", id, status);
}

// Orders layout: A=timestamp, B=id, C=telegramId, D=game, E=item, F=gameId,
// G=serverId, H=qty, I=price, J=currency, K=payMethod, L=status
function updateOrderStatus(id, status) {
  return updateStatus("Orders", "L", id, status);
}

module.exports = { logOrder, logDeposit, updateDepositStatus, updateOrderStatus };
