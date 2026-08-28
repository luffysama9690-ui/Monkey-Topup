const { getOffers, createTopupOrder, validatePlayerId } = require("./fazercards");

/**
 * Category IDs confirmed against FazerCards' dashboard (2569-08). Re-verify
 * if orders start failing with "unmapped_item" — FazerCards may reshuffle.
 *
 * MISSING: Magic Chess Go Go (RU) and CapCut have no category_id yet.
 * Their frontend package data exists (Money_topup_front) but orders for
 * them will safely fail with "unmapped_item" until Myatko provides one.
 */
const CATEGORY_IDS = {
  ML_GLOBAL: "a67331f3-7a3a-4345-b948-a07aa81cba62",
  ML_PH: "d76d3d1d-aedf-4c52-8d03-c892dc24ed00",
  MCGG_GLOBAL: "5ee6297b-42d1-41da-8b12-9e2821691f6a",
  PUBG_AUTO: "8e34ea33-5d6f-4f04-81c0-6cd9d489b71d",
  RACING_SEA: "22c28b10-064b-4731-9c33-555c653029ee",
  RACING_LATAM: "d6595b1f-688f-4da3-ab1b-b1e1baa0e7c5",
};

/**
 * Every region-split game's item labels are prefixed with their region
 * ("Global 86 Diamonds", "PH 86 Diamonds", "SEA Novice Pack") because some
 * amounts/names exist in more than one region at different prices -- the
 * prefix is how we know which FazerCards category to buy from. PUBG has
 * only one region so it isn't prefixed.
 */
const REGION_PREFIXES = {
  "Mobile Legends": { Global: CATEGORY_IDS.ML_GLOBAL, PH: CATEGORY_IDS.ML_PH },
  "Magic Chess GoGo": { Global: CATEGORY_IDS.MCGG_GLOBAL }, // RU deliberately omitted -- no category_id yet
  "Racing Master": { SEA: CATEGORY_IDS.RACING_SEA, LATAM: CATEGORY_IDS.RACING_LATAM },
};

/**
 * Splits a region-prefixed item name ("Global 86 Diamonds") into the
 * FazerCards category to use and the bare name FazerCards actually shows.
 * Returns null if the game isn't region-split or the prefix isn't one we
 * have a category for (e.g. "RU ..." for Magic Chess GoGo -- safely
 * unmapped rather than guessed).
 */
function resolveRegionCategory(game, itemName) {
  const prefixes = REGION_PREFIXES[game];
  if (!prefixes || !itemName) return null;
  for (const [region, categoryId] of Object.entries(prefixes)) {
    if (itemName.startsWith(region + " ")) {
      return { region, categoryId, bareItem: itemName.slice(region.length + 1) };
    }
  }
  return null;
}

// Overrides where FazerCards' real offer name/price doesn't match Monkey
// Topup's bare (region-prefix-stripped) label closely enough for the
// generic matchers in findOfferForItem. Keyed by "Game:Region".
const NAME_OVERRIDES = {
  "Mobile Legends:Global": {
    // Myatko's confirmed display labels for these say "X + X" (e.g.
    // "50 + 50 Diamonds") but FazerCards' real offer only delivers the
    // smaller bonus amount (e.g. 50+5=55, not 100) -- confirmed intentional
    // 2569-08-26. Map by USD cost instead of name/diamond-sum so the
    // correct underlying offer still gets bought.
    "50 + 50 Diamonds (First Top-Up Bonus)": { priceUsd: 0.74 },
    "150 + 150 Diamonds (First Top-Up Bonus)": { priceUsd: 2.23 },
    "250 + 250 Diamonds (First Top-Up Bonus)": { priceUsd: 3.57 },
    "500 + 500 Diamonds (First Top-Up Bonus)": { priceUsd: 7.33 },
  },
  "Mobile Legends:PH": {
    // Same "X + X" labeling caveat as Global, different USD costs for PH.
    "50 + 50 Diamonds (First Top-Up Bonus)": { priceUsd: 0.84 },
    "150 + 150 Diamonds (First Top-Up Bonus)": { priceUsd: 2.49 },
    "250 + 250 Diamonds (First Top-Up Bonus)": { priceUsd: 4.14 },
    "500 + 500 Diamonds (First Top-Up Bonus)": { priceUsd: 8.37 },
  },
  "Magic Chess GoGo:Global": {
    "Lukas's Battle Bounty": "Lucas's Battle Bounty", // FazerCards spells it "Lucas's"
    // The "First Recharge N (X + X Bonus)" bundles here ARE literally
    // accurate (FazerCards really delivers 50+50, 150+150, etc.) -- tolerant
    // normalized matching in findOfferForItem handles the "50 + 50" vs
    // FazerCards' "50+50" spacing difference, no override needed.
  },
};

/** Removes all whitespace and lowercases, for tolerant name comparison. */
function normalize(s) {
  return s.replace(/\s+/g, "").toLowerCase();
}

/** Sums the numbers in an offer name like "78 + 8 Diamonds" -> 86, or "429 Diamonds" -> 429. */
function offerDiamondTotal(offerName) {
  if (!/diamond/i.test(offerName)) return null;
  const nums = offerName.match(/\d+/g);
  if (!nums) return null;
  return nums.reduce((sum, n) => sum + parseInt(n, 10), 0);
}

/** Extracts the diamond amount from a "86 Diamonds" / "5 Diamonds" style label (number first). */
function itemDiamondAmount(itemName) {
  const match = itemName.match(/^(\d+)\s+Diamonds?\b/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Finds the FazerCards offer matching a bare (region-prefix-stripped) item
 * name. Throws if no confident match is found -- callers should NOT guess.
 * `overrideKey` is "Game:Region" (see NAME_OVERRIDES) -- pass null/undefined
 * for games without region-specific overrides.
 */
function findOfferForItem(offers, itemName, overrideKey) {
  const override = overrideKey && NAME_OVERRIDES[overrideKey] && NAME_OVERRIDES[overrideKey][itemName];
  if (override) {
    if (typeof override === "string") {
      const byName = offers.find((o) => normalize(o.name) === normalize(override));
      if (byName) return byName;
      throw new Error(`Name override "${override}" for "${itemName}" not found in current offer list`);
    }
    if (override.priceUsd != null) {
      const byPrice = offers.find((o) => Math.abs(parseFloat(o.price_usd) - override.priceUsd) < 0.005);
      if (byPrice) return byPrice;
      throw new Error(`Price override $${override.priceUsd} for "${itemName}" not found in current offer list`);
    }
  }

  // Tolerant exact-name match (handles spacing differences like "50 + 50" vs "50+50").
  const exact = offers.find((o) => normalize(o.name) === normalize(itemName));
  if (exact) return exact;

  // Fall back to diamond-total matching (for plain "N Diamonds" packages).
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
      fields[f.key] = String(order.server_id != null ? order.server_id : "");
    } else {
      fields[f.key] = String(order.game_id != null ? order.game_id : "");
    }
  }
  return fields;
}

/**
 * Validates a Player ID + Server ID against FazerCards before an order is
 * accepted, for whichever games/regions FazerCards covers.
 *
 * `item` is required for region-split games (ML, MCGG, Racing Master) so
 * the right category gets checked; PUBG ignores it.
 *
 * Returns:
 *   { checked: false }                                 -- game/region isn't one FazerCards covers, or gameId missing; caller should just proceed
 *   { checked: true, valid: true, playerName, region }  -- confirmed real account
 *   { checked: true, valid: false }                     -- FazerCards says this ID/Server doesn't exist
 *   { checked: true, valid: null, error }               -- couldn't check (network/API issue) -- caller should fail OPEN, just log it
 */
async function validateGamePlayerId(game, gameId, serverId, item) {
  let categoryId;
  if (game === "PUBG Mobile") {
    categoryId = CATEGORY_IDS.PUBG_AUTO;
  } else {
    const resolved = resolveRegionCategory(game, item);
    categoryId = resolved ? resolved.categoryId : undefined;
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

async function relayViaFazercards(order, opts) {
  const categoryId = opts.categoryId;
  const itemName = opts.itemName;
  const overrideKey = opts.overrideKey;

  if (!order.game_id) {
    console.error(`[fazercards] Order #${order.id} missing game_id -- skipping relay`);
    return { ok: false, reason: "missing_ids" };
  }

  try {
    const offersRes = await getOffers(categoryId);
    const offer = findOfferForItem(offersRes.offers, itemName, overrideKey);
    const fields = buildFields(offersRes.fields || [], order);

    const result = await createTopupOrder({
      categoryId,
      offerId: offer.offer_id,
      fields,
      idempotencyKey: `monkeytopup-order-${order.id}`,
    });

    console.log(`[fazercards] Order #${order.id} -> FazerCards order ${result.order && result.order.id} (${offer.name}, $${offer.price_usd})`);
    return { ok: true, fazercardsOrder: result.order, offer };
  } catch (err) {
    console.error(`[fazercards] Order #${order.id} failed: ${err.message}`);
    return { ok: false, reason: "relay_failed", error: err.message };
  }
}

/** Shared dispatcher for the three region-split games (ML, MCGG, Racing Master). */
function relayRegionSplitGame(order, game) {
  if (order.game !== game) return Promise.resolve({ ok: false, reason: "not_" + game.toLowerCase().replace(/\s+/g, "_") });
  const resolved = resolveRegionCategory(game, order.item);
  if (!resolved) {
    console.error(`[fazercards] Order #${order.id}: ${game} item "${order.item}" has no region prefix FazerCards covers -- can't relay (maybe RU, which has no category_id yet)`);
    return Promise.resolve({ ok: false, reason: "unmapped_item" });
  }
  return relayViaFazercards(order, {
    categoryId: resolved.categoryId,
    itemName: resolved.bareItem,
    overrideKey: `${game}:${resolved.region}`,
  });
}

const relayMlOrderFazercards = (order) => relayRegionSplitGame(order, "Mobile Legends");
const relayMcOrderFazercards = (order) => relayRegionSplitGame(order, "Magic Chess GoGo");
const relayRacingOrderFazercards = (order) => relayRegionSplitGame(order, "Racing Master");

const relayPubgOrderFazercards = (order) => {
  if (order.game !== "PUBG Mobile") return Promise.resolve({ ok: false, reason: "not_pubg_mobile" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.PUBG_AUTO, itemName: order.item });
};

module.exports = {
  CATEGORY_IDS,
  relayMlOrderFazercards,
  relayMcOrderFazercards,
  relayPubgOrderFazercards,
  relayRacingOrderFazercards,
  validateGamePlayerId,
  findOfferForItem,
  offerDiamondTotal,
  resolveRegionCategory,
};
