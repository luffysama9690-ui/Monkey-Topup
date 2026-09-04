const {
  getOffers,
  createTopupOrder,
  validatePlayerId,
  buyTelegramStars,
  buyTelegramPremium,
  checkSteamLogin,
  buySteamTopup,
} = require("./fazercards");

/**
 * Category IDs confirmed against FazerCards' real API catalog
 * (GET /api/v2/topups) on 2569-08-29.
 *
 * IMPORTANT: earlier versions of this file used UUIDs copied from the
 * reseller dashboard's browser URL (e.g. "a67331f3-7a3a-..."). FazerCards
 * support confirmed those are INTERNAL PANEL IDs that don't work with the
 * public API at all -- every relay call was failing with "Unknown or
 * unavailable category_id" until this fix. The real API uses short slugs
 * like "mobile_legends_global" instead. If orders start failing with that
 * error again, re-fetch GET /api/v2/topups?limit=500 and diff against this
 * list -- don't copy IDs from the dashboard URL.
 */
const CATEGORY_IDS = {
  ML_GLOBAL: "mobile_legends_global",
  ML_PH: "mobile_legends_philippines",
  ML_RU: "mobile_legends_ru",
  ML_BR: "mobile_legends_brazil",
  MCGG_GLOBAL: "magic_chess_gogo_global",
  MCGG_RU: "magic_chess_gogo_ru",
  PUBG_AUTO: "pubg_mobile_auto",
  PUBG_NEW_STATE: "pubg_new_state",
  RACING_SEA: "racing_master_sea",
  RACING_LATAM: "racing_master_latam",
  CAPCUT: "capcut",
  SAUSAGE_MAN: "sausage_man",
  WWM: "where_winds_meet",
  BLOOD_STRIKE: "blood_strike",
  FREE_FIRE_TH: "free_fire_th",
  HONOR_OF_KINGS: "honor_of_kings",
  SKY_COTL: "sky_children_of_light",
  VALORANT_TH: "valorant_th",
  LOL_TH: "lol_th",
  CODM_SGMY: "codm_garena_sgmy",
  GENSHIN_GLOBAL: "genshin_impact_global",
  HONKAI_STAR_RAIL_GLOBAL: "honkai_star_rail_global",
  HONKAI_IMPACT_3RD_ASIA: "honkai_impact_3rd_asia",
};

/**
 * Every region-split game's item labels are prefixed with their region
 * ("Global 86 Diamonds", "PH 86 Diamonds", "SEA Novice Pack") because some
 * amounts/names exist in more than one region at different prices -- the
 * prefix is how we know which FazerCards category to buy from. PUBG has
 * only one region so it isn't prefixed.
 */
const REGION_PREFIXES = {
  "Mobile Legends": { Global: CATEGORY_IDS.ML_GLOBAL, PH: CATEGORY_IDS.ML_PH, RU: CATEGORY_IDS.ML_RU, BR: CATEGORY_IDS.ML_BR },
  "Magic Chess GoGo": { Global: CATEGORY_IDS.MCGG_GLOBAL, RU: CATEGORY_IDS.MCGG_RU },
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
  // Steam doesn't go through the /topups family, so it needs its own path:
  // FazerCards' check-login call tells us up front whether this Steam
  // account can actually be refilled, before we touch the customer's
  // wallet balance.
  if (game === "Steam") {
    if (!gameId) return { checked: false };
    try {
      const result = await checkSteamLogin(gameId);
      return { checked: true, valid: !!result.can_refill };
    } catch (err) {
      console.error(`[fazercards] Steam login check failed: ${err.message}`);
      return { checked: false, valid: null };
    }
  }

  let categoryId;
  if (game === "PUBG Mobile") {
    categoryId = CATEGORY_IDS.PUBG_AUTO;
  } else if (game === "PUBG New State") {
    categoryId = CATEGORY_IDS.PUBG_NEW_STATE;
  } else if (game === "CapCut") {
    categoryId = CATEGORY_IDS.CAPCUT;
  } else if (game === "Sausage Man") {
    categoryId = CATEGORY_IDS.SAUSAGE_MAN;
  } else if (game === "Where Winds Meet") {
    categoryId = CATEGORY_IDS.WWM;
  } else if (game === "Blood Strike") {
    categoryId = CATEGORY_IDS.BLOOD_STRIKE;
  } else if (game === "Honor of Kings") {
    categoryId = CATEGORY_IDS.HONOR_OF_KINGS;
  } else if (game === "Sky: Children of the Light") {
    categoryId = CATEGORY_IDS.SKY_COTL;
  } else if (game === "Valorant (TH)") {
    categoryId = CATEGORY_IDS.VALORANT_TH;
  } else if (game === "League of Legends (TH)") {
    categoryId = CATEGORY_IDS.LOL_TH;
  } else if (game === "Call of Duty Mobile (SG/MY)") {
    categoryId = CATEGORY_IDS.CODM_SGMY;
  } else if (game === "Genshin Impact (Global)") {
    categoryId = CATEGORY_IDS.GENSHIN_GLOBAL;
  } else if (game === "Honkai: Star Rail (Global)") {
    categoryId = CATEGORY_IDS.HONKAI_STAR_RAIL_GLOBAL;
  } else if (game === "Honkai Impact 3rd (Asia)") {
    categoryId = CATEGORY_IDS.HONKAI_IMPACT_3RD_ASIA;
  } else if (game === "Free Fire") {
    // Only Thailand is on FazerCards right now -- Global has no matching
    // category, so it falls through to `undefined` and stays unchecked
    // (fails open, same as any other unconnected game).
    categoryId = /^Thailand /.test(item || "") ? CATEGORY_IDS.FREE_FIRE_TH : undefined;
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

const relayNewStateOrderFazercards = (order) => {
  if (order.game !== "PUBG New State") return Promise.resolve({ ok: false, reason: "not_pubg_new_state" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.PUBG_NEW_STATE, itemName: order.item });
};

// Ready for when CapCut is added as a product in the frontend (icon/game card/packages
// not built yet as of 2569-08-30) -- category_id is already confirmed, so no backend
// work will be needed once the frontend order.game starts sending "CapCut".
const relayCapcutOrderFazercards = (order) => {
  if (order.game !== "CapCut") return Promise.resolve({ ok: false, reason: "not_capcut" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.CAPCUT, itemName: order.item });
};

// Sausage Man item labels ("61 Candies", "186 Candies", ...) match
// FazerCards' real offer names exactly -- no region prefix, no
// NAME_OVERRIDES needed. FazerCards only asks for a single "Character ID"
// field (see buildFields: any field not labeled server/zone gets game_id),
// so order.server_id is simply ignored here.
const relaySausageOrderFazercards = (order) => {
  if (order.game !== "Sausage Man") return Promise.resolve({ ok: false, reason: "not_sausage_man" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.SAUSAGE_MAN, itemName: order.item });
};

// Where Winds Meet: "Echo N" (frontend label) doesn't match FazerCards'
// real offer name ("N Echo Beads"), so it needs its own item-name mapping
// before handing off to findOfferForItem. Passes ("Monthly Pass", "Elite
// Battle Pass", "Premium Battle Pass") match exactly already. Single
// "Character ID" field, same as Sausage Man -- order.server_id is ignored.
function normalizeWwmItemName(item) {
  const echoMatch = /^Echo (\d+)$/.exec(item || "");
  return echoMatch ? `${echoMatch[1]} Echo Beads` : item;
}

const relayWwmOrderFazercards = (order) => {
  if (order.game !== "Where Winds Meet") return Promise.resolve({ ok: false, reason: "not_wwm" });
  return relayViaFazercards(order, {
    categoryId: CATEGORY_IDS.WWM,
    itemName: normalizeWwmItemName(order.item),
  });
};// Blood Strike item labels ("51 BC", "Season Pass", "0.99 DEAL", ...)
// match FazerCards' real offer names exactly -- no normalization needed.
// Single "Player ID" field, region: Global.
const relayBloodstrikeOrderFazercards = (order) => {
  if (order.game !== "Blood Strike") return Promise.resolve({ ok: false, reason: "not_blood_strike" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.BLOOD_STRIKE, itemName: order.item });
};

// Honor of Kings item labels ("16 Tokens", "Weekly Card", "Double Token
// Lucky Bag", ...) match FazerCards' real offer names exactly -- no
// normalization needed. Single "Player ID" field.
const relayHokOrderFazercards = (order) => {
  if (order.game !== "Honor of Kings") return Promise.resolve({ ok: false, reason: "not_hok" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.HONOR_OF_KINGS, itemName: order.item });
};

// Sky: Children of the Light item labels ("15 Regular Candles", "Season
// Pass Pack", ...) match FazerCards' real offer names exactly -- no
// normalization needed (confirmed via GET /topups/offers?category_id=
// sky_children_of_light, 2569-09-04). Single "Sky ID" field (key: sky_id),
// no server ID -- order.server_id is ignored, same as Sausage Man/WWM/
// Blood Strike/HoK.
const relaySkyCotlOrderFazercards = (order) => {
  if (order.game !== "Sky: Children of the Light") return Promise.resolve({ ok: false, reason: "not_sky_cotl" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.SKY_COTL, itemName: order.item });
};

// Valorant (TH), League of Legends (TH), Call of Duty Mobile - Garena
// (SG/MY) -- confirmed via GET /topups/offers, 2569-09-05. Riot Games
// titles use a single "Riot ID" field; CODM Garena uses "Player ID". Offer
// names ("475 VP", "575 RP", "114 CP") match FazerCards' real offer names
// exactly -- no normalization needed.
const relayValorantThOrderFazercards = (order) => {
  if (order.game !== "Valorant (TH)") return Promise.resolve({ ok: false, reason: "not_valorant_th" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.VALORANT_TH, itemName: order.item });
};

const relayLolThOrderFazercards = (order) => {
  if (order.game !== "League of Legends (TH)") return Promise.resolve({ ok: false, reason: "not_lol_th" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.LOL_TH, itemName: order.item });
};

const relayCodmSgmyOrderFazercards = (order) => {
  if (order.game !== "Call of Duty Mobile (SG/MY)") return Promise.resolve({ ok: false, reason: "not_codm_sgmy" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.CODM_SGMY, itemName: order.item });
};

// Genshin Impact / Honkai: Star Rail need a "server" field FazerCards'
// side -- the frontend hardcodes order.server_id to "asia" for these two
// (no server picker shown to the customer), and buildFields() already maps
// any field whose label contains "server" to order.server_id generically,
// so no special-casing is needed here beyond the category id itself.
// Honkai Impact 3rd (Asia) only needs a Player ID, same as Sky/HoK.
const relayGenshinGlobalOrderFazercards = (order) => {
  if (order.game !== "Genshin Impact (Global)") return Promise.resolve({ ok: false, reason: "not_genshin_global" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.GENSHIN_GLOBAL, itemName: order.item });
};

const relayHonkaiStarRailGlobalOrderFazercards = (order) => {
  if (order.game !== "Honkai: Star Rail (Global)") return Promise.resolve({ ok: false, reason: "not_honkai_star_rail_global" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.HONKAI_STAR_RAIL_GLOBAL, itemName: order.item });
};

const relayHonkaiImpact3rdAsiaOrderFazercards = (order) => {
  if (order.game !== "Honkai Impact 3rd (Asia)") return Promise.resolve({ ok: false, reason: "not_honkai_impact_3rd_asia" });
  return relayViaFazercards(order, { categoryId: CATEGORY_IDS.HONKAI_IMPACT_3RD_ASIA, itemName: order.item });
};

// Telegram Stars/Premium don't go through the /topups family at all --
// FazerCards exposes dedicated POST /telegram/stars/buy and
// /telegram/premium/buy endpoints instead (see reseller.fazercards.com
// /en/docs). Item labels are "⭐ N Stars" / "🎁 Premium N Months" (see
// TELEGRAM_STARS/TELEGRAM_PREMIUM in App.jsx); order.game_id holds the
// Telegram username the frontend collected, with or without a leading "@".
function parseTelegramItem(item) {
  const starMatch = /(\d+)\s*Stars/i.exec(item || "");
  if (starMatch) return { kind: "stars", quantity: parseInt(starMatch[1], 10) };
  const premMatch = /Premium\s*(\d+)\s*Months?/i.exec(item || "");
  if (premMatch) return { kind: "premium", months: parseInt(premMatch[1], 10) };
  return null;
}

const relayTelegramOrderFazercards = async (order) => {
  if (order.game !== "Telegram") return { ok: false, reason: "not_telegram" };
  if (!order.game_id) {
    console.error(`[fazercards] Order #${order.id} missing Telegram username -- skipping relay`);
    return { ok: false, reason: "missing_ids" };
  }
  const parsed = parseTelegramItem(order.item);
  if (!parsed) {
    console.error(`[fazercards] Order #${order.id}: couldn't parse Telegram item "${order.item}"`);
    return { ok: false, reason: "unparseable_item" };
  }
  const username = order.game_id.startsWith("@") ? order.game_id : `@${order.game_id}`;
  try {
    const result =
      parsed.kind === "stars"
        ? await buyTelegramStars(username, parsed.quantity)
        : await buyTelegramPremium(username, parsed.months);
    console.log(`[fazercards] Order #${order.id} -> Telegram ${parsed.kind} order ${result.order && result.order.id}`);
    return { ok: true, fazercardsOrder: result.order };
  } catch (err) {
    console.error(`[fazercards] Telegram order #${order.id} failed: ${err.message}`);
    return { ok: false, reason: "relay_failed", error: err.message };
  }
};

// Steam wallet top-up. FazerCards needs the Steam account *login*
// (username) rather than a numeric id -- order.game_id holds that (see the
// purchase modal's Steam-specific field in App.jsx). Item labels are
// "Steam Global {usd} USD" (see STEAM_PACKAGES in App.jsx); FazerCards is
// always paid in USD regardless of which currency the customer paid us in.
function parseSteamUsdAmount(item) {
  const m = /(\d+(?:\.\d+)?)\s*USD/i.exec(item || "");
  return m ? Number(m[1]) : null;
}

const relaySteamOrderFazercards = async (order) => {
  if (order.game !== "Steam") return { ok: false, reason: "not_steam" };
  if (!order.game_id) {
    console.error(`[fazercards] Order #${order.id} missing Steam login -- skipping relay`);
    return { ok: false, reason: "missing_ids" };
  }
  const usdAmount = parseSteamUsdAmount(order.item);
  if (usdAmount == null) {
    console.error(`[fazercards] Order #${order.id}: couldn't parse Steam USD amount from "${order.item}"`);
    return { ok: false, reason: "unparseable_item" };
  }
  try {
    const result = await buySteamTopup(order.game_id, "USD", usdAmount, `monkeytopup-order-${order.id}`);
    console.log(`[fazercards] Order #${order.id} -> Steam top-up order ${result.order && result.order.id} ($${usdAmount})`);
    return { ok: true, fazercardsOrder: result.order };
  } catch (err) {
    console.error(`[fazercards] Steam order #${order.id} failed: ${err.message}`);
    return { ok: false, reason: "relay_failed", error: err.message };
  }
};

// Free Fire: only the Thailand region exists on FazerCards right now (no
// "Global" category there), so Global orders are intentionally left
// unrelayed -- they stay on manual fulfillment like before. Thailand item
// labels are prefixed ("Thailand 33 Diamonds", "Thailand Weekly Pack") to
// tell the two regions apart in the shop UI; strip that prefix to match
// FazerCards' real offer names ("33 Diamonds", "Weekly Pack").
function normalizeFreeFireItemName(item) {
  return (item || "").replace(/^Thailand /, "");
}

const relayFreeFireOrderFazercards = (order) => {
  if (order.game !== "Free Fire") return Promise.resolve({ ok: false, reason: "not_free_fire" });
  if (!/^Thailand /.test(order.item || "")) {
    return Promise.resolve({ ok: false, reason: "not_free_fire_thailand" });
  }
  return relayViaFazercards(order, {
    categoryId: CATEGORY_IDS.FREE_FIRE_TH,
    itemName: normalizeFreeFireItemName(order.item),
  });
};

// True if this (game, item) combination is one routes/orders.js will
// attempt to auto-relay to FazerCards. Used at order-creation time (before
// the relay actually runs) to decide whether the customer's fulfillment
// receipt will be sent automatically -- if so, the admin "New Order"
// notification skips the manual "✅ Done ပို့ရန်" button, since clicking it
// too would send the receipt twice.
function isAutoFulfilled(game, item) {
  const autoGames = [
    "Mobile Legends",
    "Magic Chess GoGo",
    "PUBG Mobile",
    "PUBG New State",
    "Racing Master",
    "CapCut",
    "Sausage Man",
    "Where Winds Meet",
    "Blood Strike",
    "Telegram",
    "Steam",
    "Honor of Kings",
    "Sky: Children of the Light",
    "Valorant (TH)",
    "League of Legends (TH)",
    "Call of Duty Mobile (SG/MY)",
    "Genshin Impact (Global)",
    "Honkai: Star Rail (Global)",
    "Honkai Impact 3rd (Asia)",
  ];
  if (autoGames.includes(game)) return true;
  if (game === "Free Fire" && /^Thailand /.test(item || "")) return true;
  return false;
}

module.exports = {
  CATEGORY_IDS,
  relayMlOrderFazercards,
  relayMcOrderFazercards,
  relayPubgOrderFazercards,
  relayNewStateOrderFazercards,
  relayCapcutOrderFazercards,
  relaySausageOrderFazercards,
  relayWwmOrderFazercards,
  relayBloodstrikeOrderFazercards,
  relayFreeFireOrderFazercards,
  relayHokOrderFazercards,
  relaySkyCotlOrderFazercards,
  relayValorantThOrderFazercards,
  relayLolThOrderFazercards,
  relayCodmSgmyOrderFazercards,
  relayGenshinGlobalOrderFazercards,
  relayHonkaiStarRailGlobalOrderFazercards,
  relayHonkaiImpact3rdAsiaOrderFazercards,
  relayTelegramOrderFazercards,
  relaySteamOrderFazercards,
  relayRacingOrderFazercards,
  validateGamePlayerId,
  findOfferForItem,
  offerDiamondTotal,
  resolveRegionCategory,
  isAutoFulfilled,
};
