// Matching a repair vehicle to the rental class an insurer or body shop
// would replace it with: like for like, by the kind of vehicle it is. The
// partner portal (partner.js) uses it; the partner can always change it.
// No imports, so partner_match.test.mjs can run it in node.

const LUXURY_MAKES = ["acura", "audi", "bmw", "cadillac", "genesis", "infiniti", "jaguar", "land rover", "lexus", "lincoln",
  "maserati", "mercedes-benz", "mercedes", "porsche", "volvo", "alfa romeo", "range rover"];
const ELECTRIC_MAKES = ["tesla", "polestar", "rivian", "lucid"];
const ELECTRIC_MODELS = ["bolt", "leaf", "ioniq 5", "ioniq 6", "ev6", "ev9", "mach-e", "id.4", "kona electric", "niro ev", "model 3", "model y", "solterra", "bz4x", "lyriq", "equinox ev", "blazer ev", "prologue", "i4", "ix", "e-tron", "q8 e-tron"];
// Electric crossovers, which have no body class until a VIN is read.
const ELECTRIC_SUVS = ["ev6", "ev9", "ioniq 5", "model y", "model x", "mach-e", "id.4", "bz4x", "solterra", "lyriq", "equinox ev", "blazer ev", "prologue", "ix", "e-tron", "q8 e-tron", "kona electric", "niro ev", "r1s"];
const PICKUPS = ["f-150", "f150", "f-250", "f-350", "silverado", "sierra", "ram", "1500", "2500", "tacoma", "tundra", "frontier", "titan", "ranger", "colorado", "canyon", "ridgeline", "gladiator", "maverick", "santa cruz"];
const MINIVANS = ["sienna", "odyssey", "pacifica", "grand caravan", "caravan", "carnival", "sedona", "voyager", "quest"];
const CARGO_VANS = ["transit", "promaster", "sprinter", "express", "savana", "nv200", "nv1500", "nv2500", "metris", "transit connect", "promaster city"];
const SMALL_SUVS = ["hr-v", "cx-30", "cx-3", "kona", "venue", "seltos", "soul", "trax", "trailblazer", "encore", "ecosport", "kicks", "qashqai", "crosstrek", "c-hr", "corolla cross", "renegade", "compass", "mx-30", "niro"];
const LARGE_SUVS = ["tahoe", "suburban", "yukon", "expedition", "sequoia", "armada", "pilot", "highlander", "telluride", "palisade", "atlas", "ascent", "traverse", "explorer", "durango", "grand cherokee l", "4runner", "pathfinder", "cx-90", "enclave", "acadia"];
const SUVS = ["cr-v", "rav4", "rogue", "escape", "equinox", "tucson", "sportage", "cx-5", "forester", "outback", "edge", "santa fe", "sorento", "murano", "blazer", "terrain", "cherokee", "grand cherokee", "tiguan", "passport", "bronco", "wrangler", "cx-50", "x-trail"];
const SMALL_CARS = ["civic", "corolla", "elantra", "forte", "sentra", "mazda3", "mazda 3", "3", "jetta", "golf", "impreza", "versa", "accent", "rio", "yaris", "fit", "spark", "mirage", "cruze", "focus", "fiesta", "k5 gt-line"];
const MEDIUM_CARS = ["camry", "accord", "altima", "sonata", "k5", "optima", "malibu", "fusion", "mazda6", "mazda 6", "6", "passat", "legacy", "prius", "insight"];
const LARGE_CARS = ["charger", "300", "avalon", "impala", "taurus", "maxima", "cadenza", "k900", "challenger"];

const norm = (s) => String(s || "").trim().toLowerCase();
const hasModel = (list, model) => list.some((m) => model === m || model.startsWith(`${m} `) || model.startsWith(`${m}-`));

// The kind of vehicle, from what the partner typed or a VIN decode
// (NHTSA's BodyClass): suv, pickup, minivan, van or car, and its size.
export function repairVehicleKind({ make, model, bodyClass, electric } = {}) {
  const mk = norm(make), md = norm(model), body = norm(bodyClass);
  const isElectric = !!electric || ELECTRIC_MAKES.includes(mk) || hasModel(ELECTRIC_MODELS, md);
  const isLuxury = LUXURY_MAKES.includes(mk);
  let kind = "car";
  if (/pickup/.test(body) || hasModel(PICKUPS, md)) kind = "pickup";
  else if (/minivan/.test(body) || hasModel(MINIVANS, md)) kind = "minivan";
  else if (/\bvan\b|cargo/.test(body) || hasModel(CARGO_VANS, md)) kind = "van";
  else if (/sport utility|suv|crossover|multi-purpose/.test(body) || hasModel(SMALL_SUVS, md) || hasModel(LARGE_SUVS, md) || hasModel(SUVS, md) || hasModel(ELECTRIC_SUVS, md)) kind = "suv";
  let size = "medium";
  if (kind === "suv") size = hasModel(SMALL_SUVS, md) ? "small" : hasModel(LARGE_SUVS, md) ? "large" : "medium";
  if (kind === "car") size = hasModel(SMALL_CARS, md) ? "small" : hasModel(LARGE_CARS, md) ? "large" : "medium";
  return { kind, size, luxury: isLuxury, electric: isElectric };
}

// The company's class that best replaces it. classes: [{ id, name, category,
// luxury, electric, seats }] as the portal has them. Tries the exact kind and
// size first, then nearby ones, then any class of the same category.
export function matchClass(vehicle, classes) {
  const list = (classes || []).filter(Boolean);
  if (!list.length) return null;
  const k = repairVehicleKind(vehicle);
  const byName = (name) => list.find((c) => norm(c.name) === name) || null;
  const wanted = [];
  const sizes = k.size === "small" ? ["small", "medium", "large"] : k.size === "large" ? ["large", "medium", "small"] : ["medium", "large", "small"];
  if (k.kind === "car") {
    if (k.electric) wanted.push("electric car");
    if (k.luxury) wanted.push("luxury car", "premium car");
    sizes.forEach((s) => wanted.push(`${s} car`));
    wanted.push("compact car", "intermediate car", "full size car");
  } else if (k.kind === "suv") {
    if (k.electric) wanted.push("electric suv");
    if (k.luxury) wanted.push("luxury suv");
    sizes.forEach((s) => wanted.push(`${s} suv`));
    wanted.push("suv");
  } else if (k.kind === "pickup") wanted.push("pickup truck", "pickup", "truck");
  else if (k.kind === "minivan") wanted.push("minivan", "passenger van");
  else if (k.kind === "van") wanted.push("cargo van", "passenger van", "minivan");
  for (const w of wanted) { const c = byName(w); if (c) return c; }
  const category = { car: "car", suv: "suv", pickup: "truck", minivan: "minivan", van: "van" }[k.kind];
  return list.find((c) => norm(c.category) === category) || list[0];
}
