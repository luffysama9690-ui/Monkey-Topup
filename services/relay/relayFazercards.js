const { getOffers, createTopupOrder } = require("./fazercards");

/**
 * Category IDs confirmed live against Myatko's Monkey Topup package list
 * (2569-08-19). Re-verify in the reseller dashboard if orders start
 * failing with "unmapped_item" — FazerCards may reshuffle categories.
 */
const CATEGORY_IDS = {
  ML: "a67331f3-7a3a-4345-b948-a07aa81cba62", // Mobile Legends (Global)
  MCGG: "5ee6297b-42d1-41da-8b12-9e2821691f6a", // Magic Chess Go Go (Global)
  PUBG: "8e34ea33-5d6f-4f04-81c0-6cd9d489b71d", // PUBG Mobile (Auto)
};

// Named (non-diamond) products where FazerCards' name doesn't match
// Monkey Topup's package name exactly. Diamond packages aren't listed
// here — they're matched by total diamond count instead (see
// findOfferForItem below), since FazerCards' offer names are things like
// "78 + 8 Diamonds" for what Monkey Topup sells as "Diamond 86".
const NAME_OVERRIDES = {
  // Mobile Legends
  "Weekly Elite Bundle": "Weekly Elite Pack",
  "Monthly Epic Bundle": "Monthly Elite Pack",
  // "Weekly Pass" and "Twilight Pass" match FazerCards' names as-is.

  // Magic Chess Go Go
  "Mcgg Weekly Pass": "Weekly Card",
  "Lukas's Battle Bounty": "Lucas's Battle Bounty", // FazerCards spells it "Lucas's"
  // "Battle for Discounts" matches as-is.
};

/** Sums the numbers in an offer name like "78 + 8 Diamonds" -> 86, or "429 Diamonds" -> 429. */
function offerDiamondTotal(offerName) {
  if (!/diamond/i.test(offerName)) return null;
  const nums = offerName.match(/\d+/g);
  if (!nums) return null;
  return nums.reduce((sum, n) => sum + parseInt(n, 10), 0);
}

/** Extracts the target diamond amount from an item name like "Diamond 86" or "Mcgg Dia 172". */
function itemDiamondAmount(itemName) {
  const match = itemName.match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Finds the FazerCards offer matching a Monkey Topup item name.
 * Throws if no confident match is found — callers should NOT guess.
 */
function findOfferForItem(offers, itemName) {
  const overrideName = NAME_OVERRIDES[itemName];
  if (overrideName) {
    const byName = offers.find((o) => o.name.trim().toLowerCase() === overrideName.toLowerCase());
    if (byName) return byName;
    throw new Error(`Name override "${overrideName}" for "${itemName}" not found in current offer list`);
  }

  // Try exact name match first (covers passes not in NAME_OVERRIDES).
  const exact = offers.find((o) => o.name.trim().toLowerCase() === itemName.trim().toLowerCase());
  if (exact) return exact;

  // Fall back to diamond-total matching.
  const targetAmount = itemDiamondAmount(itemName);
  if (targetAmount != null) {
    const byTotal = offers.find((o) => offerDiamondTotal(o.name) === targetAmount);
    if (byTotal) return byTotal;
  }

  throw new Error(`No FazerCards offer matches item "${itemName}"`);
}

/** Builds the `fields` object for an order from the offer's dynamic field schema. */
function buildFields(fieldsSchema, order) {
  const fields = {};
  for (const f of fieldsSchema) {
    const label = (f.label || "").toLowerCase();
    if (label.includes("server") || label.includes("zone")) {
      fields[f.key] = String(order.server_id ?? "");
    } else {
      // Anything else (Player ID, UID, Role ID, ...) maps to game_id.
      fields[f.key] = String(order.game_id ?? "");
    }
  }
  return fields;
}

async function relayViaFazercards(order, { game, categoryId }) {
  if (order.game !== game) return { ok: false, reason: "not_" + game.toLowerCase().replace(/\s+/g, "_") };
  if (!order.game_id) {
    console.error(`[fazercards] Order #${order.id} missing game_id — skipping relay`);
    return { ok: false, reason: "missing_ids" };
  }

  try {
    const { offers, fields: fieldsSchema } = await getOffers(categoryId);
    const offer = findOfferForItem(offers, order.item);
    const fields = buildFields(fieldsSchema || [], order);

    const result = await createTopupOrder({
      categoryId,
      offerId: offer.offer_id,
      fields,
      idempotencyKey: `monkeytopup-order-${order.id}`,
    });

    console.log(`[fazercards] Order #${order.id} -> FazerCards order ${result.order?.id} (${offer.name}, $${offer.price_usd})`);
    return { ok: true, fazercardsOrder: result.order, offer };
  } catch (err) {
    console.error(`[fazercards] Order #${order.id} failed: ${err.message}`);
    return { ok: false, reason: "relay_failed", error: err.message };
  }
}

const relayMlOrderFazercards = (order) => relayViaFazercards(order, { game: "Mobile Legends", categoryId: CATEGORY_IDS.ML });
const relayMcOrderFazercards = (order) => relayViaFazercards(order, { game: "Magic Chess GoGo", categoryId: CATEGORY_IDS.MCGG });
const relayPubgOrderFazercards = (order) => relayViaFazercards(order, { game: "PUBG Mobile", categoryId: CATEGORY_IDS.PUBG });

module.exports = {
  CATEGORY_IDS,
  relayMlOrderFazercards,
  relayMcOrderFazercards,
  relayPubgOrderFazercards,
  // exported for testing / debugging
  findOfferForItem,
  offerDiamondTotal,
};
