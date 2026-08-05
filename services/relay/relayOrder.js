const { sendAndWaitForReply } = require("./telegramUserbot");
const { buildMlCommand, getMlOrderCost, detectError, parseTransactionReport } = require("./orderCommand");

const SUPPLIER_BOT_USERNAME = process.env.SUPPLIER_BOT_USERNAME || "easytopup4ubot";

// Maps your Monkey Topup package names (the `item` column) to the
// supplier's { region, itemCode }. Built from your Mobile Legends Pass +
// Diamond shop screenshots, cross-referenced against @easytopup4ubot's
// `.l` price list (see pricing.js).
//
// ⚠️ "2x Diamonds" bundles (50+50, 150+150, 250+250, 500+500 အပိုရ) are
// NOT filled in yet — pending manual test confirmation (see README).
// Do NOT guess these in production — a wrong code under/over-delivers
// diamonds to a paying customer.
const MONKEY_ITEM_MAP = {
  "Diamond 11": { region: "PH", itemCode: "11" },
  "Diamond 22": { region: "PH", itemCode: "22" },
  "Diamond 33": { region: "PH", itemCode: "33" },
  "Diamond 44": { region: "PH", itemCode: "44" },
  "Diamond 56": { region: "PH", itemCode: "56" },
  "Diamond 86": { region: "BR", itemCode: "86" },
  "Diamond 112": { region: "PH", itemCode: "112" },
  "Diamond 172": { region: "BR", itemCode: "172" },
  "Diamond 257": { region: "BR", itemCode: "257" },
  "Diamond 343": { region: "BR", itemCode: "343" },
  "Diamond 429": { region: "BR", itemCode: "429" },
  "Diamond 514": { region: "BR", itemCode: "514" },
  "Diamond 600": { region: "BR", itemCode: "600" },
  "Diamond 706": { region: "BR", itemCode: "706" },
  "Diamond 878": { region: "BR", itemCode: "878" },
  "Diamond 963": { region: "BR", itemCode: "963" },
  "Diamond 1049": { region: "BR", itemCode: "1049" },
  "Diamond 1135": { region: "BR", itemCode: "1135" },
  "Diamond 1412": { region: "BR", itemCode: "1412" },
  "Diamond 2195": { region: "BR", itemCode: "2195" },
  "Diamond 2901": { region: "BR", itemCode: "2901" },
  "Diamond 3688": { region: "BR", itemCode: "3688" },
  "Diamond 4394": { region: "BR", itemCode: "4394" },
  "Diamond 5532": { region: "BR", itemCode: "5532" },
  "Diamond 9288": { region: "BR", itemCode: "9288" },

  "Weekly Elite Bundle": { region: "BR", itemCode: "weekly_elite_bundle" },
  "Monthly Epic Bundle": { region: "BR", itemCode: "monthly_epic_bundle" },
  "Weekly Pass": { region: "BR", itemCode: "wp" },
  "Twilight Pass": { region: "BR", itemCode: "twilight_pass" },

  // "50+50 အပိုရ": { region: "?", itemCode: "?" },
  // "150+150 အပိုရ": { region: "?", itemCode: "?" },
  // "250+250 အပိုရ": { region: "?", itemCode: "?" },
  // "500+500 အပိုရ": { region: "?", itemCode: "?" },
};

/**
 * Only handles Mobile Legends orders — PUBG/other games aren't wired up
 * yet. Returns { ok: false, reason: "not_ml" } for anything else so the
 * caller can decide whether to skip silently or log it.
 *
 * @param {object} order - a row from the `orders` table
 *   (id, telegram_id, game, item, game_id, server_id, qty, price, currency, ...)
 */
async function relayMlOrder(order) {
  if (order.game !== "Mobile Legends") {
    return { ok: false, reason: "not_ml" };
  }
  if (!order.game_id || !order.server_id) {
    console.error(`[relay] Order #${order.id} missing game_id/server_id — skipping relay`);
    return { ok: false, reason: "missing_ids" };
  }

  const mapping = MONKEY_ITEM_MAP[order.item];
  if (!mapping) {
    console.error(`[relay] Order #${order.id}: no item mapping for "${order.item}" — add it to MONKEY_ITEM_MAP`);
    return { ok: false, reason: "unmapped_item" };
  }

  const { region, itemCode } = mapping;
  const command = buildMlCommand({
    region,
    gameId: order.game_id,
    serverId: order.server_id,
    itemCode,
  });
  const expectedCost = getMlOrderCost({ region, itemCode });

  try {
    const reply = await sendAndWaitForReply(SUPPLIER_BOT_USERNAME, command);
    const errorType = detectError(reply);

    if (errorType) {
      console.error(`[relay] Order #${order.id} failed: ${errorType} — "${reply}"`);
      return { ok: false, reason: errorType, reply };
    }

    const report = parseTransactionReport(reply);
    console.log(`[relay] Order #${order.id} sent (${expectedCost} coins).`, report || reply);
    return { ok: true, reply, report, coinCost: expectedCost };
  } catch (err) {
    console.error(`[relay] Failed to send order #${order.id}:`, err.message);
    return { ok: false, reason: "send_failed", error: err.message };
  }
}

module.exports = { relayMlOrder, MONKEY_ITEM_MAP };
