const { getCoinCost } = require("./pricing");

/**
 * Builds the exact command text for @easytopup4ubot.
 *
 * ML top-up:  .m gameId serverId itemCode   (Brazil server)
 *             .p gameId serverId itemCode   (Philippines server)
 * PUBG UC:    .u gameId code1 [code2..code5]
 * Order check: .ck orderId
 * Player check: .r gameId serverId
 * Balance:    .myb
 * Player name: .n gameId serverId
 * UC usage check: .c code
 * Coin top-up: .t code
 */

function buildMlCommand({ region, gameId, serverId, itemCode }) {
  const prefix = region === "PH" ? ".p" : ".m";
  return `${prefix} ${gameId} ${serverId} ${itemCode}`;
}

function buildUcCommand({ gameId, codes }) {
  // codes: array of up to 5 UC redeem codes
  return [".u", gameId, ...codes.slice(0, 5)].join(" ");
}

function buildCheckOrderCommand(orderId) {
  return `.ck ${orderId}`;
}

function buildCheckPlayerCommand({ gameId, serverId }) {
  return `.r ${gameId} ${serverId}`;
}

function buildBalanceCommand() {
  return ".myb";
}

function buildNicknameCommand({ gameId, serverId }) {
  return `.n ${gameId} ${serverId}`;
}

function buildCheckCodeCommand(code) {
  return `.c ${code}`;
}

function buildTopUpCoinCommand(code) {
  return `.t ${code}`;
}

/** Coin cost (before any auto-retry fee) for a given ML order. */
function getMlOrderCost({ region, itemCode }) {
  return getCoinCost(region, itemCode);
}

// Known error strings from the supplier bot's replies — see README for
// what triggers each one. Match against the incoming reply text.
const TARGET_BOT_ERRORS = {
  INVALID_CODE: "Invalid code provided.",
  CODE_USED: "Code has already been used.",
  INVALID_COOKIE: "Invalid cookie",
};

function detectError(replyText) {
  for (const [key, phrase] of Object.entries(TARGET_BOT_ERRORS)) {
    if (replyText.includes(phrase)) return key;
  }
  return null;
}

/**
 * Parses a successful "==== Transaction Report ====" reply into a plain
 * object. Returns null if the text doesn't look like a transaction
 * report (e.g. it was an error message instead — check detectError first).
 *
 * Example input:
 *   ==== Transaction Report ====
 *   Order ID.: #100034
 *   UID     : 115047769 (2587)
 *   Name    : (パン)'' ft.
 *   Product : Weekly Pass
 *   Orders  :
 *   WP S260805103930690DFOT ✅
 *   Spent Amount: 76 🪙
 *   Time    : 8/5/2026, 8:09:31 PM
 */
function parseTransactionReport(replyText) {
  if (!replyText.includes("Transaction Report")) return null;

  const grab = (label) => {
    const match = replyText.match(new RegExp(`${label}\\s*:\\s*(.+)`));
    return match ? match[1].trim() : null;
  };

  const orderId = grab("Order ID\\.?");
  const uid = grab("UID");
  const name = grab("Name");
  const product = grab("Product");
  const spentMatch = replyText.match(/Spent Amount:\s*([\d.]+)/);
  const success = replyText.includes("✅");

  return {
    orderId,
    uid,
    name,
    product,
    spentAmount: spentMatch ? Number(spentMatch[1]) : null,
    success,
    raw: replyText,
  };
}

module.exports = {
  buildMlCommand,
  buildUcCommand,
  buildCheckOrderCommand,
  buildCheckPlayerCommand,
  buildBalanceCommand,
  buildNicknameCommand,
  buildCheckCodeCommand,
  buildTopUpCoinCommand,
  getMlOrderCost,
  detectError,
  parseTransactionReport,
  TARGET_BOT_ERRORS,
};
