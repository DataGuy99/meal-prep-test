import { useState, useRef, useEffect, useCallback, useMemo } from "react";

// ============================================================
// CONSTANTS
// ============================================================
const COLORS = {
  bg: "#FAFAF7", surface: "#F0EDE6", surfaceAlt: "#E6E1D8",
  primary: "#3D6B2E", primaryLight: "#5A8A47",
  red: "#C4532A", redLight: "#F4E0DA",
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
const CATEGORIES = ["Produce","Meat","Seafood","Dairy","Bakery","Pantry","Frozen","Beverages","Spices","Other"];

// ============================================================
// PERSISTENCE
// ============================================================
function load(key, fallback) {
  try { const v = localStorage.getItem("prep_" + key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem("prep_" + key, JSON.stringify(val)); } catch {}
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ============================================================
// INGREDIENT NORMALIZATION
// ============================================================
function normalize(s) {
  return s.toLowerCase().trim().replace(/-/g, " ").replace(/\s+/g, " ")
    .replace(/ies$/, "y").replace(/ves$/, "f").replace(/([^s])s$/, "$1");
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
function calcFatigueRecency(recipe) {
  if (!recipe.lastUsed) return 1;
  const days = (Date.now() - recipe.lastUsed) / 86400000;
  return 1 - Math.exp(-days / 3);
}

function calcWeight(recipe, settings, planTagCounts) {
  const { tagWeights, boosts, excludes } = settings;
  const now = Date.now();
  // Hard exclude check
  for (const ex of excludes) {
    if (ex.expiresAt > now) {
      for (const ing of recipe.ingredients) {
        if (normalize(ing.name) === normalize(ex.ingredient)) return 0;
      }
    }
  }
  if (recipe.quarantine) return 0;

  let starW = (recipe.stars || 3) / 5;
  let tagW = 0;
  for (const t of (recipe.tags || [])) {
    tagW += (tagWeights[t] || 10) / 100;
  }
  let fatigue = calcFatigueRecency(recipe);
  let boostMul = 1;
  for (const b of boosts) {
    const item = normalize(b.item);
    if ((recipe.tags || []).includes(item)) boostMul += (b.weight || 10) / 100;
    for (const ing of recipe.ingredients) {
      if (normalize(ing.name).includes(item)) boostMul += (b.weight || 10) / 100;
    }
  }
  return starW * (1 + tagW) * fatigue * boostMul;
}

function generatePlan(recipes, existingPlan, settings) {
  const plan = {};
  DAYS.forEach(d => {
    plan[d] = {};
    MEALS.forEach(m => {
      const existing = existingPlan?.[d]?.[m];
      plan[d][m] = existing?.locked ? { ...existing } : null;
    });
  });

  const { ranges, excludes, redList } = settings;
  const now = Date.now();
  const eligible = recipes.filter(r => {
    if (r.quarantine) return false;
    for (const ex of excludes) {
      if (ex.expiresAt > now) {
        for (const ing of r.ingredients) {
          if (normalize(ing.name) === normalize(ex.ingredient)) return false;
        }
      }
    }
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

  for (const meal of MEALS) {
    const emptySlots = DAYS.filter(d => !plan[d][meal]);
    if (emptySlots.length === 0) continue;

    const mealKey = meal.toLowerCase();
    const pool = eligible.filter(r => (r.mealTags || []).includes(mealKey));
    let remaining = [...emptySlots];

    let attempts = 0;
    while (remaining.length > 0 && attempts < 50) {
      attempts++;
      const weights = pool.map(r => {
        if (usedRecipes.has(r.id)) return { r, w: calcWeight(r, settings, tagCounts) * 0.3 };
        return { r, w: calcWeight(r, settings, tagCounts) };
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
          chunk: `${i + 1}/${chunkSize}`,
          locked: false,
        };
      }
      remaining = remaining.slice(chunkSize);
      usedRecipes.add(picked.id);
      (picked.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + chunkSize; });
    }
  }
  return plan;
}

function rerollSlot(day, meal, recipes, plan, settings) {
  const mealKey = meal.toLowerCase();
  const now = Date.now();
  const currentRecipeId = plan[day]?.[meal]?.recipeId;

  const eligible = recipes.filter(r => {
    if (r.quarantine || r.id === currentRecipeId) return false;
    if (!(r.mealTags || []).includes(mealKey)) return false;
    for (const ex of settings.excludes) {
      if (ex.expiresAt > now) {
        for (const ing of r.ingredients) {
          if (normalize(ing.name) === normalize(ex.ingredient)) return false;
        }
      }
    }
    return true;
  });

  if (eligible.length === 0) return plan;
  const weights = eligible.map(r => ({ r, w: calcWeight(r, settings, {}) })).filter(x => x.w > 0);
  if (weights.length === 0) return plan;

  const totalW = weights.reduce((s, x) => s + x.w, 0);
  let rand = Math.random() * totalW;
  let picked = weights[0].r;
  for (const { r, w } of weights) { rand -= w; if (rand <= 0) { picked = r; break; } }

  const newPlan = JSON.parse(JSON.stringify(plan));
  newPlan[day][meal] = {
    recipeId: picked.id, recipeName: picked.name, chunk: "1/1", locked: false,
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

function generateShoppingList(plan, recipes, pantry) {
  // Bucket needs by ingredient name + unit family. Within a family, sum in base units.
  // needs[name] = { name, category, families: { [family]: baseQty } }
  const needs = {};
  DAYS.forEach(d => MEALS.forEach(m => {
    const slot = plan?.[d]?.[m];
    if (!slot?.recipeId) return;
    const recipe = recipes.find(r => r.id === slot.recipeId);
    if (!recipe) return;
    for (const ing of recipe.ingredients) {
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

const Badge = ({ children, color, bg, style: s }) => (
  <span style={{ display:"inline-block", padding:"2px 8px", borderRadius:99, fontSize:11, fontWeight:600, color, background:bg, whiteSpace:"nowrap", ...s }}>{children}</span>
);

const Card = ({ children, style, onClick }) => (
  <div onClick={onClick} style={{ background:COLORS.surface, borderRadius:10, padding:"12px 14px", border:`1px solid ${COLORS.border}`, cursor:onClick?"pointer":"default", ...style }}>{children}</div>
);

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
function RecipesTab({ recipes, setRecipes, settings, dictionary, setDictionary }) {
  const [filter, setFilter] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name:"", tags:[], mealTags:[], servings:4, slotsMin:2, slotsMax:4, stars:3, ingredientText:"" });

  const allTags = useMemo(() => [...new Set([...DEFAULT_TAGS, ...recipes.flatMap(r => r.tags || [])])].sort(), [recipes]);

  const filtered = recipes.filter(r => {
    if (filter === "favorites") return r.stars >= 4;
    if (filter === "quarantine") return r.quarantine;
    return true;
  });

  const freqNotifs = recipes.filter(r => r.useCount >= 8 && calcFatigueRecency(r) > 0.6).map(r => ({
    icon: "🔔", text: `${r.name} picked ${r.useCount}× recently. Take a break?`,
    bg: "#FFF3CD", color: "#856404", action: "Shelve",
    onAction: () => setRecipes(prev => prev.map(x => x.id === r.id ? { ...x, lastUsed: Date.now(), useCount: 0 } : x)),
  }));
  const quarNotifs = recipes.filter(r => r.quarantine).map(r => ({
    icon: "🔴", text: `${r.name} has unresolved red-list items`,
    bg: COLORS.quarantineBg, color: COLORS.quarantine,
  }));

  function saveRecipe() {
    const ings = addForm.ingredientText.split("\n").map(parseIngredientLine).filter(Boolean);
    const newIngs = ings.map(ing => ({ ...ing, name: findMatch(ing.name, dictionary) }));
    const newDict = [...new Set([...dictionary, ...newIngs.map(i => i.name)])];
    setDictionary(newDict);

    // Check red list
    const redHits = newIngs.filter(ing => settings.redList.some(rl => normalize(rl) === normalize(ing.name)));
    const isQ = redHits.length > 0;

    const recipe = {
      id: uid(), name: addForm.name.trim(), stars: addForm.stars,
      tags: addForm.tags, mealTags: addForm.mealTags,
      servings: addForm.servings, slotsMin: addForm.slotsMin, slotsMax: addForm.slotsMax,
      ingredients: newIngs, quarantine: isQ,
      quarantineItems: redHits.map(r => ({ ingredient: r.name, sub: "" })),
      lastUsed: null, useCount: 0, useHistory: [], createdAt: Date.now(),
    };
    setRecipes(prev => [...prev, recipe]);
    setAddForm({ name:"", tags:[], mealTags:[], servings:4, slotsMin:2, slotsMax:4, stars:3, ingredientText:"" });
    setShowAdd(false);
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
      <div style={{ display:"flex", gap:6, marginBottom:14, flexWrap:"wrap" }}>
        {["all","favorites","quarantine"].map(f => (
          <Btn key={f} small variant={filter===f?"primary":"ghost"} onClick={() => setFilter(f)}>
            {f==="all"?"All ("+recipes.length+")":f==="favorites"?"★ Favorites":"🔴 Quarantined ("+recipes.filter(r=>r.quarantine).length+")"}
          </Btn>
        ))}
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {filtered.map(r => (
          <Card key={r.id} onClick={() => setExpandedId(expandedId===r.id?null:r.id)}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                  <span style={{ fontSize:15, fontWeight:700 }}>{r.name}</span>
                  {r.quarantine && <Badge color={COLORS.quarantine} bg={COLORS.quarantineBg}>Quarantined</Badge>}
                </div>
                <div style={{ display:"flex", gap:4, marginTop:4, flexWrap:"wrap" }}>
                  {(r.tags||[]).map(t => <Badge key={t} color={COLORS.primary} bg={`${COLORS.primary}18`}>{t}</Badge>)}
                  {(r.mealTags||[]).map(t => <Badge key={t} color={MC[t.charAt(0).toUpperCase()+t.slice(1)]?.fg||COLORS.textSec} bg={MC[t.charAt(0).toUpperCase()+t.slice(1)]?.bg||COLORS.surface}>{t}</Badge>)}
                </div>
                <div style={{ fontSize:11, color:COLORS.textSec, marginTop:3 }}>{r.servings} servings · {r.slotsMin}–{r.slotsMax} slots · Used {r.useCount||0}×</div>
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
                      <input type="number" value={r.slotsMin} onChange={e => updateRecipe(r.id, { slotsMin: Math.max(1, +e.target.value) })} style={{ width:36, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
                      <span style={{ color:COLORS.textSec }}>–</span>
                      <input type="number" value={r.slotsMax} onChange={e => updateRecipe(r.id, { slotsMax: Math.max(r.slotsMin, +e.target.value) })} style={{ width:36, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600 }}>Servings</div>
                    <input type="number" value={r.servings} onChange={e => updateRecipe(r.id, { servings: Math.max(1, +e.target.value) })} style={{ width:50, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center", marginTop:2 }} />
                  </div>
                </div>
                <div style={{ fontSize:12, fontWeight:600, color:COLORS.textSec, marginBottom:4 }}>Ingredients ({r.ingredients.length})</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                  {r.ingredients.map((ing, idx) => {
                    const isRed = settings.redList.some(rl => normalize(rl) === normalize(ing.name));
                    return (
                      <span key={idx} style={{ fontSize:12, padding:"3px 8px", borderRadius:4, background:isRed?COLORS.quarantineBg:"#fff", border:`1px solid ${isRed?COLORS.quarantine:COLORS.border}`, color:isRed?COLORS.quarantine:COLORS.text, fontWeight:isRed?600:400 }}>
                        {isRed && "⚠ "}{ing.qty > 0 && ing.qty !== 1 ? ing.qty + " " : ""}{ing.unit ? ing.unit + " " : ""}{ing.name}
                      </span>
                    );
                  })}
                </div>
                {r.quarantine && r.quarantineItems?.length > 0 && (
                  <div style={{ marginTop:8 }}>
                    <div style={{ fontSize:12, fontWeight:600, color:COLORS.quarantine, marginBottom:4 }}>Substitutions needed</div>
                    {r.quarantineItems.filter(qi => !qi.sub).map(qi => (
                      <SubstitutionRow key={qi.ingredient} qi={qi} onResolve={(sub) => resolveQuarantine(r.id, qi.ingredient, sub)} />
                    ))}
                  </div>
                )}
                <div style={{ marginTop:8 }}>
                  <Btn small variant="ghost" style={{ color:COLORS.red, borderColor:COLORS.red }} onClick={() => deleteRecipe(r.id)}>Delete recipe</Btn>
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>
      <div style={{ marginTop:16 }}>
        {!showAdd ? (
          <Btn onClick={() => setShowAdd(true)} style={{ width:"100%" }}>+ Add Recipe</Btn>
        ) : (
          <Card style={{ border:`2px solid ${COLORS.primary}` }}>
            <div style={{ fontSize:14, fontWeight:700, color:COLORS.primary, marginBottom:10 }}>New Recipe</div>
            <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
              <input placeholder="Recipe name" value={addForm.name} onChange={e => setAddForm(p => ({ ...p, name: e.target.value }))} style={{ padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14 }} />
              <div>
                <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Category tags</div>
                <Combobox multi options={allTags} placeholder="Type or select..." selected={addForm.tags} onChange={v => setAddForm(p => ({ ...p, tags: v }))} />
              </div>
              <div>
                <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Meal suitability</div>
                <Combobox multi options={["breakfast","lunch","dinner"]} placeholder="breakfast, lunch, dinner..." selected={addForm.mealTags} onChange={v => setAddForm(p => ({ ...p, mealTags: v }))} />
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Servings</div>
                  <input type="number" value={addForm.servings} onChange={e => setAddForm(p => ({ ...p, servings: +e.target.value }))} style={{ width:"100%", padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14, boxSizing:"border-box" }} />
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Slot range</div>
                  <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                    <input type="number" value={addForm.slotsMin} onChange={e => setAddForm(p => ({ ...p, slotsMin: +e.target.value }))} style={{ width:"100%", padding:"8px 6px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14, boxSizing:"border-box", textAlign:"center" }} />
                    <span style={{ color:COLORS.textSec }}>–</span>
                    <input type="number" value={addForm.slotsMax} onChange={e => setAddForm(p => ({ ...p, slotsMax: +e.target.value }))} style={{ width:"100%", padding:"8px 6px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14, boxSizing:"border-box", textAlign:"center" }} />
                  </div>
                </div>
              </div>
              <div>
                <div style={{ fontSize:11, color:COLORS.textSec, marginBottom:3, fontWeight:600 }}>Rating</div>
                <StarRating rating={addForm.stars} size={22} onChange={v => setAddForm(p => ({ ...p, stars: v }))} />
              </div>
              <textarea placeholder={"Paste ingredients, one per line:\n2 cups rice\n1.5 kg chicken thigh\n3 cloves garlic\nsalt"} value={addForm.ingredientText} onChange={e => setAddForm(p => ({ ...p, ingredientText: e.target.value }))} rows={5} style={{ padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13, resize:"vertical", fontFamily:"inherit" }} />
              <div style={{ display:"flex", gap:8 }}>
                <Btn style={{ flex:1 }} onClick={saveRecipe} disabled={!addForm.name.trim() || !addForm.ingredientText.trim()}>Save Recipe</Btn>
                <Btn variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Btn>
              </div>
            </div>
          </Card>
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
function PlanTab({ recipes, setRecipes, plan, setPlan, settings }) {
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [pickerSlot, setPickerSlot] = useState(null);
  const [pickerSearch, setPickerSearch] = useState("");

  function doGenerate() {
    const newPlan = generatePlan(recipes, plan, settings);
    setPlan(newPlan);
    // Update usage stats
    const usedIds = new Set();
    DAYS.forEach(d => MEALS.forEach(m => { if (newPlan[d]?.[m]?.recipeId) usedIds.add(newPlan[d][m].recipeId); }));
    setRecipes(prev => prev.map(r => usedIds.has(r.id) ? { ...r, lastUsed: Date.now(), useCount: (r.useCount||0) + 1, useHistory: [...(r.useHistory||[]), Date.now()] } : r));
  }

  function doRerollUnlocked() {
    const newPlan = generatePlan(recipes, plan, settings);
    setPlan(newPlan);
  }

  function doRerollSlot(day, meal) {
    const newPlan = rerollSlot(day, meal, recipes, plan, settings);
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
        recipeId: recipe.id, recipeName: recipe.name, chunk: "1/1", locked: true,
      };
      return next;
    });
    setPickerSlot(null);
    setPickerSearch("");
  }

  function autofillBlanks() {
    const newPlan = generatePlan(recipes, plan, settings);
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
        <div style={{ display:"flex", gap:6 }}>
          <Btn small variant="secondary" onClick={doRerollUnlocked}>🎲 Reroll</Btn>
          <Btn small onClick={doGenerate}>Generate</Btn>
        </div>
      </div>
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
                        <div onClick={() => { setSelectedSlot({ day:d, meal:m }); setPickerSlot(null); }} style={{ background:MC[m].bg, border:`1.5px solid ${isSel?MC[m].fg:`${MC[m].fg}40`}`, borderRadius:6, padding:"4px 6px", minHeight:36, position:"relative", cursor:"pointer" }}>
                          {slot.locked && <span style={{ position:"absolute", top:2, right:3, fontSize:9, color:COLORS.lock }}>🔒</span>}
                          <div style={{ fontSize:11, fontWeight:600, color:MC[m].fg, lineHeight:1.2, paddingRight:slot.locked?14:0 }}>{slot.recipeName}</div>
                          <div style={{ fontSize:9, color:COLORS.textSec, marginTop:1 }}>{slot.chunk}</div>
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
          for (const ex of settings.excludes) {
            if (ex.expiresAt > now) {
              for (const ing of r.ingredients) {
                if (normalize(ing.name) === normalize(ex.ingredient)) return false;
              }
            }
          }
          if (pickerSearch) {
            const q = pickerSearch.toLowerCase();
            if (!r.name.toLowerCase().includes(q) && !(r.tags||[]).some(t => t.includes(q))) return false;
          }
          return true;
        }).sort((a, b) => (b.stars || 0) - (a.stars || 0));

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
              {eligible.length === 0 && (
                <div style={{ padding:16, textAlign:"center", fontSize:13, color:COLORS.textSec }}>
                  No {mealKey}-tagged recipes{pickerSearch ? " matching search" : ""}
                </div>
              )}
              {eligible.map(r => (
                <div key={r.id} onClick={() => assignRecipe(pickerSlot.day, pickerSlot.meal, r)} style={{
                  display:"flex", alignItems:"center", gap:10, padding:"8px 10px", borderRadius:6,
                  background:mealColor.bg, border:`1px solid ${mealColor.fg}25`, cursor:"pointer",
                }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:mealColor.fg }}>{r.name}</div>
                    <div style={{ display:"flex", gap:4, marginTop:2, flexWrap:"wrap" }}>
                      {(r.tags||[]).map(t => <Badge key={t} color={COLORS.primary} bg={`${COLORS.primary}15`} style={{ fontSize:9, padding:"1px 5px" }}>{t}</Badge>)}
                      <span style={{ fontSize:10, color:COLORS.textSec }}>{r.servings} srv · {r.slotsMin}–{r.slotsMax} slots</span>
                    </div>
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

      {selectedSlot && plan?.[selectedSlot.day]?.[selectedSlot.meal] && (
        <Card style={{ marginTop:10, border:`2px solid ${MC[selectedSlot.meal].fg}` }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
            <span style={{ fontSize:13, fontWeight:700 }}>{selectedSlot.day} {selectedSlot.meal}: {plan[selectedSlot.day][selectedSlot.meal].recipeName}</span>
            <span style={{ fontSize:11, color:COLORS.textSec, cursor:"pointer" }} onClick={() => setSelectedSlot(null)}>✕</span>
          </div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            <Btn small variant={plan[selectedSlot.day][selectedSlot.meal].locked?"primary":"ghost"} onClick={() => toggleLock(selectedSlot.day, selectedSlot.meal)} style={plan[selectedSlot.day][selectedSlot.meal].locked?{ background:COLORS.lock }:{}}>
              {plan[selectedSlot.day][selectedSlot.meal].locked?"🔒 Locked":"🔓 Lock"}
            </Btn>
            <Btn small variant="secondary" onClick={() => doRerollSlot(selectedSlot.day, selectedSlot.meal)}>🎲 Reroll</Btn>
            <Btn small variant="ghost" style={{ color:COLORS.red, borderColor:COLORS.red }} onClick={() => removeSlot(selectedSlot.day, selectedSlot.meal)}>Remove</Btn>
          </div>
        </Card>
      )}

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
    </div>
  );
}

// ============================================================
// SHOP TAB
// ============================================================
function ShopTab({ plan, recipes, pantry }) {
  const [shopItems, setShopItems] = useState([]);
  const [floorItems, setFloorItems] = useState([]);
  const [groupBy, setGroupBy] = useState("category");
  const [manualName, setManualName] = useState("");
  const [manualQty, setManualQty] = useState("");
  const [generated, setGenerated] = useState(false);

  function doGenerate() {
    setShopItems(generateShoppingList(plan, recipes, pantry).map((x, i) => ({ ...x, id: "s" + i })));
    setFloorItems(getFloorItems(pantry).map((x, i) => ({ ...x, id: "f" + i })));
    setGenerated(true);
  }

  function toggle(id) { setShopItems(p => p.map(x => x.id === id ? { ...x, checked: !x.checked } : x)); }
  function toggleFloor(id) { setFloorItems(p => p.map(x => x.id === id ? { ...x, checked: !x.checked } : x)); }
  function addManual() {
    if (!manualName.trim()) return;
    setShopItems(p => [...p, { id: "m" + uid(), name: manualName.trim(), qty: manualQty || "1", unit: "", category: guessCategory(manualName), store: "", checked: false, source: "manual" }]);
    setManualName(""); setManualQty("");
  }

  const groupKey = groupBy === "store" ? "store" : "category";
  const groups = [...new Set(shopItems.map(i => i[groupKey] || "Other"))].sort();
  const totalChecked = shopItems.filter(i => i.checked).length + floorItems.filter(i => i.checked).length;
  const totalItems = shopItems.length + floorItems.length;

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
        <span style={{ fontSize:14, fontWeight:700 }}>Shopping List</span>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {generated && <span style={{ fontSize:12, color:COLORS.textSec }}>{totalChecked}/{totalItems}</span>}
          <Btn small onClick={doGenerate}>{generated ? "Refresh" : "Generate"}</Btn>
        </div>
      </div>

      {!generated ? (
        <Card style={{ marginTop:12, textAlign:"center", padding:24 }}>
          <div style={{ fontSize:13, color:COLORS.textSec, marginBottom:8 }}>Set up your meal plan first, then generate the shopping list</div>
          <Btn onClick={doGenerate}>Generate from plan</Btn>
        </Card>
      ) : (
        <>
          <div style={{ display:"flex", gap:6, marginBottom:10 }}>
            <Btn small variant={groupBy==="category"?"primary":"ghost"} onClick={() => setGroupBy("category")}>By category</Btn>
            <Btn small variant={groupBy==="store"?"primary":"ghost"} onClick={() => setGroupBy("store")}>By store</Btn>
          </div>

          {shopItems.length > 0 && <>
            <SectionLabel>From Meal Plan</SectionLabel>
            {groups.map(g => (
              <div key={g} style={{ marginBottom:10 }}>
                <div style={{ fontSize:11, fontWeight:700, color:COLORS.primary, marginBottom:4, textTransform:"uppercase", letterSpacing:0.8 }}>{g || "Other"}</div>
                {shopItems.filter(i => (i[groupKey]||"Other") === g).map(item => (
                  <div key={item.id} onClick={() => toggle(item.id)} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px", borderRadius:6, background:item.checked?`${COLORS.primary}08`:"transparent", cursor:"pointer", marginBottom:2 }}>
                    <div style={{ width:20, height:20, borderRadius:4, border:`2px solid ${item.checked?COLORS.primary:COLORS.border}`, background:item.checked?COLORS.primary:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                      {item.checked && <span style={{ color:"#fff", fontSize:12, fontWeight:700 }}>✓</span>}
                    </div>
                    <span style={{ flex:1, fontSize:14, color:item.checked?COLORS.textSec:COLORS.text, textDecoration:item.checked?"line-through":"none" }}>{item.name}</span>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:12, color:COLORS.textSec }}>{item.qty}{item.unit ? " " + item.unit : ""}</div>
                      {groupBy==="category" && item.store && <div style={{ fontSize:9, color:COLORS.textSec }}>{item.store}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </>}

          {floorItems.length > 0 && <>
            <SectionLabel>Staple Replenishment</SectionLabel>
            <div style={{ background:COLORS.surface, borderRadius:8, padding:"4px 0" }}>
              {floorItems.map(item => (
                <div key={item.id} onClick={() => toggleFloor(item.id)} style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 10px", cursor:"pointer" }}>
                  <div style={{ width:20, height:20, borderRadius:4, border:`2px solid ${item.checked?COLORS.primary:COLORS.red}`, background:item.checked?COLORS.primary:"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                    {item.checked && <span style={{ color:"#fff", fontSize:12, fontWeight:700 }}>✓</span>}
                  </div>
                  <span style={{ flex:1, fontSize:14, color:item.checked?COLORS.textSec:COLORS.text, textDecoration:item.checked?"line-through":"none" }}>{item.name}</span>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:12, color:COLORS.textSec }}>{item.qty}{item.unit ? " " + item.unit : ""}</div>
                    <div style={{ fontSize:10, color:COLORS.red }}>{item.reason}</div>
                  </div>
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
function PantryTab({ pantry, setPantry }) {
  const [storageFilter, setStorageFilter] = useState("all");
  const [editId, setEditId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name:"", qty:1, unit:"pcs", floor:0, storage:"dry", store:"" });

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
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>
        {pantry.filter(p => p.floor > 0 && p.qty <= p.floor).length} at or below floor
      </div>

      <div style={{ display:"flex", gap:4, marginBottom:12, flexWrap:"wrap" }}>
        <Btn small variant={storageFilter==="all"?"primary":"ghost"} onClick={() => setStorageFilter("all")}>All</Btn>
        {Object.entries(SC).map(([key, sc]) => (
          <Btn key={key} small variant={storageFilter===key?"primary":"ghost"} onClick={() => setStorageFilter(key)} style={storageFilter===key?{ background:sc.fg }:{ color:sc.fg, borderColor:sc.fg }}>{sc.label} ({counts[key]||0})</Btn>
        ))}
      </div>

      {showAdd && (
        <Card style={{ border:`2px solid ${COLORS.primary}`, marginBottom:12 }}>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <input placeholder="Item name" value={addForm.name} onChange={e => setAddForm(p => ({ ...p, name: e.target.value }))} style={{ padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:14 }} />
            <div style={{ display:"flex", gap:8 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:2 }}>Qty</div>
                <input type="number" value={addForm.qty} onChange={e => setAddForm(p => ({ ...p, qty: +e.target.value }))} style={{ width:"100%", padding:"6px 8px", borderRadius:5, border:`1px solid ${COLORS.border}`, fontSize:13, boxSizing:"border-box" }} />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:2 }}>Unit</div>
                <Combobox options={UNITS.filter(Boolean)} value={addForm.unit} onChange={v => setAddForm(p => ({ ...p, unit: v }))} placeholder="unit" />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:10, color:COLORS.textSec, fontWeight:600, marginBottom:2 }}>Floor</div>
                <input type="number" value={addForm.floor} onChange={e => setAddForm(p => ({ ...p, floor: +e.target.value }))} style={{ width:"100%", padding:"6px 8px", borderRadius:5, border:`1px solid ${COLORS.border}`, fontSize:13, boxSizing:"border-box" }} />
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
                    <input type="number" value={item.qty} onChange={e => updateItem(item.id, { qty: Math.max(0, +e.target.value) })} style={{ width:56, padding:"5px 6px", borderRadius:5, border:`1.5px solid ${COLORS.border}`, fontSize:14, textAlign:"center", fontWeight:600 }} />
                  </div>
                  <div>
                    <div style={{ fontSize:10, fontWeight:600, color:COLORS.textSec, marginBottom:2 }}>Floor</div>
                    <input type="number" value={item.floor} onChange={e => updateItem(item.id, { floor: Math.max(0, +e.target.value) })} style={{ width:56, padding:"5px 6px", borderRadius:5, border:`1.5px solid ${below?COLORS.quarantine:COLORS.border}`, fontSize:14, textAlign:"center", fontWeight:600 }} />
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
    </div>
  );
}

// ============================================================
// SETTINGS TAB
// ============================================================
function SettingsTab({ settings, setSettings }) {
  const [section, setSection] = useState("weights");
  const update = (key, val) => setSettings(prev => ({ ...prev, [key]: val }));

  return (
    <div>
      <div style={{ display:"flex", gap:4, marginBottom:14, flexWrap:"wrap" }}>
        {[["weights","Tag Weights"],["targets","Meal Targets"],["ranges","Ranges"],["redlist","Red List"],["excludes","Excludes"],["boosts","Boosts"],["data","Data"]].map(([k, l]) => (
          <Btn key={k} small variant={section===k?"primary":"ghost"} onClick={() => setSection(k)}>{l}</Btn>
        ))}
      </div>

      {section === "weights" && <TagWeightsSection tagWeights={settings.tagWeights} onChange={v => update("tagWeights", v)} />}
      {section === "targets" && <MealTargetsSection targets={settings.mealTargets} onChange={v => update("mealTargets", v)} />}
      {section === "ranges" && <RangesSection ranges={settings.ranges} onChange={v => update("ranges", v)} tagWeights={settings.tagWeights} />}
      {section === "redlist" && <RedListSection redList={settings.redList} onChange={v => update("redList", v)} />}
      {section === "excludes" && <ExcludesSection excludes={settings.excludes} onChange={v => update("excludes", v)} />}
      {section === "boosts" && <BoostsSection boosts={settings.boosts} onChange={v => update("boosts", v)} />}
      {section === "data" && <DataSection />}
    </div>
  );
}

function TagWeightsSection({ tagWeights, onChange }) {
  const [newTag, setNewTag] = useState("");
  const entries = Object.entries(tagWeights).sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>Weight per tag — drives randomization probability</div>
      {entries.map(([tag, w]) => (
        <div key={tag} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
          <span style={{ fontSize:13, fontWeight:600, minWidth:80 }}>{tag}</span>
          <div style={{ flex:1, height:6, borderRadius:3, background:COLORS.border }}>
            <div style={{ width:`${w}%`, height:6, borderRadius:3, background:COLORS.primary }} />
          </div>
          <input type="number" value={w} onChange={e => onChange({ ...tagWeights, [tag]: Math.max(0, Math.min(100, +e.target.value)) })} style={{ width:44, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:12, textAlign:"center" }} />
          <span style={{ fontSize:13, cursor:"pointer", color:COLORS.red }} onClick={() => { const next = { ...tagWeights }; delete next[tag]; onChange(next); }}>×</span>
        </div>
      ))}
      <div style={{ display:"flex", gap:6, marginTop:8 }}>
        <input value={newTag} onChange={e => setNewTag(e.target.value)} placeholder="New tag..." style={{ flex:1, padding:"6px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
        <Btn small onClick={() => { if (newTag.trim()) { onChange({ ...tagWeights, [newTag.toLowerCase().trim()]: 15 }); setNewTag(""); } }}>Add</Btn>
      </div>
    </div>
  );
}

function MealTargetsSection({ targets, onChange }) {
  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>Target tag-score range per meal type</div>
      {MEALS.map(m => {
        const t = targets[m] || { min:50, max:80 };
        return (
          <div key={m} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10, padding:"10px 12px", borderRadius:8, background:COLORS.surface }}>
            <div style={{ width:4, height:32, borderRadius:2, background:MC[m].fg }} />
            <span style={{ fontSize:14, fontWeight:700, color:MC[m].fg, minWidth:80 }}>{m}</span>
            <input type="number" value={t.min} onChange={e => onChange({ ...targets, [m]: { ...t, min: +e.target.value } })} style={{ width:50, padding:"4px 6px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
            <span style={{ color:COLORS.textSec }}>–</span>
            <input type="number" value={t.max} onChange={e => onChange({ ...targets, [m]: { ...t, max: +e.target.value } })} style={{ width:50, padding:"4px 6px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
          </div>
        );
      })}
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
          <input type="number" value={r.min} onChange={e => { const nr = [...ranges]; nr[i] = { ...r, min: +e.target.value }; onChange(nr); }} style={{ width:40, padding:"4px 6px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
          <span style={{ color:COLORS.textSec }}>–</span>
          <input type="number" value={r.max} onChange={e => { const nr = [...ranges]; nr[i] = { ...r, max: +e.target.value }; onChange(nr); }} style={{ width:40, padding:"4px 6px", borderRadius:4, border:`1px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
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

function ExcludesSection({ excludes, onChange }) {
  const [newIng, setNewIng] = useState("");
  const [newDays, setNewDays] = useState(14);
  const now = Date.now();
  const active = excludes.filter(e => e.expiresAt > now);
  return (
    <div>
      <div style={{ fontSize:12, color:COLORS.textSec, marginBottom:10 }}>Hard-excluded with expiry</div>
      {active.map((ex, i) => {
        const daysLeft = Math.ceil((ex.expiresAt - now) / 86400000);
        return (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8, padding:"10px 12px", borderRadius:8, background:COLORS.surface }}>
            <span style={{ fontSize:13, fontWeight:600, flex:1 }}>{ex.ingredient}</span>
            <Badge color={COLORS.red} bg={COLORS.quarantineBg}>{daysLeft}d left</Badge>
            <Btn small variant="ghost" style={{ fontSize:11, padding:"3px 8px" }} onClick={() => onChange(excludes.filter((_, j) => j !== i))}>Lift</Btn>
          </div>
        );
      })}
      <div style={{ display:"flex", gap:6, marginTop:10, flexWrap:"wrap" }}>
        <input value={newIng} onChange={e => setNewIng(e.target.value)} placeholder="Ingredient..." style={{ flex:1, minWidth:100, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
        <input type="number" value={newDays} onChange={e => setNewDays(+e.target.value)} style={{ width:60, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
        <Btn small onClick={() => { if (newIng.trim()) { onChange([...excludes, { ingredient: normalize(newIng), expiresAt: now + newDays * 86400000 }]); setNewIng(""); } }}>Exclude</Btn>
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
          <input type="number" value={b.weight} onChange={e => { const nb = [...boosts]; nb[i] = { ...b, weight: +e.target.value }; onChange(nb); }} style={{ width:44, padding:"3px 5px", borderRadius:4, border:`1px solid ${COLORS.boost}40`, fontSize:12, textAlign:"center" }} />
          <span style={{ fontSize:10, color:COLORS.boost }}>%</span>
          <Btn small variant="ghost" style={{ fontSize:11, padding:"3px 8px", color:COLORS.boost, borderColor:COLORS.boost }} onClick={() => onChange(boosts.filter((_, j) => j !== i))}>×</Btn>
        </div>
      ))}
      <div style={{ display:"flex", gap:6, marginTop:10 }}>
        <input value={newItem} onChange={e => setNewItem(e.target.value)} placeholder="Tag or ingredient..." style={{ flex:1, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13 }} />
        <input type="number" value={newWeight} onChange={e => setNewWeight(+e.target.value)} style={{ width:50, padding:"8px 10px", borderRadius:6, border:`1.5px solid ${COLORS.border}`, fontSize:13, textAlign:"center" }} />
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
const DEFAULT_SETTINGS = {
  tagWeights: { chicken:30, beef:25, salad:12, pasta:18, seafood:15, soup:10, grain:14, curry:20, vegetarian:10, pastry:8 },
  mealTargets: { Breakfast:{ min:40, max:80 }, Lunch:{ min:80, max:120 }, Dinner:{ min:50, max:90 } },
  ranges: [],
  redList: [],
  excludes: [],
  boosts: [],
};

const emptyPlan = () => {
  const p = {};
  DAYS.forEach(d => { p[d] = {}; MEALS.forEach(m => { p[d][m] = null; }); });
  return p;
};

export default function App() {
  const [tab, setTab] = useState("Recipes");
  const [recipes, setRecipesRaw] = useState(() => load("recipes", []));
  const [pantry, setPantryRaw] = useState(() => load("pantry", []));
  const [plan, setPlanRaw] = useState(() => load("plan", emptyPlan()));
  const [settings, setSettingsRaw] = useState(() => load("settings", DEFAULT_SETTINGS));
  const [dictionary, setDictionaryRaw] = useState(() => load("dictionary", []));

  const setRecipes = useCallback(v => { const val = typeof v === "function" ? v(recipes) : v; setRecipesRaw(val); save("recipes", val); }, [recipes]);
  const setPantry = useCallback(v => { const val = typeof v === "function" ? v(pantry) : v; setPantryRaw(val); save("pantry", val); }, [pantry]);
  const setPlan = useCallback(v => { const val = typeof v === "function" ? v(plan) : v; setPlanRaw(val); save("plan", val); }, [plan]);
  const setSettings = useCallback(v => { const val = typeof v === "function" ? v(settings) : v; setSettingsRaw(val); save("settings", val); }, [settings]);
  const setDictionary = useCallback(v => { const val = typeof v === "function" ? v(dictionary) : v; setDictionaryRaw(val); save("dictionary", val); }, [dictionary]);

  return (
    <div style={{ minHeight:"100vh", background:COLORS.bg, fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color:COLORS.text, display:"flex", flexDirection:"column" }}>
      <div style={{ padding:"14px 16px 10px", borderBottom:`1px solid ${COLORS.border}`, background:COLORS.bg, position:"sticky", top:0, zIndex:15 }}>
        <div style={{ fontSize:20, fontWeight:800, color:COLORS.primary, letterSpacing:-0.5 }}>Prep</div>
      </div>
      <div style={{ flex:1, padding:"12px 16px 90px", overflowY:"auto" }}>
        {tab === "Recipes" && <RecipesTab recipes={recipes} setRecipes={setRecipes} settings={settings} dictionary={dictionary} setDictionary={setDictionary} />}
        {tab === "Plan" && <PlanTab recipes={recipes} setRecipes={setRecipes} plan={plan} setPlan={setPlan} settings={settings} />}
        {tab === "Shop" && <ShopTab plan={plan} recipes={recipes} pantry={pantry} />}
        {tab === "Pantry" && <PantryTab pantry={pantry} setPantry={setPantry} />}
        {tab === "Settings" && <SettingsTab settings={settings} setSettings={setSettings} />}
      </div>
      <div style={{ position:"fixed", bottom:0, left:0, right:0, display:"flex", justifyContent:"space-around", padding:"8px 0 max(12px, env(safe-area-inset-bottom))", background:COLORS.bg, borderTop:`1px solid ${COLORS.border}`, zIndex:20 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2, background:"none", border:"none", color:tab===t?COLORS.primary:COLORS.textSec, fontSize:10, fontWeight:tab===t?700:500, cursor:"pointer", padding:"2px 8px", minWidth:44 }}>
            {TAB_ICONS[t]}{t}
          </button>
        ))}
      </div>
    </div>
  );
}
