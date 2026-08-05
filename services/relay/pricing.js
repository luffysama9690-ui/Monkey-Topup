// Coin cost per item code, from `.l` output on @easytopup4ubot.
// Keys are exactly what you'd pass as the last argument to `.p` (PH)
// or `.m` (BR) — e.g. ".p 12345678 1234 112" or ".m 12345678 1234 wp5".
//
// Re-run `.l` and update these if the supplier changes prices.

const PH_PRICES = {
  11: 10,
  22: 19,
  33: 28.5,
  44: 38,
  56: 47.5,
  112: 95,
  223: 190,
  336: 285,
  570: 475,
  1163: 950,
  2398: 1900,
  6042: 4750,
  growthplan: 475, // "Mobile Legends PH - growthplan"
  wp: 95, // Weekly Diamond Pass
};

const BR_PRICES = {
  55: 39,
  86: 61.5,
  110: 78,
  165: 116.9,
  172: 122,
  257: 177.5,
  275: 187.5,
  343: 239,
  429: 299.5,
  514: 355,
  565: 385,
  600: 416.5,
  605: 414,
  706: 480,
  878: 602,
  963: 657.5,
  1049: 719,
  1135: 779.5,
  1220: 835,
  1412: 960,
  1755: 1199,
  2195: 1453,
  2281: 1514.5,
  2452: 1630.5,
  2538: 1692,
  2901: 1933,
  3073: 2055,
  3158: 2110.5,
  3688: 2424,
  3945: 2601.5,
  4031: 2663,
  4394: 2904,
  4566: 3026,
  5100: 3384,
  5532: 3660,
  5704: 3782,
  6238: 4140,
  6752: 4495,
  7030: 4681.5,
  7376: 4848,
  7727: 5113,
  8433: 5593,
  9288: 6079,
  10700: 7039,
  11483: 7532,
  12189: 8012,
  12976: 8503,
  13682: 8983,
  15526: 10219,
  16232: 10699,
  17015: 11192,
  18508: 12163,
  20703: 13616,
  limited_time_pack: 12, // BR Limited-Time Value Pack
  monthly_epic_bundle: 196.5, // BR Monthly Epic Bundle
  super_value_pass: 39, // BR Super Value Pass
  twilight_pass: 402.5, // Twilight Pass
  weekly_elite_bundle: 39, // BR Weekly Elite Bundle
  wp: 76, // Weekly Pass x1
  wp2: 152, // Weekly Pass x2
  wp3: 228,
  wp4: 304,
  wp5: 380,
  wp6: 456,
  wp7: 532,
  wp8: 608,
  wp9: 684,
  wp10: 760,
};

function getCoinCost(region, itemCode) {
  const table = region === "PH" ? PH_PRICES : BR_PRICES;
  const cost = table[itemCode];
  if (cost === undefined) {
    throw new Error(`Unknown item code "${itemCode}" for region ${region}`);
  }
  return cost;
}

/**
 * Given a plain diamond amount (e.g. from a "Diamond 112" style package),
 * figures out which region's `.l` list it belongs to and returns both.
 * Monkey Topup's own diamond list mixes PH-only and BR-only amounts —
 * this just checks both tables since the amounts don't overlap.
 */
function resolveDiamondPackage(diamondAmount) {
  const code = String(diamondAmount);
  if (PH_PRICES[code] !== undefined) {
    return { region: "PH", itemCode: code, coinCost: PH_PRICES[code] };
  }
  if (BR_PRICES[code] !== undefined) {
    return { region: "BR", itemCode: code, coinCost: BR_PRICES[code] };
  }
  throw new Error(`Diamond amount ${diamondAmount} not found in either price list`);
}

module.exports = { PH_PRICES, BR_PRICES, getCoinCost, resolveDiamondPackage };
