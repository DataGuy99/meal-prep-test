# Prep — Ingredient Normalization Schema (rebuild spec)

## The core problem this fixes
Today, ingredient names are stored as dirty strings ("tablespoon all purpose flour",
"tb soy", "to 4 clove"). Every surface — cook, shop, pantry — RE-PARSES these strings
at display time, each guessing differently. Result: garlic shows as ×43, 180 g, AND
8 tsp simultaneously; artifacts never die; doubling everywhere.

## The fix: parse ONCE at entry, store structured, never re-parse
A recipe ingredient stops being a string and becomes a structured object. All
downstream code reads the structured fields. Nothing re-derives from the raw text.

## The Ingredient object (the schema)
```
{
  raw:        "2 tablespoon all purpose flour",  // original text, kept for reference/display
  qty:        2,            // numeric quantity (already evaluated: fractions, ranges resolved)
  unit:       "tbsp",       // canonical short unit, or "" for bare count
  family:     "volume",     // "mass" | "volume" | "count"  — drives conversion
  item:       "flour",      // CANONICAL item identity (merge key) — lowercase, singular
  itemDisplay:"all purpose flour", // what to show the user (nicer than canonical)
  tier:       "essential",  // "essential" | "secondary"
  confirmed:  true,         // user verified this at entry time (review step)
  // --- derived / cached for convenience, computed once ---
  baseQty:    29.57,        // qty in base units (g for mass, ml for volume, singles for count)
}
```

### Field rules
- **raw**: never mutated after entry. Used for the "as written" display option.
- **qty**: always a number. Fractions (½), mixed (1 1/2), ranges (3 to 4 → 4) resolved at entry.
- **unit**: one of the canonical units below, or "" for bare count.
- **family**: derived from unit. Determines what can convert/merge with what.
- **item**: the canonical merge key. "low sodium soy sauce" → "soy sauce". This is what
  shop sums by and what pantry matches against.
- **itemDisplay**: human label. Defaults to the cleaned name; user can keep the nicer form.
- **confirmed**: true once the user has seen it in the entry-review step. Migrated legacy
  ingredients are confirmed=false until the user reviews (but still usable).

## Canonical units & families
```
mass:   g(1), kg(1000), oz(28.3495), lb(453.592)
volume: ml(1), l(1000), tsp(4.92892), tbsp(14.7868), cup(236.588)
count:  "" or pcs/whole/each/clove/etc (factor 1), dozen(12), pair(2)
```
Base units: mass→g, volume→ml, count→singles.

## Conversion (the "alternatives in the background")
Because every ingredient stores `family` + `baseQty`, ANY surface can display it in
any unit of the same family on demand:
- 200 g flour → also 0.44 lb, 7.05 oz  (mass family)
- 250 ml milk → also 1.06 cup, 16.9 tbsp (volume family)
No re-parsing needed — just multiply baseQty by the target unit's factor.

## Locked design decisions (from review)
1. **Display: NORMALIZED by default.** Show "2 tbsp flour", not the raw paste. Raw kept for reference only.
2. **Shopping composition display** — canonical headline + indented breakdown:
   ```
   soy sauce — 60 g
      10 g  low sodium
      50 g  yuzu
   ```
3. **Entry review: CONFIRM-ALL.** Every ingredient is eyeballed + confirmed when adding a recipe.
6. **Unconfirmed (migrated) items: SUBTLE nudge** (a small dot), never a banner.

## #4 — "sold as": per-item count vs weight  (LOCKED)
Each item carries `soldAs: "count" | "weight"`. This decides DISPLAY direction:
- **count items** (carrot, onion, apple, bell pepper...): recipe 800 g carrots → show "~13 carrots", buy in counts.
- **weight items** (beef, rice, flour, sugar, spices...): recipe 500 g → show "500 g", buy by weight.
The AVG_WEIGHT table enables the count↔mass conversion; `soldAs` picks which way to show it.

## #5 — three-tier merging  (LOCKED)
1. **Auto-fold known equivalences.** Fixed, knowable sub-unit ratios fold confidently:
   - garlic: 1 head ≈ 10 cloves → 5 recipes × 2-3 cloves → "buy 2 heads (need ~1.5)"
   - eggs: 1 dozen = 12; curated families (low-sodium/light/dark soy sauce → soy sauce)
2. **Leave ambiguous units untouched.** No knowable size → never guess:
   - "can" (8/12/16 oz?), "bunch", "package", "jar" — keep as written, do not merge.
3. **User-offered manual merge.** For ambiguous/unique items, show a merge button so the
   user folds "these two are the same" themselves. The app never presumes on ambiguous units.

## count ↔ weight bridge
```
AVG_WEIGHT = { carrot: 61, onion: 110, potato: 170, ... }  // grams per whole item
SUB_UNIT   = { garlic: { clove: 5, head: 50 } }            // fixed sub-unit weights
```
"800 g carrots" → ~13 carrots; garlic ×43 cloves + 180 g + 8 tsp all convert to grams and
sum to ONE line. Shop says "buy ~13 carrots". Table editable; pantry can override later.

## Entry-time review flow (the "take 2 extra seconds" step)
When adding/editing a recipe, after the user pastes ingredients, show a review list.
For each parsed ingredient:
1. Show: qty | unit | item, with the raw text underneath.
2. If item name is close to a known item → "Did you mean <X>?" (accept / it's its own thing).
3. Unit dropdown: defaults to the parsed unit; user can change.
4. Confirm. Once confirmed, it's locked in clean forever.
Headers ("for the sauce") and never-buy (water) are auto-flagged/removed here.

## Data flow (one direction, no re-parsing)
```
RECIPE ENTRY  ──parse+normalize+review──►  structured Ingredient[]  (stored on recipe)
                                                  │
                         ┌────────────────────────┼────────────────────────┐
                         ▼                         ▼                        ▼
                   PLAN (cook)               SHOP (generate)           PANTRY (match)
              reads item/qty/family      sums baseQty by item        matches by `item`
              deducts from pantry        converts to nice unit       same schema
              shows raw OR normalized     (produce→count)            manual adds use schema
```
- **Pantry** stores items in the SAME schema. Manual adds go through the same normalizer.
- **Shop** never parses. It reads `item` (already canonical) + `baseQty` + `family`,
  subtracts pantry `baseQty`, and prints in the best unit (produce in counts).
- **Cook** reads structured fields; deduction is baseQty math. No string guessing.

## Backward compatibility (Dana's recipes are NOT dead)
Migration `upgradeIngredient(oldIng)`:
1. Take old `{qty, unit, name}` (or compound string).
2. Run it through the normalizer ONCE to produce the new schema object.
3. Set `confirmed: false` (so the UI can gently prompt review, but it WORKS immediately).
4. Keep `raw` = best reconstruction of the original.
Nothing is deleted. Worst case, the user re-confirms items via the review step.
Even fully manual re-assignment is fine — recipes are preserved, just flagged unconfirmed.

## Why the blank-recipe bug probably fits here
An empty install (no recipes, empty dictionary) likely hits a code path that a
populated install skips — e.g. `findMatch` against an empty dictionary, or a parse
step that throws on first-run. The rebuild's normalizer will be defensive against
empty state, so this gets fixed as part of the same work.
