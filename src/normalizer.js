// normalizer.js — Stage 1 of the schema rebuild (DATA LAYER ONLY).
//
// Turns ANY messy ingredient input into ONE clean structured Ingredient object,
// per SCHEMA.md. This is pure logic with no UI and no live-data mutation: it is
// built and tested in isolation first, wired into the app only once proven.
//
// The single entry point is normalizeIngredient(input, opts) where input is
// either a raw string ("2 tablespoon all purpose flour") or a legacy object
// ({ qty, unit, name, tier }). It always returns a full Ingredient or null
// (null = the line was a section header / empty / never-buy).

import { ITEM_DB, SUB_UNIT, AMBIGUOUS_UNITS } from "./itemDb.js";

// ---- unit system (mirrors App.jsx; kept here so the module is self-contained) ----
const UNIT_CONV = {
  g:   { family: "mass",   factor: 1 },
  kg:  { family: "mass",   factor: 1000 },
  oz:  { family: "mass",   factor: 28.3495 },
  lb:  { family: "mass",   factor: 453.592 },
  lbs: { family: "mass",   factor: 453.592 },
  ml:  { family: "volume", factor: 1 },
  l:   { family: "volume", factor: 1000 },
  tsp: { family: "volume", factor: 4.92892 },
  tbsp:{ family: "volume", factor: 14.7868 },
  cup: { family: "volume", factor: 236.588 },
  dozen: { family: "count", factor: 12 },
  doz:   { family: "count", factor: 12 },
  dz:    { family: "count", factor: 12 },
  pair:  { family: "count", factor: 2 },
  pairs: { family: "count", factor: 2 },
};
const PLAIN_COUNT_LABELS = new Set(["", "pc", "pcs", "piece", "pieces", "whole", "each", "ct", "count", "unit", "units", "head", "heads", "clove", "cloves", "stalk", "stalks", "slice", "slices", "can", "cans", "bag", "bags", "bottle", "bottles", "bunch", "bunches", "block", "blocks", "fillet", "fillets"]);

export function unitInfo(unit) {
  const u = (unit || "").toLowerCase().trim();
  if (UNIT_CONV[u]) return UNIT_CONV[u];
  if (PLAIN_COUNT_LABELS.has(u)) return { family: "count", factor: 1 };
  return { family: "count:" + u, factor: 1 };
}

// ---- quantity tokens (fractions, mixed numbers, ranges) ----
const FRACTION_MAP = { "½": 0.5, "⅓": 1/3, "⅔": 2/3, "¼": 0.25, "¾": 0.75, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1/6, "⅚": 5/6 };
function evalQtyToken(tok) {
  const parts = String(tok).trim().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const p of parts) {
    if (p.includes("/")) { const [a, b] = p.split("/").map(Number); if (!b) return null; total += a / b; }
    else { const n = parseFloat(p); if (isNaN(n)) return null; total += n; }
  }
  return total || null;
}
function parseLeadingQty(s) {
  let str = String(s).trim();
  let expanded = "";
  for (const ch of str) expanded += (FRACTION_MAP[ch] != null ? " " + FRACTION_MAP[ch] : ch);
  expanded = expanded.trim();
  const range = expanded.match(/^([\d.\/\s]+)\s*(?:to|-|–|—|or)\s*([\d.\/\s]+)\s+(.*)$/i);
  if (range) { const hi = evalQtyToken(range[2]); if (hi != null) return { qty: hi, rest: range[3] }; }
  const m = expanded.match(/^((?:\d+\s+)?\d*\.?\d+(?:\/\d+)?(?:\s+\d+\/\d+)?)\s+(.*)$/);
  if (m) { const q = evalQtyToken(m[1]); if (q != null) return { qty: q, rest: m[2] }; }
  return null;
}

// ---- unit words (long & short forms) -> canonical short unit ----
const UNIT_WORD_MAP = {
  teaspoon: "tsp", teaspoons: "tsp", tsp: "tsp", tsps: "tsp", tspn: "tsp",
  tablespoon: "tbsp", tablespoons: "tbsp", tbsp: "tbsp", tbsps: "tbsp", tbs: "tbsp", tbl: "tbsp", tb: "tbsp",
  cup: "cup", cups: "cup",
  gram: "g", grams: "g", g: "g", gr: "g",
  kilogram: "kg", kilograms: "kg", kg: "kg", kgs: "kg",
  ounce: "oz", ounces: "oz", oz: "oz",
  pound: "lb", pounds: "lb", lb: "lb", lbs: "lb",
  milliliter: "ml", milliliters: "ml", millilitre: "ml", ml: "ml",
  liter: "l", liters: "l", litre: "l", litres: "l", l: "l",
  can: "can", cans: "can", bottle: "bottle", bottles: "bottle",
  bag: "bag", bags: "bag", head: "head", heads: "head",
  clove: "clove", cloves: "clove", stalk: "stalk", stalks: "stalk",
  slice: "slice", slices: "slice", piece: "pc", pieces: "pc", pc: "pc", pcs: "pc",
  bunch: "bunch", bunches: "bunch", block: "block", blocks: "block",
  fillet: "fillet", fillets: "fillet", dozen: "dozen", pinch: "pinch", dash: "dash",
};
const UNIT_WORD_ALTERNATION = Object.keys(UNIT_WORD_MAP).sort((a, b) => b.length - a.length).join("|");

// ---- text helpers ----
const NORM_KEEP = new Set(["hummus", "couscous", "asparagus", "molasses", "watercress"]);
export function normalize(s) {
  if (typeof s !== "string") s = s == null ? "" : String(s);
  let w = s.toLowerCase().trim().replace(/-/g, " ").replace(/\s+/g, " ");
  if (!w) return w;
  if (NORM_KEEP.has(w)) return w;
  if (/[^aeiou]ies$/.test(w)) return w.replace(/ies$/, "y");
  if (/ves$/.test(w)) return w.replace(/s$/, "");
  if (/oes$/.test(w)) return w.replace(/es$/, "");
  if (/ss$/.test(w)) return w;
  if (/(us|is)$/.test(w)) return w;
  if (/s$/.test(w)) return w.replace(/s$/, "");
  return w;
}

const PREP_DESCRIPTORS = ["julienned","julienne","minced","chopped","finely chopped","roughly chopped","diced","finely diced","sliced","thinly sliced","grated","shredded","crushed","ground","peeled","deseeded","seeded","cored","trimmed","halved","quartered","cubed","mashed","beaten","whisked","melted","softened","room temperature","chilled","cold","warm","hot","lukewarm","fresh","freshly","dried","frozen","thawed","cooked","uncooked","raw","divided","plus more","plus extra","for frying","for drizzling","for serving","for brushing","for greasing","for dusting","rinsed","drained","washed","patted dry","at room temperature","lightly packed","packed","level","heaped","heaping","sifted","toasted","roasted","store bought","store-bought","homemade","large","medium","small","extra large"];
const MERGE_NOISE = ["to taste","for taste","or to taste","or more to taste","a pinch of","a pinch","pinch of","pinch","a dash of","a dash","dash of","dash","a sprinkle of","a sprinkle","sprinkle of","sprinkle","for garnish","to garnish","as garnish","garnish","as needed","if needed","optional","or as needed","a little","some","a bit of","a handful of","handful of","a few","a few sprinkle","few"];

// Canonical-base rewrites (the curated "genuine same item" folds).
const CANONICAL_BASE = [
  [/^(low sodium|light|dark|reduced sodium|regular|all purpose|sweet|thick|premium|naturally brewed)?\s*soy sauce$/, "soy sauce"],
  [/^(firm|extra firm|soft|silken|medium firm|pressed)?\s*tofu$/, "tofu"],
  [/^(extra virgin|virgin|light|pure|refined)?\s*olive oil$/, "olive oil"],
  [/^(granulated|white|caster|superfine|fine)?\s*sugar$/, "sugar"],
  [/^(light|dark)?\s*brown sugar$/, "brown sugar"],
  [/^(fine|coarse|kosher|sea|table|flaky|iodized)?\s*salt$/, "salt"],
  [/^garlic clove(s)?$/, "garlic"],
  [/^clove(s)? garlic$/, "garlic"],
  [/^(minced|crushed|grated)?\s*garlic$/, "garlic"],
  [/^(yellow|white|red|brown|spanish|sweet)?\s*onion$/, "onion"],
  [/^(freshly ground|ground|cracked|whole)?\s*black pepper$/, "black pepper"],
  [/^(all purpose|plain|cake|bread|self raising|self-raising)?\s*flour$/, "flour"],
  [/^(cold|hot|warm|lukewarm|boiling|ice|iced|filtered|room temperature)?\s*water$/, "water"],
  [/^(unsalted|salted|softened|melted)?\s*butter$/, "butter"],
  [/^(sweet rice wine|rice wine|cooking wine|shaoxing wine|shaoxing)?\s*\(?mirin\)?$/, "mirin"],
  [/^(spring onion|scallion|green onion)s?$/, "green onion"],
  [/^(low fat|reduced fat|full fat|light|homemade|japanese|kewpie)?\s*mayonnaise$/, "mayonnaise"],
  [/^(low fat|reduced fat|full fat|light|homemade)?\s*mayo$/, "mayonnaise"],
  [/.*\bchicken breast\b.*/, "chicken breast"],
  [/.*\bchicken thigh\b.*/, "chicken thigh"],
  [/^.*boneless skinless chicken.*$/, "chicken breast"],
  [/.*\b(rib eye|ribeye|top sirloin|sirloin)\b.*/, "beef"],
  [/.*\bfish cake\b.*/, "fish cake"],
];

const SECTION_HEADERS = new Set(["for the sauce","for the meat","for the marinade","for the dough","for the filling","for the topping","for the garnish","for the batter","for the dressing","for the soup","for the base","for the broth","for the seasoning","for serving","for the dipping sauce","for the glaze","sauce","marinade","seasoning","garnish","topping","filling","dressing","dipping sauce","soy dipping sauce","for the coating","to serve","optional","for the rice","for the noodles","for the vegetables","for the chicken","for sauce","for meat","for marinade","second marination","first marination","marination","bulgogi marinade"]);
const NEVER_BUY = new Set(["water","ice","ice water","cold water","hot water","warm water","boiling water","tap water","filtered water"]);

export function isSectionHeader(raw) {
  const n = normalize(raw).replace(/[:]+$/, "").trim();
  if (!n) return false;
  if (SECTION_HEADERS.has(n)) return true;
  if (/\b(marinade|marination|seasoning)$/.test(n) && n.split(/\s+/).length <= 3) return true;
  if (/^for\s+\w/.test(n) && n.split(/\s+/).length <= 4 && !/\d/.test(n)) return true;
  if (/\bto (size|taste|serve|garnish)$/.test(n)) return true;
  if (/:\s*$/.test(String(raw)) && String(raw).trim().split(/\s+/).length <= 4) return true;
  return false;
}

// Reduce a raw ingredient name to its canonical item identity + a display label.
// Returns { item, itemDisplay }.
export function canonicalize(rawName) {
  const display0 = normalize(rawName);
  let n = display0;
  if (!n) return { item: n, itemDisplay: n };
  n = n.replace(/^\s*[\d.\/]+\s*(?:g|kg|oz|lb|lbs?|ml|l|cups?|tbsp|tsp|cloves?|stalks?|slices?|pieces?|pcs?|cans?|bottles?|bags?|bunch(?:es)?|heads?|blocks?|fillets?|dozen|doz|pairs?)?\s+/i, "").trim();
  n = n.replace(/\([^)]*\)/g, " ");
  n = n.replace(/\bfor the [a-z ]+$/i, " ");
  n = n.replace(/,.*$/, " ");
  n = n.replace(/\b(homemade|store bought|store-bought|brand)\b/gi, " ");
  for (const d of PREP_DESCRIPTORS) n = n.replace(new RegExp(`(^|[,\\s])${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([,\\s]|$)`, "gi"), " ");
  for (const noise of MERGE_NOISE) n = n.replace(new RegExp(`(^|[,\\s])${noise.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([,\\s]|$)`, "gi"), " ");
  n = n.replace(/[,]+/g, " ").replace(/\s+/g, " ").trim();
  n = n.split(" ").map(w => normalize(w)).filter(Boolean).join(" ");
  let item = n || display0;
  for (const [re, to] of CANONICAL_BASE) { if (re.test(item)) { item = item.replace(re, to).replace(/\s+/g, " ").trim(); break; } }
  // Display label: the cleaned-but-uncanonicalized name (nicer), falling back to item.
  const itemDisplay = (n && n !== item) ? n : item;
  return { item, itemDisplay };
}

export function isNeverBuy(name) {
  const { item } = canonicalize(name);
  return NEVER_BUY.has(item) || NEVER_BUY.has(normalize(name));
}

// ---- THE ENTRY POINT ----
// input: raw string OR legacy { qty, unit, name, tier }
// opts:  { tier } default "essential"
// returns: structured Ingredient, or null (header/empty/never-buy)
export function normalizeIngredient(input, opts = {}) {
  const tier = opts.tier || (input && input.tier) || "essential";

  // Reconstruct a single raw line from either form.
  let rawLine;
  if (typeof input === "string") {
    rawLine = input;
  } else if (input && typeof input === "object") {
    const q = input.qty != null && (input.qty !== 1 || input.unit) ? input.qty + " " : "";
    const u = input.unit ? input.unit + " " : "";
    rawLine = `${q}${u}${input.name || ""}`.trim();
  } else {
    return null;
  }

  const raw = String(rawLine).trim();
  if (!raw) return null;
  if (isSectionHeader(raw)) return null;

  // Strip a broken-range remnant ("to 4 clove" -> "4 clove").
  let line = raw.replace(/^to\s+(?=[\d½⅓⅔¼¾⅛])/i, "");

  // Quantity.
  let qty = 1, rest = line;
  const ql = parseLeadingQty(line);
  if (ql) { qty = ql.qty; rest = ql.rest; }

  // Unit word.
  let unit = "";
  const uw = rest.match(new RegExp(`^(${UNIT_WORD_ALTERNATION})\\b\\.?\\s+(.*)$`, "i"));
  if (uw) { unit = UNIT_WORD_MAP[uw[1].toLowerCase()] || ""; rest = uw[2]; }
  rest = rest.replace(/^of\s+/i, "");

  // Name -> canonical identity + display.
  const cleanedName = stripPrepClauseLocal(normalize(rest));
  if (!cleanedName) return null;
  if (isSectionHeader(cleanedName)) return null;
  const { item, itemDisplay } = canonicalize(cleanedName);
  if (!item) return null;

  // Family + base quantity.
  const info = unitInfo(unit);
  const family = info.family.startsWith("count") ? "count" : info.family;
  const baseQty = qty * info.factor; // base units: g / ml / singles

  // Look up the item knowledge (sold-as, category, avg weight).
  const db = ITEM_DB[item] || null;
  const soldAs = db ? db.soldAs : (family === "count" ? "count" : "weight");
  const category = db ? db.cat : guessCategoryLocal(item);
  const ambiguousUnit = AMBIGUOUS_UNITS.has((unit || "").toLowerCase());

  return {
    raw,
    qty: qty || 1,
    unit,
    family,
    item,
    itemDisplay,
    tier,
    confirmed: false,        // becomes true only via the entry-review step
    baseQty,
    soldAs,
    category,
    ambiguousUnit,           // if true: never auto-merge; offer manual merge
    neverBuy: NEVER_BUY.has(item),  // valid ingredient, but shopping skips it (water)
  };
}

// Local copies (so the module has no hard dependency on App.jsx internals).
function stripPrepClauseLocal(name) {
  let n = name;
  n = n.replace(/\b(into|in a|in to|cut into|cut in|sliced into|chopped into|moisture removed|with a |with the )\b.*$/i, "");
  n = n.replace(/\b(finely|roughly|thinly|coarsely|lightly|well|thoroughly)\s*$/i, "");
  n = n.replace(/^(and|or|to|the|a|an|of|with|for)\s+/i, "");
  return n.replace(/\s+/g, " ").trim() || name;
}
function guessCategoryLocal(name) {
  const n = name.toLowerCase();
  if (/chicken|beef|pork|lamb|steak|roast|ground|sausage|bacon|turkey|salami/.test(n)) return "Meat";
  if (/salmon|shrimp|tuna|cod|fish|crab|lobster|fillet|anchovy/.test(n)) return "Seafood";
  if (/milk|cream|cheese|yogurt|butter|egg/.test(n)) return "Dairy";
  if (/lettuce|tomato|onion|garlic|pepper|carrot|potato|cucumber|avocado|spinach|broccoli|mushroom|zucchini|celery|corn|bean|pea|herb|basil|cilantro|parsley|lemon|lime|banana|apple|berry|radish|cabbage/.test(n)) return "Produce";
  if (/bread|tortilla|bun|roll|pita|naan|panko|breadcrumb/.test(n)) return "Bakery";
  if (/frozen/.test(n)) return "Frozen";
  if (/salt|pepper|cumin|paprika|oregano|thyme|cinnamon|nutmeg|chili|spice|masala|garam|turmeric|coriander|cardamom|clove/.test(n)) return "Spices";
  if (/water|juice|soda|wine|beer|coffee|tea/.test(n)) return "Beverages";
  return "Pantry";
}

// ---- count <-> weight bridge ----
// Convert an ingredient's baseQty to a whole-item count, if the item is a known
// count item with an average weight. Returns a number (can be fractional) or null.
export function toWholeCount(ing) {
  const db = ITEM_DB[ing.item];
  if (!db || db.soldAs !== "count") return null;
  if (ing.family === "count") return ing.baseQty;          // already singles
  if (ing.family === "mass" && db.avgG) return ing.baseQty / db.avgG; // grams -> items
  return null;
}

// Migrate a legacy ingredient object to the new schema (no data loss).
export function upgradeIngredient(oldIng) {
  return normalizeIngredient(oldIng, { tier: oldIng && oldIng.tier });
}
