// Run this ONCE, locally, to log in with your own Telegram account and
// generate a long-lived session string. Never share this string — it's
// equivalent to your account password (whoever has it can act as you).
//
// Usage:
//   1. npm install telegram input
//   2. node scripts/generateSession.js
//   3. Follow the prompts (phone number, login code, 2FA password if set)
//   4. Copy the printed session string into TG_SESSION_STRING on Render

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

(async () => {
  if (!apiId || !apiHash) {
    console.error("Set TG_API_ID and TG_API_HASH env vars first (from https://my.telegram.org).");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text("Phone number (+95...): "),
    password: async () => await input.text("2FA password (leave blank if none): "),
    phoneCode: async () => await input.text("Login code from Telegram: "),
    onError: (err) => console.error(err),
  });

  console.log("\n✅ Logged in. Save this as TG_SESSION_STRING:\n");
  console.log(client.session.save());
  console.log("\nKeep this secret — do not commit it to git.\n");

  await client.disconnect();
  process.exit(0);
})();
