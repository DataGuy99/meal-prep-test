import { useState, useRef, useEffect, useCallback, useMemo } from "react";

// ============================================================
// CONSTANTS
// ============================================================
const COLORS = {
  bg: "#FAFAF7", surface: "#F0EDE6",
  primary: "#3D6B2E",
  red: "#C4532A",
  text: "#1A1A1A", textSec: "#7A7067", border: "#DDD8CE",
  breakfast: "#7CB342", breakfastBg: "#E8F5C8",
  lunch: "#3949AB", lunchBg: "#D6DAF0",
  dinner: "#E65100", dinnerBg: "#FDE0CC",
  star: "#D4A017", starEmpty: "#D5CFC4",
  boost: "#0E7C6B", boostBg: "#D4F0EB",
  quarantine: "#C4532A", quarantineBg: "#F4E0DA",
  dry: "#8D6E3F", dryBg: "#F5EFE3",
  cold: "#2E7D9B", coldBg: "#DFF0F7",
  frozen: "#5C6BC0", frozenBg: "#E3E6F5",
  lock: "#6D4C91",
  gold: "#C8960C", goldBg: "#FBF3DA",
};
const MC = {
  Breakfast: { bg: COLORS.breakfastBg, fg: COLORS.breakfast },
  Lunch: { bg: COLORS.lunchBg, fg: COLORS.lunch },
  Dinner: { bg: COLORS.dinnerBg, fg: COLORS.dinner },
};
const SC = {
  dry: { bg: COLORS.dryBg, fg: COLORS.dry, label: "Dry" },
  cold: { bg: COLORS.coldBg, fg: COLORS.cold, label: "Cold" },
  frozen: { bg: COLORS.frozenBg, fg: COLORS.frozen, label: "Frozen" },
};
const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const MEALS = ["Breakfast","Lunch","Dinner"];
const TABS = ["Recipes","Plan","Shop","Pantry","Settings"];
const DEFAULT_TAGS = ["chicken","beef","pork","seafood","fish","salad","grain","pasta","soup","pastry","vegetarian","curry","stir-fry","sandwich","bowl","stew"];
const DEFAULT_STORES = ["aldi","costco","walmart","kroger","trader joes","butcher","farmers market","other"];
const UNITS = ["","g","kg","oz","lb","ml","L","cup","tbsp","tsp","pcs","can","bottle","bag","head","bunch","clove","stalk","block","tub","fillet","slice"];

// People roster: profile types map to a portion weight (1 adult man = 1.0).
// All editable per-person; these are just the starting presets.
const PROFILE_TYPES = [
  { key: "man", label: "Man", weight: 1.0 },
  { key: "woman", label: "Woman", weight: 0.75 },
  { key: "teen", label: "Teen", weight: 0.85 },
  { key: "child", label: "Child", weight: 0.5 },
  { key: "toddler", label: "Toddler", weight: 0.3 },
];
// Attendance frequency: when present, how often they actually eat.
const ATTENDANCE = [
  { key: "every", label: "Every meal", factor: 1.0 },
  { key: "most", label: "Most", factor: 0.75 },
  { key: "sporadic", label: "Sporadic", factor: 0.5 },
  { key: "occasional", label: "Occasional", factor: 0.25 },
];

// Household portion demand = sum over active people of (weight × attendance).
// Empty/all-inactive roster returns 0, signaling callers to fall back to the
// recipe's own serving count.
function portionDemand(people) {
  if (!people || people.length === 0) return 0;
  return people.reduce((sum, p) => {
    if (!p.active) return sum;
    const w = typeof p.weight === "number" ? p.weight : 1;
    const a = typeof p.attendance === "number" ? p.attendance : 1;
    return sum + w * a;
  }, 0);
}

// ============================================================
// PERSISTENCE
// ============================================================
function load(key, fallback) {
  try { const v = localStorage.getItem("prep_" + key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
let _quotaWarned = false;
function save(key, val) {
  try {
    localStorage.setItem("prep_" + key, JSON.stringify(val));
    return true;
  } catch (e) {
    const isQuota = e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22 || e.code === 1014);
    if (isQuota && !_quotaWarned) {
      _quotaWarned = true;
      try { alert("Storage is full — recent changes may not be saved. Export a backup from Settings → Data, then clear old data to free space."); } catch {}
    }
    return false;
  }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ============================================================
// INGREDIENT NORMALIZATION
// ============================================================
// Singular words ending in 's' that must never be reduced.
const NORM_KEEP = new Set([
  "hummus","asparagus","couscous","molasses","watercress","swiss","bass",
  "citrus","status","focus","octopus","cactus","analysis","basis","series",
  "species","kiwi","chili","gas",
]);

// An exclude is active if permanent (no expiry) or not yet expired.
function excludeActive(ex, now = Date.now()) {
  return !ex.expiresAt || ex.expiresAt > now;
}
// Does this exclude apply given a set of active person ids? "all"-scoped
// excludes always apply. Person-scoped excludes apply only when that person
// is among the active eaters. If activePersonIds is null, scope is ignored
// (treat every active exclude as applying — used where we don't yet filter
// by who's eating).
function excludeApplies(ex, activePersonIds) {
  if (!ex.scope || ex.scope === "all") return true;
  if (!activePersonIds) return true;
  return activePersonIds.has(ex.scope);
}

// Qualification engine (K) + omission threshold (L). Given a recipe and the
// active+applicable excludes, decide whether it can be made and what gets
// left out:
//   - excluded ingredient on an ESSENTIAL tier   -> recipe DISQUALIFIED
//   - excluded ingredient on SECONDARY tier only -> recipe QUALIFIES, omit it
//   - more than maxOmissions secondary omissions  -> recipe DISQUALIFIED
//     (too many accessories gone — not worth making this span)
// Legacy untiered ingredients are treated as essential. Returns
// { qualified, omitted:[names], blockedBy:[{ingredient,scope}], tooManyOmissions:bool }.
function qualifyRecipe(recipe, excludes, activePersonIds, now = Date.now(), maxOmissions = Infinity) {
  const omitted = [];
  const blockedBy = [];
  for (const ex of excludes) {
    if (!excludeActive(ex, now)) continue;
    if (!excludeApplies(ex, activePersonIds)) continue;
    const exName = normalize(ex.ingredient);
    for (const ing of recipe.ingredients) {
      if (normalize(ing.name) !== exName) continue;
      const tier = ing.tier || "essential";
      if (tier === "essential") {
        blockedBy.push({ ingredient: ing.name, scope: ex.scope || "all" });
      } else {
        if (!omitted.includes(ing.name)) omitted.push(ing.name);
      }
    }
  }
  const tooMany = omitted.length > maxOmissions;
  return {
    qualified: blockedBy.length === 0 && !tooMany,
    omitted, blockedBy, tooManyOmissions: tooMany,
  };
}

function normalize(s) {
  let w = s.toLowerCase().trim().replace(/-/g, " ").replace(/\s+/g, " ");
  if (!w) return w;
  if (NORM_KEEP.has(w)) return w;
  if (/[^aeiou]ies$/.test(w)) return w.replace(/ies$/, "y");   // berries -> berry
  if (/ves$/.test(w)) return w.replace(/s$/, "");              // olives -> olive, cloves -> clove
  if (/oes$/.test(w)) return w.replace(/es$/, "");             // tomatoes -> tomato
  if (/ss$/.test(w)) return w;                                  // glass, watercress (singular)
  if (/(us|is)$/.test(w)) return w;                            // citrus, basis (singular)
  if (/s$/.test(w)) return w.replace(/s$/, "");               // generic plural: eggs -> egg
  return w;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(a[i-1]!==b[j-1]?1:0));
  return d[m][n];
}

function findMatch(input, dictionary, threshold = 2) {
  const norm = normalize(input);
  if (dictionary.includes(norm)) return norm;
  let best = null, bestDist = Infinity;
  for (const entry of dictionary) {
    const dist = levenshtein(norm, entry);
    if (dist < bestDist) { bestDist = dist; best = entry; }
  }
  return bestDist <= threshold ? best : norm;
}

// Conglomerate a tag into an existing canonical tag via normalize + fuzzy
// match, so "beefs"/"Beef"/"beef " all collapse to one "beef". Returns the
// canonical form. knownTags is the set of tags already in use.
function canonicalizeTag(input, knownTags) {
  return findMatch(input, knownTags, 2);
}

function parseIngredientLine(line) {
  line = line.trim();
  if (!line) return null;
  const m = line.match(/^([\d.\/]+)\s*(g|kg|oz|lb|lbs?|ml|l|cups?|tbsp|tsp|cans?|bottles?|bags?|heads?|pcs?|pieces?|bunch|bunches?|cloves?|stalks?|blocks?|fillets?|slices?)?\s+(.+)$/i);
  if (m) {
    let qty = m[1].includes("/") ? m[1].split("/").reduce((a,b) => a/b) : parseFloat(m[1]);
    let unit = (m[2] || "").toLowerCase().replace(/s$/, "").replace("piece", "pc");
    return { qty: qty || 1, unit, name: normalize(m[3]) };
  }
  const m2 = line.match(/^([\d.\/]+)\s+(.+)$/);
  if (m2) {
    let qty = m2[1].includes("/") ? m2[1].split("/").reduce((a,b) => a/b) : parseFloat(m2[1]);
    return { qty: qty || 1, unit: "", name: normalize(m2[2]) };
  }
  return { qty: 1, unit: "", name: normalize(line) };
}

function guessCategory(name) {
  const n = name.toLowerCase();
  if (/chicken|beef|pork|lamb|steak|roast|ground|sausage|bacon|turkey/.test(n)) return "Meat";
  if (/salmon|shrimp|tuna|cod|fish|crab|lobster|fillet/.test(n)) return "Seafood";
  if (/milk|cream|cheese|yogurt|butter|egg/.test(n)) return "Dairy";
  if (/lettuce|tomato|onion|garlic|pepper|carrot|potato|cucumber|avocado|spinach|broccoli|mushroom|zucchini|celery|corn|bean|pea|herb|basil|cilantro|parsley|lemon|lime|banana|apple|berry/.test(n)) return "Produce";
  if (/bread|tortilla|bun|roll|pita|naan/.test(n)) return "Bakery";
  if (/frozen/.test(n)) return "Frozen";
  if (/salt|pepper|cumin|paprika|oregano|thyme|cinnamon|nutmeg|chili|spice|masala|garam|turmeric/.test(n)) return "Spices";
  if (/water|juice|soda|wine|beer|coffee|tea/.test(n)) return "Beverages";
  return "Pantry";
}

// ============================================================
// RANDOMIZATION ENGINE
// ============================================================
// ============================================================
// FATIGUE — TWO LAYERS
// Layer 1 (recency): time-decay since last use. Short-term pull-down
//   that recovers over days.
// Layer 2 (frequency): count of uses within a trailing window, derived
//   from useHistory timestamps. Long-term pull-down against a recipe
//   resurfacing too often even when each individual recency check passes.
// A manual "shelve" sets shelvedUntil for an explicit extended back-burner.
// ============================================================
const FREQ_WINDOW_DAYS = 30;   // rolling window for frequency counting
const FREQ_SOFT_CAP = 6;       // uses in-window beyond which weight tapers hard
const FREQ_PROMPT_AT = 8;      // uses in-window that trigger the "take a break?" nudge
const HISTORY_KEEP_DAYS = 90;  // trim useHistory older than this

function recencyFactor(recipe) {
  if (!recipe.lastUsed) return 1;
  const days = (Date.now() - recipe.lastUsed) / 86400000;
  return 1 - Math.exp(-days / 3);
}

function windowedUseCount(recipe, windowDays = FREQ_WINDOW_DAYS) {
  if (!recipe.useHistory || recipe.useHistory.length === 0) return 0;
  const cutoff = Date.now() - windowDays * 86400000;
  return recipe.useHistory.filter(t => t >= cutoff).length;
}

function frequencyFactor(recipe) {
  const n = windowedUseCount(recipe);
  if (n <= FREQ_SOFT_CAP) return 1;
  // Beyond the soft cap, decay toward (but never reaching) zero.
  return Math.max(0.05, 1 - (n - FREQ_SOFT_CAP) * 0.18);
}

// Combined fatigue multiplier in [0,1]. Used by the weighting engine.
function calcFatigue(recipe) {
  // Explicit manual shelf overrides everything until it expires.
  if (recipe.shelvedUntil && recipe.shelvedUntil > Date.now()) return 0.05;
  return recencyFactor(recipe) * frequencyFactor(recipe);
}

// Back-compat shim: older call sites referenced calcFatigueRecency.
const calcFatigueRecency = calcFatigue;

// Trim history to keep storage bounded.
function trimHistory(hist) {
  if (!hist) return [];
  const cutoff = Date.now() - HISTORY_KEEP_DAYS * 86400000;
  return hist.filter(t => t >= cutoff);
}

function calcWeight(recipe, settings, planTagCounts, activePersonIds = null) {
  const { tagWeights, boosts, excludes, ranges } = settings;
  const now = Date.now();
  // Qualification: essential exclusion disqualifies (weight 0).
  if (!qualifyRecipe(recipe, excludes, activePersonIds, now, settings.maxOmissions).qualified) return 0;
  if (recipe.quarantine) return 0;

  let starW = (recipe.stars || 3) / 5;
  let tagW = 0;
  for (const t of (recipe.tags || [])) {
    tagW += (tagWeights[t] || 10) / 100;
  }
  let fatigue = calcFatigueRecency(recipe);

  // Boosts: each boost contributes its weight AT MOST ONCE per recipe,
  // whether it matches a tag or one-or-more ingredients (no stacking).
  // Ingredient match is exact or whole-word (so "chicken" matches
  // "chicken thigh" but not "licorice"; avoids substring bleed).
  let boostMul = 1;
  const recipeTags = recipe.tags || [];
  for (const b of boosts) {
    const item = normalize(b.item);
    if (!item) continue;
    const matchesTag = recipeTags.includes(item);
    const matchesIng = recipe.ingredients.some(ing => {
      const n = normalize(ing.name);
      return n === item || n.split(" ").includes(item);
    });
    if (matchesTag || matchesIng) boostMul += (b.weight || 10) / 100;
  }

  // Soft range pressure: as a ranged tag approaches its max within the plan,
  // taper this recipe's weight. Gradual downward pressure that complements the
  // hard >= max cutoff in generatePlan. Below min, no penalty (1.0).
  let rangeMul = 1;
  if (ranges && planTagCounts) {
    for (const range of ranges) {
      if (!recipeTags.includes(range.tag)) continue;
      const count = planTagCounts[range.tag] || 0;
      if (range.max > 0 && count >= range.min) {
        // Linear taper from 1.0 (at min) down toward 0.15 (at max).
        const span = Math.max(1, range.max - range.min);
        const over = Math.min(span, count - range.min);
        rangeMul *= Math.max(0.15, 1 - (over / span) * 0.85);
      }
    }
  }

  return starW * (1 + tagW) * fatigue * boostMul * rangeMul;
}

function generatePlan(recipes, existingPlan, settings, activePersonIds = null) {
  const plan = {};
  DAYS.forEach(d => {
    plan[d] = {};
    MEALS.forEach(m => {
      const existing = existingPlan?.[d]?.[m];
      plan[d][m] = existing?.locked ? { ...existing } : null;
    });
  });

  const { ranges, excludes, redList, mealTargets } = settings;
  const now = Date.now();
  const eligible = recipes.filter(r => {
    if (r.quarantine) return false;
    // Qualification engine: essential exclusion disqualifies; secondary omits.
    if (!qualifyRecipe(r, excludes, activePersonIds, now, settings.maxOmissions).qualified) return false;
    for (const rl of redList) {
      for (const ing of r.ingredients) {
        if (normalize(ing.name) === normalize(rl)) return false;
      }
    }
    return true;
  });

  const tagCounts = {};
  const usedRecipes = new Set();
  // Count existing locked assignments
  DAYS.forEach(d => MEALS.forEach(m => {
    const s = plan[d][m];
    if (s) {
      const r = recipes.find(x => x.id === s.recipeId);
      if (r) {
        usedRecipes.add(r.id);
        (r.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
      }
    }
  }));

  // Recipe tag-score = sum of its tag weights. Used for meal-target banding.
  const tagScoreOf = (r) => (r.tags || []).reduce((s, t) => s + (settings.tagWeights[t] || 10), 0);

  for (const meal of MEALS) {
    const emptySlots = DAYS.filter(d => !plan[d][meal]);
    if (emptySlots.length === 0) continue;

    const mealKey = meal.toLowerCase();
    const pool = eligible.filter(r => (r.mealTags || []).includes(mealKey));
    let remaining = [...emptySlots];

    // Meal-target banding: accumulate tag-score for this meal type. Below the
    // band's min, bias toward higher-scoring recipes to climb into band; once
    // at/over max, taper score-heavy picks. Seed with any locked slots' scores.
    const band = mealTargets?.[meal];
    let mealScore = 0;
    if (band) {
      DAYS.forEach(d => {
        const s = plan[d][meal];
        if (s?.recipeId) {
          const r = recipes.find(x => x.id === s.recipeId);
          if (r) mealScore += tagScoreOf(r);
        }
      });
    }

    let attempts = 0;
    while (remaining.length > 0 && attempts < 50) {
      attempts++;
      const weights = pool.map(r => {
        let base = usedRecipes.has(r.id)
          ? calcWeight(r, settings, tagCounts, activePersonIds) * 0.3
          : calcWeight(r, settings, tagCounts, activePersonIds);
        // Soft meal-target bias
        if (band && base > 0) {
          const score = tagScoreOf(r);
          if (mealScore < band.min) {
            // Below band: prefer recipes that move us toward min (favor higher score)
            base *= 1 + (score / Math.max(1, band.max)) * 0.6;
          } else if (mealScore >= band.max) {
            // At/over band: taper score-heavy recipes (favor lighter ones)
            base *= Math.max(0.3, 1 - (score / Math.max(1, band.max)) * 0.6);
          }
        }
        return { r, w: base };
      }).filter(x => x.w > 0);

      if (weights.length === 0) break;

      // Check range constraints
      const validWeights = weights.filter(({ r }) => {
        for (const range of ranges) {
          if ((r.tags || []).includes(range.tag)) {
            if ((tagCounts[range.tag] || 0) >= range.max) return false;
          }
        }
        return true;
      });

      const finalPool = validWeights.length > 0 ? validWeights : weights;
      const totalW = finalPool.reduce((s, x) => s + x.w, 0);
      let rand = Math.random() * totalW;
      let picked = finalPool[0].r;
      for (const { r, w } of finalPool) {
        rand -= w;
        if (rand <= 0) { picked = r; break; }
      }

      const maxChunk = Math.min(picked.slotsMax || picked.servings, remaining.length);
      const minChunk = Math.min(picked.slotsMin || 1, maxChunk);
      const chunkSize = Math.floor(Math.random() * (maxChunk - minChunk + 1)) + minChunk;

      for (let i = 0; i < chunkSize && i < remaining.length; i++) {
        plan[remaining[i]][meal] = {
          recipeId: picked.id,
          recipeName: picked.name,
          locked: false,
        };
      }
      remaining = remaining.slice(chunkSize);
      usedRecipes.add(picked.id);
      (picked.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + chunkSize; });
      if (band) mealScore += tagScoreOf(picked) * chunkSize;
    }
  }
  return plan;
}

function rerollSlot(day, meal, recipes, plan, settings, activePersonIds = null) {
  const mealKey = meal.toLowerCase();
  const now = Date.now();
  const currentRecipeId = plan[day]?.[meal]?.recipeId;

  const eligible = recipes.filter(r => {
    if (r.quarantine || r.id === currentRecipeId) return false;
    if (!(r.mealTags || []).includes(mealKey)) return false;
    if (!qualifyRecipe(r, settings.excludes, activePersonIds, now, settings.maxOmissions).qualified) return false;
    return true;
  });

  if (eligible.length === 0) return plan;
  const weights = eligible.map(r => ({ r, w: calcWeight(r, settings, {}, activePersonIds) })).filter(x => x.w > 0);
  if (weights.length === 0) return plan;

  const totalW = weights.reduce((s, x) => s + x.w, 0);
  let rand = Math.random() * totalW;
  let picked = weights[0].r;
  for (const { r, w } of weights) { rand -= w; if (rand <= 0) { picked = r; break; } }

  const newPlan = JSON.parse(JSON.stringify(plan));
  newPlan[day][meal] = {
    recipeId: picked.id, recipeName: picked.name, locked: false,
  };
  return newPlan;
}

// ============================================================
// SHOPPING LIST GENERATOR
// ============================================================
// Unit conversion: map each unit to a {family, factor-to-base} pair.
// Mass base = g. Volume base = ml. Count/other = its own family (no conversion).
const UNIT_CONV = {
  g:   { family: "mass",   factor: 1 },
  kg:  { family: "mass",   factor: 1000 },
  oz:  { family: "mass",   factor: 28.3495 },
  lb:  { family: "mass",   factor: 453.592 },
  ml:  { family: "volume", factor: 1 },
  l:   { family: "volume", factor: 1000 },
  tsp: { family: "volume", factor: 4.92892 },
  tbsp:{ family: "volume", factor: 14.7868 },
  cup: { family: "volume", factor: 236.588 },
};

function unitInfo(unit) {
  const u = (unit || "").toLowerCase();
  return UNIT_CONV[u] || { family: "count:" + u, factor: 1 };
}

// Pick a human-friendly display unit + value from a base quantity in a family.
function prettyUnit(family, baseQty) {
  if (family === "mass") {
    return baseQty >= 1000
      ? { qty: baseQty / 1000, unit: "kg" }
      : { qty: baseQty, unit: "g" };
  }
  if (family === "volume") {
    if (baseQty >= 1000) return { qty: baseQty / 1000, unit: "L" };
    if (baseQty >= 240)  return { qty: baseQty, unit: "ml" };
    if (baseQty >= 45)   return { qty: baseQty / 14.7868, unit: "tbsp" };
    return { qty: baseQty / 4.92892, unit: "tsp" };
  }
  // count:<unit> — strip prefix back to the original unit label
  return { qty: baseQty, unit: family.slice(6) };
}

function round1(n) { return Math.round(n * 10) / 10; }

function generateShoppingList(plan, recipes, pantry, excludes = [], activePersonIds = null, maxOmissions = Infinity) {
  // Bucket needs by ingredient name + unit family. Within a family, sum in base units.
  // needs[name] = { name, category, families: { [family]: baseQty } }
  const needs = {};
  const now = Date.now();
  DAYS.forEach(d => MEALS.forEach(m => {
    const slot = plan?.[d]?.[m];
    if (!slot?.recipeId) return;
    const recipe = recipes.find(r => r.id === slot.recipeId);
    if (!recipe) return;
    // Omission (M): ingredients dropped for the active household shouldn't be
    // bought. A qualifying recipe's omitted secondary ingredients are excluded
    // from the shopping list.
    const qual = qualifyRecipe(recipe, excludes, activePersonIds, now, maxOmissions);
    const omittedSet = new Set(qual.omitted.map(n => normalize(n)));
    for (const ing of recipe.ingredients) {
      if (omittedSet.has(normalize(ing.name))) continue;
      const key = normalize(ing.name);
      if (!needs[key]) needs[key] = { name: ing.name, category: guessCategory(ing.name), families: {} };
      const info = unitInfo(ing.unit);
      const base = (ing.qty || 1) * info.factor;
      needs[key].families[info.family] = (needs[key].families[info.family] || 0) + base;
    }
  }));

  const items = [];
  for (const [key, need] of Object.entries(needs)) {
    const pantryItem = pantry.find(p => normalize(p.name) === key);

    for (const [family, baseQty] of Object.entries(need.families)) {
      let remaining = baseQty;

      // Subtract pantry ONLY if the pantry item's unit is in the same family.
      if (pantryItem && pantryItem.qty > 0) {
        const pInfo = unitInfo(pantryItem.unit);
        if (pInfo.family === family) {
          remaining -= pantryItem.qty * pInfo.factor;
        }
      }

      if (remaining > 0.01) {
        const disp = prettyUnit(family, remaining);
        items.push({
          name: need.name,
          qty: round1(disp.qty),
          unit: disp.unit,
          category: need.category,
          store: pantryItem?.store || "",
          checked: false,
          source: "plan",
        });
      }
    }
  }
  return items;
}

function getFloorItems(pantry) {
  return pantry.filter(p => p.floor > 0 && p.qty <= p.floor).map(p => ({
    name: p.name, qty: round1(p.floor - p.qty), unit: p.unit,
    category: guessCategory(p.name), store: p.store || "",
    reason: `${p.qty < p.floor ? "Below" : "At"} floor (${p.qty}/${p.floor})`,
    checked: false, source: "floor",
  })).filter(i => i.qty > 0);
}

// Unified shopping list: merge plan-demand and floor-replenishment into one
// deduplicated list keyed by (normalized name + unit family). When both
// sources want the same ingredient, take the MAX of the two needs, not the
// sum — buying enough for the larger need covers the smaller. This is what
// prevents the floor double-add (an item that's both plan-needed and below
// floor appears once). Manual items are passed through untouched.
function buildUnifiedList(plan, recipes, pantry, excludes = [], activePersonIds = null, maxOmissions = Infinity) {
  // Collect plan needs in base units per (name, family).
  const planItems = generateShoppingList(plan, recipes, pantry, excludes, activePersonIds, maxOmissions);
  const floorItems = getFloorItems(pantry);

  // Key each by name|family. For floor items, derive their family from unit.
  const merged = {}; // key -> item with baseQty for comparison
  const keyOf = (name, unit) => `${normalize(name)}|${unitInfo(unit).family}`;

  function consider(item, reason) {
    const k = keyOf(item.name, item.unit);
    const info = unitInfo(item.unit);
    const base = (parseFloat(item.qty) || 0) * info.factor;
    if (!merged[k]) {
      merged[k] = { ...item, _base: base, _family: info.family, sources: [item.source] };
      if (reason) merged[k].reason = reason;
    } else {
      const m = merged[k];
      if (!m.sources.includes(item.source)) m.sources.push(item.source);
      // Take the larger need (max), re-deriving display from the winning base.
      if (base > m._base) {
        m._base = base;
        const disp = prettyUnit(info.family, base);
        m.qty = round1(disp.qty);
        m.unit = disp.unit;
      }
      // Prefer a store hint if we don't have one.
      if (!m.store && item.store) m.store = item.store;
      // Keep a floor reason if present (explains why it's here beyond the plan).
      if (reason && !m.reason) m.reason = reason;
    }
  }

  planItems.forEach(it => consider(it, null));
  floorItems.forEach(it => consider(it, it.reason));

  // Strip internal fields.
  return Object.values(merged).map(({ _base, _family, ...rest }) => rest);
}

// ============================================================
// SHARED UI COMPONENTS
// ============================================================
const TAB_ICONS = {
  Recipes: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="13" y2="11"/></svg>,
  Plan: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  Shop: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>,
  Pantry: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 7l10-5 10 5-10 5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>,
  Settings: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
};

const StarRating = ({ rating, size = 16, onChange }) => (
  <div style={{ display: "flex", gap: 2 }}>
    {[1,2,3,4,5].map(i => <span key={i} onClick={e => { e.stopPropagation(); onChange?.(i === rating ? i-1 : i); }} style={{ cursor: onChange?"pointer":"default", color: i <= rating ? COLORS.star : COLORS.starEmpty, fontSize: size, lineHeight: 1, userSelect: "none" }}>★</span>)}
  </div>
);

// Continuous blue→red preference scale. Drag the dot anywhere; value is read
// from pointer position as a float in [min,max]. Blue end = less, red = more,
// center = neutral. Touch + mouse. Optional editable number (showNumber) lets
// a user type an exact value beside the scale.
function GradientScale({ value, min = 0, max = 100, onChange, showNumber = false, height = 14, label, leftLabel, rightLabel }) {
  const barRef = useRef(null);
  const dragging = useRef(false);

  const clamp = (v) => Math.max(min, Math.min(max, v));
  const pct = ((clamp(value) - min) / (max - min)) * 100;

  const valueFromClientX = (clientX) => {
    const rect = barRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return clamp(min + ratio * (max - min));
  };

  const handleDown = (clientX) => { dragging.current = true; onChange(Math.round(valueFromClientX(clientX) * 100) / 100); };
  const handleMove = (clientX) => { if (dragging.current) onChange(Math.round(valueFromClientX(clientX) * 100) / 100); };
  const handleUp = () => { dragging.current = false; };

  useEffect(() => {
    const mm = (e) => handleMove(e.clientX);
    const mu = () => handleUp();
    const tm = (e) => { if (e.touches[0]) handleMove(e.touches[0].clientX); };
    window.addEventListener("mousemove", mm);
    window.addEventListener("mouseup", mu);
    window.addEventListener("touchmove", tm, { passive: false });
    window.addEventListener("touchend", mu);
    return () => {
      window.removeEventListener("mousemove", mm);
      window.removeEventListener("mouseup", mu);
      window.removeEventListener("touchmove", tm);
      window.removeEventListener("touchend", mu);
    };
  }, [min, max]);

  return (
    <div style={{ width: "100%" }}>
      {label && <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          ref={barRef}
          onMouseDown={e => handleDown(e.clientX)}
          onTouchStart={e => { if (e.touches[0]) handleDown(e.touches[0].clientX); }}
          style={{ position: "relative", flex: 1, height, borderRadius: height/2, cursor: "pointer", touchAction: "none",
            background: "linear-gradient(90deg, #3A6FB0 0%, #B8B0C0 50%, #C4532A 100%)" }}
        >
          <div style={{ position: "absolute", top: "50%", left: `${pct}%`, transform: "translate(-50%, -50%)",
            width: height + 8, height: height + 8, borderRadius: "50%", background: "#fff",
            border: `2px solid ${COLORS.text}`, boxShadow: "0 1px 4px rgba(0,0,0,0.25)", pointerEvents: "none" }} />
        </div>
        {showNumber && (
          <input type="number" value={Math.round(clamp(value))} onChange={e => onChange(clamp(+e.target.value))}
            style={{ width: 48, padding: "4px 6px", borderRadius: 5, border: `1px solid ${COLORS.border}`, fontSize: 13, textAlign: "center" }} />
        )}
      </div>
      {(leftLabel || rightLabel) && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
          <span style={{ fontSize: 9, color: COLORS.textSec }}>{leftLabel}</span>
          <span style={{ fontSize: 9, color: COLORS.textSec }}>{rightLabel}</span>
        </div>
      )}
    </div>
  );
}

const Badge = ({ children, color, bg, style: s }) => (
  <span style={{ display:"inline-block", padding:"2px 8px", borderRadius:99, fontSize:11, fontWeight:600, color, background:bg, whiteSpace:"nowrap", ...s }}>{children}</span>
);

// A recipe tag that, when tapped, expands to a mini gradient scale for that
// tag's global preference (same value the survey + Settings edit). The third
// edit surface for tag weights. If the tag isn't in tagWeights yet, tapping
// seeds it at neutral.
function TagPrefBadge({ tag, settings, setSettings }) {
  const [open, setOpen] = useState(false);
  const weight = settings.tagWeights?.[tag] ?? NEUTRAL_WEIGHT;
  const setWeight = (v) => setSettings(prev => ({ ...prev, tagWeights: { ...prev.tagWeights, [tag]: Math.max(0, Math.min(100, Math.round(v))) } }));
  return (
    <div style={{ display:"inline-block" }}>
      <span onClick={e => { e.stopPropagation(); setOpen(o => !o); }} style={{ display:"inline-flex", alignItems:"center", gap:3, padding:"2px 8px", borderRadius:99, fontSize:11, fontWeight:600, color:COLORS.primary, background:`${COLORS.primary}18`, cursor:"pointer", whiteSpace:"nowrap" }}>
        {tag} <span style={{ fontSize:8, opacity:0.7 }}>{open ? "▲" : "▾"}</span>
      </span>
      {open && (
        <div onClick={e => e.stopPropagation()} style={{ marginTop:6, marginBottom:4, padding:"8px 10px", borderRadius:8, background:COLORS.surface, border:`1px solid ${COLORS.border}` }}>
          <div style={{ fontSize:10, color:COLORS.textSec, marginBottom:5 }}>Preference for <b style={{ textTransform:"capitalize" }}>{tag}</b> across all plans</div>
          <GradientScale value={weight} min={0} max={100} onChange={setWeight} showNumber leftLabel="less" rightLabel="more" />
        </div>
      )}
    </div>
  );
}

const Card = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{ background:COLORS.surface, borderRadius:10, padding:"12px 14px", border:`1px solid ${COLORS.border}`, cursor:onClick?"pointer":"default", ...style }}>{children}</div>
);

// Number input that lets the field go blank while editing (so you can clear it
// and type fresh) and only resolves to a number on blur. Commits valid numbers
// live; on blur, an empty/invalid field falls back to `fallback` (default min).
// Props: value, onCommit(num), min, max, step, and any style/extra passthrough.
function NumberInput({ value, onCommit, min = -Infinity, max = Infinity, step, fallback, style, ...rest }) {
  const [draft, setDraft] = useState(String(value ?? ""));
  const focused = useRef(false);
  // Keep draft in sync when the external value changes and we're not editing.
  useEffect(() => { if (!focused.current) setDraft(String(value ?? "")); }, [value]);

  const clamp = (n) => Math.max(min, Math.min(max, n));

  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      value={draft}
      onFocus={() => { focused.current = true; }}
      onChange={e => {
        const v = e.target.value;
        setDraft(v);
        if (v !== "" && v !== "-" && !isNaN(+v)) onCommit(clamp(+v));
      }}
      onBlur={() => {
        focused.current = false;
        if (draft === "" || isNaN(+draft)) {
          const fb = fallback != null ? fallback : (min === -Infinity ? 0 : min);
          onCommit(fb);
          setDraft(String(fb));
        } else {
          const c = clamp(+draft);
          onCommit(c);
          setDraft(String(c));
        }
      }}
      style={style}
      {...rest}
    />
  );
}

const Btn = ({ children, variant="primary", style, onClick, small, disabled }) => {
  const s = {
    primary: { background:COLORS.primary, color:"#fff", border:"none" },
    secondary: { background:"transparent", color:COLORS.primary, border:`1.5px solid ${COLORS.primary}` },
    danger: { background:COLORS.red, color:"#fff", border:"none" },
    ghost: { background:"transparent", color:COLORS.textSec, border:`1px solid ${COLORS.border}` },
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...s[variant], borderRadius:8, padding:small?"6px 12px":"10px 16px", fontSize:small?12:14, fontWeight:600, cursor:disabled?"not-allowed":"pointer", opacity:disabled?0.5:1, ...style }}>{children}</button>;
};

const SectionLabel = ({ children }) => (
  <div style={{ fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:1.2, color:COLORS.textSec, marginBottom:8, marginTop:16 }}>{children}</div>
);

const Combobox = ({ options, value, onChange, placeholder, multi, selected = [] }) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef();
  const filtered = options.filter(o => o.toLowerCase().includes(search.toLowerCase()) && !selected.includes(o));
  useEffect(() => { const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);

  if (multi) {
    return (
      <div ref={ref} style={{ position:"relative", width:"100%" }}>
        <div style={{ display:"flex", flexWrap:"wrap", gap:4, padding:"4px 8px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, background:"#fff", minHeight:34, alignItems:"center", cursor:"text" }} onClick={() => setOpen(true)}>
          {selected.map(s => (
            <span key={s} style={{ display:"inline-flex", alignItems:"center", gap:3, padding:"2px 6px", borderRadius:4, background:`${COLORS.primary}15`, color:COLORS.primary, fontSize:11, fontWeight:600 }}>
              {s} <span onClick={e => { e.stopPropagation(); onChange(selected.filter(x => x !== s)); }} style={{ cursor:"pointer", fontSize:13, lineHeight:1 }}>×</span>
            </span>
          ))}
          <input value={search} onChange={e => { setSearch(e.target.value); setOpen(true); }} placeholder={selected.length?"":placeholder} style={{ border:"none", outline:"none", fontSize:13, flex:1, minWidth:60, background:"transparent" }} />
        </div>
        {open && (
          <div style={{ position:"absolute", top:"100%", left:0, right:0, maxHeight:160, overflowY:"auto", background:"#fff", border:`1px solid ${COLORS.border}`, borderRadius:6, marginTop:2, zIndex:10, boxShadow:"0 4px 12px rgba(0,0,0,0.08)" }}>
            {filtered.map(o => <div key={o} onClick={() => { onChange([...selected, o]); setSearch(""); }} style={{ padding:"8px 10px", cursor:"pointer", fontSize:13 }}>{o}</div>)}
            {filtered.length === 0 && search && <div onClick={() => { onChange([...selected, search.toLowerCase().trim()]); setSearch(""); }} style={{ padding:"8px 10px", cursor:"pointer", fontSize:13, color:COLORS.primary, fontWeight:600 }}>+ Add "{search.toLowerCase().trim()}"</div>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} style={{ position:"relative", width:"100%" }}>
      <input value={open ? search : value || ""} placeholder={placeholder} onFocus={() => { setOpen(true); setSearch(""); }} onChange={e => setSearch(e.target.value)} style={{ width:"100%", padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14, background:"#fff", boxSizing:"border-box", outline:"none" }} />
      {open && (
        <div style={{ position:"absolute", top:"100%", left:0, right:0, maxHeight:160, overflowY:"auto", background:"#fff", border:`1px solid ${COLORS.border}`, borderRadius:6, marginTop:2, zIndex:10, boxShadow:"0 4px 12px rgba(0,0,0,0.08)" }}>
          {filtered.map(o => <div key={o} onClick={() => { onChange(o); setOpen(false); setSearch(""); }} style={{ padding:"8px 10px", cursor:"pointer", fontSize:13, background:o===value?COLORS.surface:"transparent" }}>{o}</div>)}
          {filtered.length === 0 && search && <div onClick={() => { onChange(search.toLowerCase().trim()); setOpen(false); setSearch(""); }} style={{ padding:"8px 10px", cursor:"pointer", fontSize:13, color:COLORS.primary, fontWeight:600 }}>+ Add "{search.toLowerCase().trim()}"</div>}
        </div>
      )}
    </div>
  );
};

const Notif = ({ notifications }) => {
  if (!notifications?.length) return null;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:12 }}>
      {notifications.map((n, i) => (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", borderRadius:8, fontSize:12, fontWeight:500, background:n.bg || COLORS.boostBg, color:n.color || COLORS.boost }}>
          <span style={{ fontSize:15 }}>{n.icon}</span>
          <span style={{ flex:1 }}>{n.text}</span>
          {n.action && <Btn small variant="ghost" onClick={n.onAction} style={{ fontSize:11, padding:"3px 8px", color:"inherit", borderColor:"currentColor" }}>{n.action}</Btn>}
        </div>
      ))}
    </div>
  );
};

// ============================================================
// RECIPES TAB
// ============================================================
function RecipesTab({ recipes, setRecipes, settings, setSettings, dictionary, setDictionary }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [grouped, setGrouped] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null); // recipe id being edited, or null for new
  const [addForm, setAddForm] = useState({ name:"", tags:[], mealTags:[], servings:4, slotsMin:2, slotsMax:4, stars:3, essentialText:"", secondaryText:"", instructions:"" });
  const formRef = useRef(null);

  const allTags = useMemo(() => [...new Set([...Object.keys(settings.tagWeights || {}), ...recipes.flatMap(r => r.tags || [])])].sort(), [recipes, settings.tagWeights]);

  const filtered = recipes.filter(r => {
    if (filter === "favorites" && !(r.stars >= 4)) return false;
    if (filter === "quarantine" && !r.quarantine) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const inName = r.name.toLowerCase().includes(q);
      const inTags = (r.tags || []).some(t => t.toLowerCase().includes(q)) || (r.mealTags || []).some(t => t.toLowerCase().includes(q));
      const inIngs = (r.ingredients || []).some(i => i.name.toLowerCase().includes(q));
      if (!inName && !inTags && !inIngs) return false;
    }
    return true;
  });

  // Group filtered recipes by primary category (first tag), "Other" if untagged.
  const groupedRecipes = (() => {
    const groups = {};
    for (const r of filtered) {
      const key = (r.tags && r.tags[0]) || "Other";
      (groups[key] = groups[key] || []).push(r);
    }
    return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
  })();

  const freqNotifs = recipes.filter(r => {
    if (r.shelvedUntil && r.shelvedUntil > Date.now()) return false;
    return windowedUseCount(r) >= FREQ_PROMPT_AT;
  }).map(r => ({
    icon: "🔔", text: `${r.name} used ${windowedUseCount(r)}× in the last ${FREQ_WINDOW_DAYS} days. Take a break?`,
    bg: "#FFF3CD", color: "#856404", action: "Shelve",
    onAction: () => setRecipes(prev => prev.map(x => x.id === r.id
      ? { ...x, shelvedUntil: Date.now() + 14 * 86400000 }
      : x)),
  }));
  const quarNotifs = recipes.filter(r => r.quarantine).map(r => ({
    icon: "🔴", text: `${r.name} has unresolved red-list items`,
    bg: COLORS.quarantineBg, color: COLORS.quarantine,
  }));

  const blankForm = { name:"", tags:[], mealTags:[], servings:4, slotsMin:2, slotsMax:4, stars:3, essentialText:"", secondaryText:"", instructions:"" };

  // Serialize a recipe's ingredients of one tier back into editable text lines.
  // Keep the quantity whenever there's a unit (so "1 kg beef" round-trips); only
  // drop a bare "1" when there's no unit ("1 onion" -> "onion").
  function ingsToText(ingredients, tier) {
    return ingredients
      .filter(i => (i.tier || "essential") === tier)
      .map(i => {
        const showQty = i.qty && (i.qty !== 1 || i.unit);
        return `${showQty ? i.qty + " " : ""}${i.unit ? i.unit + " " : ""}${i.name}`.trim();
      })
      .join("\n");
  }

  function startEdit(r) {
    setAddForm({
      name: r.name, tags: r.tags || [], mealTags: r.mealTags || [],
      servings: r.servings, slotsMin: r.slotsMin, slotsMax: r.slotsMax, stars: r.stars,
      essentialText: ingsToText(r.ingredients, "essential"),
      secondaryText: ingsToText(r.ingredients, "secondary"),
      instructions: r.instructions || "",
    });
    setEditId(r.id);
    setShowAdd(true);
    setExpandedId(null);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }

  function closeForm() {
    setShowAdd(false);
    setEditId(null);
    setAddForm(blankForm);
  }

  function saveRecipe() {
    const parseTier = (text, tier) => text.split("\n").map(parseIngredientLine).filter(Boolean)
      .map(ing => ({ ...ing, name: findMatch(ing.name, dictionary), tier }));
    const essentialIngs = parseTier(addForm.essentialText, "essential");
    const secondaryIngs = parseTier(addForm.secondaryText, "secondary");
    const newIngs = [...essentialIngs, ...secondaryIngs];
    const newDict = [...new Set([...dictionary, ...newIngs.map(i => i.name)])];
    setDictionary(newDict);

    // Check red list
    const redHits = newIngs.filter(ing => settings.redList.some(rl => normalize(rl) === normalize(ing.name)));
    const isQ = redHits.length > 0;

    const core = {
      name: addForm.name.trim(), stars: addForm.stars,
      tags: addForm.tags, mealTags: addForm.mealTags,
      servings: addForm.servings, slotsMin: addForm.slotsMin, slotsMax: addForm.slotsMax,
      ingredients: newIngs, quarantine: isQ,
      instructions: addForm.instructions.trim(),
      quarantineItems: redHits.map(r => ({ ingredient: r.name, sub: "" })),
    };

    if (editId) {
      // Update existing — preserve usage history, dates, shelving.
      setRecipes(prev => prev.map(r => r.id === editId ? { ...r, ...core } : r));
    } else {
      setRecipes(prev => [...prev, {
        id: uid(), ...core,
        lastUsed: null, useCount: 0, useHistory: [], shelvedUntil: null, createdAt: Date.now(),
      }]);
    }
    closeForm();
  }

  function deleteRecipe(id) { setRecipes(prev => prev.filter(r => r.id !== id)); }

  function resolveQuarantine(recipeId, ingredient, sub) {
    if (!sub.trim()) return;
    setRecipes(prev => prev.map(r => {
      if (r.id !== recipeId) return r;
      const qi = r.quarantineItems.map(q => q.ingredient === ingredient ? { ...q, sub: sub.trim() } : q);
      const ings = r.ingredients.map(i => normalize(i.name) === normalize(ingredient) ? { ...i, name: normalize(sub) } : i);
      const allResolved = qi.every(q => q.sub);
      return { ...r, quarantineItems: qi, ingredients: ings, quarantine: !allResolved };
    }));
  }

  function updateRecipe(id, updates) { setRecipes(prev => prev.map(r => r.id === id ? { ...r, ...updates } : r)); }

  return (
    <div>
      <Notif notifications={[...quarNotifs, ...freqNotifs]} />
      {recipes.length > 0 && (
        <>
          <div style={{ display:"flex", gap:6, marginBottom:8, flexWrap:"wrap" }}>
            {["all","favorites","quarantine"].map(f => (
              <Btn key={f} small variant={filter===f?"primary":"ghost"} onClick={() => setFilter(f)}>
                {f==="all"?"All ("+recipes.length+")":f==="favorites"?"★ Favorites":"🔴 Quarantined ("+recipes.filter(r=>r.quarantine).length+")"}
              </Btn>
            ))}
          </div>
          <div style={{ display:"flex", gap:8, marginBottom:14, alignItems:"center" }}>
            <div style={{ flex:1, position:"relative" }}>
              <span style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", fontSize:13, color:COLORS.textSec, pointerEvents:"none" }}>🔍</span>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search recipes, tags, ingredients..." style={{ width:"100%", boxSizing:"border-box", padding:"8px 10px 8px 30px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
              {search && <span onClick={() => setSearch("")} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", fontSize:15, color:COLORS.textSec, cursor:"pointer" }}>×</span>}
            </div>
            <Btn small variant={grouped?"primary":"ghost"} onClick={() => setGrouped(g => !g)} title="Group by category">⊞ Group</Btn>
          </div>
        </>
      )}
      {recipes.length === 0 && !showAdd && (
        <div style={{ textAlign:"center", padding:"32px 20px 24px" }}>
          <div style={{ fontSize:40, marginBottom:10 }}>🍳</div>
          <div style={{ fontSize:17, fontWeight:700, marginBottom:6 }}>Add your first recipe</div>
          <div style={{ fontSize:13, color:COLORS.textSec, marginBottom:18, lineHeight:1.45 }}>
            Recipes are the building blocks — once you've added a few, the planner can build meal plans and shopping lists for you.
          </div>
          <Btn onClick={() => setShowAdd(true)} style={{ width:"100%" }}>+ Add a recipe</Btn>
        </div>
      )}
      {(() => {
        const renderCard = (r) => (
          <Card key={r.id} onClick={() => setExpandedId(expandedId===r.id?null:r.id)}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                  <span style={{ fontSize:15, fontWeight:700 }}>{r.name}</span>
                  {r.quarantine && <Badge color={COLORS.quarantine} bg={COLORS.quarantineBg}>Quarantined</Badge>}
                  {r.shelvedUntil && r.shelvedUntil > Date.now() && <Badge color={COLORS.lock} bg={COLORS.surface}>💤 Shelved</Badge>}
                </div>
                <div style={{ display:"flex", gap:4, marginTop:4, flexWrap:"wrap" }}>
                  {(r.tags||[]).map(t => <Badge key={t} color={COLORS.primary} bg={`${COLORS.primary}18`}>{t}</Badge>)}
                  {(r.mealTags||[]).map(t => <Badge key={t} color={MC[t.charAt(0).toUpperCase()+t.slice(1)]?.fg||COLORS.textSec} bg={MC[t.charAt(0).toUpperCase()+t.slice(1)]?.bg||COLORS.surface}>{t}</Badge>)}
                </div>
                <div style={{ fontSize:11, color:COLORS.textSec, marginTop:3 }}>{r.servings} servings · {r.slotsMin}–{r.slotsMax} slots · {windowedUseCount(r)}× in {FREQ_WINDOW_DAYS}d</div>
              </div>
              <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:4, flexShrink:0 }}>
                <StarRating rating={r.stars} size={14} onChange={v => updateRecipe(r.id, { stars: v })} />
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:10, color:COLORS.textSec }}>Fatigue</span>
                  <div style={{ width:40, height:4, borderRadius:2, background:COLORS.border }}>
                    <div style={{ width:`${calcFatigueRecency(r)*100}%`, height:4, borderRadius:2, background:calcFatigueRecency(r)>0.7?COLORS.primary:calcFatigueRecency(r)>0.3?COLORS.star:COLORS.red }} />
                  </div>
                </div>
              </div>
            </div>
            {expandedId === r.id && (
              <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${COLORS.border}` }} onClick={e => e.stopPropagation()}>
                <div style={{ display:"flex", gap:12, marginBottom:8, flexWrap:"wrap" }}>
                  <div>
                    <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600 }}>Slot range</div>
                    <div style={{ display:"flex", alignItems:"center", gap:4, marginTop:2 }}>
                      <NumberInput value={r.slotsMin} onCommit={v => updateRecipe(r.id, { slotsMin: v })} min={1} fallback={1} style={{ width:36, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
                      <span style={{ color:COLORS.textSec }}>–</span>
                      <NumberInput value={r.slotsMax} onCommit={v => updateRecipe(r.id, { slotsMax: Math.max(r.slotsMin, v) })} min={1} fallback={r.slotsMin} style={{ width:36, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600 }}>Servings</div>
                    <NumberInput value={r.servings} onCommit={v => updateRecipe(r.id, { servings: v })} min={1} fallback={1} style={{ width:50, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center", marginTop:2 }} />
                  </div>
                </div>
                {(r.tags || []).length > 0 && (
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:4 }}>Tags — tap to set how often this kind shows up</div>
                    <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"flex-start" }}>
                      {(r.tags || []).map(t => <TagPrefBadge key={t} tag={t} settings={settings} setSettings={setSettings} />)}
                    </div>
                  </div>
                )}
                <div style={{ marginBottom:10 }}>
                  <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:4 }}>Instructions</div>
                  <textarea value={r.instructions || ""} onChange={e => updateRecipe(r.id, { instructions: e.target.value })} placeholder="Add steps to make this meal..." rows={3} style={{ width:"100%", boxSizing:"border-box", padding:"8px 10px", borderRadius:6, border:`1px solid ${COLORS.border}`, fontSize:13, resize:"vertical", fontFamily:"inherit" }} />
                </div>
                {(() => {
                  const renderIng = (ing, idx) => {
                    const isRed = settings.redList.some(rl => normalize(rl) === normalize(ing.name));
                    return (
                      <span key={idx} style={{ fontSize:12, padding:"3px 8px", borderRadius:4, background:isRed?COLORS.quarantineBg:"#fff", border:`1px solid ${isRed?COLORS.quarantine:COLORS.border}`, color:isRed?COLORS.quarantine:COLORS.text, fontWeight:isRed?600:400 }}>
                        {isRed && "⚠ "}{ing.qty > 0 && ing.qty !== 1 ? ing.qty + " " : ""}{ing.unit ? ing.unit + " " : ""}{ing.name}
                      </span>
                    );
                  };
                  // Legacy recipes have no tier — treat those as essential.
                  const essential = r.ingredients.filter(i => (i.tier || "essential") === "essential");
                  const secondary = r.ingredients.filter(i => i.tier === "secondary");
                  return (
                    <>
                      <div style={{ fontSize:11, fontWeight:700, color:COLORS.primary, marginBottom:4 }}>Essential ({essential.length})</div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>{essential.map(renderIng)}</div>
                      {secondary.length > 0 && <>
                        <div style={{ fontSize:11, fontWeight:700, color:COLORS.textSec, marginBottom:4, marginTop:8 }}>Secondary ({secondary.length})</div>
                        <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>{secondary.map(renderIng)}</div>
                      </>}
                    </>
                  );
                })()}
                {r.quarantine && r.quarantineItems?.length > 0 && (
                  <div style={{ marginTop:8 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:COLORS.quarantine, marginBottom:4 }}>Substitutions needed</div>
                    {r.quarantineItems.filter(qi => !qi.sub).map(qi => (
                      <SubstitutionRow key={qi.ingredient} qi={qi} onResolve={(sub) => resolveQuarantine(r.id, qi.ingredient, sub)} />
                    ))}
                  </div>
                )}
                <div style={{ marginTop:8, display:"flex", gap:6, flexWrap:"wrap" }}>
                  <Btn small variant="primary" onClick={() => startEdit(r)}>✏️ Edit recipe</Btn>
                  {r.shelvedUntil && r.shelvedUntil > Date.now() && (
                    <Btn small variant="ghost" style={{ color:COLORS.lock, borderColor:COLORS.lock }} onClick={() => updateRecipe(r.id, { shelvedUntil: null })}>
                      💤 Unshelve ({Math.ceil((r.shelvedUntil - Date.now())/86400000)}d left)
                    </Btn>
                  )}
                  <Btn small variant="ghost" style={{ color:COLORS.red, borderColor:COLORS.red }} onClick={() => deleteRecipe(r.id)}>Delete recipe</Btn>
                </div>
              </div>
            )}
          </Card>
        );
        if (filtered.length === 0 && recipes.length > 0) {
          return <div style={{ textAlign:"center", padding:"24px 20px", fontSize:13, color:COLORS.textSec }}>No recipes match{search ? ` "${search}"` : ""}.</div>;
        }
        if (grouped) {
          return (
            <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
              {groupedRecipes.map(([cat, rs]) => (
                <div key={cat}>
                  <div style={{ fontSize:11, fontWeight:700, color:COLORS.primary, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>{cat} ({rs.length})</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {rs.map(renderCard)}
                  </div>
                </div>
              ))}
            </div>
          );
        }
        return <div style={{ display:"flex", flexDirection:"column", gap:8 }}>{filtered.map(renderCard)}</div>;
      })()}
      <div style={{ marginTop:16 }}>
        {!showAdd ? (
          recipes.length > 0 && <Btn onClick={() => setShowAdd(true)} style={{ width:"100%" }}>+ Add Recipe</Btn>
        ) : (
          <div ref={formRef}>
          <Card style={{ border:`2px solid ${COLORS.primary}` }}>
            <div style={{ fontSize:14, fontWeight:700, color:COLORS.primary, marginBottom:10 }}>{editId ? "Edit Recipe" : "New Recipe"}</div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              <input placeholder="Recipe name" value={addForm.name} onChange={e => setAddForm(p => ({ ...p, name: e.target.value }))} style={{ padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14 }} />
              <div>
                <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Category tags</div>
                <Combobox multi options={allTags} placeholder="Type or select..." selected={addForm.tags} onChange={v => {
                  // Conglomerate fuzzy/plural variants into canonical tags.
                  const known = allTags.filter(t => !v.includes(t));
                  const merged = [...new Set(v.map(t => canonicalizeTag(t, [...known, ...DEFAULT_TAGS])))];
                  setAddForm(p => ({ ...p, tags: merged }));
                }} />
              </div>
              <div>
                <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Meal suitability</div>
                <Combobox multi options={["breakfast","lunch","dinner"]} placeholder="breakfast, lunch, dinner..." selected={addForm.mealTags} onChange={v => setAddForm(p => ({ ...p, mealTags: v }))} />
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Servings</div>
                  <NumberInput value={addForm.servings} onCommit={v => setAddForm(p => ({ ...p, servings: v }))} min={1} fallback={1} style={{ width:"100%", padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14, boxSizing:"border-box" }} />
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Slot range</div>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <NumberInput value={addForm.slotsMin} onCommit={v => setAddForm(p => ({ ...p, slotsMin: v }))} min={1} fallback={1} style={{ width:"100%", padding:"8px 6px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14, boxSizing:"border-box", textAlign:"center" }} />
                    <span style={{ color:COLORS.textSec }}>–</span>
                    <NumberInput value={addForm.slotsMax} onCommit={v => setAddForm(p => ({ ...p, slotsMax: v }))} min={1} fallback={1} style={{ width:"100%", padding:"8px 6px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14, boxSizing:"border-box", textAlign:"center" }} />
                  </div>
                </div>
              </div>
              <div>
                <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Rating</div>
                <StarRating rating={addForm.stars} size={22} onChange={v => setAddForm(p => ({ ...p, stars: v }))} />
              </div>
              <div>
                <div style={{ fontSize:11, color:COLORS.text, marginBottom:2, fontWeight:700 }}>Essential ingredients</div>
                <div style={{ fontSize:10, color:COLORS.textSec, marginBottom:3 }}>The ones that define the dish. If someone can't have one of these, the recipe won't work for them.</div>
                <textarea placeholder={"2 cups rice\n1.5 kg chicken thigh"} value={addForm.essentialText} onChange={e => setAddForm(p => ({ ...p, essentialText: e.target.value }))} rows={4} style={{ width:"100%", boxSizing:"border-box", padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.primary}80`, fontSize:13, resize:"vertical", fontFamily:"inherit" }} />
              </div>
              <div>
                <div style={{ fontSize:11, color:COLORS.text, marginBottom:2, fontWeight:700 }}>Secondary ingredients <span style={{ color:COLORS.textSec, fontWeight:400 }}>(optional)</span></div>
                <div style={{ fontSize:10, color:COLORS.textSec, marginBottom:3 }}>Accessories that can be left out. If someone can't have one, it's just omitted and the recipe still works.</div>
                <textarea placeholder={"3 cloves garlic\n1 onion\ncilantro"} value={addForm.secondaryText} onChange={e => setAddForm(p => ({ ...p, secondaryText: e.target.value }))} rows={3} style={{ width:"100%", boxSizing:"border-box", padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13, resize:"vertical", fontFamily:"inherit" }} />
              </div>
              <div>
                <div style={{ fontSize:11, color:COLORS.text, marginBottom:2, fontWeight:700 }}>Instructions <span style={{ color:COLORS.textSec, fontWeight:400 }}>(optional)</span></div>
                <div style={{ fontSize:10, color:COLORS.textSec, marginBottom:3 }}>Steps to make it. Shown when you're cooking the meal.</div>
                <textarea placeholder={"1. Brown the chicken...\n2. Add the sauce and simmer 20 min...\n3. Serve over rice"} value={addForm.instructions} onChange={e => setAddForm(p => ({ ...p, instructions: e.target.value }))} rows={4} style={{ width:"100%", boxSizing:"border-box", padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13, resize:"vertical", fontFamily:"inherit" }} />
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <Btn style={{ flex:1 }} onClick={saveRecipe} disabled={!addForm.name.trim() || !addForm.essentialText.trim()}>{editId ? "Save Changes" : "Save Recipe"}</Btn>
                <Btn variant="ghost" onClick={closeForm}>Cancel</Btn>
              </div>
            </div>
          </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function SubstitutionRow({ qi, onResolve }) {
  const [val, setVal] = useState("");
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
      <span style={{ fontSize:12, color:COLORS.quarantine, fontWeight:600, minWidth:90 }}>{qi.ingredient}</span>
      <span style={{ fontSize:12, color:COLORS.textSec }}>→</span>
      <input value={val} onChange={e => setVal(e.target.value)} placeholder="substitute..." style={{ flex:1, padding:"5px 8px", borderRadius:5, border:`1.5px solid ${COLORS.quarantine}`, fontSize:12, outline:"none" }} />
      <Btn small variant="primary" style={{ padding:"4px 10px", fontSize:11 }} onClick={() => { onResolve(val); setVal(""); }}>✓</Btn>
    </div>
  );
}

// ============================================================
// PLAN TAB
// ============================================================
function PlanTab({ recipes, setRecipes, plan, setPlan, settings, pantry, setPantry, people, spices, setSpices, setTab }) {
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [pickerSlot, setPickerSlot] = useState(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [cookModal, setCookModal] = useState(null); // { day, meal, recipe, lines, spices, untracked }
  const [viewRecipe, setViewRecipe] = useState(null); // recipe object to show full guidance
  const [genMsg, setGenMsg] = useState("");

  // Scale factor for a recipe given the active household. With no portion
  // demand (empty/inactive roster), falls back to 1× (recipe-as-written).
  const demand = portionDemand(people);
  const scaleFor = (recipe) => {
    if (demand <= 0) return 1;
    const base = recipe.servings || 1;
    return demand / base;
  };

  // Active eater ids — drives scope-aware qualification. Null when roster is
  // empty/all-inactive, so person-scoped restrictions are ignored (no one to
  // restrict for); "all"-scoped restrictions still always apply.
  const activeIds = (() => {
    const ids = new Set((people || []).filter(p => p.active).map(p => p.id));
    return ids.size > 0 ? ids : null;
  })();

  // Build the consumption breakdown for a recipe at the current scale.
  function buildCookLines(recipe) {
    const factor = scaleFor(recipe);
    const tracked = [], spices = [], untracked = [];
    for (const ing of recipe.ingredients) {
      const cat = guessCategory(ing.name);
      if (cat === "Spices") { spices.push(ing.name); continue; }
      const need = (ing.qty || 1) * factor;
      const pItem = pantry.find(p => normalize(p.name) === normalize(ing.name));
      if (pItem) {
        const info = unitInfo(ing.unit), pInfo = unitInfo(pItem.unit);
        // Only deduct if units share a family; otherwise treat as untracked-unit.
        if (info.family === pInfo.family) {
          const deductBase = need * info.factor;
          const haveBase = pItem.qty * pInfo.factor;
          const afterBase = haveBase - deductBase;
          tracked.push({
            id: pItem.id, name: ing.name, unit: pItem.unit,
            deduct: round1(deductBase / pInfo.factor),
            have: pItem.qty,
            after: round1(Math.max(0, afterBase) / pInfo.factor),
          });
        } else {
          untracked.push({ name: ing.name, reason: "unit mismatch" });
        }
      } else {
        untracked.push({ name: ing.name, reason: "not in pantry" });
      }
    }
    return { factor, tracked, spices, untracked };
  }

  function applyCook(day, meal, recipe, lines) {
    // Decrement tracked pantry items.
    setPantry(prev => prev.map(p => {
      const line = lines.tracked.find(l => l.id === p.id);
      if (!line) return p;
      return { ...p, qty: line.after };
    }));
    // Mark slot cooked (implies locked).
    setPlan(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (next[day]?.[meal]) {
        next[day][meal].cooked = true;
        next[day][meal].cookedAt = Date.now();
        next[day][meal].locked = true;
      }
      return next;
    });
    setCookModal(null);
    setSelectedSlot(null);
  }

  function startCook(day, meal) {
    const slot = plan?.[day]?.[meal];
    if (!slot?.recipeId) return;
    const recipe = recipes.find(r => r.id === slot.recipeId);
    if (!recipe) return;
    const lines = buildCookLines(recipe);
    if (settings.autoDecrement) {
      applyCook(day, meal, recipe, lines);
    } else {
      setCookModal({ day, meal, recipe, ...lines });
    }
  }

  function uncook(day, meal) {
    // Reverse: add back the deducted quantities, clear cooked flag.
    const slot = plan?.[day]?.[meal];
    if (!slot?.recipeId) return;
    const recipe = recipes.find(r => r.id === slot.recipeId);
    if (recipe) {
      const lines = buildCookLines(recipe);
      setPantry(prev => prev.map(p => {
        const line = lines.tracked.find(l => l.id === p.id);
        if (!line) return p;
        return { ...p, qty: round1(p.qty + line.deduct) };
      }));
    }
    setPlan(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (next[day]?.[meal]) {
        delete next[day][meal].cooked;
        delete next[day][meal].cookedAt;
      }
      return next;
    });
    setSelectedSlot(null);
  }

  function doGenerate() {
    const newPlan = generatePlan(recipes, plan, settings, activeIds);
    // If generation filled nothing, tell the user why instead of failing
    // silently. Most common cause: recipes exist but none are meal-tagged.
    const filledCount = DAYS.reduce((a, d) => a + MEALS.filter(m => newPlan[d]?.[m]?.recipeId).length, 0);
    const hadCount = DAYS.reduce((a, d) => a + MEALS.filter(m => plan?.[d]?.[m]?.recipeId).length, 0);
    if (filledCount === hadCount) {
      const anyMealTagged = recipes.some(r => (r.mealTags || []).length > 0);
      setGenMsg(anyMealTagged
        ? "Couldn't fill any slots — your active restrictions may be ruling everything out, or all slots are locked."
        : "Your recipes need a meal (breakfast/lunch/dinner) tag before they can be planned. Add one in each recipe.");
      setTimeout(() => setGenMsg(""), 5000);
      return;
    }
    setPlan(newPlan);
    // Count uses by SLOTS FILLED, not per-generation. A recipe occupying
    // 5 slots logs 5 timestamps so the frequency layer reflects real load.
    const slotCounts = {};
    DAYS.forEach(d => MEALS.forEach(m => {
      const id = newPlan[d]?.[m]?.recipeId;
      if (id) slotCounts[id] = (slotCounts[id] || 0) + 1;
    }));
    const now = Date.now();
    setRecipes(prev => prev.map(r => {
      const added = slotCounts[r.id];
      if (!added) return r;
      const stamps = Array(added).fill(now);
      return {
        ...r,
        lastUsed: now,
        useCount: (r.useCount || 0) + added,
        useHistory: trimHistory([...(r.useHistory || []), ...stamps]),
      };
    }));
  }

  function doRerollUnlocked() {
    const newPlan = generatePlan(recipes, plan, settings, activeIds);
    setPlan(newPlan);
  }

  function doRerollSlot(day, meal) {
    const newPlan = rerollSlot(day, meal, recipes, plan, settings, activeIds);
    setPlan(newPlan);
  }

  function toggleLock(day, meal) {
    setPlan(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (next[day]?.[meal]) next[day][meal].locked = !next[day][meal].locked;
      return next;
    });
  }

  function removeSlot(day, meal) {
    setPlan(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      next[day][meal] = null;
      return next;
    });
    setSelectedSlot(null);
  }

  function assignRecipe(day, meal, recipe) {
    setPlan(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (!next[day]) next[day] = {};
      next[day][meal] = {
        recipeId: recipe.id, recipeName: recipe.name, locked: true,
      };
      return next;
    });
    setPickerSlot(null);
    setPickerSearch("");
  }

  function assignPlaceholder(day, meal) {
    setPlan(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      if (!next[day]) next[day] = {};
      // Placeholder: occupies the slot (so it's not flagged empty) but carries
      // no recipeId — skipped by generator, shopping list, and fatigue.
      next[day][meal] = { placeholder: true, recipeName: "No-Cook Meal", locked: true };
      return next;
    });
    setPickerSlot(null);
    setPickerSearch("");
  }

  function autofillBlanks() {
    const newPlan = generatePlan(recipes, plan, settings, activeIds);
    // Merge: keep all existing assignments, fill only nulls
    const merged = JSON.parse(JSON.stringify(plan));
    DAYS.forEach(d => MEALS.forEach(m => {
      if (!merged[d]) merged[d] = {};
      if (!merged[d][m] && newPlan[d]?.[m]) merged[d][m] = newPlan[d][m];
    }));
    setPlan(merged);
  }

  // Build chunk summary
  const chunks = {};
  DAYS.forEach(d => MEALS.forEach(m => {
    const s = plan?.[d]?.[m];
    if (!s?.recipeId) return;
    if (!chunks[s.recipeId]) {
      const r = recipes.find(x => x.id === s.recipeId);
      chunks[s.recipeId] = { name: s.recipeName, total: r?.servings || 1, used: 0, meals: {}, color: MC[m]?.fg || COLORS.textSec, score: 0, recipeId: s.recipeId };
      if (r) {
        let sc = 0;
        (r.tags||[]).forEach(t => { sc += settings.tagWeights[t] || 10; });
        chunks[s.recipeId].score = sc;
      }
    }
    chunks[s.recipeId].used++;
    chunks[s.recipeId].meals[m] = (chunks[s.recipeId].meals[m] || 0) + 1;
  }));
  const chunkList = Object.values(chunks);

  // Live slot fractions: for each recipe, number its occurrences in week
  // reading order (Mon→Sun, Breakfast→Dinner) as "i/total". Derived from the
  // actual plan every render, so manual/generated/rerolled all read honestly
  // and nothing stale is stored on the slot.
  const slotFraction = {}; // key: `${day}|${meal}` -> "i/total"
  const recipeTotals = {};
  DAYS.forEach(d => MEALS.forEach(m => {
    const s = plan?.[d]?.[m];
    if (s?.recipeId) recipeTotals[s.recipeId] = (recipeTotals[s.recipeId] || 0) + 1;
  }));
  const recipeSeen = {};
  DAYS.forEach(d => MEALS.forEach(m => {
    const s = plan?.[d]?.[m];
    if (s?.recipeId) {
      recipeSeen[s.recipeId] = (recipeSeen[s.recipeId] || 0) + 1;
      slotFraction[`${d}|${m}`] = `${recipeSeen[s.recipeId]}/${recipeTotals[s.recipeId]}`;
    }
  }));

  // Range compliance
  const tagCounts = {};
  DAYS.forEach(d => MEALS.forEach(m => {
    const s = plan?.[d]?.[m];
    if (!s?.recipeId) return;
    const r = recipes.find(x => x.id === s.recipeId);
    (r?.tags||[]).forEach(t => { tagCounts[t] = (tagCounts[t]||0) + 1; });
  }));

  const emptySlots = DAYS.reduce((a, d) => a + MEALS.filter(m => !plan?.[d]?.[m]).length, 0);
  const notifications = [];
  if (emptySlots > 0) notifications.push({ icon:"📋", text:`${emptySlots} empty slot${emptySlots>1?"s":""}`, bg:COLORS.lunchBg, color:COLORS.lunch, action:"Autofill", onAction: autofillBlanks });

  return (
    <div>
      <Notif notifications={notifications} />
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:6 }}>
        <span style={{ fontSize:14, fontWeight:700 }}>Meal Plan</span>
        {recipes.length > 0 && (
          <div style={{ display:"flex", gap:6 }}>
            <Btn small variant="secondary" onClick={doRerollUnlocked}>🎲 Reroll</Btn>
            <Btn small onClick={doGenerate}>Generate</Btn>
          </div>
        )}
      </div>
      {genMsg && (
        <div style={{ padding:"10px 12px", borderRadius:8, background:COLORS.quarantineBg, color:COLORS.quarantine, fontSize:12, fontWeight:500, marginBottom:12, lineHeight:1.4 }}>
          {genMsg}
        </div>
      )}
      {recipes.length === 0 && (
        <div style={{ textAlign:"center", padding:"28px 20px", marginBottom:12, background:COLORS.surface, borderRadius:12, border:`1px dashed ${COLORS.border}` }}>
          <div style={{ fontSize:34, marginBottom:8 }}>📋</div>
          <div style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>No recipes to plan with yet</div>
          <div style={{ fontSize:13, color:COLORS.textSec, marginBottom:16, lineHeight:1.45 }}>
            Add a few recipes first, then the planner can fill your week automatically.
          </div>
          <Btn onClick={() => setTab && setTab("Recipes")}>Go to Recipes</Btn>
        </div>
      )}
      <div style={{ overflowX:"auto", marginLeft:-4, marginRight:-4, paddingLeft:4, paddingRight:4 }}>
        <table style={{ width:"100%", borderCollapse:"separate", borderSpacing:3, minWidth:480 }}>
          <thead><tr>
            <th style={{ width:42 }}></th>
            {MEALS.map(m => <th key={m} style={{ fontSize:10, fontWeight:700, color:MC[m].fg, textAlign:"center", padding:"4px 2px" }}>{m}</th>)}
          </tr></thead>
          <tbody>
            {DAYS.map(d => (
              <tr key={d}>
                <td style={{ fontSize:12, fontWeight:700, padding:"2px 4px", verticalAlign:"middle" }}>{d}</td>
                {MEALS.map(m => {
                  const slot = plan?.[d]?.[m];
                  const isSel = selectedSlot?.day===d && selectedSlot?.meal===m;
                  return (
                    <td key={m} style={{ padding:2, verticalAlign:"top" }}>
                      {slot ? (
                        <div onClick={() => { setSelectedSlot({ day:d, meal:m }); setPickerSlot(null); }} style={{ background:slot.placeholder?COLORS.surface:(slot.cooked?COLORS.goldBg:MC[m].bg), border:`${slot.cooked?2:1.5}px ${slot.placeholder?"dashed":"solid"} ${slot.cooked?COLORS.gold:(isSel?(slot.placeholder?COLORS.textSec:MC[m].fg):(slot.placeholder?COLORS.border:`${MC[m].fg}40`))}`, borderRadius:6, padding:"4px 6px", minHeight:36, position:"relative", cursor:"pointer" }}>
                          {slot.cooked && <span style={{ position:"absolute", top:2, right:3, fontSize:10 }}>✓</span>}
                          {slot.locked && !slot.placeholder && !slot.cooked && <span style={{ position:"absolute", top:2, right:3, fontSize:9, color:COLORS.lock }}>🔒</span>}
                          {slot.placeholder ? (
                            <div style={{ fontSize:11, fontWeight:600, color:COLORS.textSec, lineHeight:1.2, display:"flex", alignItems:"center", gap:3 }}>
                              <span style={{ fontSize:10 }}>🍽️</span> {slot.recipeName}
                            </div>
                          ) : (
                            <>
                              <div style={{ fontSize:11, fontWeight:600, color:MC[m].fg, lineHeight:1.2, paddingRight:slot.locked?14:0 }}>{slot.recipeName}</div>
                              <div style={{ fontSize:9, color:COLORS.textSec, marginTop:1 }}>{slotFraction[`${d}|${m}`]}</div>
                            </>
                          )}
                        </div>
                      ) : (
                        <div onClick={() => { setPickerSlot({ day:d, meal:m }); setSelectedSlot(null); setPickerSearch(""); }} style={{ border:`1.5px dashed ${(pickerSlot?.day===d && pickerSlot?.meal===m)?MC[m].fg:COLORS.border}`, borderRadius:6, padding:"5px 6px", minHeight:36, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer" }}>
                          <span style={{ fontSize:14, color:(pickerSlot?.day===d && pickerSlot?.meal===m)?MC[m].fg:COLORS.border }}>+</span>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pickerSlot && !plan?.[pickerSlot.day]?.[pickerSlot.meal] && (() => {
        const mealKey = pickerSlot.meal.toLowerCase();
        const mealColor = MC[pickerSlot.meal];
        const now = Date.now();
        const eligible = recipes.filter(r => {
          if (r.quarantine) return false;
          if (!(r.mealTags || []).includes(mealKey)) return false;
          if (pickerSearch) {
            const q = pickerSearch.toLowerCase();
            if (!r.name.toLowerCase().includes(q) && !(r.tags||[]).some(t => t.includes(q))) return false;
          }
          return true;
        }).map(r => ({ r, qual: qualifyRecipe(r, settings.excludes, activeIds, now, settings.maxOmissions) }))
          // Qualified first, then by stars.
          .sort((a, b) => (b.qual.qualified - a.qual.qualified) || ((b.r.stars || 0) - (a.r.stars || 0)));

        return (
          <Card style={{ marginTop:10, border:`2px solid ${mealColor.fg}`, maxHeight:320, display:"flex", flexDirection:"column" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <span style={{ fontSize:13, fontWeight:700, color:mealColor.fg }}>{pickerSlot.day} {pickerSlot.meal}</span>
              <span style={{ fontSize:11, color:COLORS.textSec, cursor:"pointer" }} onClick={() => setPickerSlot(null)}>✕</span>
            </div>
            <input
              value={pickerSearch} onChange={e => setPickerSearch(e.target.value)}
              placeholder="Search recipes..." autoFocus
              style={{ padding:"7px 10px", borderRadius:6, border:`1.5px solid ${mealColor.fg}40`, fontSize:13, marginBottom:8, outline:"none" }}
            />
            <div style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:4 }}>
              <div onClick={() => assignPlaceholder(pickerSlot.day, pickerSlot.meal)} style={{
                display:"flex", alignItems:"center", gap:10, padding:"8px 10px", borderRadius:6,
                background:COLORS.surface, border:`1px dashed ${COLORS.textSec}50`, cursor:"pointer",
              }}>
                <span style={{ fontSize:14 }}>🍽️</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:COLORS.textSec }}>No-Cook Meal</div>
                  <div style={{ fontSize:10, color:COLORS.textSec }}>Eat out, leftovers, skip — no recipe, no shopping</div>
                </div>
              </div>
              {eligible.length === 0 && (
                <div style={{ padding:16, textAlign:"center", fontSize:13, color:COLORS.textSec }}>
                  No {mealKey}-tagged recipes{pickerSearch ? " matching search" : ""}
                </div>
              )}
              {eligible.map(({ r, qual }) => (
                <div key={r.id} onClick={() => assignRecipe(pickerSlot.day, pickerSlot.meal, r)} style={{
                  display:"flex", alignItems:"center", gap:10, padding:"8px 10px", borderRadius:6,
                  background:qual.qualified ? mealColor.bg : COLORS.quarantineBg,
                  border:`1px solid ${qual.qualified ? `${mealColor.fg}25` : `${COLORS.quarantine}40`}`,
                  cursor:"pointer", opacity:qual.qualified ? 1 : 0.85,
                }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:qual.qualified ? mealColor.fg : COLORS.quarantine }}>{r.name}</div>
                    <div style={{ display:"flex", gap:4, marginTop:2, flexWrap:"wrap", alignItems:"center" }}>
                      {(r.tags||[]).map(t => <Badge key={t} color={COLORS.primary} bg={`${COLORS.primary}15`} style={{ fontSize:9, padding:"1px 5px" }}>{t}</Badge>)}
                      <span style={{ fontSize:10, color:COLORS.textSec }}>{r.servings} srv</span>
                    </div>
                    {!qual.qualified && qual.blockedBy.length > 0 && (
                      <div style={{ fontSize:9, color:COLORS.quarantine, marginTop:2 }}>
                        ⚠ contains {qual.blockedBy.map(b => b.ingredient).join(", ")} (essential)
                      </div>
                    )}
                    {!qual.qualified && qual.blockedBy.length === 0 && qual.tooManyOmissions && (
                      <div style={{ fontSize:9, color:COLORS.quarantine, marginTop:2 }}>
                        ⚠ too many omissions ({qual.omitted.join(", ")})
                      </div>
                    )}
                    {qual.qualified && qual.omitted.length > 0 && (
                      <div style={{ fontSize:9, color:COLORS.boost, marginTop:2 }}>
                        omits {qual.omitted.join(", ")}
                      </div>
                    )}
                  </div>
                  <div style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"flex-end", gap:2 }}>
                    <StarRating rating={r.stars} size={11} />
                    <div style={{ width:30, height:3, borderRadius:2, background:COLORS.border }}>
                      <div style={{ width:`${calcFatigueRecency(r)*100}%`, height:3, borderRadius:2, background:calcFatigueRecency(r)>0.5?COLORS.primary:COLORS.red }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        );
      })()}

      {selectedSlot && plan?.[selectedSlot.day]?.[selectedSlot.meal] && (() => {
        const sl = plan[selectedSlot.day][selectedSlot.meal];
        const borderC = sl.placeholder ? COLORS.textSec : (sl.cooked ? COLORS.gold : MC[selectedSlot.meal].fg);
        return (
        <Card style={{ marginTop:10, border:`2px solid ${borderC}` }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <span style={{ fontSize:13, fontWeight:700 }}>
              {sl.cooked && <span style={{ color:COLORS.gold, marginRight:4 }}>✓</span>}
              {selectedSlot.day} {selectedSlot.meal}: {sl.recipeName}
            </span>
            <span style={{ fontSize:11, color:COLORS.textSec, cursor:"pointer" }} onClick={() => setSelectedSlot(null)}>✕</span>
          </div>
          {sl.cooked && (
            <div style={{ fontSize:11, color:COLORS.gold, marginBottom:8 }}>
              Cooked{sl.cookedAt ? ` ${new Date(sl.cookedAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}` : ""} · ingredients deducted from pantry
            </div>
          )}
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {sl.placeholder ? (
              <Btn small variant="ghost" style={{ color:COLORS.red, borderColor:COLORS.red }} onClick={() => removeSlot(selectedSlot.day, selectedSlot.meal)}>Remove</Btn>
            ) : sl.cooked ? (
              <>
                <Btn small variant="secondary" onClick={() => { const rec = recipes.find(r => r.id === sl.recipeId); if (rec) setViewRecipe(rec); }}>📖 View recipe</Btn>
                <Btn small variant="ghost" style={{ color:COLORS.gold, borderColor:COLORS.gold }} onClick={() => uncook(selectedSlot.day, selectedSlot.meal)}>↩ Uncook (restore pantry)</Btn>
              </>
            ) : (
              <>
                <Btn small variant="primary" style={{ background:COLORS.gold }} onClick={() => startCook(selectedSlot.day, selectedSlot.meal)}>🍳 Cook</Btn>
                <Btn small variant="secondary" onClick={() => { const rec = recipes.find(r => r.id === sl.recipeId); if (rec) setViewRecipe(rec); }}>📖 View</Btn>
                <Btn small variant={sl.locked?"primary":"ghost"} onClick={() => toggleLock(selectedSlot.day, selectedSlot.meal)} style={sl.locked?{ background:COLORS.lock }:{}}>
                  {sl.locked?"🔒 Locked":"🔓 Lock"}
                </Btn>
                <Btn small variant="secondary" onClick={() => doRerollSlot(selectedSlot.day, selectedSlot.meal)}>🎲 Reroll</Btn>
                <Btn small variant="ghost" style={{ color:COLORS.red, borderColor:COLORS.red }} onClick={() => removeSlot(selectedSlot.day, selectedSlot.meal)}>Remove</Btn>
              </>
            )}
          </div>
        </Card>
        );
      })()}

      {chunkList.length > 0 && <>
        <SectionLabel>Chunk Summary</SectionLabel>
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {chunkList.map(c => {
            const mealStr = Object.entries(c.meals).map(([m, n]) => `${n}× ${m}`).join(", ");
            return (
              <div key={c.recipeId} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0" }}>
                <div style={{ width:4, height:28, borderRadius:2, background:c.color }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:600 }}>{c.name}</div>
                  <div style={{ fontSize:11, color:COLORS.textSec }}>{mealStr}</div>
                </div>
                <Badge color={COLORS.primary} bg={`${COLORS.primary}15`}>Score {c.score}</Badge>
                <span style={{ fontSize:11, fontWeight:600, color:c.used<c.total?COLORS.red:COLORS.primary }}>{c.used}/{c.total}</span>
              </div>
            );
          })}
        </div>
      </>}

      {settings.ranges.length > 0 && <>
        <SectionLabel>Range Compliance</SectionLabel>
        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
          {settings.ranges.map(r => {
            const used = tagCounts[r.tag] || 0;
            const ok = used >= r.min && used <= r.max;
            return (
              <div key={r.tag} style={{ padding:"6px 10px", borderRadius:6, background:ok?COLORS.boostBg:COLORS.quarantineBg, fontSize:12 }}>
                <span style={{ fontWeight:600, color:ok?COLORS.boost:COLORS.quarantine }}>{r.tag}</span>
                <span style={{ color:COLORS.textSec, marginLeft:4 }}>{used}/{r.min}–{r.max}</span>
                {!ok && <span style={{ marginLeft:4 }}>{used<r.min?"↓":"↑"}</span>}
              </div>
            );
          })}
        </div>
      </>}

      {cookModal && (
        <div onClick={() => setCookModal(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:50 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:COLORS.bg, borderRadius:"16px 16px 0 0", width:"100%", maxWidth:480, maxHeight:"82vh", overflowY:"auto", padding:"18px 16px max(18px, env(safe-area-inset-bottom))", boxShadow:"0 -4px 24px rgba(0,0,0,0.2)" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
              <span style={{ fontSize:16, fontWeight:800, color:COLORS.gold }}>🍳 Cook {cookModal.recipe.name}</span>
              <span style={{ fontSize:18, color:COLORS.textSec, cursor:"pointer" }} onClick={() => setCookModal(null)}>✕</span>
            </div>
            <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:14 }}>
              {cookModal.factor === 1
                ? "Cooking at recipe scale (no active people set)."
                : `Scaled ${cookModal.factor.toFixed(2)}× for household demand.`}
              {" "}Confirm to deduct from pantry.
            </div>

            {cookModal.tracked.length > 0 && <>
              <SectionLabel>Deducting from pantry</SectionLabel>
              <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                {cookModal.tracked.map((l, i) => (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 10px", borderRadius:6, background:COLORS.surface }}>
                    <span style={{ flex:1, fontSize:13, fontWeight:600 }}>{l.name}</span>
                    <span style={{ fontSize:12, color:COLORS.red, fontWeight:600 }}>−{l.deduct} {l.unit}</span>
                    <span style={{ fontSize:11, color:COLORS.textSec }}>{l.have}→{l.after}</span>
                  </div>
                ))}
              </div>
            </>}

            {cookModal.untracked.length > 0 && <>
              <SectionLabel>Not tracked</SectionLabel>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {cookModal.untracked.map((u, i) => (
                  <span key={i} style={{ fontSize:12, padding:"4px 8px", borderRadius:5, background:"#fff", border:`1px solid ${COLORS.border}`, color:COLORS.textSec }}>
                    {u.name} <span style={{ fontSize:10 }}>({u.reason})</span>
                  </span>
                ))}
              </div>
            </>}

            {cookModal.spices.length > 0 && <>
              <SectionLabel>Spices used — tap to flag low</SectionLabel>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                {cookModal.spices.map((s, i) => {
                  const onShelf = spices.find(x => normalize(x.name) === normalize(s));
                  const isLow = onShelf?.low;
                  return (
                    <span key={i} onClick={() => {
                      setSpices(prev => {
                        const existing = prev.find(x => normalize(x.name) === normalize(s));
                        if (existing) return prev.map(x => x.id === existing.id ? { ...x, low: !x.low } : x);
                        // Not on shelf yet — add it, flagged low.
                        return [...prev, { id: uid(), name: normalize(s), low: true }];
                      });
                    }} style={{ fontSize:12, padding:"4px 8px", borderRadius:5, cursor:"pointer", background:isLow?COLORS.quarantineBg:COLORS.surface, border:`1px solid ${isLow?COLORS.red:COLORS.border}`, color:isLow?COLORS.red:COLORS.text, fontWeight:isLow?600:400 }}>
                      {isLow ? "🔻 " : ""}{s}{!onShelf ? " +" : ""}
                    </span>
                  );
                })}
              </div>
              <div style={{ fontSize:10, color:COLORS.textSec, marginTop:4 }}>Flagged spices appear on your shopping list. "+" adds a new spice to your shelf.</div>
            </>}

            <div style={{ display:"flex", gap:8, marginTop:18 }}>
              <Btn style={{ flex:1, background:COLORS.gold }} onClick={() => applyCook(cookModal.day, cookModal.meal, cookModal.recipe, cookModal)}>Confirm & Cook</Btn>
              <Btn variant="ghost" onClick={() => setCookModal(null)}>Cancel</Btn>
            </div>
            <div style={{ textAlign:"center", marginTop:8 }}>
              <span onClick={() => { setViewRecipe(cookModal.recipe); }} style={{ fontSize:12, color:COLORS.primary, cursor:"pointer", textDecoration:"underline" }}>📖 View full recipe & instructions</span>
            </div>
          </div>
        </div>
      )}

      {viewRecipe && (() => {
        const factor = scaleFor(viewRecipe);
        const scaled = (q) => factor === 1 ? q : round1((q || 1) * factor);
        const essential = viewRecipe.ingredients.filter(i => (i.tier || "essential") === "essential");
        const secondary = viewRecipe.ingredients.filter(i => i.tier === "secondary");
        const renderLine = (ing, i) => (
          <div key={i} style={{ display:"flex", gap:8, padding:"5px 0", borderBottom:`1px solid ${COLORS.border}40` }}>
            <span style={{ fontSize:13, color:COLORS.textSec, minWidth:64, flexShrink:0 }}>
              {ing.qty > 0 ? scaled(ing.qty) : ""}{ing.unit ? " " + ing.unit : ""}
            </span>
            <span style={{ fontSize:13, flex:1 }}>{ing.name}</span>
          </div>
        );
        return (
          <div onClick={() => setViewRecipe(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.45)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:55 }}>
            <div onClick={e => e.stopPropagation()} style={{ background:COLORS.bg, borderRadius:"16px 16px 0 0", width:"100%", maxWidth:480, maxHeight:"88vh", overflowY:"auto", padding:"18px 16px max(18px, env(safe-area-inset-bottom))", boxShadow:"0 -4px 24px rgba(0,0,0,0.2)" }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:18, fontWeight:800 }}>{viewRecipe.name}</div>
                  <div style={{ display:"flex", gap:5, marginTop:4, flexWrap:"wrap", alignItems:"center" }}>
                    <StarRating rating={viewRecipe.stars} size={13} />
                    {(viewRecipe.tags || []).map(t => <Badge key={t} color={COLORS.primary} bg={`${COLORS.primary}18`}>{t}</Badge>)}
                  </div>
                </div>
                <span style={{ fontSize:20, color:COLORS.textSec, cursor:"pointer", marginLeft:8 }} onClick={() => setViewRecipe(null)}>✕</span>
              </div>
              <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:14 }}>
                {factor === 1
                  ? `Makes ${viewRecipe.servings} serving${viewRecipe.servings>1?"s":""} (recipe scale)`
                  : `Scaled ${factor.toFixed(2)}× for your household`}
              </div>

              <SectionLabel>Ingredients</SectionLabel>
              <div style={{ marginBottom:8 }}>
                {essential.map(renderLine)}
                {secondary.length > 0 && <>
                  <div style={{ fontSize:10, fontWeight:700, color:COLORS.textSec, textTransform:"uppercase", letterSpacing:0.6, marginTop:8, marginBottom:2 }}>Optional</div>
                  {secondary.map(renderLine)}
                </>}
              </div>

              <SectionLabel>Instructions</SectionLabel>
              {viewRecipe.instructions ? (
                <div style={{ fontSize:14, lineHeight:1.6, whiteSpace:"pre-wrap" }}>{viewRecipe.instructions}</div>
              ) : (
                <div style={{ fontSize:13, color:COLORS.textSec, fontStyle:"italic" }}>No instructions added for this recipe. You can add them by editing the recipe in the Recipes tab.</div>
              )}

              <Btn style={{ width:"100%", marginTop:18 }} variant="secondary" onClick={() => setViewRecipe(null)}>Close</Btn>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// Spice chip in the cook modal — taps toggle a "flag low" visual hint.
// (Wiring spice flags into the shopping list comes with the spice shelf, D.)

// ============================================================
// SHOP TAB
// ============================================================
function ShopTab({ plan, recipes, pantry, setPantry, spices, setSpices, settings, people, setTab }) {
  // Active eater ids for scope-aware omission (M). Null when roster empty/all
  // inactive, so person-scoped restrictions don't omit anything.
  const activeIds = (() => {
    const ids = new Set((people || []).filter(p => p.active).map(p => p.id));
    return ids.size > 0 ? ids : null;
  })();
  const excludes = settings?.excludes || [];
  const maxOmissions = settings?.maxOmissions ?? Infinity;
  const [shopItems, setShopItems] = useState([]);
  const [groupBy, setGroupBy] = useState("category");
  const [manualName, setManualName] = useState("");
  const [manualQty, setManualQty] = useState("");
  const [generated, setGenerated] = useState(false);
  const [stockedMsg, setStockedMsg] = useState("");

  function doGenerate() {
    // Preserve any manual items the user added, re-merge with fresh plan+floor.
    const manual = shopItems.filter(i => i.source === "manual");
    const unified = buildUnifiedList(plan, recipes, pantry, excludes, activeIds, maxOmissions);
    // Merge manual items in, deduped by name+family against the unified list.
    const byKey = {};
    const keyOf = (name, unit) => `${normalize(name)}|${unitInfo(unit).family}`;
    [...unified, ...manual].forEach(it => {
      const k = keyOf(it.name, it.unit);
      if (!byKey[k]) byKey[k] = { ...it };
      else {
        // keep existing; note manual source if applicable
        if (it.source === "manual" && byKey[k].source !== "manual") {
          byKey[k].sources = [...(byKey[k].sources || [byKey[k].source]), "manual"];
        }
      }
    });
    setShopItems(Object.values(byKey).map((x, i) => ({ ...x, id: x.id || ("s" + i), checked: x.checked || false })));
    setGenerated(true);
  }

  function toggle(id) { setShopItems(p => p.map(x => x.id === id ? { ...x, checked: !x.checked } : x)); }
  function addManual() {
    if (!manualName.trim()) return;
    // Dedup: if this ingredient is already on the list (same name+family), don't double-add.
    const keyOf = (name, unit) => `${normalize(name)}|${unitInfo(unit).family}`;
    const newKey = keyOf(manualName, "");
    const exists = shopItems.find(i => keyOf(i.name, i.unit) === newKey);
    if (exists) {
      setManualName(""); setManualQty("");
      setStockedMsg(`${normalize(manualName)} is already on your list`);
      setTimeout(() => setStockedMsg(""), 2500);
      return;
    }
    setShopItems(p => [...p, { id: "m" + uid(), name: manualName.trim(), qty: manualQty || "1", unit: "", category: guessCategory(manualName), store: "", checked: false, source: "manual" }]);
    setManualName(""); setManualQty("");
  }

  // Flow all checked items into pantry inventory. Existing items get their
  // quantity increased (unit-aware: convert into the pantry item's unit when
  // families match; otherwise leave the pantry qty and just note it). New
  // items are created. Checked items are then removed from the list.
  function stockChecked() {
    const checked = shopItems.filter(i => i.checked);
    if (checked.length === 0) return;

    setPantry(prev => {
      const next = prev.map(p => ({ ...p }));
      for (const item of checked) {
        const qtyNum = parseFloat(item.qty) || 0;
        const existing = next.find(p => normalize(p.name) === normalize(item.name));
        if (existing) {
          const iInfo = unitInfo(item.unit);
          const pInfo = unitInfo(existing.unit);
          if (item.unit && existing.unit && iInfo.family === pInfo.family) {
            // add converted into pantry's unit
            const addBase = qtyNum * iInfo.factor;
            existing.qty = round1(existing.qty + addBase / pInfo.factor);
          } else if (!item.unit || !existing.unit || item.unit === existing.unit) {
            existing.qty = round1(existing.qty + qtyNum);
          } else {
            // unit families differ and both set — can't safely combine; bump by raw count
            existing.qty = round1(existing.qty + qtyNum);
          }
        } else {
          next.push({
            id: uid(), name: normalize(item.name),
            qty: qtyNum || 1, unit: item.unit || "pcs", floor: 0,
            storage: "dry", store: item.store || "",
          });
        }
      }
      return next;
    });

    // Remove stocked items from the list.
    setShopItems(p => p.filter(i => !i.checked));
    setStockedMsg(`${checked.length} item${checked.length>1?"s":""} added to pantry`);
    setTimeout(() => setStockedMsg(""), 3000);
  }

  const groupKey = groupBy === "store" ? "store" : "category";
  const groups = [...new Set(shopItems.map(i => i[groupKey] || "Other"))].sort();
  const totalChecked = shopItems.filter(i => i.checked).length;
  const totalItems = shopItems.length;

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
        <span style={{ fontSize:14, fontWeight:700 }}>Shopping List</span>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {generated && <span style={{ fontSize:12, color:COLORS.textSec }}>{totalChecked}/{totalItems}</span>}
          <Btn small onClick={doGenerate}>{generated ? "Refresh" : "Generate"}</Btn>
        </div>
      </div>

      {stockedMsg && (
        <div style={{ padding:"8px 12px", borderRadius:8, background:COLORS.boostBg, color:COLORS.boost, fontSize:12, fontWeight:600, marginBottom:10 }}>
          ✓ {stockedMsg}
        </div>
      )}

      {generated && totalChecked > 0 && (
        <div style={{ marginBottom:10 }}>
          <Btn small onClick={stockChecked} style={{ width:"100%" }}>
            ✓ Add {totalChecked} checked item{totalChecked>1?"s":""} to pantry
          </Btn>
        </div>
      )}

      {!generated ? (() => {
        const hasRecipes = recipes.length > 0;
        const planHasMeals = DAYS.some(d => MEALS.some(m => plan?.[d]?.[m]?.recipeId));
        if (!hasRecipes) {
          return (
            <Card style={{ marginTop:12, textAlign:"center", padding:24 }}>
              <div style={{ fontSize:34, marginBottom:8 }}>🛒</div>
              <div style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Nothing to shop for yet</div>
              <div style={{ fontSize:13, color:COLORS.textSec, marginBottom:16, lineHeight:1.45 }}>Add a few recipes, then plan your week — your shopping list builds itself from there.</div>
              <Btn onClick={() => setTab && setTab("Recipes")}>Go to Recipes</Btn>
            </Card>
          );
        }
        if (!planHasMeals) {
          return (
            <Card style={{ marginTop:12, textAlign:"center", padding:24 }}>
              <div style={{ fontSize:34, marginBottom:8 }}>📋</div>
              <div style={{ fontSize:16, fontWeight:700, marginBottom:6 }}>Plan your week first</div>
              <div style={{ fontSize:13, color:COLORS.textSec, marginBottom:16, lineHeight:1.45 }}>Once your meal plan has some meals in it, generate the shopping list to see everything you need.</div>
              <Btn onClick={() => setTab && setTab("Plan")}>Go to Meal Plan</Btn>
            </Card>
          );
        }
        return (
          <Card style={{ marginTop:12, textAlign:"center", padding:24 }}>
            <div style={{ fontSize:13, color:COLORS.textSec, marginBottom:8 }}>Your plan is ready — build the shopping list from it.</div>
            <Btn onClick={doGenerate}>Generate shopping list</Btn>
          </Card>
        );
      })() : (
        <>
          <div style={{ display:"flex", gap:6, marginBottom:10 }}>
            <Btn small variant={groupBy==="category"?"primary":"ghost"} onClick={() => setGroupBy("category")}>By category</Btn>
            <Btn small variant={groupBy==="store"?"primary":"ghost"} onClick={() => setGroupBy("store")}>By store</Btn>
          </div>

          {shopItems.length > 0 && <>
            <SectionLabel>Shopping List</SectionLabel>
            {groups.map(g => (
              <div key={g} style={{ marginBottom:10 }}>
                <div style={{ fontSize:11, fontWeight:700, color:COLORS.primary, marginBottom:4, textTransform:"uppercase", letterSpacing:0.8 }}>{g || "Other"}</div>
                {shopItems.filter(i => (i[groupKey]||"Other") === g).map(item => {
                  const srcs = item.sources || [item.source];
                  const isFloor = srcs.includes("floor");
                  return (
                    <div key={item.id} onClick={() => toggle(item.id)} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px", borderRadius:6, background:item.checked?`${COLORS.primary}08`:"transparent", cursor:"pointer", marginBottom:2 }}>
                      <div style={{ width:20, height:20, borderRadius:4, border:`2px solid ${item.checked?COLORS.primary:(isFloor?COLORS.red:COLORS.border)}`, background:item.checked?COLORS.primary:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                        {item.checked && <span style={{ color:"#fff", fontSize:12, fontWeight:700 }}>✓</span>}
                      </div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <span style={{ fontSize:14, color:item.checked?COLORS.textSec:COLORS.text, textDecoration:item.checked?"line-through":"none" }}>{item.name}</span>
                        {item.reason && <div style={{ fontSize:9, color:COLORS.red }}>{item.reason}</div>}
                      </div>
                      <div style={{ textAlign:"right", flexShrink:0 }}>
                        <div style={{ fontSize:12, color:COLORS.textSec }}>{item.qty}{item.unit ? " " + item.unit : ""}</div>
                        {groupBy==="category" && item.store && <div style={{ fontSize:9, color:COLORS.textSec }}>{item.store}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </>}

          {spices.filter(s => s.low).length > 0 && <>
            <SectionLabel>Spices Running Low</SectionLabel>
            <div style={{ background:COLORS.surface, borderRadius:8, padding:"4px 0" }}>
              {spices.filter(s => s.low).map(s => (
                <div key={s.id} onClick={() => setSpices(prev => prev.map(x => x.id === s.id ? { ...x, low: false } : x))} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px", cursor:"pointer" }}>
                  <div style={{ width:20, height:20, borderRadius:4, border:`2px solid ${COLORS.red}`, background:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }} />
                  <span style={{ flex:1, fontSize:14 }}>🧂 {s.name}</span>
                  <span style={{ fontSize:10, color:COLORS.textSec }}>tap when restocked</span>
                </div>
              ))}
            </div>
          </>}

          <SectionLabel>Add manually</SectionLabel>
          <div style={{ display:"flex", gap:6 }}>
            <input placeholder="Item name..." value={manualName} onChange={e => setManualName(e.target.value)} style={{ flex:1, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
            <input placeholder="Qty" value={manualQty} onChange={e => setManualQty(e.target.value)} style={{ width:50, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
            <Btn small onClick={addManual}>+</Btn>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// PANTRY TAB
// ============================================================
function PantryTab({ pantry, setPantry, spices, setSpices }) {
  const [storageFilter, setStorageFilter] = useState("all");
  const [editId, setEditId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name:"", qty:1, unit:"pcs", floor:0, storage:"dry", store:"" });
  const [spicesOpen, setSpicesOpen] = useState(false);
  const [newSpice, setNewSpice] = useState("");
  const [dragSpice, setDragSpice] = useState(null);  // id being dragged
  const [overSpice, setOverSpice] = useState(null);   // id currently hovered over

  // Move the dragged spice to the position of the target spice.
  function moveSpice(draggedId, targetId) {
    if (!draggedId || draggedId === targetId) return;
    setSpices(prev => {
      const arr = [...prev];
      const from = arr.findIndex(s => s.id === draggedId);
      const to = arr.findIndex(s => s.id === targetId);
      if (from < 0 || to < 0) return prev;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return arr;
    });
  }

  // Touch reorder: hit-test the chip under the finger via elementFromPoint.
  function spiceTouchMove(e) {
    if (!dragSpice) return;
    const t = e.touches[0];
    if (!t) return;
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const chip = el && el.closest("[data-spice-id]");
    if (chip) {
      const id = chip.getAttribute("data-spice-id");
      if (id && id !== overSpice) setOverSpice(id);
    }
  }
  function spiceDrop() {
    if (dragSpice && overSpice) moveSpice(dragSpice, overSpice);
    setDragSpice(null);
    setOverSpice(null);
  }

  const allStores = useMemo(() => [...new Set([...DEFAULT_STORES, ...pantry.map(p => p.store).filter(Boolean)])].sort(), [pantry]);

  const filtered = pantry.filter(p => storageFilter === "all" || p.storage === storageFilter)
    .sort((a, b) => {
      const aB = a.floor > 0 && a.qty <= a.floor ? 0 : 1;
      const bB = b.floor > 0 && b.qty <= b.floor ? 0 : 1;
      return aB - bB;
    });

  const counts = { dry:0, cold:0, frozen:0 };
  pantry.forEach(p => counts[p.storage] = (counts[p.storage]||0) + 1);

  function updateItem(id, updates) { setPantry(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p)); }
  function deleteItem(id) { setPantry(prev => prev.filter(p => p.id !== id)); setEditId(null); }
  function addItem() {
    if (!addForm.name.trim()) return;
    setPantry(prev => [...prev, { ...addForm, id: uid(), name: normalize(addForm.name) }]);
    setAddForm({ name:"", qty:1, unit:"pcs", floor:0, storage:"dry", store:"" });
    setShowAdd(false);
  }

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
        <span style={{ fontSize:14, fontWeight:700 }}>Pantry ({pantry.length})</span>
        <Btn small onClick={() => setShowAdd(!showAdd)}>+ Add</Btn>
      </div>
      {pantry.length > 0 ? (
        <>
          <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>
            {pantry.filter(p => p.floor > 0 && p.qty <= p.floor).length} at or below floor
          </div>
          <div style={{ display:"flex", gap:4, marginBottom:12, flexWrap:"wrap" }}>
            <Btn small variant={storageFilter==="all"?"primary":"ghost"} onClick={() => setStorageFilter("all")}>All</Btn>
            {Object.entries(SC).map(([key, sc]) => (
              <Btn key={key} small variant={storageFilter===key?"primary":"ghost"} onClick={() => setStorageFilter(key)} style={storageFilter===key?{ background:sc.fg }:{ color:sc.fg, borderColor:sc.fg }}>{sc.label} ({counts[key]||0})</Btn>
            ))}
          </div>
        </>
      ) : !showAdd && (
        <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:12, lineHeight:1.45 }}>
          Track what's on hand so it's subtracted from your shopping list. Optional — add items as you go, or let your shopping flow in here when you check things off.
        </div>
      )}
      {showAdd && (
        <Card style={{ border:`2px solid ${COLORS.primary}`, marginBottom:12 }}>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <input placeholder="Item name" value={addForm.name} onChange={e => setAddForm(p => ({ ...p, name: e.target.value }))} style={{ padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14 }} />
            <div style={{ display:"flex", gap:8 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:2 }}>Qty</div>
                <NumberInput value={addForm.qty} onCommit={v => setAddForm(p => ({ ...p, qty: v }))} min={0} fallback={0} style={{ width:"100%", padding:"6px 8px", borderRadius:5, border:`1px solid ${COLORS.border}`, fontSize:13, boxSizing:"border-box" }} />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:2 }}>Unit</div>
                <Combobox options={UNITS.filter(Boolean)} value={addForm.unit} onChange={v => setAddForm(p => ({ ...p, unit: v }))} placeholder="unit" />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:2 }}>Floor</div>
                <NumberInput value={addForm.floor} onCommit={v => setAddForm(p => ({ ...p, floor: v }))} min={0} fallback={0} style={{ width:"100%", padding:"6px 8px", borderRadius:5, border:`1px solid ${COLORS.border}`, fontSize:13, boxSizing:"border-box" }} />
              </div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:2 }}>Storage</div>
                <div style={{ display:"flex", gap:4 }}>
                  {Object.entries(SC).map(([k, sc]) => (
                    <Btn key={k} small variant={addForm.storage===k?"primary":"ghost"} onClick={() => setAddForm(p => ({ ...p, storage: k }))} style={addForm.storage===k?{ background:sc.fg, fontSize:11, padding:"4px 8px" }:{ fontSize:11, padding:"4px 8px", color:sc.fg, borderColor:sc.fg }}>{sc.label}</Btn>
                  ))}
                </div>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:2 }}>Store</div>
                <Combobox options={allStores} value={addForm.store} onChange={v => setAddForm(p => ({ ...p, store: v }))} placeholder="store..." />
              </div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <Btn style={{ flex:1 }} onClick={addItem}>Save</Btn>
              <Btn variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Btn>
            </div>
          </div>
        </Card>
      )}

      <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
        {filtered.map(item => {
          const below = item.floor > 0 && item.qty <= item.floor;
          const sc = SC[item.storage] || SC.dry;
          const isEdit = editId === item.id;
          return (
            <div key={item.id}>
              <div onClick={() => setEditId(isEdit?null:item.id)} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", borderRadius:isEdit?"8px 8px 0 0":8, background:below?COLORS.quarantineBg:COLORS.surface, border:`1px solid ${below?`${COLORS.quarantine}30`:COLORS.border}`, borderBottom:isEdit?"none":undefined, cursor:"pointer" }}>
                <div style={{ width:4, height:32, borderRadius:2, background:sc.fg, flexShrink:0 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, fontWeight:600 }}>{item.name}</div>
                  <div style={{ display:"flex", gap:6, alignItems:"center", marginTop:2 }}>
                    <Badge color={sc.fg} bg={sc.bg}>{sc.label}</Badge>
                    {item.store && <span style={{ fontSize:10, color:COLORS.textSec }}>{item.store}</span>}
                    <span style={{ fontSize:10, color:below?COLORS.quarantine:COLORS.textSec }}>Floor: {item.floor} {item.unit}</span>
                  </div>
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  <div style={{ fontSize:16, fontWeight:700, color:below?COLORS.quarantine:COLORS.text }}>{item.qty}</div>
                  <div style={{ fontSize:10, color:COLORS.textSec }}>{item.unit}</div>
                </div>
                {below && <span style={{ fontSize:12 }}>⚠️</span>}
              </div>
              {isEdit && (
                <div style={{ padding:"10px 12px", background:below?COLORS.quarantineBg:COLORS.surface, border:`1px solid ${below?`${COLORS.quarantine}30`:COLORS.border}`, borderTop:`1px dashed ${COLORS.border}`, borderRadius:"0 0 8px 8px", display:"flex", gap:10, alignItems:"flex-end", flexWrap:"wrap" }} onClick={e => e.stopPropagation()}>
                  <div>
                    <div style={{ fontSize:10, fontWeight:600, color:COLORS.textSec, marginBottom:2 }}>Qty</div>
                    <NumberInput value={item.qty} onCommit={v => updateItem(item.id, { qty: v })} min={0} fallback={0} style={{ width:56, padding:"5px 6px", borderRadius:5, border:`1.5px solid ${COLORS.border}`, fontSize:14, textAlign:"center", fontWeight:600 }} />
                  </div>
                  <div>
                    <div style={{ fontSize:10, fontWeight:600, color:COLORS.textSec, marginBottom:2 }}>Floor</div>
                    <NumberInput value={item.floor} onCommit={v => updateItem(item.id, { floor: v })} min={0} fallback={0} style={{ width:56, padding:"5px 6px", borderRadius:5, border:`1.5px solid ${below?COLORS.quarantine:COLORS.border}`, fontSize:14, textAlign:"center", fontWeight:600 }} />
                  </div>
                  <div>
                    <div style={{ fontSize:10, fontWeight:600, color:COLORS.textSec, marginBottom:2 }}>Store</div>
                    <Combobox options={allStores} value={item.store} onChange={v => updateItem(item.id, { store: v })} placeholder="store" />
                  </div>
                  <Btn small variant="ghost" style={{ color:COLORS.red, borderColor:COLORS.red }} onClick={() => deleteItem(item.id)}>Delete</Btn>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Spice shelf — binary stocked/low, collapsed by default */}
      <div style={{ marginTop:18 }}>
        <div onClick={() => setSpicesOpen(o => !o)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 12px", borderRadius:8, background:COLORS.surface, border:`1px solid ${COLORS.border}`, cursor:"pointer" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:14 }}>🧂</span>
            <span style={{ fontSize:14, fontWeight:700 }}>Spice Shelf</span>
            <span style={{ fontSize:11, color:COLORS.textSec }}>({spices.length})</span>
            {spices.filter(s => s.low).length > 0 && (
              <Badge color={COLORS.red} bg={COLORS.quarantineBg}>{spices.filter(s => s.low).length} low</Badge>
            )}
          </div>
          <span style={{ fontSize:12, color:COLORS.textSec }}>{spicesOpen ? "▲" : "▼"}</span>
        </div>

        {spicesOpen && (
          <div style={{ marginTop:8 }}>
            <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:8 }}>
              No quantities — just tap a spice when it's running low to add it to the shopping list.
            </div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:10 }}
              onTouchMove={spiceTouchMove} onTouchEnd={spiceDrop}>
              {spices.map(s => {
                const isOver = overSpice === s.id && dragSpice && dragSpice !== s.id;
                const isDragging = dragSpice === s.id;
                return (
                  <span
                    key={s.id}
                    data-spice-id={s.id}
                    draggable
                    onDragStart={() => setDragSpice(s.id)}
                    onDragEnter={() => dragSpice && setOverSpice(s.id)}
                    onDragEnd={spiceDrop}
                    onDragOver={e => e.preventDefault()}
                    onClick={() => { if (!dragSpice) setSpices(prev => prev.map(x => x.id === s.id ? { ...x, low: !x.low } : x)); }}
                    style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:13, padding:"6px 8px 6px 6px", borderRadius:6, cursor:"pointer",
                      background:s.low?COLORS.quarantineBg:"#fff",
                      border:`1.5px solid ${isOver?COLORS.primary:(s.low?COLORS.red:COLORS.border)}`,
                      color:s.low?COLORS.red:COLORS.text, fontWeight:s.low?600:400,
                      opacity:isDragging?0.4:1,
                      boxShadow:isOver?`0 0 0 2px ${COLORS.primary}40`:"none",
                      transition:"opacity 0.1s, box-shadow 0.1s" }}
                  >
                    <span
                      onPointerDown={() => setDragSpice(s.id)}
                      onClick={e => e.stopPropagation()}
                      style={{ cursor:"grab", color:COLORS.textSec, fontSize:13, lineHeight:1, touchAction:"none", padding:"0 2px", userSelect:"none" }}
                      title="Drag to reorder"
                    >⠿</span>
                    {s.low && "🔻"}{s.name}
                    <span onClick={e => { e.stopPropagation(); setSpices(prev => prev.filter(x => x.id !== s.id)); }} style={{ fontSize:14, color:COLORS.textSec, marginLeft:2 }}>×</span>
                  </span>
                );
              })}
              {spices.length === 0 && <span style={{ fontSize:12, color:COLORS.textSec }}>No spices yet — add some below.</span>}
            </div>
            <div style={{ display:"flex", gap:6 }}>
              <input value={newSpice} onChange={e => setNewSpice(e.target.value)} placeholder="Add spice (cumin, paprika…)" onKeyDown={e => { if (e.key === "Enter" && newSpice.trim()) { setSpices(prev => [...prev, { id: uid(), name: normalize(newSpice), low: false }]); setNewSpice(""); } }} style={{ flex:1, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
              <Btn small onClick={() => { if (newSpice.trim()) { setSpices(prev => [...prev, { id: uid(), name: normalize(newSpice), low: false }]); setNewSpice(""); } }}>Add</Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// SETTINGS TAB
// ============================================================
function SettingsTab({ settings, setSettings, people, setPeople }) {
  const [section, setSection] = useState("people");
  const update = (key, val) => setSettings(prev => ({ ...prev, [key]: val }));

  return (
    <div>
      <div style={{ display:"flex", gap:4, marginBottom:14, flexWrap:"wrap" }}>
        {[["people","People"],["preferences","Preferences"],["ranges","Ranges"],["redlist","Red List"],["excludes","Excludes"],["boosts","Boosts"],["cooking","Cooking"],["data","Data"]].map(([k, l]) => (
          <Btn key={k} small variant={section===k?"primary":"ghost"} onClick={() => setSection(k)}>{l}</Btn>
        ))}
      </div>

      {section === "people" && <PeopleSection people={people} setPeople={setPeople} />}
      {section === "preferences" && <CalibrationSection settings={settings} update={update} />}
      {section === "ranges" && <RangesSection ranges={settings.ranges} onChange={v => update("ranges", v)} tagWeights={settings.tagWeights} />}
      {section === "redlist" && <RedListSection redList={settings.redList} onChange={v => update("redList", v)} />}
      {section === "excludes" && <ExcludesSection excludes={settings.excludes} onChange={v => update("excludes", v)} people={people} />}
      {section === "boosts" && <BoostsSection boosts={settings.boosts} onChange={v => update("boosts", v)} />}
      {section === "cooking" && <CookingSection settings={settings} update={update} />}
      {section === "data" && <DataSection />}
    </div>
  );
}

function PeopleSection({ people, setPeople }) {
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("man");

  function addPerson() {
    if (!name.trim()) return;
    const pt = PROFILE_TYPES.find(p => p.key === profile) || PROFILE_TYPES[0];
    setPeople(prev => [...prev, {
      id: uid(), name: name.trim(), profile: pt.key,
      weight: pt.weight, attendance: 1.0, active: true,
    }]);
    setName("");
  }
  function updatePerson(id, patch) { setPeople(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p)); }
  function removePerson(id) { setPeople(prev => prev.filter(p => p.id !== id)); }

  const demand = portionDemand(people);

  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>
        Who you're cooking for. Recipes scale to total portion demand. With no active people, recipes fall back to their own serving count.
      </div>

      {people.length > 0 && (
        <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom:12 }}>
          {people.map(p => {
            const pt = PROFILE_TYPES.find(x => x.key === p.profile);
            const att = ATTENDANCE.reduce((best, a) => Math.abs(a.factor - p.attendance) < Math.abs(best.factor - p.attendance) ? a : best, ATTENDANCE[0]);
            return (
              <Card key={p.id} style={{ opacity: p.active ? 1 : 0.55, padding:"10px 12px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                  <div onClick={() => updatePerson(p.id, { active: !p.active })} style={{ width:22, height:22, borderRadius:5, border:`2px solid ${p.active?COLORS.primary:COLORS.border}`, background:p.active?COLORS.primary:"transparent", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", flexShrink:0 }}>
                    {p.active && <span style={{ color:"#fff", fontSize:13, fontWeight:700 }}>✓</span>}
                  </div>
                  <span style={{ fontSize:14, fontWeight:700, flex:1 }}>{p.name}</span>
                  <span style={{ fontSize:11, color:COLORS.textSec }}>{(p.weight * p.attendance).toFixed(2)} portion</span>
                  <span style={{ fontSize:14, cursor:"pointer", color:COLORS.red }} onClick={() => removePerson(p.id)}>×</span>
                </div>
                <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
                  <select value={p.profile} onChange={e => { const npt = PROFILE_TYPES.find(x => x.key === e.target.value); updatePerson(p.id, { profile: npt.key, weight: npt.weight }); }} style={{ fontSize:12, padding:"4px 6px", borderRadius:5, border:`1px solid ${COLORS.border}`, background:"#fff" }}>
                    {PROFILE_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                  <NumberInput value={p.weight} onCommit={v => updatePerson(p.id, { weight: v })} min={0} step="0.05" fallback={0} style={{ width:54, fontSize:12, padding:"4px 6px", borderRadius:5, border:`1px solid ${COLORS.border}`, textAlign:"center" }} title="portion weight" />
                  <select value={att.key} onChange={e => { const na = ATTENDANCE.find(x => x.key === e.target.value); updatePerson(p.id, { attendance: na.factor }); }} style={{ fontSize:12, padding:"4px 6px", borderRadius:5, border:`1px solid ${COLORS.border}`, background:"#fff" }}>
                    {ATTENDANCE.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}
                  </select>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <div style={{ padding:"10px 12px", borderRadius:8, background:COLORS.boostBg, marginBottom:12, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span style={{ fontSize:12, fontWeight:600, color:COLORS.boost }}>Total portion demand</span>
        <span style={{ fontSize:16, fontWeight:800, color:COLORS.boost }}>{demand > 0 ? demand.toFixed(2) : "—"}</span>
      </div>

      <div style={{ display:"flex", gap:6 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name..." style={{ flex:1, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
        <select value={profile} onChange={e => setProfile(e.target.value)} style={{ fontSize:13, padding:"4px 8px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, background:"#fff" }}>
          {PROFILE_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <Btn small onClick={addPerson}>Add</Btn>
      </div>
    </div>
  );
}

function CookingSection({ settings, update }) {
  const auto = !!settings.autoDecrement;
  const maxOm = settings.maxOmissions ?? 2;
  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>Cooking behavior</div>
      <Card style={{ padding:"12px 14px", marginBottom:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div onClick={() => update("autoDecrement", !auto)} style={{ width:44, height:26, borderRadius:13, background:auto?COLORS.primary:COLORS.border, position:"relative", cursor:"pointer", flexShrink:0, transition:"background 0.15s" }}>
            <div style={{ width:20, height:20, borderRadius:10, background:"#fff", position:"absolute", top:3, left:auto?21:3, transition:"left 0.15s", boxShadow:"0 1px 3px rgba(0,0,0,0.2)" }} />
          </div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:600 }}>Auto-decrement on cook</div>
            <div style={{ fontSize:11, color:COLORS.textSec }}>{auto ? "Marking cooked deducts ingredients immediately" : "Marking cooked shows a confirm screen first"}</div>
          </div>
        </div>
      </Card>
      <Card style={{ padding:"12px 14px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:14, fontWeight:600 }}>Max secondary omissions</div>
            <div style={{ fontSize:11, color:COLORS.textSec }}>A recipe needing more than this many accessory ingredients dropped (to satisfy restrictions) is disqualified.</div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
            <button onClick={() => update("maxOmissions", Math.max(0, maxOm - 1))} style={{ width:26, height:26, borderRadius:5, border:`1px solid ${COLORS.border}`, background:COLORS.surface, cursor:"pointer", fontSize:15, fontWeight:700, color:COLORS.textSec }}>−</button>
            <span style={{ fontSize:16, fontWeight:700, minWidth:20, textAlign:"center" }}>{maxOm}</span>
            <button onClick={() => update("maxOmissions", maxOm + 1)} style={{ width:26, height:26, borderRadius:5, border:`1px solid ${COLORS.border}`, background:COLORS.surface, cursor:"pointer", fontSize:15, fontWeight:700, color:COLORS.textSec }}>+</button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// Meal heaviness <-> target band translation. A single 0-100 heaviness maps
// to a score band centered on that value with a fixed half-width.
const HEAVY_HALF = 20;
function heavinessToBand(h) {
  const center = Math.max(0, Math.min(140, h));
  return { min: Math.max(0, Math.round(center - HEAVY_HALF)), max: Math.round(center + HEAVY_HALF) };
}
function bandToHeaviness(band) {
  if (!band) return 50;
  return Math.round((band.min + band.max) / 2);
}

function CalibrationSection({ settings, update }) {
  const [advanced, setAdvanced] = useState(false);
  const [newTag, setNewTag] = useState("");
  const tagWeights = settings.tagWeights || {};
  const targets = settings.mealTargets || {};
  const entries = Object.entries(tagWeights).sort((a, b) => a[0].localeCompare(b[0]));

  const setTag = (tag, val) => update("tagWeights", { ...tagWeights, [tag]: Math.max(0, Math.min(100, Math.round(val))) });
  const removeTag = (tag) => { const next = { ...tagWeights }; delete next[tag]; update("tagWeights", next); };
  const addTag = () => {
    if (!newTag.trim()) return;
    const canon = canonicalizeTag(newTag, Object.keys(tagWeights));
    if (!(canon in tagWeights)) update("tagWeights", { ...tagWeights, [canon]: 50 });
    setNewTag("");
  };
  const setMeal = (m, h) => update("mealTargets", { ...targets, [m]: heavinessToBand(h) });

  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:14 }}>
        Slide toward <span style={{ color:"#C4532A", fontWeight:600 }}>more</span> or <span style={{ color:"#3A6FB0", fontWeight:600 }}>less</span> to shape what shows up in your plans. Center is neutral.
      </div>

      <SectionLabel>Food preferences</SectionLabel>
      <div style={{ display:"flex", flexDirection:"column", gap:12, marginBottom:8 }}>
        {entries.map(([tag, w]) => (
          <div key={tag}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
              <span style={{ fontSize:13, fontWeight:600 }}>{tag}</span>
              <span style={{ fontSize:13, cursor:"pointer", color:COLORS.textSec }} onClick={() => removeTag(tag)}>×</span>
            </div>
            <GradientScale value={w} min={0} max={100} onChange={v => setTag(tag, v)} showNumber leftLabel="less" rightLabel="more" />
          </div>
        ))}
      </div>
      <div style={{ display:"flex", gap:6, marginTop:10 }}>
        <input value={newTag} onChange={e => setNewTag(e.target.value)} placeholder="Add a food type..." style={{ flex:1, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
        <Btn small onClick={addTag}>Add</Btn>
      </div>

      <SectionLabel>Meal heaviness</SectionLabel>
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {MEALS.map(m => (
          <div key={m}>
            <div style={{ fontSize:13, fontWeight:700, color:MC[m].fg, marginBottom:3 }}>{m}</div>
            <GradientScale value={bandToHeaviness(targets[m])} min={0} max={140} onChange={h => setMeal(m, h)} leftLabel="light" rightLabel="heavy" />
          </div>
        ))}
      </div>

      <div onClick={() => setAdvanced(a => !a)} style={{ marginTop:18, padding:"8px 0", fontSize:12, color:COLORS.textSec, cursor:"pointer", borderTop:`1px solid ${COLORS.border}` }}>
        {advanced ? "▲" : "▼"} Advanced — exact values
      </div>
      {advanced && (
        <div style={{ paddingTop:8 }}>
          <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:8 }}>The raw numbers behind the scales. Tweak directly if you want precise control.</div>
          <div style={{ fontSize:11, fontWeight:700, marginBottom:4 }}>Tag weights (0–100)</div>
          {entries.map(([tag, w]) => (
            <div key={tag} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
              <span style={{ fontSize:12, flex:1 }}>{tag}</span>
              <NumberInput value={w} onCommit={v => setTag(tag, v)} min={0} max={100} fallback={50} style={{ width:54, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:12, textAlign:"center" }} />
            </div>
          ))}
          <div style={{ fontSize:11, fontWeight:700, margin:"10px 0 4px" }}>Meal target bands (score min–max)</div>
          {MEALS.map(m => {
            const t = targets[m] || { min:50, max:80 };
            return (
              <div key={m} style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
                <span style={{ fontSize:12, minWidth:70 }}>{m}</span>
                <NumberInput value={t.min} onCommit={v => update("mealTargets", { ...targets, [m]: { ...t, min:v } })} min={0} fallback={0} style={{ width:50, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:12, textAlign:"center" }} />
                <span style={{ color:COLORS.textSec }}>–</span>
                <NumberInput value={t.max} onCommit={v => update("mealTargets", { ...targets, [m]: { ...t, max:v } })} min={0} fallback={0} style={{ width:50, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:12, textAlign:"center" }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RangesSection({ ranges, onChange, tagWeights }) {
  const [newTag, setNewTag] = useState("");
  const tags = Object.keys(tagWeights);
  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>Min–max per tag per week</div>
      {ranges.map((r, i) => (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8, padding:"10px 12px", borderRadius:8, background:COLORS.surface }}>
          <span style={{ fontSize:13, fontWeight:600, minWidth:70 }}>{r.tag}</span>
          <NumberInput value={r.min} onCommit={v => { const nr = [...ranges]; nr[i] = { ...r, min: v }; onChange(nr); }} min={0} fallback={0} style={{ width:40, padding:"4px 6px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
          <span style={{ color:COLORS.textSec }}>–</span>
          <NumberInput value={r.max} onCommit={v => { const nr = [...ranges]; nr[i] = { ...r, max: v }; onChange(nr); }} min={0} fallback={0} style={{ width:40, padding:"4px 6px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
          <span style={{ fontSize:13, cursor:"pointer", color:COLORS.red }} onClick={() => onChange(ranges.filter((_, j) => j !== i))}>×</span>
        </div>
      ))}
      <div style={{ display:"flex", gap:6, marginTop:8 }}>
        <Combobox options={tags} value={newTag} onChange={setNewTag} placeholder="Select tag..." />
        <Btn small onClick={() => { if (newTag) { onChange([...ranges, { tag: newTag, min: 1, max: 5, period: "week" }]); setNewTag(""); } }}>Add</Btn>
      </div>
    </div>
  );
}

function RedListSection({ redList, onChange }) {
  const [newItem, setNewItem] = useState("");
  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>Recipes with these are quarantined until substituted</div>
      {redList.map(item => (
        <div key={item} style={{ display:"flex", alignItems:"center", gap:8, padding:"8px 12px", borderRadius:8, background:COLORS.quarantineBg, marginBottom:4 }}>
          <span style={{ fontSize:14 }}>🔴</span>
          <span style={{ flex:1, fontSize:13, fontWeight:600, color:COLORS.quarantine }}>{item}</span>
          <Btn small variant="ghost" style={{ fontSize:11, padding:"3px 8px", color:COLORS.quarantine, borderColor:COLORS.quarantine }} onClick={() => onChange(redList.filter(x => x !== item))}>Remove</Btn>
        </div>
      ))}
      <div style={{ display:"flex", gap:6, marginTop:10 }}>
        <input value={newItem} onChange={e => setNewItem(e.target.value)} placeholder="Add to red list..." style={{ flex:1, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
        <Btn small variant="danger" onClick={() => { if (newItem.trim()) { onChange([...redList, normalize(newItem)]); setNewItem(""); } }}>Add</Btn>
      </div>
    </div>
  );
}

function ExcludesSection({ excludes, onChange, people }) {
  const [newIng, setNewIng] = useState("");
  const [newScope, setNewScope] = useState("all");
  const [permanent, setPermanent] = useState(true);
  const [newDays, setNewDays] = useState(14);
  const now = Date.now();

  // An exclude is active if it has no expiry (permanent) or hasn't expired.
  const isActive = (ex) => !ex.expiresAt || ex.expiresAt > now;
  const active = excludes.filter(isActive);

  const scopeLabel = (scope) => {
    if (scope === "all" || !scope) return "Everyone";
    const p = people.find(x => x.id === scope);
    return p ? p.name : "Everyone";
  };

  function addExclude() {
    if (!newIng.trim()) return;
    const ex = { ingredient: normalize(newIng), scope: newScope };
    if (!permanent) ex.expiresAt = now + newDays * 86400000;
    onChange([...excludes, ex]);
    setNewIng("");
  }

  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>
        Exclude ingredients for everyone or one person. Permanent for allergies/dislikes; time-boxed for temporary avoids.
      </div>
      {active.map((ex, i) => {
        const realIdx = excludes.indexOf(ex);
        const daysLeft = ex.expiresAt ? Math.ceil((ex.expiresAt - now) / 86400000) : null;
        return (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, padding:"10px 12px", borderRadius:8, background:COLORS.surface }}>
            <div style={{ flex:1, minWidth:0 }}>
              <span style={{ fontSize:13, fontWeight:600 }}>{ex.ingredient}</span>
              <div style={{ fontSize:10, color:COLORS.textSec }}>{scopeLabel(ex.scope)}</div>
            </div>
            {daysLeft != null
              ? <Badge color={COLORS.red} bg={COLORS.quarantineBg}>{daysLeft}d left</Badge>
              : <Badge color={COLORS.lock} bg={COLORS.surface}>permanent</Badge>}
            <Btn small variant="ghost" style={{ fontSize:11, padding:"3px 8px" }} onClick={() => onChange(excludes.filter((_, j) => j !== realIdx))}>Lift</Btn>
          </div>
        );
      })}
      <div style={{ display:"flex", flexDirection:"column", gap:6, marginTop:10, padding:"10px 12px", borderRadius:8, background:COLORS.surface }}>
        <input value={newIng} onChange={e => setNewIng(e.target.value)} placeholder="Ingredient..." style={{ padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
        <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
          <span style={{ fontSize:11, color:COLORS.textSec, fontWeight:600 }}>For:</span>
          <select value={newScope} onChange={e => setNewScope(e.target.value)} style={{ fontSize:12, padding:"5px 8px", borderRadius:5, border:`1px solid ${COLORS.border}`, background:"#fff" }}>
            <option value="all">Everyone</option>
            {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <label style={{ display:"flex", alignItems:"center", gap:4, fontSize:12, cursor:"pointer" }}>
            <input type="checkbox" checked={permanent} onChange={e => setPermanent(e.target.checked)} /> Permanent
          </label>
          {!permanent && (
            <span style={{ display:"flex", alignItems:"center", gap:4 }}>
              <NumberInput value={newDays} onCommit={setNewDays} min={1} fallback={14} style={{ width:50, padding:"5px 6px", borderRadius:5, border:`1px solid ${COLORS.border}`, fontSize:12, textAlign:"center" }} />
              <span style={{ fontSize:11, color:COLORS.textSec }}>days</span>
            </span>
          )}
          <Btn small onClick={addExclude} style={{ marginLeft:"auto" }}>Exclude</Btn>
        </div>
      </div>
    </div>
  );
}

function BoostsSection({ boosts, onChange }) {
  const [newItem, setNewItem] = useState("");
  const [newWeight, setNewWeight] = useState(15);
  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>Soft weight boosts</div>
      {boosts.map((b, i) => (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8, padding:"10px 12px", borderRadius:8, background:COLORS.boostBg }}>
          <span style={{ fontSize:14 }}>⬆</span>
          <span style={{ flex:1, fontSize:13, fontWeight:600, color:COLORS.boost }}>{b.item}</span>
          <NumberInput value={b.weight} onCommit={v => { const nb = [...boosts]; nb[i] = { ...b, weight: v }; onChange(nb); }} min={0} fallback={10} style={{ width:44, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.boost}40`, fontSize:12, textAlign:"center" }} />
          <span style={{ fontSize:10, color:COLORS.boost }}>%</span>
          <Btn small variant="ghost" style={{ fontSize:11, padding:"3px 8px", color:COLORS.boost, borderColor:COLORS.boost }} onClick={() => onChange(boosts.filter((_, j) => j !== i))}>×</Btn>
        </div>
      ))}
      <div style={{ display:"flex", gap:6, marginTop:10 }}>
        <input value={newItem} onChange={e => setNewItem(e.target.value)} placeholder="Tag or ingredient..." style={{ flex:1, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
        <NumberInput value={newWeight} onCommit={setNewWeight} min={0} fallback={10} style={{ width:50, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
        <Btn small onClick={() => { if (newItem.trim()) { onChange([...boosts, { item: normalize(newItem), weight: newWeight }]); setNewItem(""); } }}>Boost</Btn>
      </div>
    </div>
  );
}

function DataSection() {
  function exportAll() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith("prep_")) data[key] = JSON.parse(localStorage.getItem(key));
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "prep-backup.json"; a.click();
  }
  function clearAll() {
    if (confirm("Delete ALL data? This cannot be undone.")) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith("prep_")) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
      window.location.reload();
    }
  }
  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>Manage your data</div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        <Btn variant="secondary" onClick={exportAll}>Export backup (JSON)</Btn>
        <Btn variant="danger" onClick={clearAll}>Clear all data</Btn>
      </div>
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
// Starter food tags seeded on first run — all neutral (50) so there's no
// hidden food-type bias. The first-open survey lets the user nudge these.
const STARTER_TAGS = ["beef", "poultry", "fish", "eggs", "salad", "pasta", "grain", "vegetarian"];
const DEFAULT_SETTINGS = {
  tagWeights: Object.fromEntries(STARTER_TAGS.map(t => [t, 50])),
  // Neutral heaviness (center 70 ± 20) for every meal — no built-in bias.
  mealTargets: { Breakfast:{ min:50, max:90 }, Lunch:{ min:50, max:90 }, Dinner:{ min:50, max:90 } },
  ranges: [],
  redList: [],
  excludes: [],
  boosts: [],
  maxOmissions: 2,
};

const emptyPlan = () => {
  const p = {};
  DAYS.forEach(d => { p[d] = {}; MEALS.forEach(m => { p[d][m] = null; }); });
  return p;
};

// First-open calibration survey. Fades in over a fresh install, lets the user
// shape food preferences + meal heaviness on gradient scales, fully skippable.
// Writes directly to settings (same values the Settings Preferences tab edits)
// and sets the seen-flag so it never reappears.
function FirstRunSurvey({ settings, setSettings, onClose }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVisible(true), 60); return () => clearTimeout(t); }, []);

  const tagWeights = settings.tagWeights || {};
  const targets = settings.mealTargets || {};
  const tags = Object.keys(tagWeights).sort((a, b) => a.localeCompare(b));

  const setTag = (tag, val) => setSettings(prev => ({ ...prev, tagWeights: { ...prev.tagWeights, [tag]: Math.max(0, Math.min(100, Math.round(val))) } }));
  const setMeal = (m, h) => setSettings(prev => ({ ...prev, mealTargets: { ...prev.mealTargets, [m]: heavinessToBand(h) } }));

  return (
    <div style={{ position:"fixed", inset:0, zIndex:100, display:"flex", alignItems:"center", justifyContent:"center", padding:16,
      background:`rgba(20,18,15,${visible?0.5:0})`, transition:"background 0.8s ease", backdropFilter:visible?"blur(2px)":"none" }}>
      <div style={{ background:COLORS.bg, borderRadius:16, width:"100%", maxWidth:440, maxHeight:"88vh", overflowY:"auto",
        padding:"22px 20px", boxShadow:"0 12px 48px rgba(0,0,0,0.3)",
        opacity:visible?1:0, transform:visible?"translateY(0) scale(1)":"translateY(16px) scale(0.98)",
        transition:"opacity 0.8s ease, transform 0.8s ease" }}>
        <div style={{ fontSize:20, fontWeight:800, color:COLORS.primary, marginBottom:4 }}>Welcome 👋</div>
        <div style={{ fontSize:13, color:COLORS.textSec, marginBottom:18, lineHeight:1.4 }}>
          Tell us what your household likes and we'll tailor your meal plans. Slide toward <span style={{ color:"#C4532A", fontWeight:600 }}>more</span> or <span style={{ color:"#3A6FB0", fontWeight:600 }}>less</span> — or just skip and adjust later.
        </div>

        <SectionLabel>How much do you like…</SectionLabel>
        <div style={{ display:"flex", flexDirection:"column", gap:13, marginBottom:6 }}>
          {tags.map(tag => (
            <div key={tag}>
              <div style={{ fontSize:13, fontWeight:600, marginBottom:3, textTransform:"capitalize" }}>{tag}</div>
              <GradientScale value={tagWeights[tag]} min={0} max={100} onChange={v => setTag(tag, v)} leftLabel="less" rightLabel="more" />
            </div>
          ))}
        </div>

        <SectionLabel>How heavy should each meal be?</SectionLabel>
        <div style={{ display:"flex", flexDirection:"column", gap:13 }}>
          {MEALS.map(m => (
            <div key={m}>
              <div style={{ fontSize:13, fontWeight:700, color:MC[m].fg, marginBottom:3 }}>{m}</div>
              <GradientScale value={bandToHeaviness(targets[m])} min={0} max={140} onChange={h => setMeal(m, h)} leftLabel="light" rightLabel="heavy" />
            </div>
          ))}
        </div>

        <div style={{ display:"flex", gap:8, marginTop:22 }}>
          <Btn style={{ flex:1 }} onClick={onClose}>Done</Btn>
          <Btn variant="ghost" onClick={onClose}>Skip</Btn>
        </div>
        <div style={{ fontSize:10, color:COLORS.textSec, textAlign:"center", marginTop:8 }}>You can recalibrate anytime in Settings → Preferences.</div>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("Recipes");
  const [recipes, setRecipesRaw] = useState(() => load("recipes", []));
  const [pantry, setPantryRaw] = useState(() => load("pantry", []));
  const [plan, setPlanRaw] = useState(() => load("plan", emptyPlan()));
  const [settings, setSettingsRaw] = useState(() => load("settings", DEFAULT_SETTINGS));
  const [dictionary, setDictionaryRaw] = useState(() => load("dictionary", []));
  const [people, setPeopleRaw] = useState(() => load("people", []));
  const [seenSurvey, setSeenSurvey] = useState(() => load("seenSurvey", false));
  const [spices, setSpicesRaw] = useState(() => load("spices", []));

  // Persist INSIDE the functional updater so React supplies the true latest
  // state (no stale closure), and we save exactly what we commit. Empty dep
  // arrays keep these callback identities stable across renders.
  const setRecipes = useCallback(v => {
    setRecipesRaw(prev => { const next = typeof v === "function" ? v(prev) : v; save("recipes", next); return next; });
  }, []);
  const setPantry = useCallback(v => {
    setPantryRaw(prev => { const next = typeof v === "function" ? v(prev) : v; save("pantry", next); return next; });
  }, []);
  const setPlan = useCallback(v => {
    setPlanRaw(prev => { const next = typeof v === "function" ? v(prev) : v; save("plan", next); return next; });
  }, []);
  const setSettings = useCallback(v => {
    setSettingsRaw(prev => { const next = typeof v === "function" ? v(prev) : v; save("settings", next); return next; });
  }, []);
  const setDictionary = useCallback(v => {
    setDictionaryRaw(prev => { const next = typeof v === "function" ? v(prev) : v; save("dictionary", next); return next; });
  }, []);
  const setPeople = useCallback(v => {
    setPeopleRaw(prev => { const next = typeof v === "function" ? v(prev) : v; save("people", next); return next; });
  }, []);
  const setSpices = useCallback(v => {
    setSpicesRaw(prev => { const next = typeof v === "function" ? v(prev) : v; save("spices", next); return next; });
  }, []);

  return (
    <div style={{ minHeight:"100vh", background:COLORS.bg, fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color:COLORS.text, display:"flex", flexDirection:"column" }}>
      <div style={{ padding:"14px 16px 10px", borderBottom:`1px solid ${COLORS.border}`, background:COLORS.bg, position:"sticky", top:0, zIndex:15 }}>
        <div style={{ fontSize:20, fontWeight:800, color:COLORS.primary, letterSpacing:-0.5 }}>Prep</div>
      </div>
      <div style={{ flex:1, padding:"12px 16px 90px", overflowY:"auto" }}>
        {tab === "Recipes" && <RecipesTab recipes={recipes} setRecipes={setRecipes} settings={settings} setSettings={setSettings} dictionary={dictionary} setDictionary={setDictionary} />}
        {tab === "Plan" && <PlanTab recipes={recipes} setRecipes={setRecipes} plan={plan} setPlan={setPlan} settings={settings} pantry={pantry} setPantry={setPantry} people={people} spices={spices} setSpices={setSpices} setTab={setTab} />}
        {tab === "Shop" && <ShopTab plan={plan} recipes={recipes} pantry={pantry} setPantry={setPantry} spices={spices} setSpices={setSpices} settings={settings} people={people} setTab={setTab} />}
        {tab === "Pantry" && <PantryTab pantry={pantry} setPantry={setPantry} spices={spices} setSpices={setSpices} />}
        {tab === "Settings" && <SettingsTab settings={settings} setSettings={setSettings} people={people} setPeople={setPeople} />}
      </div>
      <div style={{ position:"fixed", bottom:0, left:0, right:0, display:"flex", justifyContent:"space-around", padding:"8px 0 max(12px, env(safe-area-inset-bottom))", background:COLORS.bg, borderTop:`1px solid ${COLORS.border}`, zIndex:20 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2, background:"none", border:"none", color:tab===t?COLORS.primary:COLORS.textSec, fontSize:10, fontWeight:tab===t?700:500, cursor:"pointer", padding:"2px 8px", minWidth:44 }}>
            {TAB_ICONS[t]}{t}
          </button>
        ))}
      </div>
      {!seenSurvey && (
        <FirstRunSurvey
          settings={settings}
          setSettings={setSettings}
          onClose={() => { setSeenSurvey(true); save("seenSurvey", true); }}
        />
      )}
    </div>
  );
}
