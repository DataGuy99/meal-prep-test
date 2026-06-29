// ITEM_DB — the default knowledge base for ingredient normalization.
// Each entry: how the item is sold (count vs weight) and, for count items,
// the average weight of one whole unit in grams (enables count<->mass bridge).
//
// soldAs "count"  -> display/buy as whole items; recipe grams convert via avgG.
// soldAs "weight" -> display/buy by weight; never convert to a count.
//
// This is a STARTER set covering common Western + Korean-cooking ingredients
// (since the user's recipes lean Korean). Editable; pantry can override per item.

export const ITEM_DB = {
  // ---- PRODUCE: sold as whole items (count), with avg weight per item (g) ----
  carrot:            { soldAs: "count", avgG: 61,  cat: "Produce" },
  onion:             { soldAs: "count", avgG: 110, cat: "Produce" },
  "green onion":     { soldAs: "count", avgG: 15,  cat: "Produce" },  // one stalk
  "red onion":       { soldAs: "count", avgG: 110, cat: "Produce" },
  potato:            { soldAs: "count", avgG: 170, cat: "Produce" },
  "sweet potato":    { soldAs: "count", avgG: 130, cat: "Produce" },
  tomato:            { soldAs: "count", avgG: 123, cat: "Produce" },
  cucumber:          { soldAs: "count", avgG: 200, cat: "Produce" },
  zucchini:          { soldAs: "count", avgG: 196, cat: "Produce" },
  "korean zucchini": { soldAs: "count", avgG: 250, cat: "Produce" },
  "bell pepper":     { soldAs: "count", avgG: 119, cat: "Produce" },
  "red bell pepper": { soldAs: "count", avgG: 119, cat: "Produce" },
  "green bell pepper":{ soldAs: "count", avgG: 119, cat: "Produce" },
  apple:             { soldAs: "count", avgG: 182, cat: "Produce" },
  "asian pear":      { soldAs: "count", avgG: 300, cat: "Produce" },
  pear:              { soldAs: "count", avgG: 178, cat: "Produce" },
  lemon:             { soldAs: "count", avgG: 84,  cat: "Produce" },
  lime:              { soldAs: "count", avgG: 67,  cat: "Produce" },
  avocado:           { soldAs: "count", avgG: 170, cat: "Produce" },
  eggplant:          { soldAs: "count", avgG: 250, cat: "Produce" },
  radish:            { soldAs: "count", avgG: 100, cat: "Produce" },
  "korean radish":   { soldAs: "count", avgG: 800, cat: "Produce" },  // mu, large
  "daikon radish":   { soldAs: "count", avgG: 800, cat: "Produce" },
  beet:              { soldAs: "count", avgG: 110, cat: "Produce" },
  parsnip:           { soldAs: "count", avgG: 130, cat: "Produce" },
  turnip:            { soldAs: "count", avgG: 120, cat: "Produce" },
  "lotus root":      { soldAs: "weight", cat: "Produce" }, // sold by weight/segment
  cabbage:           { soldAs: "count", avgG: 900, cat: "Produce" },
  "napa cabbage":    { soldAs: "count", avgG: 1100,cat: "Produce" },
  lettuce:           { soldAs: "count", avgG: 600, cat: "Produce" }, // a head
  broccoli:          { soldAs: "count", avgG: 600, cat: "Produce" }, // a head
  cauliflower:       { soldAs: "count", avgG: 850, cat: "Produce" },
  corn:              { soldAs: "count", avgG: 150, cat: "Produce" }, // an ear

  // count items that are really clusters/bunches — leave soldAs count, avg per unit
  "shiitake mushroom":{ soldAs: "count", avgG: 19, cat: "Produce" },
  "king oyster mushroom":{ soldAs: "count", avgG: 90, cat: "Produce" },
  "beech mushroom":  { soldAs: "weight", cat: "Produce" }, // sold by pack
  mushroom:          { soldAs: "count", avgG: 18, cat: "Produce" },

  // herbs/aromatics commonly sold as bunches -> weight (ambiguous count)
  cilantro:          { soldAs: "weight", cat: "Produce" },
  parsley:           { soldAs: "weight", cat: "Produce" },
  dill:              { soldAs: "weight", cat: "Produce" },
  ginger:            { soldAs: "weight", cat: "Produce" },  // by knob/weight
  "green chili":     { soldAs: "count", avgG: 15, cat: "Produce" },
  "cayenne chili":   { soldAs: "count", avgG: 15, cat: "Produce" },

  // garlic: special — sold as heads, used as cloves. SUB_UNIT handles the ratio.
  garlic:            { soldAs: "count", avgG: 50, cat: "Produce", unitWord: "head" },

  // ---- MEAT/SEAFOOD: sold by weight ----
  beef:              { soldAs: "weight", cat: "Meat" },
  "ground beef":     { soldAs: "weight", cat: "Meat" },
  steak:             { soldAs: "weight", cat: "Meat" },
  pork:              { soldAs: "weight", cat: "Meat" },
  "chicken breast":  { soldAs: "weight", cat: "Meat" },
  "chicken thigh":   { soldAs: "weight", cat: "Meat" },
  chicken:           { soldAs: "weight", cat: "Meat" },
  bacon:             { soldAs: "weight", cat: "Meat" },
  salami:            { soldAs: "weight", cat: "Meat" },
  anchovy:           { soldAs: "weight", cat: "Seafood" },
  "fish cake":       { soldAs: "weight", cat: "Seafood" },
  "canned tuna":     { soldAs: "count", avgG: 142, cat: "Seafood" }, // a can
  "crab stick":      { soldAs: "weight", cat: "Seafood" },
  shrimp:            { soldAs: "weight", cat: "Seafood" },
  salmon:            { soldAs: "weight", cat: "Seafood" },
  egg:               { soldAs: "count", avgG: 50, cat: "Dairy", unitWord: "dozen" },

  // ---- PANTRY DRY: sold by weight ----
  rice:              { soldAs: "weight", cat: "Pantry" },
  "white rice":      { soldAs: "weight", cat: "Pantry" },
  flour:             { soldAs: "weight", cat: "Pantry" },
  sugar:             { soldAs: "weight", cat: "Pantry" },
  "brown sugar":     { soldAs: "weight", cat: "Pantry" },
  salt:              { soldAs: "weight", cat: "Spices" },
  "potato starch":   { soldAs: "weight", cat: "Pantry" },
  cornstarch:        { soldAs: "weight", cat: "Pantry" },
  panko:             { soldAs: "weight", cat: "Bakery" },
  breadcrumb:        { soldAs: "weight", cat: "Bakery" },
  "kelp noodle":     { soldAs: "weight", cat: "Pantry" },
  noodle:            { soldAs: "weight", cat: "Pantry" },

  // ---- spices: by weight (small) ----
  "black pepper":    { soldAs: "weight", cat: "Spices" },
  "white pepper":    { soldAs: "weight", cat: "Spices" },
  pepper:            { soldAs: "weight", cat: "Spices" },
  cumin:             { soldAs: "weight", cat: "Spices" },
  coriander:         { soldAs: "weight", cat: "Spices" },
  cinnamon:          { soldAs: "weight", cat: "Spices" },
  clove:             { soldAs: "weight", cat: "Spices" },
  cardamom:          { soldAs: "weight", cat: "Spices" },
  paprika:           { soldAs: "weight", cat: "Spices" },
  "sesame seed":     { soldAs: "weight", cat: "Spices" },
  "kasuri methi":    { soldAs: "weight", cat: "Spices" },

  // ---- liquids/condiments: by volume, sold in bottles (leave as volume) ----
  "soy sauce":       { soldAs: "weight", cat: "Pantry" },
  mirin:             { soldAs: "weight", cat: "Pantry" },
  "rice wine":       { soldAs: "weight", cat: "Beverages" },
  "sweet rice wine": { soldAs: "weight", cat: "Beverages" },
  "rice wine vinegar":{ soldAs: "weight", cat: "Beverages" },
  "rice vinegar":    { soldAs: "weight", cat: "Pantry" },
  vinegar:           { soldAs: "weight", cat: "Pantry" },
  "olive oil":       { soldAs: "weight", cat: "Pantry" },
  "sesame oil":      { soldAs: "weight", cat: "Pantry" },
  oil:               { soldAs: "weight", cat: "Pantry" },
  "oyster sauce":    { soldAs: "weight", cat: "Pantry" },
  "fish sauce":      { soldAs: "weight", cat: "Pantry" },
  mayonnaise:        { soldAs: "weight", cat: "Pantry" },
  ketchup:           { soldAs: "weight", cat: "Pantry" },
  mustard:           { soldAs: "weight", cat: "Pantry" },
  honey:             { soldAs: "weight", cat: "Pantry" },
  gochujang:         { soldAs: "weight", cat: "Pantry" },
  doenjang:          { soldAs: "weight", cat: "Pantry" },
  "coconut milk":    { soldAs: "weight", cat: "Dairy" },
  milk:              { soldAs: "weight", cat: "Dairy" },
  cream:             { soldAs: "weight", cat: "Dairy" },
  "heavy cream":     { soldAs: "weight", cat: "Dairy" },
  cheese:            { soldAs: "weight", cat: "Dairy" },
  butter:            { soldAs: "weight", cat: "Dairy" },
  tofu:              { soldAs: "weight", cat: "Produce" }, // by block/weight
  broth:             { soldAs: "weight", cat: "Pantry" },
  "chicken broth":   { soldAs: "weight", cat: "Pantry" },
  stock:             { soldAs: "weight", cat: "Pantry" },
};

// Fixed sub-unit ratios — where a smaller unit maps to a whole at a known rate.
// Lets "cloves" fold into "heads": 10 cloves = 1 head of garlic.
export const SUB_UNIT = {
  garlic: { clove: { perWhole: 10, g: 5 }, head: { perWhole: 1, g: 50 } },
};

// Units that are AMBIGUOUS in size — never auto-convert or merge these; offer
// the user a manual merge instead.
export const AMBIGUOUS_UNITS = new Set([
  "can", "cans", "package", "packages", "pack", "packs", "jar", "jars",
  "bunch", "bunches", "box", "boxes", "container", "containers", "sprig", "sprigs",
  "handful", "bag", "bags", "bottle", "bottles",
]);
