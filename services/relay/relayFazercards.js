const { getOffers, createTopupOrder, validatePlayerId } = require("./fazercards");

/**
 * Category IDs confirmed live against Myatko's Monkey Topup package list
 * (2569-08-19). Re-verify in the reseller dashboard if orders start
 * failing with "unmapped_item" — FazerCards may reshuffle categories.
 */
const CATEGORY_IDS = {
  ML: "a67331f3-7a3a-4345-b948-a07aa81cba62", // Mobile Legends (Global)
  MCGG: "5ee6297b-42d1-41da-8b12-9e2821691f6a", // Magic Chess Go Go (Global)
  PUBG: "8e34ea33-5d6f-4f04-81c0-6cd9d489b71d", // PUBG Mobile (Auto)
  RACING_SEA: "22c28b10-064b-4731-9c33-555c653029ee", // Racing Master (SEA)
  RACING_LATAM: "d6595b1f-688f-4da3-ab1b-b1e1baa0e7c5", // Racing Master (LATAM)
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

const GAME_TO_CATEGORY = {
  "Mobile Legends": CATEGORY_IDS.ML,
  "Magic Chess GoGo": CATEGORY_IDS.MCGG,
  "PUBG Mobile": CATEGORY_IDS.PUBG,
};

/**
 * Validates a Player ID + Server ID against FazerCards before an order is
 * accepted, for whichever games FazerCards covers.
 *
 * `item` is only needed for region-split games (Racing Master) where the
 * category depends on which region's package was picked — pass
 * order.item; other games ignore it.
 *
 * Returns:
 *   { checked: false }                                 — game isn't one FazerCards covers, or gameId missing; caller should just proceed
 *   { checked: true, valid: true, playerName, region }  — confirmed real account
 *   { checked: true, valid: false }                     — FazerCards says this ID/Server doesn't exist
 *   { checked: true, valid: null, error }                — couldn't check (network/API issue) — caller should fail OPEN (don't block the sale over an unrelated outage), just log it
 */
async function validateGamePlayerId(game, gameId, serverId, item) {
  let categoryId = GAME_TO_CATEGORY[game];
  if (game === "Racing Master") {
    categoryId = resolveRacingCategory(item)?.categoryId;
  }
  if (!categoryId || !gameId) return { checked: false };

  try {
    const { fields: fieldsSchema } = await getOffers(categoryId);
    const fields = buildFields(fieldsSchema || [], { game_id: gameId, server_id: serverId });
    const result = await validatePlayerId(categoryId, fields);
    return { checked: true, valid: !!result.valid, playerName: result.player_name, region: result.region };
  } catch (err) {
    console.error(`[fazercards] validate-id check failed for ${game} (${gameId}/${serverId}): ${err.message}`);
    return { checked: true, valid: null, error: err.message };
  }
}

/**
 * Racing Master items are prefixed with their region ("SEA Novice Pack" /
 * "LATAM Novice Pack") since the two regions have separate FazerCards
 * categories but can share the same underlying pack name. Splits that
 * prefix off and returns the matching category + the bare name FazerCards
 * actually uses.
 */
function resolveRacingCategory(itemName) {
  if (itemName?.startsWith("SEA ")) {
    return { categoryId: CATEGORY_IDS.RACING_SEA, bareItem: itemName.slice(4) };
  }
  if (itemName?.startsWith("LATAM ")) {
    return { categoryId: CATEGORY_IDS.RACING_LATAM, bareItem: itemName.slice(6) };
  }
  return null;
}

async function relayViaFazercards(order, { game, categoryId, itemOverride } = {}) {
  if (order.game !== game) return { ok: false, reason: "not_" + game.toLowerCase().replace(/\s+/g, "_") };
  if (!order.game_id) {
    console.error(`[fazercards] Order #${order.id} missing game_id — skipping relay`);
    return { ok: false, reason: "missing_ids" };
  }

  try {
    const { offers, fields: fieldsSchema } = await getOffers(categoryId);
    const offer = findOfferForItem(offers, itemOverride ?? order.item);
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

// The only Mobile Legends items FazerCards actually sells (kept in sync
// with Money_topup_front's ML_DIAMONDS/ML_PASSES). ML is 100% FazerCards
// now (no other supplier) — this set exists as a safety guard so a
// mismatched item name fails loudly ("not_on_fazercards", logged in
// routes/orders.js) instead of silently erroring against the API.
const FAZERCARDS_ML_ITEMS = new Set([
  "Diamond 86", "Diamond 172", "Diamond 257", "Diamond 429", "Diamond 706",
  "Diamond 2195", "Diamond 3688", "Diamond 5532", "Diamond 9288",
  "Weekly Elite Bundle", "Monthly Epic Bundle", "Weekly Pass", "Twilight Pass",
]);

const relayMlOrderFazercards = (order) => {
  if (order.game === "Mobile Legends" && !FAZERCARDS_ML_ITEMS.has(order.item)) {
    return Promise.resolve({ ok: false, reason: "not_on_fazercards" });
  }
  return relayViaFazercards(order, { game: "Mobile Legends", categoryId: CATEGORY_IDS.ML });
};
const relayMcOrderFazercards = (order) => relayViaFazercards(order, { game: "Magic Chess GoGo", categoryId: CATEGORY_IDS.MCGG });
const relayPubgOrderFazercards = (order) => relayViaFazercards(order, { game: "PUBG Mobile", categoryId: CATEGORY_IDS.PUBG });

const relayRacingOrderFazercards = (order) => {
  if (order.game !== "Racing Master") return Promise.resolve({ ok: false, reason: "not_racing_master" });
  const resolved = resolveRacingCategory(order.item);
  if (!resolved) {
    console.error(`[fazercards] Order #${order.id}: Racing Master item "${order.item}" has no SEA/LATAM region prefix — can't tell which category to use`);
    return Promise.resolve({ ok: false, reason: "unmapped_item" });
  }
  return relayViaFazercards(order, { game: "Racing Master", categoryId: resolved.categoryId, itemOverride: resolved.bareItem });
};

module.exports = {
  CATEGORY_IDS,
  FAZERCARDS_ML_ITEMS,
  relayMlOrderFazercards,
  relayMcOrderFazercards,
  relayPubgOrderFazercards,
  relayRacingOrderFazercards,
  validateGamePlayerId,
  // exported for testing / debugging
  findOfferForItem,
  offerDiamondTotal,
  resolveRacingCategory,
};
