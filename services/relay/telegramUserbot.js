const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const stringSession = new StringSession(process.env.TG_SESSION_STRING || "");

let clientPromise = null;

/**
 * Lazily connects a single shared GramJS client (logged in as your own
 * Telegram account) and reuses it across calls, instead of reconnecting
 * on every order.
 */
function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
      });
      await client.connect();
      return client;
    })();
  }
  return clientPromise;
}

/**
 * Sends `text` to `targetUsername` (e.g. "@supplier_bot" or "supplier_bot")
 * exactly as if you'd typed and sent it yourself in that chat.
 * @param {string} targetUsername - the other bot's @username
 * @param {string} text - full message text, e.g. ".m 12345678 1234 wp"
 */
async function sendAsUser(targetUsername, text) {
  const client = await getClient();
  const handle = targetUsername.startsWith("@") ? targetUsername : `@${targetUsername}`;
  await client.sendMessage(handle, { message: text });
}

/**
 * Sends a command and waits for the bot's next reply in that chat, up to
 * `timeoutMs`. Since @easytopup4ubot is a plain text bot (no request IDs
 * to correlate on), this assumes you're not firing overlapping commands
 * at it concurrently — queue orders if you expect bursts.
 *
 * @param {string} targetUsername
 * @param {string} text
 * @param {number} timeoutMs
 * @returns {Promise<string>} the bot's reply text
 */
async function sendAndWaitForReply(targetUsername, text, timeoutMs = 15000) {
  const client = await getClient();
  const handle = targetUsername.startsWith("@") ? targetUsername : `@${targetUsername}`;

  return new Promise((resolve, reject) => {
    let handler;
    const timer = setTimeout(() => {
      client.removeEventHandler(handler, new NewMessage({ chats: [handle] }));
      reject(new Error(`No reply from ${handle} within ${timeoutMs}ms`));
    }, timeoutMs);

    handler = async (event) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({ chats: [handle] }));
      resolve(event.message?.message || "");
    };

    client.addEventHandler(handler, new NewMessage({ chats: [handle] }));

    client.sendMessage(handle, { message: text }).catch((err) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({ chats: [handle] }));
      reject(err);
    });
  });
}

module.exports = { sendAsUser, sendAndWaitForReply, getClient };
