import React from "https://esm.sh/react@18.3.1";
import ReactDOM from "https://esm.sh/react-dom@18.3.1/client";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  HashRouter,
  useLocation,
  useNavigate,
} from "https://esm.sh/react-router-dom@6.26.2?deps=react@18.3.1,react-dom@18.3.1";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@1/+esm";

// ─── Supabase client ──────────────────────────────────────────────────────────
// Paste your Project URL and anon key from Supabase → Settings → API
const SUPABASE_URL  = "https://hzcatlecvwpqxedrzfog.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6Y2F0bGVjdndwcXhlZHJ6Zm9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNzQzMTMsImV4cCI6MjA5MzY1MDMxM30.mfqwWQh54hPsRunAVB6RDf_IrvwKmhSYWWJ4sMy0rcw";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── restHeaders: identity for the calls that bypass supabase-js ──────────────
// A few inserts go through raw fetch rather than the client, because v1 appends
// a `columns` query parameter on array inserts that 400s when any key is not a
// real column. Those calls still have to say who is making them.
//
// apikey stays the project key, which is what Supabase routes on. Authorization
// carries the session token. Sending the anon key there instead, which is what
// these did, makes the request arrive as an anonymous caller: harmless while no
// policy reads auth.uid(), and silently empty the moment one does.
//
// No fallback to the anon key. A write with no session is a bug, and returning
// headers that "work" would hide it until a policy turned the result into an
// empty array that looks like an ordinary quiet day.
function restHeaders(extra) {
  const session = supabase.auth.session();
  if (!session) throw new Error("restHeaders called with no session; the request would arrive anonymous");
  return {
    "apikey":        SUPABASE_ANON,
    "Authorization": `Bearer ${session.access_token}`,
    ...(extra || {}),
  };
}

// ─── Authentication ───────────────────────────────────────────────────────────
// Passwords are verified by Supabase Auth, never in this file. That is the
// whole point: the anon key above ships to every browser, so anything this code
// compares is something an attacker controls. Sign-in returns a signed JWT that
// the client cannot forge, and every later request carries it.
//
// Staff type a username, not an email. Supabase Auth authenticates by email, so
// the username is mapped onto a fixed non-routable domain. The alternative, a
// public username-to-email table, would let anyone enumerate staff.
const AUTH_EMAIL_DOMAIN = "fleetr.internal";

// Usernames are globally unique, enforced by a unique index on public.users
// rather than by anything here. That is what lets the address stay a plain
// username@domain and the login form stay two fields.
//
// The tradeoff is deliberate and matches locations.code: the first company to
// take a username keeps it, and a later company with its own connor has to
// pick something else. The alternative was namespacing the address by a
// location code typed at sign-in, which worked but put a third field in front
// of every staff member every shift to solve a collision that has not happened
// yet. Uniqueness in the database costs nothing until it does.
//
// Nothing outside this file needs to know the address exists. Staff type a
// username; the mapping to an email is an implementation detail of Supabase
// Auth authenticating by email.
const usernameToEmail = (u) => `${String(u || "").trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;

// A hard cap on how long a session lives, independent of Supabase's own token
// refresh. Refresh tokens would otherwise keep a session alive indefinitely,
// which is the wrong behaviour for a terminal on a branch counter.
const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // 12 hours
const PROFILE_KEY    = "fleetr_profile";

// The profile columns the app is allowed to hold. pinHash is deliberately
// absent: it never leaves the database, because a hash in the browser is a hash
// an attacker can take away and grind offline.
const PROFILE_COLUMNS = "id,username,name,role,operatorId,locationId,active";

async function fetchProfile() {
  // Filtered on the signed-in id, explicitly. This once relied on the row level
  // security policy being `id = auth.uid()` and took whatever single row came
  // back, but the staff panel and the Exec company screen added policies that
  // let Admins and Execs read other people's rows, and policies are OR'd. An
  // unfiltered `limit(1)` then returned an arbitrary colleague: a deactivated
  // one locked the account out with "Invalid credentials", and an active one
  // would have been adopted as the signed-in identity, role and all.
  const session = supabase.auth.session();
  if (!session || !session.user) return { ok: false, reason: "no_session" };
  const { data, error } = await supabase
    .from("users").select(PROFILE_COLUMNS).eq("id", session.user.id).limit(1);
  // The PostgREST message goes to the console, not the screen. It is the one
  // failure here that can carry a database word, and the person reading the
  // login form can do nothing with a policy name.
  if (error) {
    console.warn("Fleetr profile load failed:", error.message);
    return { ok: false, reason: "load_failed" };
  }
  const row = (data || [])[0];
  if (!row)        return { ok: false, reason: "no_profile" };
  if (!row.active) return { ok: false, reason: "deactivated" };
  return { ok: true, profile: row };
}

// What the login form is allowed to say. Everything except `credentials` is
// reached only after a correct password has already been proven, so naming the
// real problem gives away nothing a person did not just demonstrate they hold.
// Collapsing them into one string is what hid a live bug behind a wrong answer.
const LOGIN_REASONS = {
  credentials:  "Invalid credentials",
  no_session:   "Signed in, but the session carries no user. Try again.",
  load_failed:  "Signed in, but your account could not be loaded. Try again.",
  no_profile:   "Signed in, but no staff profile is linked to this account. Ask an administrator to add you.",
  deactivated:  "This account has been deactivated.",
  network:      "Could not reach the server.",
  // Carries the auth service's own wording when there is one. This entry is the
  // floor for the case where there is not.
  auth_other:   "Could not sign in. Try again.",
};
// An unrecognised reason must not fall back to "Invalid credentials". That is
// how the collapse this table exists to undo would grow back one reason at a
// time, each new failure quietly wearing the wrong answer.
const loginMessage = (reason) => LOGIN_REASONS[reason] || LOGIN_REASONS.auth_other;

// GoTrue answers a wrong password and a username that was never issued with
// byte-identical bodies, which is what keeps usernames from being enumerable.
// That is the only sign-in failure worth hiding, so it is matched narrowly
// rather than by assuming every authentication error means a bad password: a
// rate limit or a disabled provider told "Invalid credentials" sends someone to
// change a password that was right all along. The whole error is taken, not
// just its message, because which field carries the wording is supabase-js's
// business and has changed before; if the match ever misses, the fallback is a
// vaguer message and not a leak, there being nothing here to tell the two
// cases apart with anyway.
const isBadCredentials = (err) => {
  if (!err) return false;
  if (typeof err === "string") return /invalid login credentials/i.test(err);
  return err.error_code === "invalid_credentials" ||
         /invalid login credentials/i.test(String(err.message || err.msg || ""));
};

// Returns { ok, user } or { ok:false, reason, error }. Never throws. `reason`
// picks the message; `error` carries the detail for the console.
async function signInReal(username, password) {
  try {
    // supabase-js v1: signIn, not v2's signInWithPassword.
    const { error } = await supabase.auth.signIn({
      email:    usernameToEmail(username),
      password: password,
    });
    if (error) {
      if (isBadCredentials(error)) {
        return { ok: false, reason: "credentials", error: error.message };
      }
      // Something else went wrong in the auth service. Its own wording is more
      // use than ours would be, so it is shown as it stands.
      return { ok: false, reason: "auth_other", message: error.message, error: error.message };
    }

    const prof = await fetchProfile();
    if (!prof.ok) {
      // Authenticated but unusable. Do not leave a half-signed-in session.
      await supabase.auth.signOut();
      return { ok: false, reason: prof.reason, error: prof.reason };
    }
    // Never fails the sign-in. Flags that cannot be read leave every feature
    // off, the same answer as a company with no rows.
    await loadCompanyFeatures(prof.profile.operatorId);
    return { ok: true, user: prof.profile };
  } catch (e) {
    return { ok: false, reason: "network", error: e.message || String(e) };
  }
}

// Stores the profile alongside when the session began, so the 12 hour cap can
// be enforced on the next load. The JWT itself is managed by supabase-js.
function storeSession(user) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ user, loginAt: Date.now(), features: companyFeatures }));
  } catch (e) { console.warn("could not persist the session:", e); }
}

function readStoredSession() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const { user, loginAt, features } = JSON.parse(raw);
    if (!user || !loginAt) return null;
    if (Date.now() - loginAt > SESSION_MAX_MS) {
      console.log("Fleetr: session older than 12 hours, signing out.");
      return null;
    }
    // A stored profile is not a session on its own. Without a live Supabase
    // token behind it, it is just JSON someone could have typed into
    // localStorage, so it is refused.
    if (!supabase.auth.session()) return null;
    // Rebuilt rather than adopted, so only literal true survives. A profile
    // stored before features existed has none, and reads as all off.
    companyFeatures = toFeatureMap(Object.entries(features || {})
      .map(([featureKey, enabled]) => ({ featureKey, enabled })));
    return user;
  } catch (e) { return null; }
}

function clearSession() {
  companyFeatures = {};
  companyLists = null;
  try {
    localStorage.removeItem(PROFILE_KEY);
    // Left over from the previous scheme. Removed so a stale token cannot
    // outlive the mechanism that used it.
    localStorage.removeItem("fleetr_session");
    sessionStorage.removeItem("fleetr_tab_token");
  } catch (e) { /* storage unavailable, nothing to clear */ }
  return supabase.auth.signOut().catch((e) => console.warn("sign out:", e));
}

// ─── Company features ─────────────────────────────────────────────────────────
// Which optional features the signed-in person's company has switched on, as
// set by Fleetr in fleetr hq. Loaded once at sign-in and kept with the stored
// profile, so it survives a reload for the life of the session. A change made
// in hq therefore reaches a company at its staff's next sign-in, at most 12
// hours later.
//
// This decides what the app SHOWS, not what anyone can do. The copy lives in
// localStorage, where anyone at the keyboard can edit it, so a feature that has
// to be enforced must be enforced by the database as well.
let companyFeatures = {};

const toFeatureMap = (rows) =>
  Object.fromEntries((rows || []).map((r) => [r.featureKey, r.enabled === true]));

async function loadCompanyFeatures(operatorId) {
  companyFeatures = {};
  if (!operatorId) return;
  try {
    // Filtered on the company explicitly, for the reason fetchProfile filters
    // on the user: policies are OR'd, and a wider read policy added later would
    // otherwise pull another company's flags into this map.
    const { data, error } = await supabase
      .from("company_features").select("featureKey,enabled").eq("operatorId", operatorId);
    if (error) {
      console.warn("Fleetr: company features could not be loaded, all off:", error.message);
      return;
    }
    companyFeatures = toFeatureMap(data);
  } catch (e) {
    console.warn("Fleetr: company features could not be loaded, all off:", e.message || String(e));
  }
}

// True only for a key whose row says enabled. A missing row is off, the same
// default company_features and the hq toggles use.
function isFeatureEnabled(featureKey) {
  return Object.prototype.hasOwnProperty.call(companyFeatures, featureKey)
    && companyFeatures[featureKey] === true;
}

// ─── Company lists ────────────────────────────────────────────────────────────
// The pickup locations, vehicle classes, sources, specific sources, daily rates
// and protection products the company's Exec manages, read from the database
// with the rest of the data at start. null means they could not be read, and
// every helper below then answers from the constants this file has always
// carried, so a failed load looks exactly like the app did before.
//
// Records keep their own text copy of what they were saved with. A value that
// has since been renamed or switched off is still offered on the record that
// holds it, so opening and saving that record does not change it.
let companyLists = null;

const LIST_SEP = " \u2014 ";

const byListOrder = (a, b) =>
  ((a.sortOrder ?? 0) - (b.sortOrder ?? 0)) || String(a.name).localeCompare(String(b.name));

async function loadCompanyLists(user) {
  // The lists already in hand stay in place until the new ones have arrived.
  // This is also called after an Exec's edit, with the app on screen, and
  // clearing them first would flash every dropdown back to the built-in lists.
  const operatorId = user?.operatorId;
  if (!operatorId) { companyLists = null; return; }
  try {
    // Filtered on the company explicitly, as loadCompanyFeatures is.
    const own = (table, cols) => supabase.from(table).select(cols).eq("operatorId", operatorId);
    const results = await Promise.all([
      own("pickup_locations",    "id,locationId,name,code,active,sortOrder"),
      own("vehicle_classes",     "id,name,active,sortOrder"),
      own("sources",             "id,name,billingType,active,sortOrder"),
      own("source_details",      "id,sourceId,name,active"),
      own("daily_rates",         "vehicleClassId,sourceId,amount"),
      own("protection_products", "id,name,active,sortOrder,customerWording,declineWording,required"),
    ]);
    const failed = results.find((r) => r.error);
    if (failed) {
      companyLists = null;
      console.warn("Fleetr: company lists could not be loaded, using the built-in ones:", failed.error.message);
      return;
    }
    const [pl, vc, so, sd, dr, pp] = results.map((r) => r.data || []);
    // A company with no classes or no sources has not been set up. The
    // built-in lists are more use than two empty dropdowns.
    if (!vc.length || !so.length) {
      companyLists = null;
      console.warn("Fleetr: this company has no lists yet, using the built-in ones.");
      return;
    }

    // The branch a new reservation belongs to: the one an Exec is acting in,
    // or the staff member's own.
    let branchId = user.locationId || null;
    if (roleAtLeast(user.role, "Exec")) {
      const { data } = await supabase.rpc("my_acting_location");
      branchId = data && data.ok ? data.locationId || null : null;
    }

    const classNames  = Object.fromEntries(vc.map((c) => [c.id, c.name]));
    const sourceNames = Object.fromEntries(so.map((x) => [x.id, x.name]));
    const rates = {};
    dr.forEach((r) => {
      const src = sourceNames[r.sourceId];
      const cls = classNames[r.vehicleClassId];
      const amount = Number(r.amount);
      if (!src || !cls || !Number.isFinite(amount)) return;
      (rates[src] = rates[src] || {})[cls] = amount;
    });

    companyLists = {
      branchId,
      pickupLocations:    [...pl].sort(byListOrder),
      vehicleClasses:     [...vc].sort(byListOrder),
      sources:            [...so].sort(byListOrder).map((x) => ({
        ...x,
        details: sd.filter((d) => d.sourceId === x.id)
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      })),
      rates,
      protectionProducts: [...pp].sort(byListOrder),
    };
  } catch (e) {
    companyLists = null;
    console.warn("Fleetr: company lists could not be loaded, using the built-in ones:", e.message || String(e));
  }
}

// ─── Company units ────────────────────────────────────────────────────────────
// The units the company's Exec chose on the Company page: fuel in litres or US
// gallons, distance in kilometres or miles. Display only. Every figure is
// still stored in litres and kilometres (tank sizes, fuel prices per litre,
// odometer readings, PM intervals), so the gas charge, the PM threshold and
// every saved record mean the same whichever unit is shown. A failed read
// leaves litres and kilometres, which is what the app always showed.
let companyUnits = { fuel: "L", distance: "km" };

async function loadCompanyUnits(user) {
  const operatorId = user?.operatorId;
  if (!operatorId) { companyUnits = { fuel: "L", distance: "km" }; return; }
  try {
    const { data, error } = await supabase.from("operators")
      .select("fuelUnit,distanceUnit").eq("id", operatorId).maybeSingle();
    if (error || !data) {
      if (error) console.warn("Fleetr: company units could not be loaded, using litres and kilometres:", error.message);
      return;
    }
    companyUnits = {
      fuel:     data.fuelUnit === "gal" ? "gal" : "L",
      distance: data.distanceUnit === "mi" ? "mi" : "km",
    };
  } catch (e) {
    console.warn("Fleetr: company units could not be loaded, using litres and kilometres:", e.message || String(e));
  }
}

const fuelUnit     = () => (companyUnits.fuel === "gal" ? "gal" : "L");
const distanceUnit = () => (companyUnits.distance === "mi" ? "mi" : "km");
const fuelUnitWord     = (plural = true) => (fuelUnit() === "gal" ? "gallon" : "litre") + (plural ? "s" : "");
const distanceUnitWord = (plural = true) => (distanceUnit() === "mi" ? "mile" : "kilometre") + (plural ? "s" : "");

// A stored kilometre figure, shown whole in the company's unit, or null.
const fmtDistance = (km) => {
  if (km === null || km === undefined || km === "" || !Number.isFinite(Number(km))) return null;
  const n = Math.round(Number(toDisplayUnits(km, distanceUnit())));
  return `${n.toLocaleString("en-CA")} ${distanceUnit()}`;
};
// A whole reading typed in the company's unit, as whole kilometres to store.
const distanceToKm = (n) => (distanceUnit() === "mi" ? Math.round(n * KM_PER_MI) : n);
const kmToDistance = (km) => (distanceUnit() === "mi" ? Math.round(km / KM_PER_MI) : km);

// Fuel prices are stored per litre. Shown and typed per the company's unit; a
// gallon price is kept to four places per litre, which shows back to the cent.
const fuelPriceForDisplay = (perLitre) => {
  const n = Number(perLitre);
  if (perLitre === null || perLitre === undefined || perLitre === "" || !Number.isFinite(n)) return null;
  return fuelUnit() === "gal" ? Math.round(n * L_PER_GAL * 1000) / 1000 : n;
};
const fuelPriceToLitre = (perUnit) =>
  fuelUnit() === "gal" ? Math.round((perUnit / L_PER_GAL) * 10000) / 10000 : perUnit;

const VOLUME_UNIT_OPTIONS   = [{ value: "L",  label: "Litres" },     { value: "gal", label: "US gallons" }];
const DISTANCE_UNIT_OPTIONS = [{ value: "km", label: "Kilometres" }, { value: "mi",  label: "Miles" }];

// Keeps a record's own value on offer when the list no longer has it.
const withCurrentOption = (options, current) => {
  const cur = String(current ?? "");
  return !cur || options.includes(cur) ? options : [...options, cur];
};

// Pickup locations for the branch the reservation is being made in. A branch
// with none entered yet is offered the old location codes, so the dropdown is
// never empty.
function pickupLocationOptions(current) {
  const mine = companyLists
    ? companyLists.pickupLocations
        .filter((p) => p.active && p.locationId === companyLists.branchId)
        .map((p) => p.name)
    : [];
  return withCurrentOption(mine.length ? mine : LOCATION_OPTIONS, current);
}

function defaultPickupLocation() {
  const options = pickupLocationOptions("");
  return options.includes("WI") ? "WI" : options[0];
}

// `fallback` is the built-in list the caller used before: the reservation
// forms and the fleet had different ones.
function vehicleClassOptions(fallback, current) {
  const mine = companyLists
    ? companyLists.vehicleClasses.filter((c) => c.active).map((c) => c.name)
    : [];
  return withCurrentOption(mine.length ? mine : fallback, current);
}

function defaultVehicleClass(fallback, preferred = "Compact Car") {
  const options = vehicleClassOptions(fallback, "");
  return options.includes(preferred) ? preferred : options[0];
}

// The rate to pre-fill for a source and a rates vehicle class, or undefined
// when there is none. Both arrive as stored: a source with its specific
// source after LIST_SEP, and either a class name or the old group and size.
function dailyRateFor(source, vehicleClass) {
  const src = String(source || "");
  const vc  = String(vehicleClass || "");
  if (companyLists) {
    const parts = vc.split(LIST_SEP);
    const className = parts.length > 1 ? `${parts[1]} ${parts[0]}` : vc;
    return companyLists.rates[src.split(LIST_SEP)[0]]?.[className];
  }
  const srcCat = src === "Retail" ? "Retail"
    : src.startsWith("Bodyshop/Dealership") ? "Bodyshop/Dealership"
    : src.startsWith("Insurance")           ? "Insurance"
    : src.startsWith("Corporate")           ? "Corporate" : null;
  const vcCat = vc === "Minivan" ? "Minivan"
    : vc === "Truck"             ? "Truck"
    : vc.startsWith("Car") || vc.endsWith(" Car") ? "Car"
    : vc.startsWith("SUV") || vc.endsWith(" SUV") ? "SUV" : null;
  return srcCat && vcCat ? DAILY_RATES[srcCat]?.[vcCat] : undefined;
}

// A reservation form with its daily rate filled for its source and vehicle
// class. Called when either of the two changes, so a rate staff typed stays
// until one of them changes again. No rate for the pair leaves it blank.
function withDailyRate(form) {
  if (!form.source || !form.vehicleClass) return form;
  const rate = dailyRateFor(form.source, form.vehicleClass);
  return { ...form, dailyRate: rate !== undefined ? String(rate) : "" };
}

// Non-Drive Intake offers who the work came from: the insurance sources by
// name, and the specific bodyshops and dealerships.
function ndiSourceOptions(current) {
  const mine = [];
  if (companyLists) {
    companyLists.sources.filter((x) => x.active).forEach((x) => {
      if (x.billingType === "insurance") {
        if (offerInsuranceSource(current)) mine.push(x.name);
      } else if (x.billingType === "bodyshop_dealership") {
        x.details.filter((d) => d.active).forEach((d) => mine.push(d.name));
      }
    });
  }
  const options = mine.length
    ? mine
    : NDI_SOURCE_OPTIONS.filter((opt) => opt !== "Insurance" || offerInsuranceSource(current));
  return withCurrentOption(options, current);
}

// What kind of billing a source means: "insurance", "bodyshop_dealership",
// "corporate", "retail", or null. Every rule that depends on the kind of
// source asks this rather than reading the name, so an Exec can rename a
// source without the billing fields, the bill-to rules or the Time of Repair
// list losing track of it.
//
// Takes the source as stored, with or without a specific source after it. A
// source the company's list does not have (an old record, or the list did not
// load) is recognised by the four built-in names, as it always was.
function sourceBillingType(source) {
  const src  = String(source || "");
  const name = src.split(LIST_SEP)[0];
  const known = companyLists && companyLists.sources.find((x) => x.name === name);
  if (known) return known.billingType;
  return src === "Retail"                      ? "retail"
    : src.startsWith("Bodyshop/Dealership")    ? "bodyshop_dealership"
    : src.startsWith("Insurance")              ? "insurance"
    : src.startsWith("Corporate")              ? "corporate" : null;
}

const quotedList = (names) => names.map((n) => `"${n}"`).join(", ");

// ─── New-version check ────────────────────────────────────────────────────────
// A deploy does not reach an open tab. Signing in never reloads the page, and
// GitHub Pages lets browsers reuse main.js for 10 minutes, so a tab opened
// before a deploy keeps running the old code until someone reloads it. That is
// how the ai_command_bar gate looked broken on the day it shipped.
//
// index.html and version.json both carry the build time, stamped into them by
// GitHub Pages' Jekyll build on every push. The page keeps the value it loaded
// with, and App's once-a-minute check fetches version.json past every cache
// and compares. Nothing reloads by itself: someone half way through a form
// would lose it. They are told, and they choose when.
//
// Read on first use rather than as the file loads: the tag never changes, and
// nothing here should touch the page before the app itself does.
let loadedVersion;
function getLoadedVersion() {
  if (loadedVersion === undefined) {
    const v = document.querySelector('meta[name="fleetr-version"]')?.content || "";
    // Served without the Jekyll build, as the local preview server does, the
    // tag still holds its template and there is nothing meaningful to compare.
    loadedVersion = /^\d+$/.test(v) ? v : null;
  }
  return loadedVersion;
}

// Resolves true only when the deployed version is known and differs. Every
// failure, being offline included, resolves false: a missed banner costs one
// more minute, a false one teaches people to ignore it.
async function checkForNewVersion() {
  const LOADED_VERSION = getLoadedVersion();
  if (!LOADED_VERSION) return false;
  try {
    const res = await fetch(new URL("version.json", document.baseURI), { cache: "no-store" });
    if (!res.ok) return false;
    const { version } = await res.json();
    return /^\d+$/.test(String(version)) && String(version) !== LOADED_VERSION;
  } catch (e) {
    return false;
  }
}

// ─── Claude API ───────────────────────────────────────────────────────────────
const CLAUDE_MODEL     = "claude-sonnet-4-5";
const CLAUDE_API_URL   = "https://fleetr-ai-proxy.connor-0a5.workers.dev";

// ─── Reservation confirmation text ────────────────────────────────────────────
// Asks the worker (the same one as above) to text the customer their
// confirmation now, rather than at its next 30 minute run. Only the code is
// sent: the worker reads the reservation itself with this session, so the
// number and the wording never come from the browser.
//
// Not awaited and never shown as an error. The reservation is already saved;
// a request that fails here is picked up by the worker's own backstop, and a
// text the customer gets twenty minutes late is not something staff can act on.
function requestReservationConfirmation(resCode) {
  const session = supabase.auth.session();
  if (!resCode || !session?.access_token) return;
  fetch(`${CLAUDE_API_URL}/reservation-confirmation`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": `Bearer ${session.access_token}` },
    body: JSON.stringify({ resCode }),
  })
    .then(async (res) => console.log("reservation confirmation:", res.status, await res.json().catch(() => null)))
    .catch((e) => console.warn("reservation confirmation request failed:", e));
}

// ─── Customer text wording ────────────────────────────────────────────────────
// What the Settings editor shows before a company has changed anything, and
// how it previews and measures a text. These mirror worker.js (fleetr-infra),
// which is what actually sends: DEFAULT_TEMPLATES, fillTemplate, codeSuffix,
// appSuffix, cancelSuffix, isGsm7 and gsm7Length. If the worker's copy
// changes, change this one.
//
// suffix is what the worker adds after the wording, as it will look in the
// preview: on the confirmation the reservation code, the app link and the
// cancel link; on the Pre-Rental Check the app link and the cancel link; on
// the return reminder the fuel note and the app link; nothing on the no-show
// texts. The tokens are stand-ins of the real length.
const TEXT_SAMPLE_LINK = " Cancel: https://app.fleetr.ai/#c=XXXXXXXXXXXXXXXXXXXXXX";
const TEXT_SAMPLE_APP_LINK = " App: https://app.fleetr.ai/#a=XXXXXXXXXXXXXXXXXXXXXX";
const TEXT_SAMPLE_CODE = " Reservation code: ABC 123 456.";
const TEXT_TEMPLATE_KINDS = [
  { kind: "confirmation", title: "Reservation confirmation", when: "Sent when a reservation is created.",
    fallback: "Hi [first name], your reservation with [company] at [location] is confirmed for [date] at [time].",
    suffix: TEXT_SAMPLE_CODE + TEXT_SAMPLE_APP_LINK + TEXT_SAMPLE_LINK, suffixNote: "the reservation code, the app link and the cancel link" },
  { kind: "pre_rental", title: "Pre-Rental Check", when: "Sent the day before pickup.",
    fallback: "Hi [first name], your rental pickup is tomorrow at our [location] location. Please bring your license and reply with your arrival time.",
    suffix: TEXT_SAMPLE_APP_LINK + TEXT_SAMPLE_LINK, suffixNote: "the app link and the cancel link" },
  { kind: "no_show_2hr", title: "No-show, after 2 hours", when: "Sent 2 hours after a pickup time when the customer has not arrived. [time] is the pickup time.",
    fallback: "Hi [first name], your pickup was at [time] and we have not seen you. Reply YES if you are on your way, or RESCHEDULE for a new time.",
    suffix: "", suffixNote: "" },
  { kind: "no_show_24hr", title: "No-show, the next day", when: "Sent a day after the 2 hour no-show text, if the customer still has not arrived.",
    fallback: "Hi [first name], we have not heard from you about yesterday's rental. Please reply or call us to let us know your plans.",
    suffix: "", suffixNote: "" },
  { kind: "return_reminder", title: "Return reminder", when: "Sent the day before an open rental is due back. [date] and [time] are when it is due back. When the fuel level at pickup is known, a note asking for it back at that level is added after the wording.",
    fallback: "Hi [first name], your rental is due back tomorrow at [time]. Complete your return in the fleetr app.",
    suffix: " Return fuel at Full to avoid a charge." + TEXT_SAMPLE_APP_LINK, suffixNote: "the fuel note and the app link" },
];
const TEXT_PLACEHOLDERS = ["[first name]", "[company]", "[location]", "[date]", "[time]"];
const TEXT_TEMPLATE_MAX = 240;
// The insert buttons above a text box, in the order a text usually reads.
const TEXT_PLACEHOLDER_BUTTONS = [
  ["First name", "[first name]"], ["Company", "[company]"], ["Location", "[location]"],
  ["Date", "[date]"], ["Time", "[time]"],
];

const fillTextTemplate = (template, values) =>
  String(template).replace(/\[(first name|company|location|date|time)\]/gi,
    (m) => String(values[m.toLowerCase()] ?? ""));

// The characters a plain text message can carry. One character outside this
// set and the whole message is sent in a wider encoding, 70 characters to a
// segment instead of 160.
const TEXT_GSM7 = new Set(
  "@\u00a3$\u00a5\u00e8\u00e9\u00f9\u00ec\u00f2\u00c7\n\u00d8\u00f8\r\u00c5\u00e5\u0394_\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\u00c6\u00e6\u00df\u00c9 !\"#\u00a4%&'()*+,-./0123456789:;<=>?"
  + "\u00a1ABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c4\u00d6\u00d1\u00dc\u00a7\u00bfabcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1\u00fc\u00e0"
  + "\f^{}\\[~]|\u20ac");
const TEXT_GSM7_DOUBLE = new Set("^{}\\[~]|\u20ac");

// How a finished text will be sent: its length as the carrier counts it, how
// many segments that is, and which characters, if any, forced the wider
// encoding. Each segment is billed as one text.
function measureText(text) {
  const chars = [...String(text)];
  const costly = [...new Set(chars.filter((ch) => !TEXT_GSM7.has(ch)))];
  if (costly.length === 0) {
    const length = chars.reduce((n, ch) => n + (TEXT_GSM7_DOUBLE.has(ch) ? 2 : 1), 0);
    return { length, segments: length <= 160 ? 1 : Math.ceil(length / 153), perSegment: 160, costly };
  }
  const length = String(text).length;
  return { length, segments: length <= 70 ? 1 : Math.ceil(length / 67), perSegment: 70, costly };
}

// Why set_message_template refused, in words.
const textTemplateRefusal = (out) => ({
  exec_only:       "Only an Exec can change the wording of customer texts.",
  not_signed_in:   "Your session has expired. Sign in again and retry.",
  too_long:        `The wording is too long. Keep it to ${out?.max || TEXT_TEMPLATE_MAX} characters.`,
  no_links:        "Links are not allowed in the wording. The cancel link is added for you.",
  bad_placeholder: out?.placeholder
    ? `${out.placeholder} is not a placeholder. Use only ${TEXT_PLACEHOLDERS.join(", ")}.`
    : `There is a stray square bracket. Use them only for ${TEXT_PLACEHOLDERS.join(", ")}.`,
}[out?.reason] || "The wording could not be saved. Try again.");
const CLAUDE_SYSTEM    = `You are fleetr ai, an assistant built into a vehicle fleet rental management system. You have access to the current reservations, rental agreements, fleet, non-drive intake, no-shows, and damage claims data passed in the user message.

Always respond with a valid JSON object — no markdown, no code fences, no text outside the JSON. Use this exact structure:
{
  "message": "Plain English description of what you found or what action you are about to take.",
  "action": {
    "table": "reservations | rental_agreements | fleet | ndi_rows | no_shows | damage_claims | app_settings",
    "operation": "update | insert | delete | confirmPickup | addNote | pmComplete | raStatus",
    "match": { "fieldName": "value" },
    "data": { "fieldName": "newValue" }
  }
}

Rules:
- "message" is always required. Write in plain conversational English.
- When "action" is included, nothing has happened yet. The staff member still has to confirm it, most actions then ask for a PIN, and the system may refuse the action outright. So describe what WILL happen, never what has happened. Write "This will set the tank size to 55 litres", not "I've set the tank size to 55 litres". Do not say done, updated, recorded, saved, opened, closed or changed about the action you are proposing.
- For a read or lookup, where nothing is being written, describe what you found in the normal past or present tense. This rule is only about actions.
- "action" is optional. Only include it when the user is requesting a write operation. For read/lookup requests omit "action" entirely.
- For "match", use the record's primary identifier: resCode for reservations, id for rental_agreements, id for fleet, id for ndi_rows, id for no_shows, id for damage_claims.
- For "data", include only the fields that need to change.
- For "delete" and "confirmPickup" operations, "data" can be omitted.
- Do not include any text, explanation, or formatting outside the JSON object.

Fleet table fields:
- id (primary key, do not modify), plate (e.g. "ABC-123"), make, model, year (number), colour, vin (exactly 17 characters, no I, O or Q), province (e.g. "NL")
- vehicleClass: one of {{FLEET_VEHICLE_CLASSES}}
- status: one of "Available", "Needs Cleaning", "Ready for Pickup", "PM", "Damaged", "On Rent", "Ready Returns"
- "PM" means Preventative Maintenance (the vehicle is due for scheduled service).
- winterTires: "Yes" or "No"
- currentRenter (customer name or null), dueBack (ISO date or null), fileType (string or null)

Fleet operation rules:
- To update a vehicle's status, use operation "update" with match on "id" and data containing the new "status".
- When marking a "Ready Returns" vehicle as collected (changing its status to any other status), also include currentRenter: null, dueBack: null, fileType: null in data.
- To add a vehicle to the fleet, use operation "insert". ALL of these are required and the action is rejected without them: plate, province, year, make, model, colour, tankSizeLiters, pmIntervalKm, vehicleClass, vin, currentOdometer, currentFuelLevel. Do not include status or winterTires in data -- those defaults are applied automatically.
- currentOdometer and currentFuelLevel are the vehicle's readings right now, which its first rental starts from. currentOdometer is a whole number of KILOMETRES; if the user gives miles, convert (1 mile = 1.609344 km) and round. currentFuelLevel must be exactly one of: Empty, ⅛, ¼, ⅜, ½, ⅝, ¾, ⅞, Full. If the user says "half" or "three quarters", send the matching one.
- tankSizeLiters is the fuel tank size in LITRES and pmIntervalKm is the service interval in KILOMETRES. If the user gives gallons or miles, convert before sending: 1 gallon = 3.785411784 litres, 1 mile = 1.609344 km. Both must be positive numbers.
- If the user has not given every required field, do NOT emit an insert action. Ask for the missing ones in "message" instead.
- To retire a vehicle from the fleet, use operation "delete" with match on "id", and data containing disposalDate (ISO date) and reason. Both are required: the archive keeps them and the action is rejected without them. Look up the vehicle id from the fleet data using the plate.
- Vehicles flagged needsPm are due for service. Changing such a vehicle to Available, Needs Cleaning or Ready for Pickup is automatically converted to PM, so say so rather than promising the requested status.
- Use the fleet data passed in the user message to find vehicle ids.

Editing an existing vehicle:
- Every field the Add Vehicle form collects can be corrected on a vehicle already in the fleet: plate, province, year, make, model, colour, tankSizeLiters, pmIntervalKm, vehicleClass, vin.
- Use operation "update" with match on "id" or "plate", and data containing only the fields being changed. Example: {"table":"fleet","operation":"update","match":{"plate":"ABC123"},"data":{"colour":"Blue","year":2025}}
- Put ALL the fields the user asked to change into ONE action. Never split a single request into several actions; the staff member confirms one card once.
- None of these may be set to blank. If the user wants a field emptied, say it cannot be blank rather than sending an empty value.
- tankSizeLiters is in LITRES and pmIntervalKm is in KILOMETRES. If the user speaks in gallons or miles, convert (1 gallon = 3.785411784 litres, 1 mile = 1.609344 km). Both must be positive. Reply in whatever unit the person used: if they said "12 gallons", send 45.4 and say 12 gallons in "message".
- year is a four digit year. vehicleClass must be one of the classes listed above. province must be a two letter province or state code.
- vin must be exactly 17 characters, letters and digits only, and never the letters I, O or Q, which a real VIN does not use. Anything else is rejected. If the user reads out a VIN that is not 17 characters, say so and ask them to check it rather than sending it.
- Changing a plate is allowed, but not while the vehicle has a rental agreement that is not closed, because other records point at the old plate. That is refused with an explanation.
- needsPm, lastPmOdometer, currentOdometer, id and created_at can never be changed on a vehicle already in the fleet. Odometer figures come from the vehicle itself, and the PM baseline is set by pmComplete. The only time currentOdometer is sent is the starting reading when a vehicle is added.
- Changing status is a separate thing, covered under Fleet operation rules above.

PM Complete:
- Use operation "pmComplete" on table "fleet", match on "id" or "plate", and no "data". Example: {"table":"fleet","operation":"pmComplete","match":{"plate":"ABC123"}}
- This is the only thing that clears the needsPm flag. It restarts the service interval from the odometer currently on file and, if the vehicle was sitting in PM status, returns it to Available.
- Never write needsPm or lastPmOdometer through an "update". Those values are computed from the vehicle's real odometer reading; setting them by hand rebaselines the service schedule to the wrong number.
- It is rejected if the vehicle is not flagged needsPm, or if it has no odometer reading yet. The odometer is captured when a rental is returned.

Notes:
- Every notes field in this system (notesLog on reservations and on rental_agreements) is an append-only log, not a text field.
- To add a note use operation "addNote" with the table, match on the record's identifier (resCode for reservations, id for rental_agreements), and data containing "text". Example: {"table":"reservations","operation":"addNote","match":{"resCode":"ABC 123 456"},"data":{"text":"Customer called to confirm"}}
- NEVER write notesLog through an "update" operation. That replaces the whole log and erases every earlier note. Use addNote.

Reservations operation rules:
- To create a reservation, use operation "insert". Required: customer, date, time, location, vehicleClass. The resCode is generated automatically, never supply one.
- If any required field is missing, ask for it in "message" rather than emitting the action.

Rental agreement lifecycle:
- A rental agreement moves through five statuses, in this order: "reservation" (not yet picked up), "open_rental_agreement" (the vehicle is out), "customer_return" (the customer returned it through the customer app and staff have not processed it yet), "close_pending" (staff have processed the return, paperwork not finished), "closed" (done).
- To change it, use operation "raStatus" on table "reservations", match on "resCode", and data containing only rentalAgreementStatus. Example: {"table":"reservations","operation":"raStatus","match":{"resCode":"ABC 123 456"},"data":{"rentalAgreementStatus":"open_rental_agreement"}}
- Never change rentalAgreementStatus through an "update", and never send any other field in the same action.
- Opening sets the vehicle to On Rent. Moving to customer_return or to close_pending sets it to Ready Returns. All of these happen automatically, do not also send a fleet status change.
- Do not set customer_return yourself. The customer app writes it when a customer returns a vehicle, and it records that a customer did so; setting it by hand would claim a return that did not happen that way.
- Opening a rental on a vehicle flagged needsPm raises a confirmation for the staff member. They can rent it anyway, or cancel, in which case nothing is written. Say in "message" that the vehicle is flagged, rather than promising the rental is open.
- Closing (close_pending or closed) stamps the return date and time automatically. Never supply returnDate, returnTime or returnMeridiem yourself.
- Use the rental agreements data passed in the user message to find the current status of an agreement, and the reservations data to find the resCode.

Settings (app_settings):
- The current settings are passed in the user message as "App settings". Read them from there to answer questions; that needs no action.
- gasMarkupPercent is the percentage added on top of every automatic gas charge. gasPrices is the price per litre by region, e.g. {"NL": 1.72}.
- To change the markup: {"table":"app_settings","operation":"update","data":{"gasMarkupPercent":18}}. It must be zero or more. No "match" is needed.
- To change a region's fuel price: {"table":"app_settings","operation":"update","data":{"gasPrices":{"NL":1.79}}}. Send ONLY the regions being changed; they are merged into the existing prices, so the others are kept. The price is per LITRE and must be positive.
- A price can only be set for a region in the "Fleet regions" list passed in the user message. If the user names one that is not there, say so rather than emitting the action.
- These are the only two settings that can be changed. Everything else on the Settings page is read-only to you.

Non-drive intake (ndi_rows) table fields:
- id (primary key, do not modify), rescode, customer, phone, type, rate (read-only, not editable)
- source: one of {{NDI_SOURCES}}
- aiDate (ISO date), aiTime (4 digit string, e.g. "1140"), aiMeridiem ("AM" or "PM")
- agentRequested, requestedAtMs (read-only, not editable through this AI)

Non-drive intake operation rules:
- ndi_rows only supports "update" through this AI. Do not insert or delete ndi_rows records.
- To change a row's source, use operation "update" with match on "id" and data containing the new "source".
- To reschedule a row's pickup date or time, use operation "update" with match on "id" and data containing aiDate, aiTime, and/or aiMeridiem as needed.
- Use the non-drive intake data passed in the user message to find row ids.

No-shows (no_shows) table fields:
- id (primary key, do not modify), rescode, customer, date, time, location, vehicleClass, phone (read-only, not editable)
- called, status, stage (read-only, not editable through this AI)

No-shows operation rules:
- no_shows only supports "confirmPickup" through this AI. Do not update, insert, or delete no_shows records directly.
- confirmPickup means the customer showed up after all. Use operation "confirmPickup" with match on "id" and no "data". This moves the row from no-shows back into an active reservation.
- Use the no-shows data passed in the user message to find row ids.

Damage claims (damage_claims) table fields:
- id (primary key, do not modify), plate, rentalAgreementId (id of the matching rental_agreements record), description
- status: one of "open", "in_review", "resolved" (read-only reportedAt/resolvedAt/photos, not editable through this AI)

Damage claims operation rules:
- To resolve a damage claim, use table "damage_claims", operation "update", match on id, and data containing status: "resolved".
- To move a claim into review, use operation "update", match on id, and data containing status: "in_review".
- Do not insert new damage_claims records through this AI. Flagging new damage happens elsewhere in the app (at vehicle return, or via the Flag Damage button on a rental agreement).
- Use the damage claims data passed in the user message to find open claims, their ids, and their descriptions.

Gas collections:
- Gas balances live on rental_agreements, in gasOwed (a dollar amount) and gasCollected (a boolean, true once fully paid). There is no separate partial-payment status field.
- To change how much a customer owes, use table "rental_agreements", operation "update", match on id, and data containing the new gasOwed amount as a string, e.g. "25.00".
- To mark a balance as fully paid, use table "rental_agreements", operation "update", match on id, and data containing gasCollected: true and gasOwed: "0".
- To mark a balance as unpaid again, use data containing gasCollected: false.
- Use the rental agreements data passed in the user message to find records with an outstanding gasOwed balance and their ids.`;

// The prompt with the company's own lists written in, so the AI offers the
// same vehicle classes and intake sources the forms do.
function claudeSystem() {
  return CLAUDE_SYSTEM
    .replace("{{FLEET_VEHICLE_CLASSES}}", quotedList(fleetVehicleClasses()))
    .replace("{{NDI_SOURCES}}", quotedList(ndiSourceOptions("")));
}

// ─── Twilio SMS ──────────────────────────────────────────────────────────────
// The client-side sendSMS helper was removed along with the automated texting
// loop. Automated customer texts are now sent server-side by the Cloudflare Cron
// Trigger in worker.js.
//
// The Worker's /sms proxy endpoint has since been deleted too. It took the
// recipient and the body from the request with no authentication, so it was an
// open relay on our Twilio number. If a staff-initiated "send text now" button
// is ever added, it needs an endpoint that verifies the caller's session, not
// the one that used to be there.

// ─── One-time customer data cleanup: removed ─────────────────────────────────
// A block here used to wipe reservations, rental agreements, intake, TOR and
// no-show rows once per device, gated by a localStorage flag and skipped if any
// customer data already existed.
//
// That guard was the whole safety of it, and it stopped working the moment the
// tables were emptied on purpose: with nothing left to find, a browser that had
// never loaded the app ran the deletes for real instead of skipping. Harmless
// against empty tables, and a data loss waiting to happen against real ones.
//
// It has served its purpose and is deliberately not replaced. Nothing else
// referenced it, and the fleetr_cleanup_v1 key it left behind is inert.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Action gating policy ────────────────────────────────────────────────────
// One registry, two tiers, deliberately declarative so that re-tiering an action
// is a one line edit here rather than a hunt through event handlers.
//
//   "pin"     Full PIN confirmation. Anything that deletes, moves money, changes
//             a vehicle's status or PM state, or drives the rental agreement
//             lifecycle.
//   "confirm" The affirmative interaction the user already performs is the
//             confirmation: pressing a button, committing an inline edit, or
//             approving the command bar's action card. No PIN, no extra modal.
//             Reserved for reversible changes with no money or safety weight.
//
// The tier is about consequence, not effort. A note can be edited away; a
// deleted reservation and a vehicle released from PM cannot.
const ACTION_POLICY = {
  // ── PIN: hard to undo, or moves money ──────────────────────────────────────
  // The tier is set by consequence, not by how important the action feels. A
  // gate on everything is a gate on nothing: staff who type a PIN forty times a
  // shift stop reading what they are confirming, which is exactly the habit the
  // gate exists to prevent. So the list below is deliberately short.

  // Destroys a record. There is no undo for any of these.
  "reservation.delete": { tier: "pin", label: "Delete reservation" },
  "reservation.noShow": { tier: "pin", label: "Mark reservation as a no-show" },
  "vehicle.retire":     { tier: "pin", label: "Retire vehicle" },

  // Changes a dollar amount.
  "gas.amount":      { tier: "pin", label: "Change the amount owed" },
  // Not obviously money until you read the handler: marking a balance Paid also
  // writes gasOwed to "0", so this writes off what a customer owed.
  "gas.collected":   { tier: "pin", label: "Change gas payment status" },
  "gas.markup":      { tier: "pin", role: "Admin", label: "Change the gas markup" },
  "gas.regionPrice": { tier: "pin", role: "Admin", label: "Change a regional fuel price" },
  // Tank size is a money input: it is the divisor in every future gas charge.
  "vehicle.tankSize": { tier: "pin", label: "Set tank size" },

  // Changes who can do what, or ends someone's access. Both are hard to notice
  // after the fact: a quietly promoted account looks exactly like a legitimate
  // one, and a deactivated colleague finds out at the start of their next
  // shift. The database refuses these for anyone who is not an Admin, and
  // refuses them outright against yourself; the PIN is the second lock.
  "staff.role":   { tier: "pin", role: "Admin", label: "Change a staff member's role" },
  "staff.active": { tier: "pin", role: "Admin", label: "Activate or deactivate a staff member" },
  // Moving someone changes which branch's data they can reach, so it is a
  // permission change wearing different clothes.
  "staff.reassign": { tier: "pin", role: "Admin", label: "Move a staff member to another branch" },
  // Clearing a PIN removes a control, and the person it belongs to is not the
  // one clicking. Gated like every other removal of a control.
  "staff.resetPin": { tier: "pin", role: "Admin", label: "Reset a staff member's PIN" },

  // Puts a vehicle on the road or ends a rental. ra.open is also where the PM
  // soft block is overridden, so the safety override is gated here.
  "ra.open":    { tier: "pin", label: "Open a rental agreement" },
  // The PM override is its own action, not a branch inside ra.open. An Agent
  // opens rentals all day; overriding a preventative maintenance flag puts a
  // vehicle that is due for service on the road with a customer in it, and that
  // is a different decision by a different person. Splitting the key is also
  // what lets the audit log tell the two apart afterwards, which a single
  // ra.open entry never could.
  "ra.openDespitePm": { tier: "pin", role: "Admin", label: "Open a rental on a vehicle flagged for PM" },
  "ra.advance": { tier: "pin", label: "Change rental agreement status" },
  // The PM interval is the back door to the same safety block: setting it wide
  // enough silences the flag for the whole fleet without overriding anything.
  "vehicle.pmInterval": { tier: "pin", label: "Set the PM interval" },

  // ── Confirm: routine, reversible, done many times a day ────────────────────
  "vehicle.status":     { tier: "confirm", label: "Change vehicle status" },
  // Switch Out swaps which vehicle a rental is on. It opens and closes nothing
  // and moves no money: two vehicle statuses change and the agreement points at
  // the new plate, all of which a second switch undoes. Confirm, like the other
  // vehicle status work, and audited either way. The PM block is not reachable
  // through it: a flagged vehicle is never Available, so it cannot be switched
  // to.
  "ra.switchOut":       { tier: "confirm", label: "Switch the vehicle on a rental agreement" },
  "vehicle.pmComplete": { tier: "confirm", label: "Record preventative maintenance as complete" },
  "vehicle.add":        { tier: "confirm", label: "Add a vehicle to the fleet" },
  "vehicle.details":    { tier: "confirm", label: "Edit vehicle details" },
  // Restores a reservation rather than destroying one. The destructive
  // direction, reservation.noShow, keeps its PIN.
  "noShow.confirmPickup": { tier: "confirm", label: "Confirm the customer showed up" },
  // Records that damage exists; it sets no amount. The claim's dollar value is
  // a gas.amount-style write, gated separately.
  "damage.flag":      { tier: "confirm", label: "Flag damage" },
  // Sets status to resolved and stamps a time. No amount is written here.
  "damage.resolve":   { tier: "confirm", label: "Resolve a damage claim" },
  "reservation.add":  { tier: "confirm", label: "Add reservation" },
  // The wording every customer of the company is texted. Exec only, and the
  // database is what holds that: set_message_template refuses anyone else.
  "texts.template":   { tier: "confirm", role: "Exec", label: "Change customer text wording" },
  "reservation.edit": { tier: "confirm", label: "Save reservation changes" },
  "note.add":         { tier: "confirm", label: "Add a note" },
  "ndi.edit":         { tier: "confirm", label: "Edit an intake row" },
  "tor.confirmDate":  { tier: "confirm", label: "Confirm the repair date" },
};

const actionTier = (key) => ACTION_POLICY[key]?.tier || "pin"; // unknown defaults to the safer tier
const actionLabel = (key) => ACTION_POLICY[key]?.label || "this action";
// null means every signed-in user may do it. Unlike actionTier there is no safe
// default to fall back to: guessing "Admin" for an unknown key would lock the
// whole branch out of a typo, and guessing null would open it. Unknown keys
// already default to the PIN tier, and the database refuses what it refuses
// whatever this returns.
const actionRole = (key) => ACTION_POLICY[key]?.role || null;

// Role is a ladder, not a label. Comparing with === was correct while Admin was
// the top, and becomes wrong the moment a role sits above it: an Exec would be
// refused every Admin-only action, leaving the most powerful role in the system
// with strictly fewer powers than the one below it.
//
// 0 covers anything unrecognised, which includes null: not signed in, inactive,
// or a profile that predates a role this build knows about.
const ROLE_RANK = { Exec: 3, Admin: 2, Agent: 1 };
const roleRank  = (r) => ROLE_RANK[r] || 0;

// The second clause is the one that matters. Without it an unknown REQUIREMENT
// ranks 0, every caller clears it, and a typo in ACTION_POLICY would silently
// open the action to everyone. With it, a requirement nobody recognises is
// refused to everybody, Exec included. Mirrors public.role_at_least in SQL, and
// the two are asserted against the same table in the test suite.
const roleAtLeast = (actual, needed) =>
  roleRank(needed) > 0 && roleRank(actual) >= roleRank(needed);

// How the command bar signs its audit entries, matching how notesLog attributes
// an AI-added note. The staff member who confirmed it is named in the entry's
// description, so "fleetr ai" never stands in for a person's accountability.
const AI_ACTOR = "fleetr ai";

// The signed-in user's display name. The session stores `username`; `name` was
// never a field on it, so every `currentUser?.name` in this file silently
// resolved to undefined. That is why notes staff added by hand were being
// attributed to fleetr ai.
const actorName = (user) => user?.name || user?.username || "unknown";

// The identifier a reader would recognise, per table: a plate for a vehicle, a
// resCode for a reservation. Falls back to whatever the match was keyed on, so
// an entry is never left with nothing to point at.
const AUDIT_ID_FIELDS = {
  fleet:             ["plate", "id"],
  reservations:      ["resCode", "id"],
  rental_agreements: ["resCode", "id"],
  damage_claims:     ["id"],
  ndi_rows:          ["rescode", "id"],
  no_shows:          ["rescode", "id"],
  app_settings:      ["key"],
};

// damage_claims is the one table with no human key of its own: it stores a
// plate, a rentalAgreementId and a description, so ["id"] above is a uuid and
// nothing else. Logging that told a reader which row changed in a language
// only Postgres speaks. The code is two hops away -- claim to agreement to
// resCode -- the same hop enrichDamageClaim makes for the claims tables, so
// the log can say it in the same words every other entry uses.
function damageClaimResCode(claim, rentalAgreements) {
  if (!claim?.rentalAgreementId) return null;
  return (rentalAgreements || []).find((a) => a.id === claim.rentalAgreementId)?.resCode || null;
}

// context carries the lists the lookup above needs. It is optional: a caller
// that has no claims or agreements to hand still gets the uuid rather than an
// error, which is the same answer this function gave before.
function auditRecordId(table, match, data, context) {
  if (table === "damage_claims") {
    // The payload first, since an insert names its agreement directly, then
    // the stored row, which is where an update matching on id has to look.
    const claim = data?.rentalAgreementId
      ? data
      : (context?.damageClaims || []).find((c) => String(c.id) === String(match?.id)) || null;
    const code = damageClaimResCode(claim, context?.rentalAgreements);
    if (code) return code;
  }

  const fields = AUDIT_ID_FIELDS[table] || ["id"];
  for (const f of fields) {
    if (match && match[f] != null && String(match[f]).trim() !== "") return String(match[f]);
    if (data  && data[f]  != null && String(data[f]).trim()  !== "") return String(data[f]);
  }
  const firstMatch = Object.values(match || {})[0];
  return firstMatch != null ? String(firstMatch) : null;
}

// A short "what changed" line from the payload, capped so one oversized field
// cannot turn the log into a place nobody reads.
function auditDescribe(data, limit = 160) {
  const entries = Object.entries(data || {});
  if (!entries.length) return null;
  const parts = entries.map(([k, v]) => {
    let shown;
    if (v === null || v === undefined) shown = "cleared";
    else if (typeof v === "object")    shown = Array.isArray(v) ? `${v.length} item(s)` : "updated";
    else                                shown = String(v);
    if (shown.length > 40) shown = shown.slice(0, 37) + "...";
    return `${k}: ${shown}`;
  });
  const joined = parts.join(", ");
  return joined.length > limit ? joined.slice(0, limit - 3) + "..." : joined;
}

// Maps a command bar action onto the same registry, so the AI is gated by
// consequence rather than uniformly. Reads the payload because the tier of a
// reservations update depends on which fields it touches.
const MONEY_FIELDS   = ["gasOwed", "gasCollected", "dailyRate"];
const PIN_RA_FIELDS  = ["rentalAgreementStatus"];
// The same ten fields VEHICLE_REQUIRED_FIELDS names, repeated here because the
// routing table is defined long before the write rules are. pin-policy.test.mjs
// asserts the two lists match, so they cannot drift apart unnoticed.
const VEHICLE_DETAIL_KEYS = [
  "plate", "province", "year", "make", "model",
  "colour", "tankSizeLiters", "pmIntervalKm", "vehicleClass", "vin",
];
function commandBarActionKey({ table, operation, data, pmVehicle }) {
  const fields = Object.keys(data || {});
  const touches = (list) => fields.some((f) => list.includes(f));

  if (operation === "delete") {
    return table === "fleet" ? "vehicle.retire" : "reservation.delete";
  }
  if (operation === "confirmPickup") return "noShow.confirmPickup";
  if (operation === "addNote")       return "note.add";
  if (operation === "pmComplete")    return "vehicle.pmComplete";
  // Opening is called out separately from advancing because opening is what puts
  // a vehicle on the road, and it is the one that can override a PM flag.
  if (operation === "raStatus") {
    if (data?.rentalAgreementStatus !== "open_rental_agreement") return "ra.advance";
    // Overriding a PM flag is a different action from opening a rental, and it
    // has to be recognised here too. The command bar reaches the same tables as
    // the UI, so a split that only exists in the page hands the AI path the
    // route around it.
    return pmVehicle?.needsPm ? "ra.openDespitePm" : "ra.open";
  }
  if (table === "app_settings") {
    return fields.includes("gasMarkupPercent") ? "gas.markup" : "gas.regionPrice";
  }
  if (table === "fleet") {
    if (operation === "insert") return "vehicle.add";
    if (fields.includes("tankSizeLiters")) return "vehicle.tankSize";
    if (fields.includes("pmIntervalKm"))   return "vehicle.pmInterval";
    if (fields.includes("needsPm") || fields.includes("lastPmOdometer")) return "vehicle.pmComplete";
    if (fields.includes("status")) return "vehicle.status";
    // A correction to the vehicle's identity: plate, VIN, class, year and so on.
    if (touches(VEHICLE_DETAIL_KEYS)) return "vehicle.details";
    // An unrecognised fleet payload. This used to fall back to vehicle.status,
    // which was fine while that was PIN-tier and is not now: the fallback would
    // have quietly become the weakest tier rather than the strongest. The key
    // below is deliberately absent from ACTION_POLICY so actionTier's
    // unknown-defaults-to-pin rule is what decides it.
    return "vehicle.unknown";
  }
  if (table === "damage_claims") return "damage.resolve";
  if (table === "rental_agreements") {
    if (touches(MONEY_FIELDS))  return "gas.amount";
    if (touches(PIN_RA_FIELDS)) return "ra.advance";
    return "note.add";
  }
  if (table === "reservations") {
    if (operation === "insert") return "reservation.add";
    if (touches(MONEY_FIELDS))  return "gas.amount";
    if (touches(PIN_RA_FIELDS)) return "ra.advance";
    if (fields.includes("hasDamage")) return "damage.flag";
    if (fields.length === 1 && fields[0] === "notesLog") return "note.add";
    return "reservation.edit";
  }
  if (table === "ndi_rows") return "ndi.edit";
  return "reservation.edit";
}

const NAV_SECTIONS = [
  {
    header: "Overview",
    items: [{ label: "Dashboard", path: "/dashboard" }],
  },
  {
    header: "Rentals",
    items: [
      { label: "Reservations", path: "/reservations" },
      { label: "Rental Agreements", path: "/rental-agreements" },
    ],
  },
  {
    header: "Fleet",
    items: [
      { label: "Vehicles",                path: "/fleet/vehicles"      },
      { label: "Additions and Deletions", path: "/fleet/additions"      },
      { label: "Gas Collections",         path: "/fleet/gas-collections" },
      { label: "Ongoing Damage Claims",   path: "/fleet/damage-claims"  },
    ],
  },
  {
    header: "AI Calls and Texts",
    items: [
      { label: "Non-Drive's", path: "/arms", feature: "non_drive_intake" },
      { label: "Pre-Rental Check", path: "/pre-rental-check", feature: "pre_rental_check" },
      { label: "Overdue Rentals", path: "/overdue-rentals" },
      { label: "Unknown Repair Date", path: "/time-of-repair" },

      { label: "No Shows", path: "/no-shows" },
    ],
  },
  {
    header: "Branch",
    items: [
      { label: "Reports", path: "/reports" },
      { label: "Audit Log", path: "/audit-log" },
      { label: "Company", path: "/company" },
      { label: "Staff", path: "/staff" },
      { label: "Settings", path: "/settings" },
      { label: "Your Account", path: "/account" },
    ],
  },
];
const NAV = NAV_SECTIONS.flatMap((section) => section.items);

// A nav item may name the feature flag it belongs to. Both navs render from
// this rather than NAV_SECTIONS directly, so an item whose company has the
// feature off is not there at all, and a section left with no items loses its
// header too instead of hanging empty. Items without a feature always show.
const navItemVisible = (item) => !item.feature || isFeatureEnabled(item.feature);
function visibleNavSections() {
  return NAV_SECTIONS
    .map((section) => ({ ...section, items: section.items.filter(navItemVisible) }))
    .filter((section) => section.items.length > 0);
}
const FLEET_MODELS_BY_BRAND = {
  Chevrolet: ["Equinox", "Malibu", "Trax"],
  Ford: ["Escape", "Fusion", "Edge"],
  Kia: ["Forte", "Soul", "Sportage"],
  Mazda: ["CX-5", "Mazda3", "CX-30"],
  Nissan: ["Sentra", "Rogue", "Altima"],
  Toyota: ["Corolla", "Camry", "RAV4"],
};
const FLEET_BRANDS = Object.keys(FLEET_MODELS_BY_BRAND).sort((a, b) =>
  a.localeCompare(b)
);

const BRANCH_LOCATIONS = [
  { label: "Mount Pearl", code: "C951" },
  { label: "St. John's", code: "C954" },
  { label: "Clarenville", code: "C972" },
];
const BRANCH_GROUPS = [
  { label: "C9 \u2014 Atlantic Canada", locations: BRANCH_LOCATIONS },
  { label: "C2 \u2014 British Columbia", locations: null },
];

// ─── Reservations page ──────────────────────────────────────────────────────

const RES_VEHICLE_CLASSES = [
  "Compact Car", "Regular Car", "Large Car",
  "Compact SUV", "Regular SUV", "Large SUV", "Minivan", "Premium Sedan", "Luxury",
];
const RES_BILL_TO_OPTIONS = [
  "Customer pay", "Intact Insurance", "Johnson Insurance",
  "Aviva Insurance", "SGI Canada", "Dealership courtesy", "Corporate account",
];

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Module-level helpers (used by DashboardPage, NonDriveIntakeSection, TORPage) ──────

function parseTimeToMinutes(time) {
  const normalized = String(time).trim().toUpperCase();
  const match = /^(\d{1,2}):(\d{2})(?:\s?(AM|PM))?$/.exec(normalized);
  if (!match) return Number.POSITIVE_INFINITY;
  let h = Number(match[1]);
  const m = Number(match[2]);
  const meridiem = match[3] || null;
  if (m > 59) return Number.POSITIVE_INFINITY;
  if (meridiem) {
    if (h < 1 || h > 12) return Number.POSITIVE_INFINITY;
    h = meridiem === "AM" ? (h === 12 ? 0 : h) : h === 12 ? 12 : h + 12;
  } else if (h > 23) {
    return Number.POSITIVE_INFINITY;
  }
  return h * 60 + m;
}

function toDisplayTime(digits) {
  const value = String(digits || "").replace(/\D/g, "").slice(0, 4);
  if (!value) return "";
  if (value.length <= 2) return value;
  if (value.length === 3) return `${value.slice(0, 1)}:${value.slice(1)}`;
  return `${value.slice(0, 2)}:${value.slice(2)}`;
}

// Convert any stored time value to "H:MM AM/PM" display format.
// Handles: "14:00" (24h), "1400" (digits), "3:00 PM" (already 12h), "03:00" (ambiguous → treats as 24h).
function fmt12h(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  // Already "H:MM AM/PM" — normalise leading zero on hour
  const already = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (already) return `${parseInt(already[1], 10)}:${already[2]} ${already[3].toUpperCase()}`;
  // Strip non-digits → treat as HHMM
  const digits = s.replace(/\D/g, "").slice(0, 4);
  if (!digits) return s;
  let h, m;
  if (digits.length <= 2)      { h = parseInt(digits, 10);              m = 0; }
  else if (digits.length === 3){ h = parseInt(digits.slice(0, 1), 10);  m = parseInt(digits.slice(1), 10); }
  else                          { h = parseInt(digits.slice(0, 2), 10); m = parseInt(digits.slice(2), 10); }
  const meridiem = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${meridiem}`;
}

// Normalise a potentially-24h time string to { digits, meridiem } in 12-hour format.
// digits is the 4-char "HHMM" string used internally by time picker fields.
// Hours 13-23 and 0 are unambiguously 24h and are converted; 1-12 trust storedMeridiem.
function normalizeTo12h(rawTime, storedMeridiem) {
  const s = String(rawTime || "").trim();
  // Already "H:MM AM/PM" — parse directly so meridiem is never lost
  const already = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (already) {
    const h = parseInt(already[1], 10);
    const m = parseInt(already[2], 10);
    const mer = already[3].toUpperCase();
    return { digits: String(h).padStart(2, "0") + String(m).padStart(2, "0"), meridiem: mer };
  }
  const digits = s.replace(/\D/g, "").slice(0, 4);
  if (!digits) return { digits: "", meridiem: storedMeridiem || "AM" };
  let h, m;
  if (digits.length <= 2) {
    h = parseInt(digits, 10); m = 0;
  } else if (digits.length === 3) {
    h = parseInt(digits.slice(0, 1), 10); m = parseInt(digits.slice(1), 10);
  } else {
    h = parseInt(digits.slice(0, 2), 10); m = parseInt(digits.slice(2), 10);
  }
  if (h === 0 || h >= 13) {
    const meridiem = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return { digits: String(h).padStart(2, "0") + String(m).padStart(2, "0"), meridiem };
  }
  return { digits, meridiem: storedMeridiem || "AM" };
}

function formatAuthor(name) {
  if (!name || name === "ADJ") return "ADJ";
  const parts = name.trim().split(" ");
  if (parts.length < 2) return name.slice(0, 8);
  const initial = parts[0][0] + ".";
  const last = parts.slice(1).join(" ");
  return `${initial} ${last.length > 6 ? last.slice(0, 6) : last}`;
}

// ─── Shared plate utility ─────────────────────────────────────────────────────

function normalizePlate(s) {
  return String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

// ─── TOR seed data ────────────────────────────────────────────────────────────

const TOR_SEED = [
  { id: "TOR-1", resCode: "JAP 182 301", customer: "James Parsons",   shop: "Midas Auto Service",   billTo: "Intact Insurance",   winterTires: "Yes", vehicleClass: "Regular Car",      torDate: isoOffset(0) },
  { id: "TOR-2", resCode: "RCN 185 602", customer: "Rachel Conway",   shop: "Steele Hyundai",        billTo: "Johnson Insurance",  winterTires: "No",  vehicleClass: "Compact Car",      torDate: isoOffset(0) },
  { id: "TOR-3", resCode: "OFI 190 103", customer: "Owen Fitzgerald", shop: "Midas Auto Service",    billTo: "Aviva Insurance",    winterTires: "Yes", vehicleClass: "Regular SUV", torDate: isoOffset(2) },
  { id: "TOR-4", resCode: "IMR 193 404", customer: "Isla Morrison",   shop: "Downtown Collision",    billTo: "Customer pay",       winterTires: "No",  vehicleClass: "Regular Car",     torDate: isoOffset(4) },
  { id: "TOR-5", resCode: "CBT 196 705", customer: "Cole Bennett",    shop: "Steele Volkswagen",     billTo: "SGI Canada",         winterTires: "Yes", vehicleClass: "Compact SUV",  torDate: isoOffset(6) },
];

// ─── Ready Returns seed ───────────────────────────────────────────────────────

const READY_RETURNS_SEED = [
  { id: "RR-1", plate: "JLM-284", vehicle: "Toyota Corolla",  location: "AF",    fileType: "Retail",    readySince: "07:55" },
  { id: "RR-2", plate: "NQF-173", vehicle: "Hyundai Elantra", location: "CCTOP", fileType: "Corporate", readySince: "08:40" },
  { id: "RR-3", plate: "RZT-909", vehicle: "Ford Escape",     location: "FA",    fileType: "Insurance", readySince: "09:05" },
];


// ─── Vehicle extra data (year, colour, VIN, province, odometer, fuel) ────────

const VEHICLE_EXTRA_DATA = {
  "JLM-284": { year: 2023, colour: "White",  vin: "1T1BF3EK5DU734891", province: "NL", odometer: 48234, fuelLevel: "3/4"  },
  "NQF-173": { year: 2024, colour: "Silver", vin: "5NPDH4AE4FH512873", province: "NL", odometer: 31100, fuelLevel: "Full" },
  "BTM-663": { year: 2022, colour: "Blue",   vin: "3KPFK4A78NE453201", province: "NL", odometer: 67445, fuelLevel: "1/2"  },
  "RZT-909": { year: 2024, colour: "Black",  vin: "1FMCU9GXXNUB12345", province: "NL", odometer: 22876, fuelLevel: "3/4"  },
  "KPV-551": { year: 2023, colour: "Red",    vin: "JM1BPBBL8N1501234", province: "NL", odometer: 41200, fuelLevel: "Full" },
  "WKM-112": { year: 2022, colour: "Grey",   vin: "5N1AT2MV8JC812345", province: "NL", odometer: 78900, fuelLevel: "1/4"  },
  "TDB-451": { year: 2021, colour: "White",  vin: "1G1ZD5ST1JF234567", province: "NL", odometer: 92340, fuelLevel: "1/2"  },
  "QPA-667": { year: 2024, colour: "Green",  vin: "KNDPM3AC1J7391234", province: "NL", odometer: 15670, fuelLevel: "Full" },
  "LNX-830": { year: 2023, colour: "Silver", vin: "2T1BURHE1JC012345", province: "NL", odometer: 36520, fuelLevel: "3/4"  },
  "FZR-294": { year: 2024, colour: "White",  vin: "1FMCU9GXXNUB99876", province: "NL", odometer: 19800, fuelLevel: "Full" },
  "WKM-819": { year: 2023, colour: "Black",  vin: "3N1AB7AP0KY345678", province: "NL", odometer: 44100, fuelLevel: "1/2"  },
  "QPA-204": { year: 2023, colour: "Blue",   vin: "KNDPM3AC1J7399999", province: "NL", odometer: 28300, fuelLevel: "3/4"  },
};

// ─── Vehicle maintenance seed ─────────────────────────────────────────────────

const VEHICLE_MAINTENANCE_SEED = {
  "JLM-284": { lastOilChange: "2026-03-15", nextServiceDue: "2026-09-15", notes: "Brake pads showing wear — inspect at next service." },
  "NQF-173": { lastOilChange: "2025-11-20", nextServiceDue: "2026-05-20", notes: "" },
  "BTM-663": { lastOilChange: "2025-09-10", nextServiceDue: "2026-03-10", notes: "Service overdue." },
  "RZT-909": { lastOilChange: "2026-04-01", nextServiceDue: "2026-10-01", notes: "" },
  "KPV-551": { lastOilChange: "2026-02-14", nextServiceDue: "2026-08-14", notes: "Tire rotation due." },
  "WKM-112": { lastOilChange: "2025-08-22", nextServiceDue: "2026-02-22", notes: "Service overdue." },
  "TDB-451": { lastOilChange: "2025-06-18", nextServiceDue: "2025-12-18", notes: "Service well overdue — schedule ASAP." },
  "QPA-667": { lastOilChange: "2026-04-28", nextServiceDue: "2026-10-28", notes: "" },
  "LNX-830": { lastOilChange: "2026-01-30", nextServiceDue: "2026-07-30", notes: "" },
  "FZR-294": { lastOilChange: "2026-04-15", nextServiceDue: "2026-10-15", notes: "" },
  "WKM-819": { lastOilChange: "2025-12-05", nextServiceDue: "2026-06-05", notes: "Due this month." },
  "QPA-204": { lastOilChange: "2026-02-28", nextServiceDue: "2026-08-28", notes: "" },
};

// ─── Vehicle damage seed ───────────────────────────────────────────────────────

const VEHICLE_DAMAGE_SEED = {
  "QPA-667": [
    { id: "VD-1", location: "Front bumper",  description: "Scuff, approx 15 cm" },
    { id: "VD-2", location: "Driver door",   description: "Small dent, paint intact" },
  ],
  "BTM-663": [
    { id: "VD-3", location: "Rear bumper",   description: "Cracked corner, passenger side" },
  ],
  "WKM-112": [
    { id: "VD-4", location: "Hood",          description: "Three stone chips, minor" },
  ],
  "TDB-451": [
    { id: "VD-5", location: "Front bumper",  description: "Paint transfer, approx 8 cm" },
    { id: "VD-6", location: "Rear bumper",   description: "Reverse impact dent" },
  ],
};

// ─── Damage claims ──────────────────────────────────────────────────────────────
// damage_claims rows only carry plate, rentalAgreementId, and description. Vehicle
// and customer/resCode are derived by joining rentalAgreements/reservations here so
// every view renders claims the same way.

const DAMAGE_CLAIM_STATUS_LABEL = { open: "Open", in_review: "In Review", resolved: "Settled" };
const damageClaimStatusLabel = (status) => DAMAGE_CLAIM_STATUS_LABEL[status] || status || "Open";

function enrichDamageClaim(claim, rentalAgreements, reservations) {
  const ra  = rentalAgreements.find((a) => a.id === claim.rentalAgreementId) || null;
  const res = ra ? reservations.find((r) => r.resCode === ra.resCode) : null;
  const vehicle = res
    ? [res.vehicleYear, res.vehicleMake, res.vehicleModel].filter(Boolean).join(" ") || res.vehicleClass
    : (ra ? [ra.make, ra.model].filter(Boolean).join(" ") || ra.vehicleClass : null);
  return {
    id:                claim.id,
    plate:             claim.plate || ra?.plate || null,
    vehicle:           vehicle || "Unknown",
    customer:          res?.customer || "Unknown",
    resCode:           ra?.resCode || null,
    description:       claim.description || "No description",
    claimStatus:       damageClaimStatusLabel(claim.status),
    vehicleRentable:   typeof claim.vehicleRentable === "boolean" ? claim.vehicleRentable : null,
    _status:           claim.status || "open",
  };
}

// The archived vehicles seed is gone. It held two invented retirements that
// existed only to make the table look populated. Now that archived_vehicles is
// a real table, seeding it would put fabricated records into the one place that
// answers "what happened to that vehicle", which is the same reason the
// reservations seed was emptied earlier.

// ─── No Shows seed ────────────────────────────────────────────────────────────

const NO_SHOWS_SEED = [
  { id: "NS-1", resCode: "BKL 230 101", customer: "Brandon Kelly",   time: "09:30", vehicleClass: "Compact Car",  location: "WI", date: isoOffset(0), phone: "(709) 555-0411", called: false, status: "", stage: "2hour" },
  { id: "NS-2", resCode: "SHW 231 802", customer: "Samantha Howell", time: "11:00", vehicleClass: "Compact SUV",  location: "AF", date: isoOffset(0), phone: "(709) 555-0528", called: false, status: "", stage: "2hour" },
  { id: "NS-3", resCode: "DCH 233 503", customer: "Derek Chafe",     time: "13:15", vehicleClass: "Regular Car",  location: "PU", date: isoOffset(0), phone: "(709) 555-0673", called: false, status: "", stage: "2hour" },
];

// ─── Overdue Rentals seed ─────────────────────────────────────────────────────

const OVERDUE_SEED = [
  { id: "OD-1", resCode: "MPK 109 201", customer: "Michelle Park",   phone: "(709) 555-0312", plate: "JXR 841", province: "NL", returnDate: isoOffset(-3), callStatus: "" },
  { id: "OD-2", resCode: "JHL 110 702", customer: "James Holloway",  phone: "(709) 555-0447", plate: "NPT 302", province: "NL", returnDate: isoOffset(-5), callStatus: "" },
  { id: "OD-3", resCode: "RSM 112 403", customer: "Rachel Simmons",  phone: "(709) 555-0589", plate: "KMV 567", province: "NL", returnDate: isoOffset(-1), callStatus: "" },
];

// ─── Non-Drive Intake seed data (module-level so AppProvider can initialise from it) ─────

const NDI_SOURCE_OPTIONS = ["Insurance", "AF", "FA", "CCS", "CSTAR", "CCTOP", "CA", "Janes", "Brian's"];

const NDI_SEED = [
  {
    id: "LMN 882 001",
    resCode: "LMN 882 001",
    customer: "Lucas MacNeil",
    phone: "(709) 555-0182",
    source: "Insurance",
    type: "Non-drive",
    rate: "$54/day",
    slaTimer: "00:26:12",
    aiDate: new Date().toISOString().slice(0, 10),
    aiTime: "1140",
    aiMeridiem: "AM",
    agentRequested: false,
    requestedAtMs: null,
  },
  {
    id: "MFY 963 002",
    resCode: "MFY 963 002",
    customer: "Maya Fernandez",
    phone: "(709) 555-0247",
    source: "Janes",
    type: "Non-drive",
    rate: "$57/day",
    slaTimer: "00:16:29",
    aiDate: new Date().toISOString().slice(0, 10),
    aiTime: "1220",
    aiMeridiem: "PM",
    agentRequested: false,
    requestedAtMs: null,
  },
  {
    id: "ETW 978 003",
    resCode: "ETW 978 003",
    customer: "Ethan White",
    phone: "(709) 555-0391",
    source: "CA",
    type: "Non-drive",
    rate: "$63/day",
    slaTimer: "00:07:43",
    aiDate: new Date().toISOString().slice(0, 10),
    aiTime: "0205",
    aiMeridiem: "PM",
    agentRequested: false,
    requestedAtMs: null,
  },
];

// ─── Dashboard reservations seed (module-level for AppProvider) ───────────────

const DASHBOARD_RES_SEED = [
  {
    date: "2026-05-07", time: "03:00", pickupMeridiem: "PM",
    returnDate: "2026-05-14", returnTime: "03:00", returnMeridiem: "PM",
    location: "AF", resCode: "CNS 123 401",
    customer: "Connor Nash", firstName: "Connor", lastName: "Nash",
    phone: "709 123 4567", email: "connornash@fleetr.ai",
    licenseNumber: "N123456789", licenseCountry: "Canada",
    licenseState: "NL", licenseExpiry: "2031-04-21",
    vehicleClass: "Regular SUV", ratesVehicleClass: "SUV \u2014 Regular",
    winterTires: "No",
    source: "Bodyshop/Dealership",
    dailyRate: "45",
    adjusterName: "", claimNumber: "", fileNumber: "", authNumber: "",
    poNumber: "", paymentMethod: "",
    preRentalCheck: "NOT Pre-Rental Check'd", notesLog: [], fromNonDrive: false,
    // \u2500\u2500 Persisted extended fields (new Supabase columns) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    pickupTime:      "03:00",
    licenseNum:      "N123456789",
    licenseProvince: "NL",
    sourceDetail:    "Avalon Ford",
    vehicleSize:     "Regular",
    vehicleYear:     "2025",
    vehicleMake:     "Mazda",
    vehicleModel:    "CX-30",
    rentalAgreementStatus:    "reservation",
  },
  {
    date: "2026-05-19", time: "08:00", pickupMeridiem: "AM",
    returnDate: "2026-06-02", returnTime: "05:00", returnMeridiem: "PM",
    location: "AF", resCode: "MFW 151 202",
    customer: "Margaret Fewer", firstName: "Margaret", lastName: "Fewer",
    phone: "709 555 0123", email: "",
    licenseNumber: "F887654321", licenseCountry: "Canada",
    licenseState: "NL", licenseExpiry: "2029-11-15",
    vehicleClass: "Compact Car", ratesVehicleClass: "Car — Compact",
    winterTires: "No",
    source: "Insurance",
    dailyRate: "52",
    adjusterName: "Keisha Thompson", claimNumber: "CL-2026-0441", fileNumber: "", authNumber: "",
    poNumber: "", paymentMethod: "",
    preRentalCheck: "NOT Pre-Rental Check'd", notesLog: [], fromNonDrive: false,
    pickupTime:      "08:00",
    licenseNum:      "F887654321",
    licenseProvince: "NL",
    sourceDetail:    "Aviva Insurance",
    vehicleSize:     "Compact",
    vehicleYear:     "2024",
    vehicleMake:     "Kia",
    vehicleModel:    "Forte",
    rentalAgreementStatus: "reservation",
  },
  {
    date: "2026-05-21", time: "10:00", pickupMeridiem: "AM",
    returnDate: "2026-06-07", returnTime: "05:00", returnMeridiem: "PM",
    location: "AF", resCode: "TPA 156 703",
    customer: "Troy Parsons", firstName: "Troy", lastName: "Parsons",
    phone: "709 555 0198", email: "",
    licenseNumber: "P334451122", licenseCountry: "Canada",
    licenseState: "NL", licenseExpiry: "2030-03-08",
    vehicleClass: "Regular Car", ratesVehicleClass: "Car — Regular",
    winterTires: "No",
    source: "Bodyshop/Dealership",
    dailyRate: "48",
    adjusterName: "", claimNumber: "", fileNumber: "", authNumber: "",
    poNumber: "", paymentMethod: "",
    preRentalCheck: "NOT Pre-Rental Check'd", notesLog: [], fromNonDrive: false,
    pickupTime:      "10:00",
    licenseNum:      "P334451122",
    licenseProvince: "NL",
    sourceDetail:    "Steele Volkswagen",
    vehicleSize:     "Regular",
    vehicleYear:     "2023",
    vehicleMake:     "Nissan",
    vehicleModel:    "Sentra",
    rentalAgreementStatus: "reservation",
  },
  // ── Gas Collections demo entries ─────────────────────────────────────────────
  {
    date: "2026-04-28", time: "09:00", pickupMeridiem: "AM",
    returnDate: "2026-05-10", returnTime: "02:00", returnMeridiem: "PM",
    location: "AF", resCode: "GCP 440 501",
    customer: "Grace Campbell", firstName: "Grace", lastName: "Campbell",
    phone: "709 555 0621", email: "",
    licenseNumber: "C448821001", licenseCountry: "Canada",
    licenseState: "NL", licenseExpiry: "2030-09-12",
    vehicleClass: "Compact Car", ratesVehicleClass: "Car — Compact",
    winterTires: "No",
    source: "Insurance",
    dailyRate: "45",
    adjusterName: "Karen Healey", claimNumber: "CL-2026-0418", fileNumber: "", authNumber: "",
    poNumber: "", paymentMethod: "Credit Card",
    preRentalCheck: "NOT Pre-Rental Check'd", notesLog: [], fromNonDrive: false,
    pickupTime:      "09:00",
    licenseNum:      "C448821001",
    licenseProvince: "NL",
    sourceDetail:    "Aviva Insurance",
    vehicleSize:     "Compact",
    vehicleYear:     "2024", vehicleMake: "Kia", vehicleModel: "Forte",
    rentalAgreementStatus: "close_pending",
    rentalPlate:     "BTM-663",
    gasOwed:         "48.50",
    gasPaymentStatus: "Unpaid",
  },
  {
    date: "2026-04-15", time: "11:00", pickupMeridiem: "AM",
    returnDate: "2026-05-02", returnTime: "10:00", returnMeridiem: "AM",
    location: "AF", resCode: "BWR 330 102",
    customer: "Barry Wright", firstName: "Barry", lastName: "Wright",
    phone: "709 555 0883", email: "",
    licenseNumber: "W229934567", licenseCountry: "Canada",
    licenseState: "NL", licenseExpiry: "2028-06-30",
    vehicleClass: "Regular SUV", ratesVehicleClass: "SUV — Regular",
    winterTires: "No",
    source: "Bodyshop/Dealership",
    dailyRate: "45",
    adjusterName: "", claimNumber: "", fileNumber: "", authNumber: "",
    poNumber: "", paymentMethod: "Credit Card",
    preRentalCheck: "NOT Pre-Rental Check'd", notesLog: [], fromNonDrive: false,
    pickupTime:      "11:00",
    licenseNum:      "W229934567",
    licenseProvince: "NL",
    sourceDetail:    "Steele Volkswagen",
    vehicleSize:     "Regular",
    vehicleYear:     "2024", vehicleMake: "Mazda", vehicleModel: "CX-5",
    rentalAgreementStatus: "closed",
    rentalPlate:     "KPV-551",
    gasOwed:         "22.00",
    gasPaymentStatus: "Partial",
  },
];

// ─── App Context ──────────────────────────────────────────────────────────────

const AppContext = React.createContext(null);

// ── runWrite: fire a supabase-js v1 write and report what happened ───────────
// v1 query builders are thenables, not Promises: they implement then() but not
// catch() or finally(). So `supabase.from(x).update(y).eq(...).catch(fn)` threw
// a TypeError on the .catch call, and because v1 only sends the request when
// then() is invoked, the write was never issued at all. Twelve call sites did
// this. Each one paired with an optimistic React update, so the screen showed
// the new value and the database kept the old one until the next reload.
//
// Found by the audit log rather than by anyone noticing: guardAction caught the
// TypeError and recorded the actions as refused.
const runWrite = (builder, label) =>
  builder.then(
    ({ error }) => { if (error) console.warn(`${label} failed:`, error); },
    (e) => console.warn(`${label} threw:`, e)
  );

// ─── PIN Confirmation Modal ───────────────────────────────────────────────────
// ── PIN failure messages ─────────────────────────────────────────────────────
const PIN_WRONG_MESSAGE = "Incorrect PIN. Please try again.";

// Shown when the check itself failed, as opposed to the PIN being wrong. These
// are different events and they now read differently: verify_pin was throwing
// 42883 on every call for two sessions, and because the failure was reported as
// "Incorrect PIN" it looked like a forgotten PIN rather than a broken gate.
// Still fails closed; it just stops lying about why.
const PIN_UNAVAILABLE_MESSAGE = "PIN check unavailable. Nothing was changed. Please try again or contact support.";

// verify_pin returned a bare boolean before the lockout was added. Both shapes
// are read here because the SQL is applied by hand: a browser holding the new
// code against a database that has not run add_pin_lockout.sql yet should still
// gate correctly rather than treat every PIN as wrong.
const readPinResult = (data) => {
  if (data === true)  return { ok: true };
  if (data === false || data == null) return { ok: false, locked: false };
  return { ok: data.ok === true, locked: data.locked === true,
           // 'no_pin_set' means the account has no PIN at all, usually because
           // an Admin just cleared it. Distinct from a wrong PIN because the
           // way out is different: there is nothing to type yet.
           reason: data.reason || null,
           // Taken from the verify_pin response, never from the cached profile.
           // The profile sits in localStorage where anyone can edit it; this
           // came from the users row in the same call that checked the PIN.
           role: data.role || null,
           attemptsLeft: data.attemptsLeft, retryInSeconds: data.retryInSeconds };
};

const PIN_SETUP_MESSAGE = "You do not have a PIN yet. Set one to continue.";

const pinFailureMessage = (result) => {
  if (result.locked) {
    const mins = Math.max(1, Math.ceil((result.retryInSeconds || 300) / 60));
    return `Too many incorrect attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
  }
  // Counting down only near the end. Showing "4 attempts remaining" on a single
  // typo reads as an accusation; showing it at one left is a useful warning.
  if (result.attemptsLeft === 1) return "Incorrect PIN. 1 attempt remaining before lockout.";
  return PIN_WRONG_MESSAGE;
};

// Reusable modal that gates any write operation behind the signed-in user's PIN.
// Rendered by AppProvider; shown via requirePin(fn) from anywhere in the tree.
function PinConfirmModal({ onConfirm, onCancel }) {
  const [pin,     setPin]     = React.useState("");
  const [error,   setError]   = React.useState("");
  const [loading, setLoading] = React.useState(false);
  // "confirm" until the database says there is no PIN to confirm.
  const [mode,    setMode]    = React.useState("confirm");
  const [newPin,  setNewPin]  = React.useState("");
  const [notice,  setNotice]  = React.useState("");
  const [focused, setFocused] = React.useState(true);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!pin) return;
    setLoading(true);
    const result = await onConfirm(pin);
    setLoading(false);
    if (result && result.ok) return;
    if (result && result.needsPinSetup) {
      setMode("setup");
      setError("");
      setNotice(result.message || PIN_SETUP_MESSAGE);
      setPin("");
      return;
    }
    setError((result && result.message) || PIN_WRONG_MESSAGE);
    setPin("");
  };

  const handleSetPin = async (e) => {
    e.preventDefault();
    if (!/^[0-9]{4}$/.test(newPin)) { setError("Your PIN must be 4 digits."); return; }
    setLoading(true);
    const { data, error: err } = await supabase.rpc("set_my_pin", { new_pin: newPin });
    setLoading(false);
    if (err || !data || !data.ok) {
      setError((data && STAFF_REASONS[data.reason]) || "Could not set your PIN. Try again.");
      return;
    }
    // Back to confirming, and they type it. Setting a PIN proves only that
    // somebody holds the session; the action still has to be confirmed by
    // someone who knows the PIN, which a moment ago nobody did.
    setMode("confirm");
    setNewPin("");
    setError("");
    setNotice("PIN set. Enter it to confirm this action.");
  };

  return React.createElement(
    "div",
    { className: "resModalBackdrop", onClick: onCancel },
    React.createElement(
      "div",
      { className: "resModal", style: { maxWidth: "340px" }, onClick: (e) => e.stopPropagation() },
      React.createElement(
        "div", { className: "resModalHeader" },
        React.createElement("h2", { className: "resModalTitle" },
          mode === "setup" ? "Set your PIN" : "Confirm PIN"),
        React.createElement("button", { type: "button", className: "resModalClose", onClick: onCancel }, "✕")
      ),
      mode === "setup" ? React.createElement(
        "form", { className: "resModalForm", onSubmit: handleSetPin },
        React.createElement(
          "div", { className: "resModalBody" },
          React.createElement("p", { style: { color: "#666", fontSize: "14px", marginBottom: "16px" } },
            notice || PIN_SETUP_MESSAGE),
          React.createElement("input", {
            className: "resFormInput",
            type: "password", inputMode: "numeric", maxLength: 4, autoFocus: true,
            placeholder: "New 4-digit PIN",
            value: newPin,
            onChange: (e) => { setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(""); },
          }),
          React.createElement("div", { style: { opacity: 0.65, fontSize: "12px", marginTop: "8px" } },
            "Nobody else can see or choose this, including whoever cleared it."),
          error && React.createElement("div", { className: "loginError" }, error)
        ),
        React.createElement(
          "div", { className: "resModalFooter" },
          React.createElement("button", { type: "button", className: "resModalCancel", onClick: onCancel }, "Cancel"),
          React.createElement("button", { type: "submit", className: "resModalSave", disabled: loading },
            loading ? "Setting\u2026" : "Set PIN")
        )
      ) : React.createElement(
        "form", { className: "resModalForm", onSubmit: handleSubmit },
        React.createElement(
          "div", { className: "resModalBody" },
          React.createElement("p", { style: { color: "#666", fontSize: "14px", marginBottom: "16px" } },
            notice || "Enter your PIN to confirm this action."
          ),
          // Four rendered slots with our own caret, rather than one centred
          // input faking dots with letter-spacing.
          //
          // The old version set text-align:center and letter-spacing:10px on a
          // password input and used "••••" as the placeholder. The browser puts
          // the caret at the text insertion point of the CENTRED text, which on
          // an empty field is the middle of the box, so it appeared between the
          // second and third placeholder dots. It then jumped around as the
          // string re-centred on every keystroke. The caret position and the dot
          // positions were computed by two different things and never agreed.
          //
          // The real input is still here and still receives every keystroke,
          // paste and IME event; it is just invisible, with its native caret
          // suppressed, so there is only one caret and we place it.
          React.createElement(
            "div",
            {
              className: `pinField${error ? " pinField--error" : ""}`,
              onMouseDown: (e) => { e.preventDefault(); inputRef.current && inputRef.current.focus(); },
            },
            React.createElement("input", {
              ref: inputRef,
              type: "password",
              inputMode: "text",
              maxLength: 4,
              className: "pinField__input",
              "aria-label": "PIN",
              autoComplete: "off",
              value: pin,
              onChange: (e) => { setPin(e.target.value.slice(0, 4)); setError(""); },
              onFocus: () => setFocused(true),
              onBlur:  () => setFocused(false),
            }),
            React.createElement(
              "div",
              { className: "pinField__slots", "aria-hidden": "true" },
              [0, 1, 2, 3].map((i) =>
                React.createElement(
                  "span",
                  { key: i, className: "pinSlot" },
                  // Caret sits before the next empty slot, which is exactly
                  // "after the last digit typed". At four it sits after the last.
                  focused && i === pin.length &&
                    React.createElement("i", { className: "pinCaret pinCaret--before" }),
                  focused && pin.length === 4 && i === 3 &&
                    React.createElement("i", { className: "pinCaret pinCaret--after" }),
                  React.createElement("span", {
                    className: `pinDot${i < pin.length ? "" : " pinDot--empty"}`,
                  })
                )
              )
            )
          ),
          error && React.createElement(
            "div",
            { style: { color: "#e53e3e", marginTop: "8px", fontSize: "13px", textAlign: "center" } },
            error
          )
        ),
        React.createElement(
          "div", { className: "resModalActions" },
          React.createElement("button", { type: "button", className: "resModalCancel", onClick: onCancel }, "Cancel"),
          React.createElement("button", {
            type: "submit",
            className: "resModalSubmit",
            disabled: loading || pin.length === 0,
          }, loading ? "Checking…" : "Confirm")
        )
      )
    )
  );
}

function AppProvider({ children, currentUser, signOut }) {
  // ── Persisted state (synced to Supabase) ─────────────────────────────────
  const [reservations, setReservationsState] = React.useState([]);
  const [ndiRows,      setNdiRowsState]      = React.useState([]);
  const [torRows,      setTorRowsState]      = React.useState([]);
  const [fleet,            setFleetState]            = React.useState([]);
  const [archivedVehicles, setArchivedVehicles]       = React.useState([]);
  const [noShows,          setNoShowsState]          = React.useState([]);
  const [rentalAgreements, setRentalAgreementsState] = React.useState([]);
  const raRef = React.useRef([]); // mirror of rentalAgreements for sync callbacks

  // ── Local UI state (seeded from constants; not synced to Supabase) ────────
  const [damageClaims, setDamageClaimsState] = React.useState([]);
  // app_settings rows collapsed to a plain { key: value } object for the UI.
  const [appSettings, setAppSettingsState] = React.useState({});
  const [readyReturns, setReadyReturns] = React.useState([]);

  // ── UI-only state (not persisted) ────────────────────────────────────────
  const [dbReady,      setDbReady]      = React.useState(false);
  const [openNotesId,  setOpenNotesId]  = React.useState(null);
  const [openRentalAgreementId, setOpenRentalAgreementId] = React.useState(null);
  const [openCustomer, setOpenCustomer] = React.useState(null);
  const [openVehiclePlate, setOpenVehiclePlate] = React.useState(null);

  // ── PIN confirmation modal ────────────────────────────────────────────────
  const [pinModalOpen, setPinModalOpen] = React.useState(false);
  const pendingFnRef = React.useRef(null);
  // What the pending action was, so dismissing the gate can be logged as a
  // cancellation rather than vanishing.
  const pendingAuditRef = React.useRef(null);

  // ── Audit log ─────────────────────────────────────────────────────────────
  // Writes one row per action. Deliberately fire-and-forget and wrapped in a
  // catch: an audit log that can block a rental from being opened, or surface a
  // Supabase error to a staff member mid-task, would be worse than one with a
  // gap in it. Failures go to the console instead.
  const logAudit = React.useCallback((entry) => {
    const row = {
      // actorId is deliberately NOT sent. A before-insert trigger sets it from
      // auth.uid(), and the insert policy rejects any row where it disagrees,
      // so a value supplied here would be discarded at best. Leaving it out
      // keeps this code honest about who decides: the database does.
      //
      // actor is sent, because one legitimate value is not a person: command
      // bar entries are signed `fleetr ai`. The trigger passes that label
      // through and replaces anything else with the caller's real name, so
      // what is sent here is a hint, not an assertion.
      actor:       entry.actor || actorName(currentUser),
      actionType:  entry.actionType,
      actionLabel: actionLabel(entry.actionType),
      tableName:   entry.tableName || null,
      recordId:    entry.recordId != null ? String(entry.recordId) : null,
      tier:        entry.tier || actionTier(entry.actionType),
      outcome:     entry.outcome,
      description: entry.description || null,
    };
    supabase.from("audit_log").insert(row)
      .then(({ error }) => { if (error) console.warn("audit_log insert failed:", error, row); })
      .catch((e) => console.warn("audit_log insert:", e, row));
  }, [currentUser]);

  // Call requirePin(fn) to show the PIN gate; fn runs only if PIN matches.
  // Private to this provider: everything goes through guardAction so that no
  // action can reach the PIN without also being logged and tiered by policy.
  const requirePin = (fn, auditEntry) => {
    pendingFnRef.current = fn;
    pendingAuditRef.current = auditEntry || null;
    setPinModalOpen(true);
  };

  // The single entry point every write goes through. Looks the action up in
  // ACTION_POLICY and either raises the PIN gate or runs it straight away,
  // because for the "confirm" tier the click that got here IS the confirmation.
  // Callers pass an action key rather than a boolean so the policy stays in one
  // place and cannot drift per call site.
  //
  // It is also where the audit log is written, for the same reason: this is the
  // one place both the UI and the command bar pass through, so a log hooked here
  // cannot be forgotten by a new handler the way a per-handler log would be.
  // `meta` carries what the entry cannot infer: which record, and a description.
  const guardAction = (actionKey, fn, meta) => {
    const tier  = actionTier(actionKey);
    const entry = { actionType: actionKey, tier, ...(meta || {}) };
    const run = async () => {
      try {
        await fn();
        logAudit({ ...entry, outcome: "completed" });
      } catch (e) {
        // The action itself threw. Record the attempt rather than lose it.
        logAudit({ ...entry, outcome: "refused", description: `${entry.description || ""} (failed: ${e.message})`.trim() });
        throw e;
      }
    };
    if (tier === "pin") { requirePin(run, entry); return; }
    run();
  };

  // Called by PinConfirmModal on submit.
  //
  // The PIN is checked inside the database by verify_pin, a security definer
  // function that reads the hash for auth.uid() and compares there. Nothing
  // about the PIN reaches the browser: no hash to grind offline, and no
  // client-side comparison for an attacker to simply skip.
  //
  // It is also a genuinely separate secret from the login password now. While
  // the two were the same string, every PIN prompt was asking for the password
  // the person had just typed to get in, so the tier bought nothing.
  const confirmPin = async (enteredPin) => {
    if (!currentUser) return { ok: false, message: PIN_WRONG_MESSAGE };

    const { data, error } = await supabase.rpc("verify_pin", { pin: enteredPin });
    if (error) {
      console.warn("verify_pin failed:", error);
      // Fail closed. A broken check must never open the gate.
      return { ok: false, message: PIN_UNAVAILABLE_MESSAGE };
    }
    const result = readPinResult(data);
    // Handed back rather than shown as a failure. The modal switches to setting
    // a PIN, because "Incorrect PIN" is a lie when there is no PIN to be wrong
    // about, and it leaves the person with nothing to try.
    if (!result.ok && result.reason === "no_pin_set") {
      return { ok: false, needsPinSetup: true, message: PIN_SETUP_MESSAGE };
    }
    if (!result.ok) return { ok: false, message: pinFailureMessage(result) };

    // Checked after the PIN, against the role the database just reported. The
    // database refuses the write either way; doing it here means the person is
    // told which permission they are missing rather than watching the action
    // fail for no stated reason.
    const needed = actionRole(pendingAuditRef.current?.actionType);
    if (needed && !roleAtLeast(result.role, needed)) {
      pendingFnRef.current = null;
      const entry = pendingAuditRef.current;
      pendingAuditRef.current = null;
      setPinModalOpen(false);
      // Logged as refused. An attempt at something above your permissions is
      // exactly the kind of thing the log should carry.
      if (entry) logAudit({ ...entry, outcome: "refused", description:
        `${entry.description || ""} (refused: ${needed} only)`.trim() });
      return { ok: false, message: `Only an ${needed} can do this.` };
    }

    const fn = pendingFnRef.current;
    pendingFnRef.current = null;
    pendingAuditRef.current = null;
    setPinModalOpen(false);
    if (fn) await fn();
    return { ok: true };
  };

  // Backing out of the PIN is recorded, not just successful writes. Someone
  // reaching the gate on a delete or a PM override and then stopping is exactly
  // what a reviewer would want to see, and it leaves no other trace.
  const dismissPinModal = () => {
    const entry = pendingAuditRef.current;
    pendingFnRef.current = null;
    pendingAuditRef.current = null;
    setPinModalOpen(false);
    if (entry) logAudit({ ...entry, outcome: "cancelled" });
  };

  // ── setRentalAgreements: keeps raRef in sync alongside React state ──────────
  // Direct Supabase writes for rental_agreements are handled by syncRAStatus;
  // this setter is for load-time and internal state updates only.
  const setRentalAgreements = (updater) => {
    setRentalAgreementsState((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      raRef.current = next;
      return next;
    });
  };

  // ── syncRAStatus: explicit direct write for rentalAgreementStatus changes ──
  // Called at each action point that changes status; updates rental_agreements
  // directly without any batch sync.
  //
  // It also moves the vehicle, because for most callers the status change IS
  // the whole action and nothing else is going to. skipFleet is for the caller
  // that sets the vehicle itself: Close Rental works out Needs Cleaning,
  // Damaged or PM from what it found on the return, and the Ready Returns write
  // this would otherwise fire was not awaited, so the two raced and the wrong
  // one could land last. That left a freshly damaged vehicle sitting in the
  // returns queue looking ready to hand out.
  async function syncRAStatus(resCode, status, { skipFleet = false } = {}) {
    try {
      const existing = raRef.current.find((ra) => ra.resCode === resCode);
      if (existing) {
        if (existing.rentalAgreementStatus === status) return;

        // An agreement created by the insert branch below carries only resCode
        // and status, so existing.plate is null until the rental agreement page
        // fills it in. Reading it blindly meant the vehicle silently failed to
        // move to Ready Returns on close, so fall back to the reservation and
        // backfill the row while we are writing to it anyway.
        const plate = existing.plate || reservations.find((r) => r.resCode === resCode)?.plate || null;
        const patch = { rentalAgreementStatus: status };
        if (!existing.plate && plate) patch.plate = plate;

        await supabase.from("rental_agreements").update(patch).eq("id", existing.id);
        const updated = raRef.current.map((ra) =>
          ra.resCode === resCode ? { ...ra, ...patch } : ra
        );
        raRef.current = updated;
        setRentalAgreementsState(updated);

        // Enforce vehicle status rules driven by RA status
        if (plate && !skipFleet) {
          const newFleetStatus =
            status === "open_rental_agreement" ? "On Rent" :
            status === "customer_return"       ? "Ready Returns" :
            status === "close_pending"         ? "Ready Returns" : null;
          if (newFleetStatus) {
            setFleetState((prev) =>
              prev.map((v) => v.plate === plate ? { ...v, status: newFleetStatus } : v)
            );
            supabase.from("fleet").update({ status: newFleetStatus }).eq("plate", plate)
              .then((res) => console.log("fleet status sync:", res))
              .catch((e) => console.warn("fleet status sync:", e));
          }
        }
      } else if (status && status !== "reservation") {
        const { data } = await supabase
          .from("rental_agreements")
          .insert({ resCode, rentalAgreementStatus: status })
          .select("*")
          .maybeSingle();
        if (data) {
          const updated = [...raRef.current, data];
          raRef.current = updated;
          setRentalAgreementsState(updated);
        }

        // Enforce vehicle status rules driven by RA status (first-time insert)
        const plate = data?.plate || reservations.find((r) => r.resCode === resCode)?.plate;
        if (plate && !skipFleet) {
          const newFleetStatus =
            status === "open_rental_agreement" ? "On Rent" :
            status === "customer_return"       ? "Ready Returns" :
            status === "close_pending"         ? "Ready Returns" : null;
          if (newFleetStatus) {
            setFleetState((prev) =>
              prev.map((v) => v.plate === plate ? { ...v, status: newFleetStatus } : v)
            );
            supabase.from("fleet").update({ status: newFleetStatus }).eq("plate", plate)
              .then((res) => console.log("fleet status sync:", res))
              .catch((e) => console.warn("fleet status sync:", e));
          }
        }
      }
    } catch (e) {
      console.warn("rental_agreements status sync error:", e);
    }
  }

  // ── Plain state setters exposed to components ─────────────────────────────
  // Every Supabase write is performed explicitly at the point of action in
  // each component; these setters only update React state.
  const setReservations = setReservationsState;
  const setNdiRows      = setNdiRowsState;
  const setTorRows      = setTorRowsState;
  const setFleet        = setFleetState;
  const setNoShows      = setNoShowsState;
  const setDamageClaims = setDamageClaimsState;

  // Writes one app_settings key and mirrors it into local state. Used by the
  // Settings page for the gas markup and per-region fuel prices.
  //
  // locationId is passed explicitly rather than left to the fill_tenant trigger,
  // and it is part of the conflict target. The key alone is no longer unique:
  // every location holds its own gasMarkupPercent, and upserting on "key" would
  // find another company's row and overwrite their fuel price with this one.
  const saveSetting = React.useCallback(async (key, value) => {
    const locationId = currentUser?.locationId;
    if (!locationId) {
      console.warn("saveSetting called with no location on the profile:", key);
      return false;
    }
    setAppSettingsState((prev) => ({ ...prev, [key]: value }));
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key, value, locationId, updatedAt: new Date().toISOString() },
              { onConflict: "locationId,key" });
    if (error) console.warn("app_settings upsert failed:", key, error);
    return !error;
  }, [currentUser?.locationId]);

  // ── Initial load from Supabase ───────────────────────────────────────────
  React.useEffect(() => {
    async function load() {
      const [res, ndi, tor, fl, ns, ra, dc, st, av] = await Promise.all([
        supabase.from("reservations").select("*"),
        supabase.from("ndi_rows").select("*"),
        supabase.from("tor_rows").select("*"),
        supabase.from("fleet").select("*"),
        supabase.from("no_shows").select("*"),
        supabase.from("rental_agreements").select("*"),
        supabase.from("damage_claims").select("*"),
        supabase.from("app_settings").select("*").eq("locationId", currentUser?.locationId ?? null),
        supabase.from("archived_vehicles").select("*").order("disposalDate", { ascending: false }),
        // Fills companyLists rather than returning rows, and never throws: a
        // failure leaves the built-in lists in charge.
        loadCompanyLists(currentUser),
        // Fills companyUnits, and never throws: a failure leaves litres and km.
        loadCompanyUnits(currentUser),
      ]);

      // maybeSeED used to live here. Both of its call sites passed an empty
      // seed and its guard required a non-empty one, so its body was
      // unreachable: it could only ever return `data || []`, which is what the
      // two lines below now do directly.
      //
      // Worth removing rather than fixing. It carried a raw insert that ran
      // under the anon key and could write invented rows into reservations and
      // rental_agreements, which is the same shape of dormant hazard as the
      // one-time cleanup block deleted earlier.

      let [resData, ndiData, torData, flData, nsData, raData] = await Promise.all([
        // Reservations and rental agreements come from Supabase only. Nothing
        // is ever seeded into them.
        Promise.resolve(res.data || []),
        Promise.resolve(ndi.data || []),
        Promise.resolve(tor.data || []),
        Promise.resolve(fl.data  || []),
        Promise.resolve(ns.data  || []),
        Promise.resolve(ra.data  || []),
      ]);

      // ── 1. Migrate reservation codes to new format "ABC 123 456" ─────────────
      const RES_CODE_RE = /^[A-Z]{3} \d{3} \d{3}$/;

      // Purge records with null or empty resCode from Supabase first.
      // These cannot be reliably deleted by resCode (SQL "col = NULL" is always
      // false; only "col IS NULL" matches), so without this step they would
      // survive every run and trigger a new random code on every refresh.
      try {
        await supabase.from("reservations").delete().is("resCode", null);
        await supabase.from("reservations").delete().eq("resCode", "");
      } catch (e) { console.warn("resCode purge error:", e); }
      resData = resData.filter((r) => r.resCode);

      // Migrate any remaining old-format codes (e.g. "C9511234") to "ABC 123 456".
      // Use update-in-place instead of insert+delete to avoid creating duplicate
      // records if the delete step were to fail.
      const needsMigration = resData.filter((r) => !RES_CODE_RE.test(r.resCode));
      if (needsMigration.length > 0) {
        const LL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const r3L = () => Array.from({ length: 3 }, () => LL[Math.floor(Math.random() * 26)]).join("");
        const r3D = () => String(Math.floor(Math.random() * 1000)).padStart(3, "0");
        const usedCodes = new Set([
          ...resData.map((r) => r.resCode),
          ...nsData.map((r) => r.resCode),
        ].filter(Boolean));
        for (const r of needsMigration) {
          let newCode;
          for (let i = 0; i < 50; i++) {
            const c = `${r3L()} ${r3D()} ${r3D()}`;
            if (!usedCodes.has(c)) { newCode = c; break; }
          }
          if (!newCode) newCode = `${r3L()} ${r3D()} ${r3D()}`;
          usedCodes.add(newCode);
          try {
            await supabase.from("reservations").update({ resCode: newCode }).eq("resCode", r.resCode);
          } catch (e) {
            console.warn("resCode migration error:", e);
          }
          r.resCode = newCode;
        }
      }

      // ── 1b. Migrate ndi_rows codes to new format "ABC 123 456" ──────────────
      // Note: the ndi_rows table column is the lowercase "rescode", not "resCode"
      // like every other table. This is a one-off inconsistency in how the column
      // was created (unquoted in SQL, so Postgres folded it to lowercase).
      const ndiNeedsMigration = ndiData.filter((r) => !RES_CODE_RE.test(r.rescode || ""));
      if (ndiNeedsMigration.length > 0) {
        const LL2 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const r3L2 = () => Array.from({ length: 3 }, () => LL2[Math.floor(Math.random() * 26)]).join("");
        const r3D2 = () => String(Math.floor(Math.random() * 1000)).padStart(3, "0");
        const usedNdiCodes = new Set([
          ...resData.map((r) => r.resCode),
          ...ndiData.map((r) => r.rescode),
          ...nsData.map((r) => r.resCode),
        ].filter(Boolean));
        for (const r of ndiNeedsMigration) {
          let newCode;
          for (let i = 0; i < 50; i++) {
            const c = `${r3L2()} ${r3D2()} ${r3D2()}`;
            if (!usedNdiCodes.has(c)) { newCode = c; break; }
          }
          if (!newCode) newCode = `${r3L2()} ${r3D2()} ${r3D2()}`;
          usedNdiCodes.add(newCode);
          try {
            await supabase.from("ndi_rows").update({ rescode: newCode }).eq("id", r.id);
          } catch (e) {
            console.warn("ndi_rows resCode migration error:", e);
          }
          r.rescode = newCode;
        }
      }

      // ── 2. Move overdue "Pending arrival" reservations to no_shows ───────────
      // Note: no_shows.id is a strict UUID column, so newly created rows must use
      // crypto.randomUUID() rather than a custom string, and the same id must be
      // reused in local state so later updates/deletes (eq("id", ...)) match the
      // real row. no_shows.rescode is also lowercase, like ndi_rows.rescode.
      const loadTodayIso = new Date().toISOString().slice(0, 10);
      const existingNsCodes = new Set(nsData.map((ns) => ns.rescode));
      const overdueRes = resData.filter(
        (r) => r.date < loadTodayIso &&
               r.pickupStatus === "Pending arrival" &&
               r.rentalAgreementStatus === "reservation"
      );
      const toMove = overdueRes.filter((r) => !existingNsCodes.has(r.resCode));
      if (toMove.length > 0) {
        const newNsEntries = toMove.map((r) => ({
          id:           crypto.randomUUID(),
          rescode:      r.resCode,
          customer:     r.customer,
          time:         r.time || "",
          vehicleClass: r.vehicleClass || "",
          location:     r.location || "",
          date:         r.date,
          phone:        r.phone || "",
          called:       false,
          status:       "",
          stage:        "2hour",
        }));
        try {
          // Raw fetch bypasses Supabase JS v1 SDK's automatic `columns` URL param
          const sweepRes = await fetch(`${SUPABASE_URL}/rest/v1/no_shows`, {
            method: "POST",
            headers: restHeaders({
              "Content-Type": "application/json",
              "Prefer":       "return=minimal",
            }),
            body: JSON.stringify(newNsEntries),
          });
          if (!sweepRes.ok) {
            console.warn("No-shows sweep insert failed:", sweepRes.status, await sweepRes.text());
          } else {
            for (const r of toMove) {
              const { error: delError } = await supabase.from("reservations").delete().eq("resCode", r.resCode);
              if (delError) console.warn("No-shows sweep reservation delete failed:", r.resCode, delError);
            }
          }
        } catch (e) {
          console.warn("No-shows sweep error:", e);
        }
        const moveCodes = new Set(toMove.map((r) => r.resCode));
        resData = resData.filter((r) => !moveCodes.has(r.resCode));
        nsData  = [...nsData, ...newNsEntries];
      }

      // Merge rentalAgreementStatus from rental_agreements (authoritative) into
      // reservation objects so all UI reads r.rentalAgreementStatus as before.
      const raByResCode = Object.fromEntries(raData.map((a) => [a.resCode, a]));
      const mergedResData = resData.map((r) => {
        const ra = raByResCode[r.resCode];
        return ra ? { ...r, rentalAgreementStatus: ra.rentalAgreementStatus } : r;
      });

      setReservationsState(mergedResData);
      setNdiRowsState(ndiData);
      setTorRowsState(torData);
      setFleetState(flData);
      setNoShowsState(nsData);
      raRef.current = raData;
      setRentalAgreementsState(raData);
      setDamageClaimsState(dc.data || []);
      setArchivedVehicles(av.data || []);
      setAppSettingsState(Object.fromEntries((st.data || []).map((r) => [r.key, r.value])));
      setDbReady(true);
    }

    load().catch((err) => {
      console.error("Supabase load failed:", err);
      setReservationsState([]);
      setNdiRowsState(NDI_SEED);
      setTorRowsState(TOR_SEED);
      setFleetState([]);
      setNoShowsState(NO_SHOWS_SEED);
      raRef.current = [];
      setRentalAgreementsState([]);
      setDamageClaimsState([]);
      setArchivedVehicles([]);
      setAppSettingsState({});
      setDbReady(true);
    });
  }, []);

  // ── No real-time subscriptions ────────────────────────────────────────────
  // Eight subscribe() calls used to live here, one per table, each re-fetching
  // its slice on change. They never fired. These tables are not in the
  // supabase_realtime publication, so Postgres publishes nothing for them and
  // the channel delivers no events, verified by subscribing as the row's own
  // tenant and watching a real write produce silence while the socket reported
  // SUBSCRIBED.
  //
  // Removed rather than fixed. Live code that cannot run is worse than absent
  // code: it states a guarantee the app does not have, and two staff members
  // reading it would reasonably conclude they see each other's changes.
  //
  // Turning it on is not a small change. Realtime is a separate path from
  // PostgREST and does not apply the policies added in step 7, so publishing
  // these tables without configuring RLS on the channel would hand every
  // subscriber every tenant's rows.

  // ── Automated SMS ─────────────────────────────────────────────────────────
  // Removed. All customer texting (pre-rental check, no-show 2hr/24hr, overdue,
  // and the new 24h-before-return reminder) now runs from a Cloudflare Cron
  // Trigger in the fleetr-ai-proxy Worker, so it no longer depends on a staff
  // browser tab being open. Dedup lives in the notifications_sent table rather
  // than this browser's localStorage. See worker.js -> scheduled().

  // ── Loading screen ───────────────────────────────────────────────────────
  if (!dbReady) {
    return React.createElement(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          background: "#1F1E1D",
          color: "#42a4ff",
          fontFamily: "'Inter', sans-serif",
          fontSize: "1.4rem",
          letterSpacing: "0.05em",
        },
      },
      "Loading fleetr…"
    );
  }

  return React.createElement(
    AppContext.Provider,
    { value: { reservations, setReservations, rentalAgreements, setRentalAgreements, syncRAStatus, ndiRows, setNdiRows, torRows, setTorRows, openNotesId, setOpenNotesId, fleet, setFleet, noShows, setNoShows, openRentalAgreementId, setOpenRentalAgreementId, openCustomer, setOpenCustomer, openVehiclePlate, setOpenVehiclePlate, damageClaims, setDamageClaims, archivedVehicles, setArchivedVehicles, readyReturns, setReadyReturns, appSettings, saveSetting, guardAction, logAudit, currentUser, signOut } },
    children,
    pinModalOpen && React.createElement(PinConfirmModal, { onConfirm: confirmPin, onCancel: dismissPinModal })
  );
}

// ─── NotesCell component ──────────────────────────────────────────────────────

function NotesCell({ noteId, preRentalCheck, notesLog: notesLogRaw, onAddNote }) {
  const notesLog = parseNotesLog(notesLogRaw);
  const { openNotesId, setOpenNotesId } = React.useContext(AppContext);
  const [viewOpen, setViewOpen] = React.useState(false);
  const [viewAnchor, setViewAnchor] = React.useState({ x: 0, y: 0 });
  const [searchInput, setSearchInput] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addAnchor, setAddAnchor] = React.useState({ x: 0, y: 0 });
  const [addText, setAddText] = React.useState("");

  // Close when another NotesCell opens
  React.useEffect(() => {
    if (openNotesId !== noteId) {
      setViewOpen(false);
      setAddOpen(false);
    }
  }, [openNotesId, noteId]);

  React.useEffect(() => {
    if (!viewOpen && !addOpen) return;
    const close = () => { setViewOpen(false); setAddOpen(false); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [viewOpen, addOpen]);

  const statusClass =
    preRentalCheck === "Pre-Rental Check'd" ? "preRentalCheckDone"
    : preRentalCheck === "LM Pre-Rental Check'd" ? "preRentalCheckLm"
    : "preRentalCheckNot";

  const hasNotes = notesLog && notesLog.length > 0;
  const showPreRentalCheck = isFeatureEnabled("pre_rental_check");

  const filteredNotes = hasNotes
    ? notesLog.filter((n) => {
        if (searchQuery === "") return true;
        const q = searchQuery.toLowerCase();
        return (
          n.text.toLowerCase().includes(q) ||
          formatAuthor(n.author).toLowerCase().includes(q) ||
          (n.author || "").toLowerCase().includes(q)
        );
      })
    : [];

  const PAGE_SIZE = 5;
  const totalPages = Math.ceil(filteredNotes.length / PAGE_SIZE);
  const pagedNotes = filteredNotes.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const calcAnchor = (rect, dropW, dropH) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = rect.left;
    let y = rect.bottom + 4;
    if (x + dropW > vw - 8) x = Math.max(8, vw - dropW - 8);
    if (y + dropH > vh - 8) y = Math.max(8, rect.top - dropH - 4);
    return { x, y };
  };

  const handleViewClick = (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setViewAnchor(calcAnchor(rect, 380, 300));
    setSearchInput("");
    setSearchQuery("");
    setPage(1);
    setAddOpen(false);
    setOpenNotesId(noteId);
    setViewOpen((prev) => !prev);
  };

  const handleAddClick = (e) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setAddAnchor(calcAnchor(rect, 280, 110));
    setAddText("");
    setViewOpen(false);
    setOpenNotesId(noteId);
    setAddOpen((prev) => !prev);
  };

  const handleAddSubmit = (e) => {
    e.preventDefault();
    if (!addText.trim()) return;
    const text = addText.trim();
    onAddNote && onAddNote({ author: "Connor Nash", text });
    setAddText("");
    setAddOpen(false);
  };

  return React.createElement(
    "div",
    { className: "notesCellWrap" },

    // ── + button ──────────────────────────────────────────────────────────
    React.createElement(
      "button",
      { type: "button", className: "notesAddBtn", onClick: handleAddClick },
      "+"
    ),

    // ── Pre-Rental Check status ───────────────────────────────────────────────────────
    // Left out when the company has pre_rental_check off. The dash below only
    // separates this status from the notes, so it goes with it; the wrap's gap
    // spaces whatever remains.
    showPreRentalCheck && React.createElement("span", { className: statusClass }, preRentalCheck),

    // ── dash + notes preview button ───────────────────────────────────────
    hasNotes && showPreRentalCheck && React.createElement("span", { className: "notesDash" }, " \u2014 "),
    hasNotes &&
      React.createElement(
        "button",
        { type: "button", className: "aiCallButton notesCellBtn", onClick: handleViewClick },
        notesLog[notesLog.length - 1].text
      ),

    // ── View/search dropdown ──────────────────────────────────────────────
    viewOpen &&
      React.createElement(
        "div",
        {
          className: "notesDropdown",
          style: { left: `${viewAnchor.x}px`, top: `${viewAnchor.y}px` },
          onClick: (e) => e.stopPropagation(),
        },
        React.createElement("input", {
          className: "notesSearch",
          placeholder: "Search notes\u2026",
          value: searchInput,
          onChange: (e) => setSearchInput(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter") { setSearchQuery(searchInput); setPage(1); }
          },
        }),
        React.createElement(
          "div",
          { className: "notesList" },
          filteredNotes.length === 0
            ? React.createElement("div", { className: "notesEmpty" }, "No notes match your search.")
            : pagedNotes.map((note, idx) =>
                React.createElement(
                  "div",
                  { key: idx, className: "notesRow" },
                  React.createElement("span", { className: "notesAuthor" }, formatAuthor(note.author)),
                  React.createElement("span", { className: "notesText" }, note.text)
                )
              )
        ),
        totalPages > 1 &&
          React.createElement(
            "div",
            { className: "notesPager" },
            Array.from({ length: totalPages }, (_, i) => i + 1).map((p) =>
              React.createElement(
                "button",
                {
                  key: p,
                  type: "button",
                  className: p === page ? "notesPagerBtn notesPagerBtn--active" : "notesPagerBtn",
                  onClick: (e) => { e.stopPropagation(); setPage(p); },
                },
                p
              )
            )
          )
      ),

    // ── Add note dropdown ─────────────────────────────────────────────────
    addOpen &&
      React.createElement(
        "form",
        {
          className: "notesDropdown",
          style: { left: `${addAnchor.x}px`, top: `${addAnchor.y}px`, width: "280px" },
          onClick: (e) => e.stopPropagation(),
          onSubmit: handleAddSubmit,
        },
        React.createElement("input", {
          className: "notesSearch",
          placeholder: "Add a note\u2026",
          value: addText,
          onChange: (e) => setAddText(e.target.value),
          autoFocus: true,
        }),
        React.createElement(
          "div",
          { style: { padding: "8px 12px" } },
          React.createElement(
            "button",
            { type: "submit", className: "aiCallButton", style: { width: "100%" } },
            "Add Note"
          )
        )
      )
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const RESERVATIONS_SEED = [
  {
    id: "rv-1", resCode: "RVS 001 101",
    firstName: "Connor", lastName: "Nash",
    phone: "709 123 4567", email: "connornash@fleetr.ai",
    pickupDate: "2026-05-07", pickupTime: "3:00 PM",
    returnDate: "2026-05-14", returnTime: "3:00 PM",
    licenseNum: "N123456789", licenseCountry: "Canada",
    licenseProvince: "NL", licenseExpiry: "2031-04-21",
    source: "Bodyshop/Dealership", sourceDetail: "Avalon Ford",
    vehicleClass: "SUV", vehicleSize: "Regular",
    winterTires: "No", dailyRate: 45,
    pickupStatus: "Pending arrival", fromNonDrive: false,
  },
];

const LOCATION_OPTIONS = ["AF", "FA", "CCS", "CS", "CCTOP", "WI", "PU"];

const EMPTY_RES_FORM = {
  date: new Date().toISOString().slice(0, 10),
  time: "", location: "WI",
  vehicleClass: "Compact Car", winterTires: "No",
  noteText: "",
  firstName: "", lastName: "", phone: "", email: "", licenseNumber: "",
  returnDate: "", returnTime: "",
  source: "", sourceDetail: "",
  dailyRate: "", adjusterName: "", claimNumber: "",
  fileNumber: "", authNumber: "", poNumber: "",
  paymentMethod: "Credit Card",
};

// The blank form, with the location and class the company's own lists start on.
const emptyResForm = () => ({
  ...EMPTY_RES_FORM,
  location: defaultPickupLocation(),
  vehicleClass: defaultVehicleClass(RES_VEHICLE_CLASSES),
});

// ─── Status label helper ──────────────────────────────────────────────────────

function statusLabel(s) {
  if (s === "open_rental_agreement") return "Open";
  if (s === "customer_return")       return "Customer Return";
  if (s === "close_pending")         return "Close Pending";
  if (s === "closed")                return "Closed";
  if (s === "reservation")           return "Reservation";
  return s || "";
}

// Every rental agreement badge takes its class from here. There were four
// copies of this, written as if/else ladders that each ended in a bare "else
// closed", so a status none of them named was painted red and labelled Closed:
// the most final-looking answer in the set, given to the one case where the
// code does not know the answer. A status is going to be added to this system
// before long, and four ladders is four chances to miss one.
//
// An explicit map instead. A status that is not in it gets the neutral badge,
// which looks like the others and claims nothing. statusLabel already returns
// an unrecognised status verbatim, so the badge reads as the raw value, which
// is the one thing that tells whoever sees it what actually needs adding here.
const RA_BADGE_VARIANTS = {
  open_rental_agreement: "rentalAgreementBadge--open",
  // Returned by the customer, not yet processed by staff. Its own colour
  // rather than sharing Close Pending's: the whole point of the state is that
  // nobody has looked at the vehicle yet, and a queue you cannot pick out at a
  // glance is not a queue.
  customer_return:       "rentalAgreementBadge--customerReturn",
  close_pending:         "rentalAgreementBadge--pending",
  closed:                "rentalAgreementBadge--closed",
  // Not a rental agreement yet. Neutral rather than one of the three live
  // states: the two ladders that used to reach it painted it as Closed.
  reservation:           "rentalAgreementBadge--neutral",
};

// meta: the larger variant the customer page header uses.
function raBadgeClass(status, { meta = false } = {}) {
  const variant = RA_BADGE_VARIANTS[status] || "rentalAgreementBadge--neutral";
  return `rentalAgreementBadge ${variant}${meta ? " rentalAgreementBadge--meta" : ""}`;
}

// ─── Status groups ───────────────────────────────────────────────────────────
// Named where more than one screen asks the same question of a status, so the
// answer cannot drift between them. Each of these was a literal comparison
// repeated across the file, which is how close_pending came to mean two
// different things depending on which screen was asking.

// A vehicle is sitting in Ready Returns under one of these. Both mean the
// vehicle is physically back: customer_return because the customer app put it
// there, close_pending because a rental returned before customer_return
// existed did. Used to find the agreement behind a row in that queue.
const RA_IN_READY_RETURNS = ["customer_return", "close_pending"];

// The vehicle's status may not be set by hand under one of these. The rental
// owns the vehicle while it is out, and it still owns it once the customer has
// dropped it off and before staff have processed it: that vehicle is not free
// to be marked Available by someone passing the detail page.
const RA_LOCKS_VEHICLE_STATUS = ["open_rental_agreement", "customer_return"];

// The only rental agreement status change a person may make by hand: finishing
// a Close Pending agreement, which is the paperwork step and nothing else.
//
// Everything before that is the return process's to decide. Close Rental reads
// the closing mileage and fuel, records the leg, asks about damage, works out
// where the vehicle goes and works out whether the agreement owes anything.
// A button that jumped an open rental straight to closed skipped all of it:
// no leg, no odometer, no damage answer, no gas charge, and a vehicle left On
// Rent with nobody holding it. The rental looked finished and none of the
// things that finish a rental had happened.
//
// One function so the buttons and the command bar cannot disagree. Answering
// with the message rather than a boolean keeps the refusal in one place too.
function manualRaTransition(from, to) {
  if (from === "close_pending" && to === "closed") {
    return { ok: true, error: null };
  }
  if (from === "open_rental_agreement" || from === "customer_return") {
    return { ok: false, error:
      "This rental has to go through Close Rental. It records the closing mileage and fuel, the damage answer and the vehicle's next status, and it decides whether the agreement can be closed or is held for charges. Open Close Rental for this reservation." };
  }
  return { ok: false, error:
    "The only rental agreement status that can be changed by hand is a Close Pending one, which can be closed. Everything else is set by opening a rental or by Close Rental." };
}

// ─── CustomerLink ─────────────────────────────────────────────────────────────

function CustomerLink({ name, resCode, label, hideBadge }) {
  const { setOpenCustomer, reservations } = React.useContext(AppContext);
  const navigate = useNavigate();
  const res = reservations.find((r) => r.resCode === resCode);
  const raStatus = res?.rentalAgreementStatus;
  const showBadge = !hideBadge && label === undefined && raStatus && raStatus !== "reservation";
  const badgeClass = raBadgeClass(raStatus);
  const displayText = label !== undefined ? label
    : resCode ? `${name} — ${resCode}` : name;
  return React.createElement(
    "span",
    { className: "customerLinkWrap" },
    React.createElement("button", {
      type: "button",
      className: "customerLink",
      onClick: () => { setOpenCustomer({ name, resCode }); navigate("/customer"); },
    }, displayText),
    showBadge &&
      React.createElement("span", { className: badgeClass }, statusLabel(raStatus))
  );
}

// ─── PlateLink ────────────────────────────────────────────────────────────────

function PlateLink({ plate, label, style }) {
  const { setOpenVehiclePlate } = React.useContext(AppContext);
  const navigate = useNavigate();
  return React.createElement("button", {
    type: "button",
    className: "plateLink",
    style,
    onClick: () => { setOpenVehiclePlate(plate); navigate("/vehicle"); },
  }, label !== undefined ? label.replace(/-/g, "") : plate.replace(/-/g, ""));
}

// ─── Unique Res Code generator ────────────────────────────────────────────────
// A code must be unique across every company, not just this branch:
// fleetr-customer looks a code up with no idea which company it belongs to.
//
// The check goes through res_code_taken (supabase/res_code_taken.sql in
// fleetr-infra), which sees every tenant's rows. Selecting the code directly
// cannot: row level security scopes those reads to the caller's own location,
// so another company's code looked free.
//
// Until that function exists (or if the call fails), the direct selects below
// still run, so a code is never less checked than before. no_shows keeps its
// code in lowercase "rescode"; querying "resCode" there errored, and the error
// read as "not taken", so no-show codes were never checked at all.
async function resCodeTaken(code) {
  const { data, error } = await supabase.rpc("res_code_taken", { p_code: code });
  if (!error) return data !== false;
  const [r1, r2, r3] = await Promise.all([
    supabase.from("reservations").select("*").eq("resCode", code).limit(1),
    supabase.from("ndi_rows").select("rescode").eq("rescode", code),
    supabase.from("no_shows").select("rescode").eq("rescode", code),
  ]);
  return [r1, r2, r3].some((r) => r.data && r.data.length > 0);
}

async function generateUniqueResCode() {
  const L    = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const rand3L = () => Array.from({ length: 3 }, () => L[Math.floor(Math.random() * 26)]).join("");
  const rand3D = () => String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  for (let i = 0; i < 30; i++) {
    const code = `${rand3L()} ${rand3D()} ${rand3D()}`;
    try {
      const exists = await resCodeTaken(code);
      if (!exists) return code;
    } catch {
      return code; // Supabase unreachable — accept the code
    }
  }
  return `${rand3L()} ${rand3D()} ${rand3D()}`; // exhaustion fallback
}

// ─── ReservationsPage ─────────────────────────────────────────────────────────

function ReservationsPage() {
  const { reservations, setReservations, noShows, setNoShows } = React.useContext(AppContext);
  const navigate = useNavigate();
  const todayIso = new Date().toISOString().slice(0, 10);
  const [showModal, setShowModal] = React.useState(false);
  const [form, setForm] = React.useState(emptyResForm);
  const [srchFirst, setSrchFirst] = React.useState("");
  const [srchLast,  setSrchLast]  = React.useState("");
  const [srchPhone, setSrchPhone] = React.useState("");
  const [srchRes,   setSrchRes]   = React.useState("");
  const [srchDate,  setSrchDate]  = React.useState(todayIso);
  const [datePickerOpen, setDatePickerOpen]   = React.useState(false);
  const [datePickerAnchor, setDatePickerAnchor] = React.useState({ x: 0, y: 0 });
  const [filterPickerMonth, setFilterPickerMonth] = React.useState(null);

  // ── Sweep: move past-due "Pending arrival" reservations into No Shows ────────
  // Note: no_shows.id is a strict UUID column and no_shows.rescode is lowercase,
  // same as the AppProvider load-time sweep. Keep both in sync if this changes.
  React.useEffect(() => {
    const overdue = reservations.filter(
      (r) => r.date < todayIso &&
             r.pickupStatus === "Pending arrival" &&
             r.rentalAgreementStatus === "reservation"
    );
    if (overdue.length === 0) return;
    const existingCodes = new Set(noShows.map((ns) => ns.rescode));
    const toAdd = overdue.filter((r) => !existingCodes.has(r.resCode));
    if (toAdd.length === 0) return;
    const newNsRows = toAdd.map((r) => ({
      id:           crypto.randomUUID(),
      rescode:      r.resCode,
      customer:     r.customer,
      time:         r.time || "",
      vehicleClass: r.vehicleClass || "",
      location:     r.location || "",
      date:         r.date,
      phone:        r.phone || "",
      called:       false,
      status:       "",
      stage:        "2hour",
    }));
    setNoShows((prev) => [...prev, ...newNsRows]);
    for (const ns of newNsRows) {
      supabase.from("no_shows").insert(ns).then(({ error }) => {
        if (error) console.warn("no_shows insert failed:", ns.rescode, error);
      }).catch((e) => console.warn("no_shows insert:", e));
    }
    const overdueCodes = new Set(overdue.map((r) => r.resCode));
    setReservations((prev) => prev.filter((r) => !overdueCodes.has(r.resCode)));
    for (const r of overdue) {
      supabase.from("reservations").delete().eq("resCode", r.resCode).then(({ error }) => {
        if (error) console.warn("reservations delete failed:", r.resCode, error);
      }).catch((e) => console.warn("reservations delete:", e));
    }
  }, [reservations, noShows]); // eslint-disable-line react-hooks/exhaustive-deps

  const fmtDate = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };

  const filterDateLabel = srchDate ? fmtDate(srchDate) : "Filter by date";

  const moveFilterMonth = (delta) => {
    setFilterPickerMonth((prev) => {
      const base = prev || `${(srchDate || todayIso).slice(0, 7)}-01`;
      const [y, m] = base.split("-").map(Number);
      const next = new Date(y, m - 1 + delta, 1);
      return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
    });
  };

  const getFilterCalendarDays = () => {
    const monthIso = filterPickerMonth || `${(srchDate || todayIso).slice(0, 7)}-01`;
    const [y, m] = monthIso.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const daysInMonth = new Date(y, m, 0).getDate();
    const cells = [];
    for (let i = 0; i < monthStart.getDay(); i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) {
      cells.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return { monthStart, cells };
  };

  const filtered = reservations.filter((r) => {
    if (r.rentalAgreementStatus && r.rentalAgreementStatus !== "reservation") return false;
    const parts = (r.customer || "").trim().split(/\s+/);
    const first = parts[0] || "";
    const last  = parts.length > 1 ? parts[parts.length - 1] : "";
    if (srchFirst && !first.toLowerCase().includes(srchFirst.toLowerCase())) return false;
    if (srchLast  && !last.toLowerCase().includes(srchLast.toLowerCase()))   return false;
    if (srchPhone && !(r.phone || "").includes(srchPhone))                    return false;
    if (srchRes   && !r.resCode.toLowerCase().includes(srchRes.toLowerCase())) return false;
    if (srchDate  && r.date !== srchDate)                                     return false;
    return true;
  });

  const updateForm = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    // One rule, shared with the command bar. Checked before a resCode is burned.
    // "Unknown" used to be silently substituted for a blank name, which is how
    // unusable reservations reached the list.
    const customerName = [form.firstName, form.lastName].filter(Boolean).join(" ");
    const resCheck = validateReservation({
      customer:     customerName,
      date:         form.date,
      time:         form.time,
      location:     form.location,
      vehicleClass: form.vehicleClass,
    });
    if (!resCheck.ok) { window.alert(resCheck.error); return; }

    const resCode = await generateUniqueResCode();
    const customer = customerName;
    const newRow = {
      date: form.date, time: form.time, location: form.location,
      resCode, customer,
      firstName: form.firstName, lastName: form.lastName,
      phone: form.phone, email: form.email, licenseNumber: form.licenseNumber,
      returnDate: form.returnDate, returnTime: form.returnTime,
      vehicleClass: form.vehicleClass, winterTires: form.winterTires,
      source: form.source, sourceDetail: form.sourceDetail,
      dailyRate: form.dailyRate,
      adjusterName: form.adjusterName, claimNumber: form.claimNumber,
      fileNumber: form.fileNumber, authNumber: form.authNumber,
      poNumber: form.poNumber, paymentMethod: form.paymentMethod,
      preRentalCheck: "NOT Pre-Rental Check'd",
      notesLog: form.noteText.trim() ? [{ author: "ADJ", text: form.noteText.trim() }] : [],
      rentalAgreementStatus: "reservation",
    };
    // Write directly to Supabase before updating state so the row exists immediately.
    // Using insert (not upsert) because upsert requires a UNIQUE constraint on
    // resCode which may not exist; generateUniqueResCode already guarantees no collision.
    // A failed save is reported and the form is left open with everything
    // still typed in. It used to be logged only: the reservation then showed
    // in the list until the next reload and was never in the database.
    let insertError = null;
    try {
      const insertRes = await supabase.from("reservations").insert(newRow);
      console.log("reservations insert response:", insertRes);
      insertError = insertRes?.error || null;
    } catch (err) {
      insertError = err;
    }
    if (insertError) {
      console.warn("Reservation Supabase write error:", insertError);
      window.alert("The reservation could not be saved, so nothing was added. Check your connection and try again.");
      return;
    }
    requestReservationConfirmation(resCode);
    setReservations((prev) => {
      const next = [...prev, newRow];
      next.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time);
      });
      return next;
    });
    setForm(emptyResForm());
    setShowModal(false);
  };

  const tf = (label, key, ph) => React.createElement("label", { className: "resFormGroup" },
    React.createElement("span", { className: "resFormLabel" }, label),
    React.createElement("input", { className: "resFormInput", type: "text", placeholder: ph, value: form[key], onChange: (e) => updateForm(key, e.target.value) })
  );

  const cols = ["Date", "Time", "Location", "Res Code", "Customer", "Vehicle class", "Winter tires", "Notes"];

  return React.createElement(
    "div",
    { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Reservations"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(
      "div",
      { className: "resvSearchBar" },
      React.createElement("button", { type: "button", className: "resvInlineBtn", onClick: () => setShowModal(true) }, "+ New Reservation"),
      React.createElement(
        "div",
        { className: "resvDatePickerWrap" },
        React.createElement(
          "button",
          {
            type: "button",
            className: srchDate ? "resvSearchInput resvDateBtn resvDateBtn--active" : "resvSearchInput resvDateBtn",
            onClick: (e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setDatePickerAnchor({ x: rect.left, y: rect.bottom + 4 });
              setDatePickerOpen((o) => !o);
            },
          },
          filterDateLabel
        ),
        srchDate && React.createElement(
          "button",
          { type: "button", className: "resvDateClear", onClick: () => { setSrchDate(""); setFilterPickerMonth(null); } },
          "×"
        ),
        datePickerOpen && (() => {
          const { monthStart, cells } = getFilterCalendarDays();
          return React.createElement(
            "div",
            { className: "calendarPopover", style: { left: `${datePickerAnchor.x}px`, top: `${datePickerAnchor.y}px` } },
            React.createElement(
              "div",
              { className: "calendarHeader" },
              React.createElement("button", { type: "button", className: "calendarArrow", onClick: () => moveFilterMonth(-1) }, "<"),
              React.createElement("div", { className: "calendarMonthLabel" }, monthStart.toLocaleDateString("en-CA", { month: "long", year: "numeric" })),
              React.createElement("button", { type: "button", className: "calendarArrow", onClick: () => moveFilterMonth(1) }, ">")
            ),
            React.createElement(
              "div",
              { className: "calendarWeekdays" },
              ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) =>
                React.createElement("div", { key: d, className: "calendarWeekday" }, d)
              )
            ),
            React.createElement(
              "div",
              { className: "calendarGrid" },
              cells.map((iso, idx) =>
                React.createElement("button", {
                  type: "button",
                  key: `fday-${idx}`,
                  className: !iso ? "calendarDay calendarDay--empty"
                    : iso === todayIso
                      ? iso === srchDate ? "calendarDay calendarDay--today calendarDay--selected" : "calendarDay calendarDay--today"
                      : iso === srchDate ? "calendarDay calendarDay--selected" : "calendarDay",
                  disabled: !iso,
                  onClick: () => { if (!iso) return; setSrchDate(iso); setDatePickerOpen(false); },
                }, iso ? Number(iso.slice(-2)) : "")
              )
            )
          );
        })()
      ),
      React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "First name",   value: srchFirst, onChange: (e) => setSrchFirst(e.target.value) }),
      React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "Last name",    value: srchLast,  onChange: (e) => setSrchLast(e.target.value)  }),
      React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "Phone number", value: srchPhone, onChange: (e) => setSrchPhone(e.target.value) }),
      React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "Res Code",     value: srchRes,   onChange: (e) => setSrchRes(e.target.value)   })
    ),
    React.createElement(
      "section",
      { className: "dashboardSection" },
      React.createElement(
        "div",
        { className: "dashboardSection__header" },
        React.createElement(
          "div",
          { className: "dashboardSection__headerRow" },
          React.createElement("span", null, "Reservations")
        )
      ),
      React.createElement(
        "div",
        { className: "dashboardSection__body" },
        filtered.length === 0
          ? React.createElement("div", { className: "resvEmpty" }, "No reservations found.")
          : React.createElement(
              "table",
              { className: "dashboardTable" },
              React.createElement("thead", null,
                React.createElement("tr", null, cols.map((col) => React.createElement("th", { key: col }, col)))
              ),
              React.createElement("tbody", null,
                filtered.map((row) =>
                  React.createElement("tr", { key: row.resCode, className: row.fromNonDrive ? "dashboardRow--fromNonDrive" : "" },
                    React.createElement("td", { key: `${row.resCode}-date` }, fmtDate(row.date)),
                    React.createElement("td", { key: `${row.resCode}-time` }, fmt12h(row.time)),
                    React.createElement("td", { key: `${row.resCode}-loc` }, row.location),
                    React.createElement("td", { key: `${row.resCode}-res` }, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.resCode })),
                    React.createElement("td", { key: `${row.resCode}-cust` },
                      React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.customer })
                    ),
                    React.createElement("td", { key: `${row.resCode}-vc` }, row.vehicleClass),
                    React.createElement("td", { key: `${row.resCode}-wt` }, row.winterTires),
                    React.createElement("td", { key: `${row.resCode}-notes` },
                      React.createElement(NotesCell, {
                        noteId: row.resCode,
                        preRentalCheck: row.preRentalCheck,
                        notesLog: parseNotesLog(row.notesLog),
                        onAddNote: (note) => {
                          const newLog = [...parseNotesLog(row.notesLog), note];
                          setReservations((prev) =>
                            prev.map((r) => r.resCode === row.resCode ? { ...r, notesLog: newLog } : r)
                          );
                          runWrite(supabase.from("reservations").update({ notesLog: newLog }).eq("resCode", row.resCode), "notes sync");
                        },
                      })
                    )
                  )
                )
              )
            )
      )
    ),
    showModal && React.createElement(
      "div",
      { className: "resModalBackdrop", onClick: () => setShowModal(false) },
      React.createElement(
        "div",
        { className: "resModal", onClick: (e) => e.stopPropagation() },
        React.createElement("div", { className: "resModalHeader" },
          React.createElement("h2", { className: "resModalTitle" }, "New Reservation"),
          React.createElement("button", { type: "button", className: "resModalClose", onClick: () => setShowModal(false) }, "✕")
        ),
        React.createElement("form", { className: "resModalForm", onSubmit: handleSubmit },
          React.createElement("div", { className: "resModalBody" },
            React.createElement("div", { className: "cdetailSubGroup" }, "Customer Information"),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Res Code"),
                React.createElement("input", { className: "resFormInput", type: "text", readOnly: true, value: "Assigned on save", style: { background: "#f7f7f7", color: "#aaa", cursor: "default" } })
              ),
              tf("First Name ✱", "firstName", "First name"),
              tf("Last Name", "lastName", "Last name")
            ),
            React.createElement("div", { className: "resFormRow" },
              tf("Phone", "phone", "(xxx) xxx-xxxx"),
              tf("Email", "email", "email@example.com"),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Driver's License ✱"),
                React.createElement("input", { className: "resFormInput", type: "text", placeholder: "License number", value: form.licenseNumber, onChange: (e) => updateForm("licenseNumber", e.target.value), required: true })
              )
            ),
            React.createElement("div", { className: "cdetailSubGroup" }, "Pickup & Return"),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Pickup Date ✱"),
                React.createElement("input", { className: "resFormInput", type: "date", value: form.date, onChange: (e) => updateForm("date", e.target.value), required: true })
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Pickup Time"),
                React.createElement("input", { className: "resFormInput", type: "time", value: form.time, onChange: (e) => updateForm("time", e.target.value) })
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Return Date"),
                React.createElement("input", { className: "resFormInput", type: "date", value: form.returnDate, onChange: (e) => updateForm("returnDate", e.target.value) })
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Return Time"),
                React.createElement("input", { className: "resFormInput", type: "time", value: form.returnTime, onChange: (e) => updateForm("returnTime", e.target.value) })
              )
            ),
            React.createElement("div", { className: "cdetailSubGroup" }, "Reservation Details"),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Location"),
                React.createElement("select", { className: "resFormInput", value: form.location, onChange: (e) => updateForm("location", e.target.value) },
                  pickupLocationOptions(form.location).map((l) => React.createElement("option", { key: l, value: l }, l))
                )
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Vehicle Class"),
                React.createElement("select", { className: "resFormInput", value: form.vehicleClass, onChange: (e) => setForm((p) => withDailyRate({ ...p, vehicleClass: e.target.value })) },
                  vehicleClassOptions(RES_VEHICLE_CLASSES, form.vehicleClass).map((c) => React.createElement("option", { key: c, value: c }, c))
                )
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Winter Tires"),
                React.createElement("select", { className: "resFormInput", value: form.winterTires, onChange: (e) => updateForm("winterTires", e.target.value) },
                  React.createElement("option", { value: "Yes" }, "Yes"),
                  React.createElement("option", { value: "No" }, "No")
                )
              )
            ),
            React.createElement("div", { className: "cdetailSubGroup" }, "Rates & Billing"),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Source"),
                React.createElement("select", { className: "resFormInput", value: form.source, onChange: (e) => setForm((p) => withDailyRate({ ...p, source: e.target.value, sourceDetail: "" })) },
                  React.createElement("option", { value: "" }, "Select source"),
                  Object.keys(sourceCatsFor(form.source)).map((cat) => React.createElement("option", { key: cat, value: cat }, cat))
                )
              ),
              form.source && (sourceCatsFor(form.source)[form.source] || []).length > 0 && React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Specific Source"),
                React.createElement("select", { className: "resFormInput", value: form.sourceDetail, onChange: (e) => updateForm("sourceDetail", e.target.value) },
                  React.createElement("option", { value: "" }, "Select…"),
                  sourceCatsFor(form.source)[form.source].map((s) => React.createElement("option", { key: s, value: s }, s))
                )
              )
            ),
            React.createElement("div", { className: "resFormRow" },
              tf("Daily Rate ($)", "dailyRate", "0.00")
            ),
            ...(() => {
              if (sourceBillingType(form.source) === "insurance") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("Adjuster Name", "adjusterName", "Adjuster name"), tf("Claim Number", "claimNumber", "Claim #")),
                React.createElement("div", { className: "resFormRow", key: "rb2" }, tf("File Number", "fileNumber", "File #"), tf("Authorization Number", "authNumber", "Auth #")),
              ];
              if (sourceBillingType(form.source) === "bodyshop_dealership") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("Claim Number", "claimNumber", "Claim #"), tf("Authorization Number", "authNumber", "Auth #")),
              ];
              if (sourceBillingType(form.source) === "corporate") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("PO Number", "poNumber", "PO #")),
              ];
              if (sourceBillingType(form.source) === "retail") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" },
                  React.createElement("label", { className: "resFormGroup" },
                    React.createElement("span", { className: "resFormLabel" }, "Payment Method"),
                    React.createElement("select", { className: "resFormInput", value: form.paymentMethod, onChange: (e) => updateForm("paymentMethod", e.target.value) },
                      ["Credit Card", "Debit Card", "Cash", "E-transfer"].map((m) => React.createElement("option", { key: m, value: m }, m))
                    )
                  )
                ),
              ];
              return [];
            })(),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup resFormGroup--full" },
                React.createElement("span", { className: "resFormLabel" }, "Notes (optional)"),
                React.createElement("textarea", { className: "resFormInput resFormTextarea", placeholder: "Optional notes…", rows: 3, value: form.noteText, onChange: (e) => updateForm("noteText", e.target.value) })
              )
            )
          ),
          React.createElement("div", { className: "resModalActions" },
            React.createElement("button", { type: "button", className: "resModalCancel", onClick: () => setShowModal(false) }, "Cancel"),
            React.createElement("button", { type: "submit", className: "resModalSubmit" }, "Add Reservation")
          )
        )
      )
    )
  );
}

// ─── NonDriveIntakeSection component ────────────────────────────────────────────────────

function NonDriveIntakeSection({ standalone }) {
  const { ndiRows, setNdiRows, setReservations, setOpenRentalAgreementId, guardAction } = React.useContext(AppContext);
  const navigate = useNavigate();
  const [now, setNow] = React.useState(Date.now());
  const [openDatePickerId, setOpenDatePickerId] = React.useState(null);
  const [datePickerAnchor, setDatePickerAnchor] = React.useState({ x: 0, y: 0 });
  const [pickerMonthByRow, setPickerMonthByRow] = React.useState({});
  const [collapsed, setCollapsed] = React.useState(true);

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const formatDateLabel = (isoDate) => {
    if (!isoDate) return "Select date";
    const parsed = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return "Select date";
    return parsed.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };

  const movePickerMonth = (rowId, delta) => {
    setPickerMonthByRow((prev) => {
      const selected = ndiRows.find((row) => row.id === rowId)?.aiDate;
      const base = prev[rowId] || `${(selected || new Date().toISOString().slice(0, 10)).slice(0, 7)}-01`;
      const [y, m] = base.split("-").map(Number);
      const nextMonth = new Date(y, m - 1 + delta, 1);
      return {
        ...prev,
        [rowId]: `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`,
      };
    });
  };

  const getCalendarDays = (row) => {
    const monthIso = pickerMonthByRow[row.id] || `${row.aiDate.slice(0, 7)}-01`;
    const [y, m] = monthIso.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const startWeekday = monthStart.getDay();
    const daysInMonth = new Date(y, m, 0).getDate();
    const cells = [];
    for (let i = 0; i < startWeekday; i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) {
      cells.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return { monthStart, cells };
  };

  const handleAiFieldUpdate = (id, field, value) => {
    setNdiRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, [field]: value } : row))
    );
    // slaTimer is a UI-only countdown — not a Supabase column
    if (field !== "slaTimer") {
      runWrite(supabase.from("ndi_rows").update({ [field]: value }).eq("id", id), "ndi_rows update");
    }
  };

  // Requests an agent call and starts the SLA clock. Nothing more.
  //
  // This used to flip a coin: heads it INVENTED a booking, inserted a real
  // reservation with a made up vehicle class and location, and deleted the
  // intake row; tails it set agentRequested. Half of every click fabricated a
  // customer booking. The coin flip is gone, and converting an intake row into a
  // reservation is now an explicit staff action (Mark as Booked) taken once the
  // booking is real.
  const handleRequestCall = (id) => {
    const target = ndiRows.find((row) => row.id === id);
    if (!target) return;
    const updates = { agentRequested: true, requestedAtMs: target.requestedAtMs || Date.now() };
    setNdiRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...updates } : row)));
    supabase.from("ndi_rows").update(updates).eq("id", id)
      .then(({ error }) => { if (error) console.warn("ndi_rows request-call update failed:", id, error); })
      .catch((e) => console.warn("ndi_rows update:", e));
  };

  // Converts an intake row into a real reservation, once a human knows it is
  // booked. Goes through the shared validator, so an intake row missing a date
  // or a customer cannot quietly become an unusable reservation.
  const handleMarkBooked = (id) => {
    const target = ndiRows.find((row) => row.id === id);
    if (!target) return;
    const displayTime = toDisplayTime(target.aiTime);
    const pickupTime =
      parseTimeToMinutes(`${displayTime} ${target.aiMeridiem}`) !== Number.POSITIVE_INFINITY
        ? `${displayTime} ${target.aiMeridiem}`
        : "09:00 AM";
    const newRes = {
      date: target.aiDate,
      time: pickupTime,
      location: pickupLocationOptions("").includes("CCS") ? "CCS" : pickupLocationOptions("")[0],
      resCode: target.rescode,
      customer: target.customer,
      vehicleClass: defaultVehicleClass(RES_VEHICLE_CLASSES, "Regular SUV"),
      winterTires: "Yes",
      preRentalCheck: "NOT Pre-Rental Check'd",
      notesLog: [{ author: "ADJ", text: `From red car intake (${target.aiDate})` }],
    };
    const check = validateReservation(newRes);
    if (!check.ok) { window.alert(`This intake row cannot be booked yet. ${check.error}`); return; }
    // Deletes the intake row, so it takes the PIN.
    guardAction("noShow.confirmPickup", () => {
      setReservations((prev) => {
        const next = [...prev, newRes];
        next.sort((a, b) => parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time));
        return next;
      });
      runWrite(supabase.from("reservations").insert(newRes).then((res) => console.log("reservations insert response:", res)), "reservations insert");
      setNdiRows((prev) => prev.filter((row) => row.id !== id));
      runWrite(supabase.from("ndi_rows").delete().eq("id", id), "ndi_rows delete");
    });
  };

  const formatSla = (value) => {
    const parts = String(value).split(":").map((part) => Number(part));
    const minutes = parts.length === 3 ? parts[0] * 60 + parts[1] + parts[2] / 60 : 0;
    const className =
      minutes >= 20 ? "slaTimer slaTimer--over"
      : minutes >= 10 ? "slaTimer slaTimer--warn"
      : "slaTimer slaTimer--under";
    return React.createElement("span", { className }, value);
  };

  const todayIso = new Date().toISOString().slice(0, 10);

  const sectionEl = React.createElement(
    "section",
    { className: "dashboardSection" },
    React.createElement(
      "div",
      { className: "dashboardSection__header" },
      React.createElement(
        "div",
        { className: "dashboardSection__headerRow" },
        React.createElement("span", null, "Non-Drive Intake"),
        React.createElement(
          "button",
          {
            type: "button",
            className: "sectionToggleCircle",
            onClick: () => setCollapsed((c) => !c),
          },
          collapsed ? "+" : "-"
        )
      )
    ),
    !collapsed &&
      React.createElement(
        "div",
        { className: "dashboardSection__body" },
        React.createElement(
          "table",
          { className: "dashboardTable" },
          React.createElement(
            "thead",
            null,
            React.createElement("tr", null, [
              "Res Code",
              "Customer",
              "Source",
              "Waiting",
              "Text",
            ].map((col) => React.createElement("th", { key: col }, col)))
          ),
          React.createElement(
            "tbody",
            null,
            ndiRows.map((row) => {
              const waitMinutes = row.requestedAtMs
                ? Math.max(0, Math.floor((now - row.requestedAtMs) / 60000))
                : 0;
              return React.createElement("tr", { key: row.id }, [
                React.createElement("td", { key: `${row.id}-res` }, React.createElement(CustomerLink, { name: row.customer, resCode: row.rescode, label: row.rescode || "—" })),
                React.createElement("td", { key: `${row.id}-customer` },
                  React.createElement(CustomerLink, { name: row.customer, resCode: row.rescode, label: row.customer })
                ),
                React.createElement("td", { key: `${row.id}-source` },
                  React.createElement(
                    "select",
                    {
                      className: "ndiSourceSelect",
                      value: row.source,
                      onChange: (e) => handleAiFieldUpdate(row.id, "source", e.target.value),
                    },
                    ndiSourceOptions(row.source)
                      .map((opt) =>
                        React.createElement("option", { key: opt, value: opt }, opt)
                      )
                  )
                ),
                React.createElement("td", { key: `${row.id}-sla` }, formatSla(row.slaTimer)),
                React.createElement(
                  "td",
                  { key: `${row.id}-ai` },
                  row.agentRequested
                    ? React.createElement(
                        "div",
                        { className: "aiCallAgentWrap" },
                        React.createElement("div", { className: "aiCallAgentText" }, "Agent Requested"),
                        row.phone &&
                          React.createElement("div", { className: "aiCallAgentPhone" }, row.phone),
                        React.createElement(
                          "div",
                          { className: "aiCallAgentTimer" },
                          `${waitMinutes} min waiting`
                        )
                      )
                    : React.createElement(
                        "div",
                        { className: "aiCallWrap" },
                        React.createElement(
                          "div",
                          { className: "aiDatePicker" },
                          React.createElement(
                            "button",
                            {
                              type: "button",
                              className: "aiControl aiControl--dateButton",
                              onClick: (e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                setDatePickerAnchor({ x: rect.left, y: rect.bottom + 4 });
                                setOpenDatePickerId((prev) => prev === row.id ? null : row.id);
                              },
                            },
                            formatDateLabel(row.aiDate)
                          ),
                          openDatePickerId === row.id &&
                            (() => {
                              const { monthStart, cells } = getCalendarDays(row);
                              return React.createElement(
                                "div",
                                { className: "calendarPopover", style: { left: `${datePickerAnchor.x}px`, top: `${datePickerAnchor.y}px` } },
                                React.createElement(
                                  "div",
                                  { className: "calendarHeader" },
                                  React.createElement(
                                    "button",
                                    { type: "button", className: "calendarArrow", onClick: () => movePickerMonth(row.id, -1) },
                                    "<"
                                  ),
                                  React.createElement(
                                    "div",
                                    { className: "calendarMonthLabel" },
                                    monthStart.toLocaleDateString("en-CA", { month: "long", year: "numeric" })
                                  ),
                                  React.createElement(
                                    "button",
                                    { type: "button", className: "calendarArrow", onClick: () => movePickerMonth(row.id, 1) },
                                    ">"
                                  )
                                ),
                                React.createElement(
                                  "div",
                                  { className: "calendarWeekdays" },
                                  ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) =>
                                    React.createElement("div", { key: `${row.id}-${d}`, className: "calendarWeekday" }, d)
                                  )
                                ),
                                React.createElement(
                                  "div",
                                  { className: "calendarGrid" },
                                  cells.map((iso, idx) =>
                                    React.createElement(
                                      "button",
                                      {
                                        type: "button",
                                        key: `${row.id}-day-${idx}`,
                                        className:
                                          !iso
                                            ? "calendarDay calendarDay--empty"
                                            : iso === todayIso
                                              ? iso === row.aiDate
                                                ? "calendarDay calendarDay--today calendarDay--selected"
                                                : "calendarDay calendarDay--today"
                                              : iso === row.aiDate
                                                ? "calendarDay calendarDay--selected"
                                                : "calendarDay",
                                        disabled: !iso,
                                        onClick: () => {
                                          if (!iso) return;
                                          handleAiFieldUpdate(row.id, "aiDate", iso);
                                          setOpenDatePickerId(null);
                                        },
                                      },
                                      iso ? Number(iso.slice(-2)) : ""
                                    )
                                  )
                                )
                              );
                            })()
                        ),
                        React.createElement("input", {
                          className: "aiControl aiControl--time",
                          type: "text",
                          inputMode: "numeric",
                          value: toDisplayTime(row.aiTime),
                          onChange: (event) =>
                            handleAiFieldUpdate(row.id, "aiTime", event.target.value.replace(/\D/g, "").slice(0, 4)),
                          placeholder: "HH:MM",
                          maxLength: 5,
                        }),
                        React.createElement(
                          "select",
                          {
                            className: "aiControl aiControl--meridiem",
                            value: row.aiMeridiem,
                            onChange: (event) => handleAiFieldUpdate(row.id, "aiMeridiem", event.target.value),
                          },
                          [
                            React.createElement("option", { key: "AM", value: "AM" }, "AM"),
                            React.createElement("option", { key: "PM", value: "PM" }, "PM"),
                          ]
                        ),
                        React.createElement(
                          "button",
                          {
                            type: "button",
                            className: "aiCallButton",
                            title: "Request an agent call and start the SLA clock",
                            onClick: () => handleRequestCall(row.id),
                          },
                          "Request Call"
                        ),
                        React.createElement(
                          "button",
                          {
                            type: "button",
                            className: "aiCallButton aiCallButton--booked",
                            title: "The customer is booked: turn this into a reservation",
                            onClick: () => handleMarkBooked(row.id),
                          },
                          "Mark as Booked"
                        )
                      )
                ),
              ]);
            })
          )
        )
      )
  );

  if (standalone) {
    return React.createElement(
      "div",
      { className: "page" },
      React.createElement("h1", { className: "page__title" }, "Non-Drive Intake"),
      React.createElement("div", { className: "page__titleUnderline" }),
      sectionEl
    );
  }
  return sectionEl;
}

// ─────────────────────────────────────────────────────────────────────────────

function DashboardPage() {
  const { reservations, setReservations, fleet, setFleet, setOpenRentalAgreementId, rentalAgreements, guardAction } = React.useContext(AppContext);
  const isMobile = useMobile();
  // Props that make a whole header bar a toggle, for mobile, where the small
  // plus button alone is too easy to miss.
  const tapToToggle = (onToggle) => ({
    role: "button", tabIndex: 0, style: { cursor: "pointer" },
    onClick: onToggle,
    onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } },
  });
  const readyReturns = fleet.filter((v) => v.status === "Ready Returns");
  const navigate = useNavigate();
  const [collapsedSections, setCollapsedSections] = React.useState({
    reservations: true,
    nonDriveIntake: true,
    fleetAvailability: true,
  });
  const [fleetGroupCollapsed, setFleetGroupCollapsed] = React.useState({
    available: true, needsCleaning: true, readyReturns: true, pm: true, damaged: true, onRent: true,
  });
  const toggleFleetGroup = (key) =>
    setFleetGroupCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const todayIso = new Date().toISOString().slice(0, 10);
  const [srchDate,          setSrchDate]          = React.useState(todayIso);
  const [srchFirst,         setSrchFirst]         = React.useState("");
  const [srchLast,          setSrchLast]          = React.useState("");
  const [srchPhone,         setSrchPhone]         = React.useState("");
  const [srchRes,           setSrchRes]           = React.useState("");
  const [datePickerOpen,    setDatePickerOpen]    = React.useState(false);
  const [datePickerAnchor,  setDatePickerAnchor]  = React.useState({ x: 0, y: 0 });
  const [filterPickerMonth, setFilterPickerMonth] = React.useState(null);
  const [showModal, setShowModal] = React.useState(false);
  const [form, setForm] = React.useState(emptyResForm);
  const updateForm = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));

  const toggleSection = (sectionKey) => {
    setCollapsedSections((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }));
  };

  const fmtDate = (iso) => {
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };
  const filterDateLabel = srchDate ? fmtDate(srchDate) : "Filter by date";
  const moveFilterMonth = (delta) => {
    setFilterPickerMonth((prev) => {
      const base = prev || `${(srchDate || todayIso).slice(0, 7)}-01`;
      const [y, m] = base.split("-").map(Number);
      const next = new Date(y, m - 1 + delta, 1);
      return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
    });
  };
  const getFilterCalendarDays = () => {
    const monthIso = filterPickerMonth || `${(srchDate || todayIso).slice(0, 7)}-01`;
    const [y, m] = monthIso.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const daysInMonth = new Date(y, m, 0).getDate();
    const cells = [];
    for (let i = 0; i < monthStart.getDay(); i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) {
      cells.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    while (cells.length % 7 !== 0) cells.push(null);
    return { monthStart, cells };
  };
  const resFiltered = reservations.filter((r) => {
    if (r.rentalAgreementStatus && r.rentalAgreementStatus !== "reservation") return false;
    const parts = (r.customer || "").trim().split(/\s+/);
    const first = parts[0] || "";
    const last  = parts.length > 1 ? parts[parts.length - 1] : "";
    if (srchFirst && !first.toLowerCase().includes(srchFirst.toLowerCase())) return false;
    if (srchLast  && !last.toLowerCase().includes(srchLast.toLowerCase()))   return false;
    if (srchPhone && !(r.phone || "").includes(srchPhone))                    return false;
    if (srchRes   && !r.resCode.toLowerCase().includes(srchRes.toLowerCase())) return false;
    if (srchDate  && r.date !== srchDate)                                     return false;
    return true;
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    // One rule, shared with the command bar. Checked before a resCode is burned.
    // "Unknown" used to be silently substituted for a blank name, which is how
    // unusable reservations reached the list.
    const customerName = [form.firstName, form.lastName].filter(Boolean).join(" ");
    const resCheck = validateReservation({
      customer:     customerName,
      date:         form.date,
      time:         form.time,
      location:     form.location,
      vehicleClass: form.vehicleClass,
    });
    if (!resCheck.ok) { window.alert(resCheck.error); return; }

    const resCode = await generateUniqueResCode();
    const customer = customerName;
    const newRow = {
      date: form.date, time: form.time, location: form.location,
      resCode, customer,
      firstName: form.firstName, lastName: form.lastName,
      phone: form.phone, email: form.email, licenseNumber: form.licenseNumber,
      returnDate: form.returnDate, returnTime: form.returnTime,
      vehicleClass: form.vehicleClass, winterTires: form.winterTires,
      source: form.source, sourceDetail: form.sourceDetail,
      dailyRate: form.dailyRate,
      adjusterName: form.adjusterName, claimNumber: form.claimNumber,
      fileNumber: form.fileNumber, authNumber: form.authNumber,
      poNumber: form.poNumber, paymentMethod: form.paymentMethod,
      preRentalCheck: "NOT Pre-Rental Check'd",
      notesLog: form.noteText.trim() ? [{ author: "ADJ", text: form.noteText.trim() }] : [],
      rentalAgreementStatus: "reservation",
    };
    // Write directly to Supabase before updating state so the row exists immediately.
    // Using insert (not upsert) because upsert requires a UNIQUE constraint on
    // resCode which may not exist; generateUniqueResCode already guarantees no collision.
    // A failed save is reported and the form is left open with everything
    // still typed in. It used to be logged only: the reservation then showed
    // in the list until the next reload and was never in the database.
    let insertError = null;
    try {
      const insertRes = await supabase.from("reservations").insert(newRow);
      console.log("reservations insert response:", insertRes);
      insertError = insertRes?.error || null;
    } catch (err) {
      insertError = err;
    }
    if (insertError) {
      console.warn("Reservation Supabase write error:", insertError);
      window.alert("The reservation could not be saved, so nothing was added. Check your connection and try again.");
      return;
    }
    requestReservationConfirmation(resCode);
    setReservations((prev) => {
      const next = [...prev, newRow];
      next.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time);
      });
      return next;
    });
    setForm(emptyResForm());
    setShowModal(false);
  };

  const tf = (label, key, ph) => React.createElement("label", { className: "resFormGroup" },
    React.createElement("span", { className: "resFormLabel" }, label),
    React.createElement("input", { className: "resFormInput", type: "text", placeholder: ph, value: form[key], onChange: (e) => updateForm(key, e.target.value) })
  );


  return React.createElement(
    "div",
    { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Dashboard"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement("div", { className: "dashboardCtaRow" },
      React.createElement("button", {
        type: "button", className: "closeRentalCta", onClick: () => navigate("/close-rental"),
      }, "Close Rental"),
      React.createElement("button", {
        type: "button", className: "closeRentalCta", onClick: () => navigate("/switch-out"),
      }, "Switch Out")
    ),
    React.createElement("div", { className: "dashboardGrid" }, [
      // ── Section 1: Reservations ──────────────────────────────────────────
      React.createElement(
        "section",
        { key: "reservations", className: "dashboardSection" },
        React.createElement(
          "div",
          { className: "dashboardSection__header" },
          React.createElement(
            "div",
            { className: "dashboardSection__headerRow" },
            React.createElement("span", null, "Reservations"),
            React.createElement("button", {
              type: "button", className: "sectionToggleCircle",
              onClick: () => toggleSection("reservations"),
            }, collapsedSections.reservations ? "+" : "-")
          )
        ),
        !collapsedSections.reservations &&
          React.createElement(
            "div",
            { className: "dashboardSection__body" },
            React.createElement("div", { className: "resvSearchBar" },
              React.createElement("button", { type: "button", className: "resvInlineBtn", onClick: () => setShowModal(true) }, "+ New Reservation"),
              React.createElement("div", { className: "resvDatePickerWrap" },
                React.createElement("button", {
                  type: "button",
                  className: srchDate ? "resvSearchInput resvDateBtn resvDateBtn--active" : "resvSearchInput resvDateBtn",
                  onClick: (e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDatePickerAnchor({ x: rect.left, y: rect.bottom + 4 });
                    setDatePickerOpen((o) => !o);
                  },
                }, filterDateLabel),
                srchDate && React.createElement("button", {
                  type: "button", className: "resvDateClear",
                  onClick: () => { setSrchDate(""); setFilterPickerMonth(null); },
                }, "×"),
                datePickerOpen && (() => {
                  const { monthStart, cells } = getFilterCalendarDays();
                  return React.createElement("div", { className: "calendarPopover", style: { left: `${datePickerAnchor.x}px`, top: `${datePickerAnchor.y}px` } },
                    React.createElement("div", { className: "calendarHeader" },
                      React.createElement("button", { type: "button", className: "calendarArrow", onClick: () => moveFilterMonth(-1) }, "<"),
                      React.createElement("div", { className: "calendarMonthLabel" }, monthStart.toLocaleDateString("en-CA", { month: "long", year: "numeric" })),
                      React.createElement("button", { type: "button", className: "calendarArrow", onClick: () => moveFilterMonth(1) }, ">")
                    ),
                    React.createElement("div", { className: "calendarWeekdays" },
                      ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) =>
                        React.createElement("div", { key: d, className: "calendarWeekday" }, d)
                      )
                    ),
                    React.createElement("div", { className: "calendarGrid" },
                      cells.map((iso, idx) =>
                        React.createElement("button", {
                          type: "button", key: `fday-${idx}`,
                          className: !iso ? "calendarDay calendarDay--empty"
                            : iso === todayIso
                              ? iso === srchDate ? "calendarDay calendarDay--today calendarDay--selected" : "calendarDay calendarDay--today"
                              : iso === srchDate ? "calendarDay calendarDay--selected" : "calendarDay",
                          disabled: !iso,
                          onClick: () => { if (!iso) return; setSrchDate(iso); setDatePickerOpen(false); },
                        }, iso ? Number(iso.slice(-2)) : "")
                      )
                    )
                  );
                })()
              ),
              React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "First name",   value: srchFirst, onChange: (e) => setSrchFirst(e.target.value) }),
              React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "Last name",    value: srchLast,  onChange: (e) => setSrchLast(e.target.value)  }),
              React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "Phone number", value: srchPhone, onChange: (e) => setSrchPhone(e.target.value) }),
              React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "Res Code",     value: srchRes,   onChange: (e) => setSrchRes(e.target.value)   })
            ),
            resFiltered.length === 0
              ? React.createElement("div", { className: "resvEmpty" }, "No reservations found.")
              : isMobile
                ? resFiltered.map((row) =>
                    React.createElement("div", { key: row.resCode, className: "dashCard" },
                      React.createElement("div", { className: "dashCard__header" },
                        React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.customer }),
                        React.createElement("span", { className: "dashCard__resCode" }, row.resCode)
                      ),
                      React.createElement("div", { className: "dashCard__meta" },
                        React.createElement("span", { className: "dashCard__chip" }, fmtDate(row.date)),
                        React.createElement("span", { className: "dashCard__chip" }, fmt12h(row.time)),
                        React.createElement("span", { className: "dashCard__chip" }, row.location)
                      ),
                      React.createElement("div", { className: "dashCard__meta" },
                        React.createElement("span", { className: "dashCard__chip" }, row.vehicleClass),
                        row.winterTires === "Yes" && React.createElement("span", { className: "dashCard__chip dashCard__chip--winter" }, "Winter tires")
                      )
                    )
                  )
                : React.createElement("table", { className: "dashboardTable" },
                  React.createElement("thead", null,
                    React.createElement("tr", null,
                      ["Date", "Time", "Location", "Res Code", "Customer", "Vehicle class", "Winter tires", "Notes"].map((col) =>
                        React.createElement("th", { key: col }, col)
                      )
                    )
                  ),
                  React.createElement("tbody", null,
                    resFiltered.map((row) =>
                      React.createElement("tr", { key: row.resCode, className: row.fromNonDrive ? "dashboardRow--fromNonDrive" : "" },
                        React.createElement("td", { key: `${row.resCode}-date`  }, fmtDate(row.date)),
                        React.createElement("td", { key: `${row.resCode}-time`  }, fmt12h(row.time)),
                        React.createElement("td", { key: `${row.resCode}-loc`   }, row.location),
                        React.createElement("td", { key: `${row.resCode}-res`   }, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.resCode })),
                        React.createElement("td", { key: `${row.resCode}-cust`  }, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.customer })),
                        React.createElement("td", { key: `${row.resCode}-vc`    }, row.vehicleClass),
                        React.createElement("td", { key: `${row.resCode}-wt`    }, row.winterTires),
                        React.createElement("td", { key: `${row.resCode}-notes` },
                          React.createElement(NotesCell, {
                            noteId: row.resCode,
                            preRentalCheck: row.preRentalCheck,
                            notesLog: parseNotesLog(row.notesLog),
                            onAddNote: (note) => {
                              const newLog = [...parseNotesLog(row.notesLog), note];
                              setReservations((prev) =>
                                prev.map((r) => r.resCode === row.resCode ? { ...r, notesLog: newLog } : r)
                              );
                              runWrite(supabase.from("reservations").update({ notesLog: newLog }).eq("resCode", row.resCode), "notes sync");
                            },
                          })
                        )
                      )
                    )
                  )
                )
          )
      ),
      // ── Section 2: Non-Drive Intake ──────────────────────────────────
      // Not rendered at all when off. dashboardGrid spaces its children with
      // gap, so the sections either side close up with nothing left between.
      isFeatureEnabled("non_drive_intake") &&
        React.createElement(NonDriveIntakeSection, { key: "nonDriveIntake", standalone: false }),
      // ── Section 3: Vehicle Status ────────────────────────────────
      React.createElement(
        "section",
        { key: "fleetAvailability", className: "dashboardSection" },
        React.createElement(
          "div",
          { className: "dashboardSection__header" },
          React.createElement(
            "div",
            {
              className: "dashboardSection__headerRow",
              // On mobile the whole bar toggles, not just the small button;
              // the button's own tap then reaches the bar instead of toggling
              // twice.
              ...(isMobile ? tapToToggle(() => toggleSection("fleetAvailability")) : {}),
            },
            React.createElement("span", null, "Vehicle Status"),
            React.createElement(
              "button",
              {
                type: "button",
                className: "sectionToggleCircle",
                onClick: isMobile ? undefined : () => toggleSection("fleetAvailability"),
              },
              collapsedSections.fleetAvailability ? "+" : "-"
            )
          )
        ),
        !collapsedSections.fleetAvailability &&
          React.createElement(
            "div",
            { className: "dashboardSection__body" },
            (() => {
              const fmtShort = (iso) => {
                if (!iso) return "";
                const d = new Date(`${iso}T00:00:00`);
                return Number.isNaN(d.getTime()) ? iso
                  : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
              };
              const fleetStatusClass = (status) =>
                status === "Available" ? "fleetStatus--available"
                : status === "Needs Cleaning" ? "fleetStatus--cleaning"
                : status === "PM" ? "fleetStatus--pm"
                : status === "Damaged" ? "fleetStatus--damaged"
                : status === "On Rent" ? "fleetStatus--onRent"
                : "";
              // Mobile: one stacked card per vehicle, the pattern the
              // reservations list above already uses, so nothing is wider than
              // the screen.
              const noneCard = () => React.createElement("div", { className: "resvEmpty" }, "None");
              const fleetCards = (rows, showStatus) =>
                rows.length === 0 ? [noneCard()] : rows.map((v) =>
                  React.createElement("div", { key: v.id, className: "dashCard" },
                    React.createElement("div", { className: "dashCard__header" },
                      React.createElement("span", null, `${v.make} ${v.model}`),
                      React.createElement(PlateLink, { plate: v.plate })
                    ),
                    React.createElement("div", { className: "dashCard__meta" },
                      v.vehicleClass && React.createElement("span", { className: "dashCard__chip" }, v.vehicleClass),
                      showStatus && React.createElement("span", { className: `dashCard__chip ${fleetStatusClass(v.status)}` }, v.status),
                      v.winterTires === "Yes" && React.createElement("span", { className: "dashCard__chip dashCard__chip--winter" }, "Winter tires")
                    )
                  )
                );
              const fleetTable = (rows, showStatus) =>
                React.createElement(
                  "table",
                  { className: "dashboardTable" },
                  React.createElement("thead", null,
                    React.createElement("tr", null,
                      ["Plate", "Vehicle", "Class", ...(showStatus ? ["Status"] : []), "Winter Tires"].map((col) =>
                        React.createElement("th", { key: col }, col)
                      )
                    )
                  ),
                  React.createElement("tbody", null,
                    rows.length === 0
                      ? React.createElement("tr", null, React.createElement("td", { colSpan: showStatus ? 5 : 4, style: { color: "#aaa", fontStyle: "italic" } }, "None"))
                      : rows.map((v) => {
                          const statusClass = fleetStatusClass(v.status);
                          return React.createElement("tr", { key: v.id },
                            React.createElement("td", null, React.createElement(PlateLink, { plate: v.plate })),
                            React.createElement("td", null, `${v.make} ${v.model}`),
                            React.createElement("td", null, v.vehicleClass),
                            ...(showStatus ? [React.createElement("td", null, React.createElement("span", { className: statusClass }, v.status))] : []),
                            React.createElement("td", null, v.winterTires || "")
                          );
                        })
                  )
                );

              const avail    = fleet.filter((v) => v.status === "Available");
              const cleaning = fleet.filter((v) => v.status === "Needs Cleaning");
              const pm     = fleet.filter((v) => v.needsPm);
              const damaged  = fleet.filter((v) => v.status === "Damaged");
              const onRent   = fleet.filter((v) => v.status === "On Rent");

              const group = (label, cls, key, rows, showStatus, children) =>
                React.createElement("div", { className: "fleetGroup" },
                  React.createElement("div", {
                    className: `fleetGroupHeader fleetGroupHeader--${cls}`,
                    ...(isMobile ? tapToToggle(() => toggleFleetGroup(key)) : {}),
                  },
                    React.createElement("span", null, label),
                    React.createElement("div", { className: "fleetGroupHeaderRight" },
                      React.createElement("span", { className: "fleetGroupCount" }, rows.length),
                      React.createElement("button", {
                        type: "button",
                        className: "fleetGroupToggle",
                        onClick: isMobile ? undefined : () => toggleFleetGroup(key),
                      }, fleetGroupCollapsed[key] ? "+" : "−")
                    )
                  ),
                  ...(fleetGroupCollapsed[key] ? [] : (children || (isMobile ? fleetCards(rows, showStatus) : [fleetTable(rows, showStatus)])))
                );

              return React.createElement(React.Fragment, null,
                group("Available", "available", "available", avail, false),
                group("Needs Cleaning", "cleaning", "needsCleaning", cleaning, false),
                // Ready Returns — two sub-sections: returned & ready + projected
                React.createElement("div", { className: "fleetGroup" },
                  React.createElement("div", {
                    className: "fleetGroupHeader fleetGroupHeader--readyReturns",
                    ...(isMobile ? tapToToggle(() => toggleFleetGroup("readyReturns")) : {}),
                  },
                    React.createElement("span", null, "Ready Returns"),
                    React.createElement("div", { className: "fleetGroupHeaderRight" },
                      React.createElement("span", { className: "fleetGroupCount" }, readyReturns.length),
                      React.createElement("button", {
                        type: "button",
                        className: "fleetGroupToggle",
                        onClick: isMobile ? undefined : () => toggleFleetGroup("readyReturns"),
                      }, fleetGroupCollapsed.readyReturns ? "+" : "−")
                    )
                  ),
                  ...(!fleetGroupCollapsed.readyReturns && isMobile
                    ? (readyReturns.length === 0 ? [noneCard()] : readyReturns.map((r) => {
                        const matchRA = (rentalAgreements || []).find((a) => a.plate === r.plate && RA_IN_READY_RETURNS.includes(a.rentalAgreementStatus));
                        const loc = matchRA?.returnVehicleLocation || "";
                        return React.createElement("div", { key: r.id, className: "dashCard" },
                          React.createElement("div", { className: "dashCard__header" },
                            React.createElement("span", null, `${r.make} ${r.model}`),
                            React.createElement(PlateLink, { plate: r.plate })
                          ),
                          (r.fileType || loc) && React.createElement("div", { className: "dashCard__meta" },
                            r.fileType && React.createElement("span", { className: "dashCard__chip" }, r.fileType),
                            loc && React.createElement("span", { className: "dashCard__chip" }, loc)
                          )
                        );
                      }))
                    : []),
                  ...(!fleetGroupCollapsed.readyReturns && !isMobile ? [
                    React.createElement("table", { className: "dashboardTable" },
                      React.createElement("thead", null,
                        React.createElement("tr", null,
                          ["Plate", "Vehicle", "Type", "Location"].map((col) =>
                            React.createElement("th", { key: col }, col)
                          )
                        )
                      ),
                      React.createElement("tbody", null,
                        readyReturns.length === 0
                          ? React.createElement("tr", null, React.createElement("td", { colSpan: 4, style: { color: "#aaa", fontStyle: "italic" } }, "None"))
                          : readyReturns.map((r) => {
                              const matchRA = (rentalAgreements || []).find((a) => a.plate === r.plate && RA_IN_READY_RETURNS.includes(a.rentalAgreementStatus));
                              const loc = matchRA?.returnVehicleLocation || "";
                              return React.createElement("tr", { key: r.id },
                                React.createElement("td", null, React.createElement(PlateLink, { plate: r.plate })),
                                React.createElement("td", null, `${r.make} ${r.model}`),
                                React.createElement("td", null, r.fileType || ""),
                                React.createElement("td", null, loc)
                              );
                            })
                      )
                    ),
                  ] : [])
                ),
                group("Preventative Maintenance", "pm", "pm", pm, false),
                group("Damaged", "damaged", "damaged", damaged, false),
                group("On Rent", "onRent", "onRent", onRent, true)
              );
            })()
          )
      ),
    ]),
    showModal && React.createElement(
      "div",
      { className: "resModalBackdrop", onClick: () => setShowModal(false) },
      React.createElement(
        "div",
        { className: "resModal", onClick: (e) => e.stopPropagation() },
        React.createElement("div", { className: "resModalHeader" },
          React.createElement("h2", { className: "resModalTitle" }, "New Reservation"),
          React.createElement("button", { type: "button", className: "resModalClose", onClick: () => setShowModal(false) }, "✕")
        ),
        React.createElement("form", { className: "resModalForm", onSubmit: handleSubmit },
          React.createElement("div", { className: "resModalBody" },
            React.createElement("div", { className: "cdetailSubGroup" }, "Customer Information"),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Res Code"),
                React.createElement("input", { className: "resFormInput", type: "text", readOnly: true, value: "Assigned on save", style: { background: "#f7f7f7", color: "#aaa", cursor: "default" } })
              ),
              tf("First Name ✱", "firstName", "First name"),
              tf("Last Name", "lastName", "Last name")
            ),
            React.createElement("div", { className: "resFormRow" },
              tf("Phone", "phone", "(xxx) xxx-xxxx"),
              tf("Email", "email", "email@example.com"),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Driver's License ✱"),
                React.createElement("input", { className: "resFormInput", type: "text", placeholder: "License number", value: form.licenseNumber, onChange: (e) => updateForm("licenseNumber", e.target.value), required: true })
              )
            ),
            React.createElement("div", { className: "cdetailSubGroup" }, "Pickup & Return"),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Pickup Date ✱"),
                React.createElement("input", { className: "resFormInput", type: "date", value: form.date, onChange: (e) => updateForm("date", e.target.value), required: true })
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Pickup Time"),
                React.createElement("input", { className: "resFormInput", type: "time", value: form.time, onChange: (e) => updateForm("time", e.target.value) })
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Return Date"),
                React.createElement("input", { className: "resFormInput", type: "date", value: form.returnDate, onChange: (e) => updateForm("returnDate", e.target.value) })
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Return Time"),
                React.createElement("input", { className: "resFormInput", type: "time", value: form.returnTime, onChange: (e) => updateForm("returnTime", e.target.value) })
              )
            ),
            React.createElement("div", { className: "cdetailSubGroup" }, "Reservation Details"),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Location"),
                React.createElement("select", { className: "resFormInput", value: form.location, onChange: (e) => updateForm("location", e.target.value) },
                  pickupLocationOptions(form.location).map((l) => React.createElement("option", { key: l, value: l }, l))
                )
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Vehicle Class"),
                React.createElement("select", { className: "resFormInput", value: form.vehicleClass, onChange: (e) => setForm((p) => withDailyRate({ ...p, vehicleClass: e.target.value })) },
                  vehicleClassOptions(RES_VEHICLE_CLASSES, form.vehicleClass).map((c) => React.createElement("option", { key: c, value: c }, c))
                )
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Winter Tires"),
                React.createElement("select", { className: "resFormInput", value: form.winterTires, onChange: (e) => updateForm("winterTires", e.target.value) },
                  React.createElement("option", { value: "Yes" }, "Yes"),
                  React.createElement("option", { value: "No" }, "No")
                )
              )
            ),
            React.createElement("div", { className: "cdetailSubGroup" }, "Rates & Billing"),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Source"),
                React.createElement("select", { className: "resFormInput", value: form.source, onChange: (e) => setForm((p) => withDailyRate({ ...p, source: e.target.value, sourceDetail: "" })) },
                  React.createElement("option", { value: "" }, "Select source"),
                  Object.keys(sourceCatsFor(form.source)).map((cat) => React.createElement("option", { key: cat, value: cat }, cat))
                )
              ),
              form.source && (sourceCatsFor(form.source)[form.source] || []).length > 0 && React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Specific Source"),
                React.createElement("select", { className: "resFormInput", value: form.sourceDetail, onChange: (e) => updateForm("sourceDetail", e.target.value) },
                  React.createElement("option", { value: "" }, "Select…"),
                  sourceCatsFor(form.source)[form.source].map((s) => React.createElement("option", { key: s, value: s }, s))
                )
              )
            ),
            React.createElement("div", { className: "resFormRow" },
              tf("Daily Rate ($)", "dailyRate", "0.00")
            ),
            ...(() => {
              if (sourceBillingType(form.source) === "insurance") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("Adjuster Name", "adjusterName", "Adjuster name"), tf("Claim Number", "claimNumber", "Claim #")),
                React.createElement("div", { className: "resFormRow", key: "rb2" }, tf("File Number", "fileNumber", "File #"), tf("Authorization Number", "authNumber", "Auth #")),
              ];
              if (sourceBillingType(form.source) === "bodyshop_dealership") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("Claim Number", "claimNumber", "Claim #"), tf("Authorization Number", "authNumber", "Auth #")),
              ];
              if (sourceBillingType(form.source) === "corporate") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("PO Number", "poNumber", "PO #")),
              ];
              if (sourceBillingType(form.source) === "retail") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" },
                  React.createElement("label", { className: "resFormGroup" },
                    React.createElement("span", { className: "resFormLabel" }, "Payment Method"),
                    React.createElement("select", { className: "resFormInput", value: form.paymentMethod, onChange: (e) => updateForm("paymentMethod", e.target.value) },
                      ["Credit Card", "Debit Card", "Cash", "E-transfer"].map((m) => React.createElement("option", { key: m, value: m }, m))
                    )
                  )
                ),
              ];
              return [];
            })(),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup resFormGroup--full" },
                React.createElement("span", { className: "resFormLabel" }, "Notes (optional)"),
                React.createElement("textarea", { className: "resFormInput resFormTextarea", placeholder: "Optional notes…", rows: 3, value: form.noteText, onChange: (e) => updateForm("noteText", e.target.value) })
              )
            )
          ),
          React.createElement("div", { className: "resModalActions" },
            React.createElement("button", { type: "button", className: "resModalCancel", onClick: () => setShowModal(false) }, "Cancel"),
            React.createElement("button", { type: "submit", className: "resModalSubmit" }, "Add Reservation")
          )
        )
      )
    )
  );
}

// ─── NonDriveIntakePage ─────────────────────────────────────────────────────────────────

function NonDriveIntakePage() {
  return React.createElement(NonDriveIntakeSection, { standalone: true });
}

// ─── NoShowsPage ──────────────────────────────────────────────────────────────

function NoShowsPage() {
  const { noShows, setNoShows, setReservations, guardAction } = React.useContext(AppContext);

  const TABS = [
    { key: "2hour",     label: "2-Hour Text",  desc: "Reservations where the customer has not arrived 2 hours past pickup time. Text triggers automatically." },
    { key: "24hour",    label: "24-Hour Text", desc: "No-shows that received a 2-hour text with no response. Text triggers automatically at the 24-hour mark." },
    { key: "abandoned", label: "Abandoned",    desc: "No response after 7 days. Requires manual staff follow-up." },
  ];

  const [activeTab, setActiveTab] = React.useState("2hour");

  // Auto-advance stages based on elapsed time.
  // 2-Hour tab  → 24-Hour tab : 24 h after the 2-hour text was sent (≈ 26 h from pickup).
  // 24-Hour tab → Abandoned   : 7 days after moving into the 24-Hour tab
  //                             (tracked via movedTo24HourAt; falls back to 48 h from pickup
  //                             for rows that pre-date this field).
  // Note: movedTo24HourAt has no matching column in Supabase, so it is kept in
  // local state only and is not sent in the update payload below. It resets to
  // the fallback estimate on reload, which is an accepted limitation until the
  // column is added.
  React.useEffect(() => {
    const now = Date.now();
    const HOUR = 3600000;
    const needsAdvance = noShows.filter((r) => {
      if (r.status === "Reached") return false;
      const stage = r.stage || "2hour";
      if (stage === "abandoned") return false;
      const pickupMs = new Date(`${r.date}T${r.time || "00:00"}`).getTime();
      if (Number.isNaN(pickupMs)) return false;
      const elapsed = now - pickupMs;
      if (stage === "2hour" && elapsed >= 26 * HOUR) return true;
      if (stage === "24hour") {
        const since = r.movedTo24HourAt || (pickupMs + 26 * HOUR);
        if (now - since >= 7 * 24 * HOUR) return true;
      }
      return false;
    });
    if (needsAdvance.length === 0) return;
    setNoShows((prev) =>
      prev.map((r) => {
        if (r.status === "Reached") return r;
        const stage = r.stage || "2hour";
        if (stage === "abandoned") return r;
        const pickupMs = new Date(`${r.date}T${r.time || "00:00"}`).getTime();
        if (Number.isNaN(pickupMs)) return r;
        const elapsed = now - pickupMs;
        if (stage === "2hour" && elapsed >= 26 * HOUR) {
          supabase.from("no_shows").update({ stage: "24hour" }).eq("id", r.id).then(({ error }) => {
            if (error) console.warn("no_shows stage update failed:", r.id, error);
          }).catch((e) => console.warn("no_shows update:", e));
          return { ...r, stage: "24hour", movedTo24HourAt: now };
        }
        if (stage === "24hour") {
          const since = r.movedTo24HourAt || (pickupMs + 26 * HOUR);
          if (now - since >= 7 * 24 * HOUR) {
            supabase.from("no_shows").update({ stage: "abandoned" }).eq("id", r.id).then(({ error }) => {
              if (error) console.warn("no_shows stage update failed:", r.id, error);
            }).catch((e) => console.warn("no_shows update:", e));
            return { ...r, stage: "abandoned" };
          }
        }
        return r;
      })
    );
  }, [noShows]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabRows = noShows.filter((r) => (r.stage || "2hour") === activeTab);

  // Move a confirmed customer from the 2-Hour tab back into Reservations.
  // Uses pickupStatus "Confirmed" so the AppProvider sweep doesn't re-flag them.
  const handleConfirmPickup = (row) => {
    const nameParts = (row.customer || "").trim().split(/\s+/);
    const newRes = {
      resCode:               row.resCode,
      customer:              row.customer || "",
      firstName:             nameParts[0] || "",
      lastName:              nameParts.slice(1).join(" ") || "",
      date:                  row.date || "",
      time:                  row.time || "",
      location:              row.location || "",
      vehicleClass:          row.vehicleClass || "",
      phone:                 row.phone || "",
      email:                 "",
      returnDate:            "",
      returnTime:            "",
      winterTires:           "No",
      source:                "",
      sourceDetail:          "",
      ratesVehicleClass:     "",
      dailyRate:             "",
      adjusterName:          "",
      claimNumber:           "",
      fileNumber:            "",
      authNumber:            "",
      poNumber:              "",
      paymentMethod:         "",
      preRentalCheck:        "NOT Pre-Rental Check'd",
      notesLog:              [],
      rentalAgreementStatus: "reservation",
      pickupStatus:          "Confirmed",
    };
    // Deletes the no-show row, so it takes the PIN.
    guardAction("noShow.confirmPickup", () => {
      setReservations((prev) => [...prev, newRes]);
      runWrite(supabase.from("reservations").insert(newRes).then((res) => console.log("reservations insert response:", res)), "reservations insert");
      setNoShows((prev) => prev.filter((r) => r.id !== row.id));
      runWrite(supabase.from("no_shows").delete().eq("id", row.id), "no_shows delete");
    });
  };

  // Texting these customers is handled entirely by the Cloudflare cron (see
  // worker.js, REMINDER.NO_SHOW_2HR and NO_SHOW_24HR). This used to be a
  // "Text All" button that flipped a coin per customer and wrote the invented
  // result to Supabase, so the Reached and LM figures on this page were fiction.
  // Staff now record what actually happened.
  const recordOutcome = (row, outcome) => {
    const patch = outcome === "Reached"
      ? { called: true, status: "Reached" }
      // No answer moves the row along the escalation ladder, the same
      // progression the cron uses to decide which reminder to send next.
      : { called: true, status: "LM", stage: (row.stage || "2hour") === "2hour" ? "24hour" : "abandoned" };
    setNoShows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
    supabase.from("no_shows").update(patch).eq("id", row.id)
      .then(({ error }) => { if (error) console.warn("no_shows outcome update failed:", row.id, error); })
      .catch((e) => console.warn("no_shows outcome update:", e));
  };

  const activeTabObj = TABS.find((t) => t.key === activeTab);

  return React.createElement(
    "div",
    { className: "page" },
    React.createElement("h1", { className: "page__title" }, "No Shows"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(
      "div",
      { className: "aiSubTabs" },
      TABS.map(({ key, label }) =>
        React.createElement(
          "button",
          {
            key,
            type: "button",
            className: `aiSubTab${activeTab === key ? " aiSubTab--active" : ""}`,
            onClick: () => setActiveTab(key),
          },
          label
        )
      )
    ),
    React.createElement("p", { className: "aiTabDesc" }, activeTabObj.desc),
    React.createElement(
      "section",
      { className: "dashboardSection" },
      React.createElement(
        "div",
        { className: "dashboardSection__header" },
        React.createElement(
          "div",
          { className: "dashboardSection__headerRow" },
          React.createElement("span", null, activeTabObj.label),
          React.createElement("span", { className: "autoTextNote" }, "Reminders are texted automatically")
        )
      ),
      React.createElement(
        "div",
        { className: "dashboardSection__body" },
        tabRows.length === 0
          ? React.createElement(
              "div",
              { className: "resvEmpty" },
              activeTab === "abandoned" ? "No abandoned no-shows." : `No entries in ${activeTabObj.label}.`
            )
          : React.createElement(
              "table",
              { className: "dashboardTable" },
              React.createElement(
                "thead",
                null,
                React.createElement(
                  "tr",
                  null,
                  ["Time", "Res Code", "Customer", "Vehicle Class", "Location", "Phone", activeTab === "abandoned" ? "Action" : "Status"].map((col) =>
                    React.createElement("th", { key: col }, col)
                  )
                )
              ),
              React.createElement(
                "tbody",
                null,
                tabRows.map((row) => {
                  const statusEl =
                    activeTab === "abandoned"
                      ? React.createElement("span", { className: "overdueManual" }, "Manual Follow-Up")
                      : activeTab === "2hour"
                        ? React.createElement("div", { className: "readyStatusWrap" },
                            row.status === "Reached"
                              ? React.createElement("span", { className: "preRentalCheckDone" }, "Reached")
                              : row.status === "LM"
                                ? React.createElement("span", { className: "preRentalCheckLm" }, "LM")
                                // Nothing recorded yet. The reminder text has gone out
                                // automatically; these record what the customer actually did.
                                : React.createElement(React.Fragment, null,
                                    React.createElement("button", {
                                      type: "button", className: "aiControl",
                                      title: "The customer replied or we spoke to them",
                                      onClick: () => recordOutcome(row, "Reached"),
                                    }, "Reached"),
                                    React.createElement("button", {
                                      type: "button", className: "aiControl",
                                      style: { marginLeft: "6px" },
                                      title: "No reply. Moves to the next escalation stage",
                                      onClick: () => recordOutcome(row, "LM"),
                                    }, "No Reply")
                                  ),
                            React.createElement("button", {
                              type: "button",
                              className: "aiControl",
                              style: { marginLeft: "6px" },
                              onClick: () => handleConfirmPickup(row),
                            }, "Confirmed Pickup")
                          )
                        : row.status === "Reached"
                          ? React.createElement("span", { className: "preRentalCheckDone" }, "Reached")
                          : row.status === "LM"
                            ? React.createElement("span", { className: "preRentalCheckLm" }, "LM")
                            : React.createElement("span", null, "");
                  return React.createElement(
                    "tr",
                    { key: row.id },
                    React.createElement("td", null, fmt12h(row.time)),
                    React.createElement("td", null, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.resCode || "—" })),
                    React.createElement("td", null, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.customer })),
                    React.createElement("td", null, row.vehicleClass),
                    React.createElement("td", null, row.location),
                    React.createElement("td", null, row.phone),
                    React.createElement("td", null, statusEl)
                  );
                })
              )
            )
      )
    )
  );
}

// ─── OverdueRentalsPage ───────────────────────────────────────────────────────

function OverdueRentalsPage() {
  const { reservations, rentalAgreements } = React.useContext(AppContext);
  const [callStatuses, setCallStatuses] = React.useState({});

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };

  // Derived: reservations with an open rental agreement whose return date has
  // passed (same computation the automated overdue-rental SMS uses).
  const rows = React.useMemo(() => {
    const now = new Date();
    return reservations
      .filter((r) => {
        if (!r.returnDate) return false;
        const ra = rentalAgreements.find((a) => a.resCode === r.resCode);
        const raStatus = ra?.rentalAgreementStatus || r.rentalAgreementStatus || "";
        if (raStatus !== "open_rental_agreement") return false;
        const returnDt = new Date(`${r.returnDate}T00:00:00`);
        return !Number.isNaN(returnDt.getTime()) && now > returnDt;
      })
      .map((r) => {
        const ra = rentalAgreements.find((a) => a.resCode === r.resCode);
        return {
          id: r.resCode,
          resCode: r.resCode,
          customer: r.customer || `${r.firstName || ""} ${r.lastName || ""}`.trim(),
          phone: r.phone,
          plate: r.plate || ra?.plate || null,
          returnDate: r.returnDate,
          // Persisted outcome wins; local state only covers the moment between
          // the click and the next load.
          callStatus: callStatuses[r.resCode] ?? r.callOutcome,
        };
      });
  }, [reservations, rentalAgreements, callStatuses]);

  const activeRows = rows.filter((r) => r.callStatus !== "LM");
  const manualRows = rows.filter((r) => r.callStatus === "LM");

  // Overdue customers are texted automatically by the cron (worker.js,
  // REMINDER.OVERDUE). This was a coin flip that only ever wrote to local React
  // state, so the outcome was both invented and lost on refresh. It now records
  // what actually happened, to Supabase.
  const recordOutcome = (row, outcome) => {
    const patch = { callOutcome: outcome, callOutcomeAt: new Date().toISOString() };
    setCallStatuses((prev) => ({ ...prev, [row.resCode]: outcome }));
    supabase.from("reservations").update(patch).eq("resCode", row.resCode)
      .then(({ error }) => { if (error) console.warn("overdue outcome update failed:", row.resCode, error); })
      .catch((e) => console.warn("overdue outcome update:", e));
  };

  const renderTable = (tableRows, lastColHeader, isManual) =>
    React.createElement(
      "table",
      { className: "dashboardTable" },
      React.createElement(
        "thead", null,
        React.createElement("tr", null,
          ["Res Code", "Customer", "Phone", "Plate", "Due Date", lastColHeader].map((col) =>
            React.createElement("th", { key: col }, col)
          )
        )
      ),
      React.createElement(
        "tbody", null,
        tableRows.map((row) =>
          React.createElement(
            "tr",
            { key: row.id },
            React.createElement("td", null, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.resCode })),
            React.createElement("td", null, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.customer })),
            React.createElement("td", null, row.phone),
            React.createElement("td", null, row.plate ? React.createElement(PlateLink, { plate: row.plate }) : "—"),
            React.createElement("td", null, fmtDate(row.returnDate)),
            React.createElement(
              "td", null,
              isManual
                ? React.createElement("span", { className: "overdueManual" }, "Manual Follow-Up Required")
                : row.callStatus === "Reached"
                  ? React.createElement("span", { className: "preRentalCheckDone" }, "Reached")
                  : row.callStatus === "LM"
                    ? React.createElement("span", { className: "preRentalCheckLm" }, "LM")
                    : React.createElement("div", { className: "readyStatusWrap" },
                        React.createElement("button", {
                          type: "button", className: "aiControl",
                          title: "The customer replied or we spoke to them",
                          onClick: () => recordOutcome(row, "Reached"),
                        }, "Reached"),
                        React.createElement("button", {
                          type: "button", className: "aiControl",
                          style: { marginLeft: "6px" },
                          title: "No reply to the automatic reminder",
                          onClick: () => recordOutcome(row, "LM"),
                        }, "No Reply")
                      )
            )
          )
        )
      )
    );

  return React.createElement(
    "div",
    { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Overdue Rentals"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(
      "p",
      { className: "aiTabDesc" },
      "Rental agreements past their return date. An AI call triggers automatically. Customers with no response are moved to Manual Follow-Up."
    ),
    React.createElement(
      "section",
      { className: "dashboardSection" },
      React.createElement(
        "div",
        { className: "dashboardSection__header" },
        React.createElement(
          "div",
          { className: "dashboardSection__headerRow" },
          React.createElement("span", null, "Overdue"),
          React.createElement("span", { className: "autoTextNote" }, "Reminders are texted automatically")
        )
      ),
      React.createElement(
        "div",
        { className: "dashboardSection__body" },
        activeRows.length === 0
          ? React.createElement("div", { className: "resvEmpty" }, "No overdue rentals.")
          : renderTable(activeRows, "Status", false)
      )
    ),
    manualRows.length > 0 &&
      React.createElement(
        "section",
        { className: "dashboardSection", style: { marginTop: "20px" } },
        React.createElement(
          "div",
          { className: "dashboardSection__header" },
          React.createElement(
            "div",
            { className: "dashboardSection__headerRow" },
            React.createElement("span", null, "Manual Follow-Up")
          )
        ),
        React.createElement(
          "div",
          { className: "dashboardSection__body" },
          renderTable(manualRows, "Action", true)
        )
      )
  );
}

// ─── VehicleDetailPage ──────────────────────────────────────────────────────────────────────────────

function VehicleDetailPage() {
  const { openVehiclePlate, fleet, setFleet, reservations, rentalAgreements, setOpenRentalAgreementId, damageClaims, guardAction } = React.useContext(AppContext);
  const navigate = useNavigate();

  const plate   = openVehiclePlate || "";
  const vehicle = fleet.find((v) => v.plate === plate) || {};
  const extra   = VEHICLE_EXTRA_DATA[plate] || {};

  // Active RA for this plate (open rental) \u2014 used for currentRenter, resCode, returnDate
  const activeRa = plate
    ? rentalAgreements.find((ra) => ra.plate === plate && RA_LOCKS_VEHICLE_STATUS.includes(ra.rentalAgreementStatus)) || null
    : null;

  // Most recent RA for this plate by inspectedAt \u2014 used for odometer and fuel level
  const latestRa = plate
    ? rentalAgreements
        .filter((ra) => ra.plate === plate && ra.inspectedAt)
        .sort((a, b) => new Date(b.inspectedAt) - new Date(a.inspectedAt))[0] || null
    : null;

  const [sect, setSect] = React.useState({ info: false, status: false, pm: false, condition: false, maintenance: false, damageClaims: false, inspections: false });

  // Tank size and PM interval are entered by hand (no free API exposes either
  // reliably). Both are stored canonically (litres / kilometres) and only
  // converted for display, so the unit toggle can never affect the gas charge
  // maths or the PM threshold comparison.
  const [tankUnit, setTankUnit] = React.useState(fuelUnit);
  const [pmUnit,   setPmUnit]   = React.useState(distanceUnit);
  const [tankInput, setTankInput] = React.useState("");
  const [pmInput,   setPmInput]   = React.useState("");

  React.useEffect(() => {
    setTankInput(toDisplayUnits(vehicle.tankSizeLiters, tankUnit));
  }, [vehicle.tankSizeLiters, plate, tankUnit]);

  React.useEffect(() => {
    setPmInput(toDisplayUnits(vehicle.pmIntervalKm, pmUnit));
  }, [vehicle.pmIntervalKm, plate, pmUnit]);

  // Shared writer: converts from the displayed unit back to canonical before
  // persisting, and restores the previous value if the input is not usable.
  const saveNumericField = (column, rawInput, canonicalUnit, currentCanonical, resetter) => {
    const trimmed = String(rawInput).trim();
    const parsed  = trimmed === "" ? null : toCanonicalUnits(trimmed, canonicalUnit);
    // Blank clears the field. Anything else has to pass the same check the
    // command bar runs, so the two paths cannot disagree about a valid number.
    if (trimmed !== "" && !validateFleetNumerics({ [column]: parsed }).ok) {
      resetter(toDisplayUnits(currentCanonical, canonicalUnit));
      return;
    }
    if (parsed === (currentCanonical ?? null)) return;
    // Tank size feeds every gas charge and the PM interval drives the service
    // schedule, so both sit in the PIN tier. Cancelling the PIN restores the
    // displayed value rather than leaving the field showing an unsaved number.
    const key = column === "tankSizeLiters" ? "vehicle.tankSize" : "vehicle.pmInterval";
    guardAction(key, () => {
      setFleet((prev) => prev.map((v) => v.plate === plate ? { ...v, [column]: parsed } : v));
      if (vehicle.id) {
        supabase.from("fleet").update({ [column]: parsed }).eq("id", vehicle.id)
          .then(({ error }) => { if (error) console.warn(`fleet ${column} update failed:`, error); })
          .catch((err) => console.warn(`fleet ${column} update:`, err));
      }
    });
  };

  const saveTankSize = () =>
    saveNumericField("tankSizeLiters", tankInput, tankUnit, vehicle.tankSizeLiters, setTankInput);
  const savePmInterval = () =>
    saveNumericField("pmIntervalKm", pmInput, pmUnit, vehicle.pmIntervalKm, setPmInput);

  // ── PM status ──────────────────────────────────────────────────────────────
  const kmSincePm = (vehicle.currentOdometer != null && vehicle.lastPmOdometer != null)
    ? vehicle.currentOdometer - vehicle.lastPmOdometer
    : null;
  const kmUntilPm = (kmSincePm != null && vehicle.pmIntervalKm)
    ? vehicle.pmIntervalKm - kmSincePm
    : null;

  // Records that PM was performed: the interval restarts from the odometer
  // reading now, and the vehicle leaves PM status so it can be rented again.
  const completePm = () => {
    if (!vehicle.id) return;
    // The rule itself lives in resolvePmComplete so the command bar records PM
    // the same way this button does.
    const { ok, patch, error } = resolvePmComplete(vehicle);
    if (!ok) {
      window.alert(error);
      return;
    }
    guardAction("vehicle.pmComplete", () => {
      setFleet((prev) => prev.map((v) => v.plate === plate ? { ...v, ...patch } : v));
      supabase.from("fleet").update(patch).eq("id", vehicle.id)
        .then(({ error }) => { if (error) console.warn("fleet PM complete failed:", error); })
        .catch((err) => console.warn("fleet PM complete:", err));
    }, { tableName: "fleet", recordId: plate, description: `PM recorded complete. Interval rebaselined to ${patch.lastPmOdometer} km${patch.status ? ", status PM -> Available" : ""}.` });
  };
  const toggle = (key) => setSect((p) => ({ ...p, [key]: !p[key] }));

  const fmtDate = (iso) => {
    if (!iso) return "\u2014";
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };

  const currentRes = vehicle.currentRenter
    ? reservations.find((r) => r.customer === vehicle.currentRenter)
    : null;

  const rentalHistory = vehicle.make
    ? reservations.filter((r) =>
        r.vehicleMake && r.vehicleMake.toLowerCase() === (vehicle.make || "").toLowerCase() &&
        r.vehicleModel && r.vehicleModel.toLowerCase() === (vehicle.model || "").toLowerCase()
      )
    : [];

  const detailRow = (label, value) =>
    React.createElement(
      "div", { className: "vehicleDetailRow" },
      React.createElement("span", { className: "vehicleDetailLabel" }, label),
      React.createElement("span", { className: "vehicleDetailValue" }, value !== undefined && value !== null && value !== "" ? String(value) : "\u2014")
    );

  const subHdr = (title) =>
    React.createElement("div", { className: "vehicleDetailSubHeader" }, title);

  const mkSection = (key, title, body) =>
    React.createElement(
      "section", { className: "dashboardSection", style: { marginTop: "16px" } },
      React.createElement(
        "div", { className: "dashboardSection__header" },
        React.createElement(
          "div", { className: "dashboardSection__headerRow" },
          React.createElement("span", null, title),
          React.createElement("button", {
            type: "button",
            className: "sectionToggleCircle",
            onClick: () => toggle(key),
          }, sect[key] ? "+" : "\u2212")
        )
      ),
      !sect[key] && React.createElement("div", { className: "dashboardSection__body" }, body)
    );

  if (!plate) {
    return React.createElement(
      "div", { className: "page" },
      React.createElement("h1", { className: "page__title" }, "Vehicle Detail"),
      React.createElement("div", { className: "page__titleUnderline" }),
      React.createElement("div", { className: "resvEmpty" }, "No vehicle selected.")
    );
  }

  return React.createElement(
    "div", { className: "page" },
    React.createElement("button", {
      type: "button",
      className: "rentalAgreementBackBtn",
      onClick: () => navigate(-1),
    }, "\u2190 Back"),
    React.createElement("h1", { className: "page__title" }, plate),
    React.createElement("div", { className: "page__titleUnderline" }),

    // \u2500\u2500 Section 1: Vehicle Information \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    mkSection("info", "Vehicle Information",
      React.createElement(React.Fragment, null,
        detailRow("Plate", plate.replace(/-/g, "")),
        detailRow("Province / State", vehicle.province || extra.province),
        detailRow("Year / Make / Model", [vehicle.year || extra.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") || "\u2014"),
        detailRow("Colour", vehicle.colour || extra.colour),
        detailRow("VIN", vehicle.vin || extra.vin),
        detailRow("Odometer", latestRa?.mileage != null
          ? fmtDistance(latestRa.mileage)
          : extra.odometer != null ? fmtDistance(extra.odometer) : "\u2014"),
        detailRow("Fuel Level", latestRa?.fuelAtPickup || extra.fuelLevel),
        React.createElement(
          "div", { className: "vehicleDetailRow" },
          React.createElement("span", { className: "vehicleDetailLabel" }, "Tank Size"),
          React.createElement("span", { className: "vehicleDetailControl" },
            React.createElement(UnitToggle, { unit: tankUnit, setUnit: setTankUnit, options: VOLUME_UNITS }),
            React.createElement("input", {
              type: "number", min: "0", step: "0.1", className: "tankSizeInput",
              placeholder: "Not set",
              value: tankInput,
              onChange: (e) => setTankInput(e.target.value),
              onBlur: saveTankSize,
              onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); },
            }),
            React.createElement("span", { className: "unitSuffix" }, tankUnit === "L" ? "L" : "gal"),
            vehicle.tankSizeLiters == null &&
              React.createElement("span", { className: "tankSizeMissing", title: "Gas charges cannot be calculated automatically until this is set" }, "Not set")
          )
        )
      )
    ),

    // ── Preventative Maintenance ──────────────────────────────────────────────
    mkSection("pm", "Preventative Maintenance",
      React.createElement(React.Fragment, null,
        React.createElement(
          "div", { className: "vehicleDetailRow" },
          React.createElement("span", { className: "vehicleDetailLabel" }, "Needs PM Every"),
          React.createElement("span", { className: "vehicleDetailControl" },
            React.createElement(UnitToggle, { unit: pmUnit, setUnit: setPmUnit, options: DISTANCE_UNITS }),
            React.createElement("input", {
              type: "number", min: "0", step: "1", className: "tankSizeInput",
              placeholder: "Not set",
              value: pmInput,
              onChange: (e) => setPmInput(e.target.value),
              onBlur: savePmInterval,
              onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); },
            }),
            React.createElement("span", { className: "unitSuffix" }, pmUnit),
            vehicle.pmIntervalKm == null &&
              React.createElement("span", { className: "tankSizeMissing", title: "PM cannot be triggered automatically until this is set" }, "Not set")
          )
        ),
        detailRow("Current Odometer", vehicle.currentOdometer != null
          ? `${Number(toDisplayUnits(vehicle.currentOdometer, pmUnit)).toLocaleString()} ${pmUnit}`
          : "Not recorded yet"),
        detailRow("Odometer at Last PM", vehicle.lastPmOdometer != null
          ? `${Number(toDisplayUnits(vehicle.lastPmOdometer, pmUnit)).toLocaleString()} ${pmUnit}`
          : "No PM on record"),
        detailRow("Since Last PM", kmSincePm != null
          ? `${Number(toDisplayUnits(kmSincePm, pmUnit)).toLocaleString()} ${pmUnit}`
          : "Not enough data"),
        React.createElement(
          "div", { className: "vehicleDetailRow" },
          React.createElement("span", { className: "vehicleDetailLabel" }, "PM Due"),
          React.createElement("span", { className: "vehicleDetailControl" },
            vehicle.needsPm
              ? React.createElement("span", { className: "pmDueBadge pmDueBadge--due" },
                  vehicle.status === "PM" ? "DUE NOW" : `DUE NOW (also ${vehicle.status})`)
              : kmUntilPm != null
                ? React.createElement("span", { className: kmUntilPm <= 0 ? "pmDueBadge pmDueBadge--due" : "pmDueBadge pmDueBadge--ok" },
                    kmUntilPm <= 0
                      ? "DUE NOW"
                      : `in ${Number(toDisplayUnits(kmUntilPm, pmUnit)).toLocaleString()} ${pmUnit}`)
                : React.createElement("span", { className: "pmDueBadge" }, "Not enough data")
          )
        ),
        React.createElement("div", { style: { marginTop: "12px" } },
          React.createElement("button", {
            type: "button",
            className: "pmCompleteBtn",
            disabled: vehicle.currentOdometer == null || !vehicle.needsPm,
            title: vehicle.currentOdometer == null
              ? "An odometer reading is needed first. It is captured when a rental is returned."
              : !vehicle.needsPm
                ? "This vehicle is not currently due for preventative maintenance."
                : "Record that PM was performed at the current odometer reading",
            onClick: completePm,
          }, "PM Complete")
        )
      )
    ),

    // \u2500\u2500 Section 2: Current Status \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    mkSection("status", "Current Status",
      React.createElement(React.Fragment, null,
        React.createElement(
          "div", { className: "vehicleDetailRow" },
          React.createElement("span", { className: "vehicleDetailLabel" }, "Status"),
          React.createElement(
            "select", {
              className: "vehicleStatusSelect",
              value: vehicle.status || "",
              disabled: !!activeRa,
              title: activeRa ? "Status is locked while a rental agreement is open" : undefined,
              onChange: (e) => {
                if (activeRa) return;
                const { status: newStatus, forced, message } = resolvePmStatus(vehicle, e.target.value);
                guardAction("vehicle.status", () => {
                  setFleet((prev) =>
                    prev.map((v) => v.plate === plate ? { ...v, status: newStatus } : v)
                  );
                  if (vehicle.id) {
                    runWrite(supabase.from("fleet").update({ status: newStatus }).eq("id", vehicle.id), "fleet update");
                  }
                  if (forced) window.alert(message);
                });
              },
            },
            FLEET_STATUS_OPTS
              .filter((o) => o.value !== "All")
              .map((opt) => React.createElement("option", { key: opt.value, value: opt.value }, opt.label))
          )
        ),
        (vehicle.status === "On Rent" || activeRa) && detailRow("Current Renter", activeRa?.customer || vehicle.currentRenter),
        (vehicle.status === "On Rent" || activeRa) && detailRow("Reservation Code", activeRa?.resCode || currentRes?.resCode || "\u2014"),
        (vehicle.status === "On Rent" || activeRa) && detailRow("Expected Return", fmtDate(activeRa?.returnDate || vehicle.dueBack)),
        subHdr("Rental History"),
        rentalHistory.length === 0
          ? React.createElement("div", { className: "resvEmpty", style: { textAlign: "left", padding: "12px 0" } }, "No rental history on record.")
          : React.createElement(
              "table", { className: "dashboardTable" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  ["Customer", "Res Code", "Pickup", "Return"].map((col) =>
                    React.createElement("th", { key: col }, col)
                  )
                )
              ),
              React.createElement("tbody", null,
                rentalHistory.map((r) =>
                  React.createElement("tr", { key: r.resCode },
                    React.createElement("td", null, React.createElement(CustomerLink, { name: r.customer, resCode: r.resCode, label: r.customer })),
                    React.createElement("td", null, React.createElement(CustomerLink, { name: r.customer, resCode: r.resCode, label: r.resCode })),
                    React.createElement("td", null, fmtDate(r.date)),
                    React.createElement("td", null, fmtDate(r.returnDate))
                  )
                )
              )
            )
      )
    ),

    // \u2500\u2500 Section 3: Condition \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    mkSection("condition", "Condition",
      React.createElement(React.Fragment, null,
        subHdr("Existing Damage"),
        React.createElement("div", { className: "resvEmpty", style: { textAlign: "left", padding: "12px 0" } }, "No damage on record."),
        subHdr("Last Inspection Photos"),
        React.createElement("div", { className: "resvEmpty", style: { textAlign: "left", padding: "12px 0" } }, "No inspection photos available."),
        detailRow("Last Inspection Date", "\u2014")
      )
    ),

    // \u2500\u2500 Section 4: Maintenance \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    mkSection("maintenance", "Maintenance", (() => {
      const maint = VEHICLE_MAINTENANCE_SEED[plate] || {};
      const fmtD = (iso) => iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }) : "\u2014";
      return React.createElement(React.Fragment, null,
        detailRow("Last Oil Change",    fmtD(maint.lastOilChange)),
        detailRow("Next Service Due",   fmtD(maint.nextServiceDue)),
        detailRow("Maintenance Notes",  maint.notes || "\u2014")
      );
    })()),

    // \u2500\u2500 Section 5: Ongoing Damage Claims \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    mkSection("damageClaims", "Ongoing Damage Claims", (() => {
      const claims = damageClaims
        .filter((c) => (c.plate || "") === plate && c.status !== "resolved")
        .map((c) => enrichDamageClaim(c, rentalAgreements, reservations));
      if (claims.length === 0) return React.createElement("div", { className: "resvEmpty", style: { textAlign: "left", padding: "12px 0" } }, "No active damage claims for this vehicle.");
      return React.createElement(
        "table", { className: "dashboardTable" },
        React.createElement("thead", null,
          React.createElement("tr", null,
            ["Customer", "Res Code", "Damage Description", "Status", "Rentable"].map((col) =>
              React.createElement("th", { key: col }, col)
            )
          )
        ),
        React.createElement("tbody", null,
          claims.map((c) => {
            const statusCls = c.claimStatus === "Open" ? "claimStatus claimStatus--open" : "claimStatus claimStatus--inReview";
            return React.createElement("tr", { key: c.id },
              React.createElement("td", null, React.createElement("button", { type: "button", className: "rentalAgreementLink rentalAgreementLink--dark", onClick: () => { setOpenRentalAgreementId(c.resCode); navigate("/rental-agreements"); } }, c.customer)),
              React.createElement("td", null, React.createElement("button", { type: "button", className: "rentalAgreementLink rentalAgreementLink--dark", onClick: () => { setOpenRentalAgreementId(c.resCode); navigate("/rental-agreements"); } }, c.resCode)),
              React.createElement("td", null, c.description),
              React.createElement("td", null, React.createElement("span", { className: statusCls }, c.claimStatus)),
              React.createElement("td", null, vehicleRentableLabel(c.vehicleRentable))
            );
          })
        )
      );
    })()),

    // \u2500\u2500 Section 7: Inspection History \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    mkSection("inspections", "Inspection History",
      React.createElement(React.Fragment, null,
        React.createElement("p", { className: "aiTabDesc" }, "The two most recent inspections appear here, each showing the pickup and return walkaround separately. Data is pulled from PWA submission records in Supabase."),
        React.createElement("div", { className: "resvEmpty", style: { textAlign: "left", padding: "12px 0" } }, "No inspection records found.")
      )
    )
  );
}

// ─── FleetPage ────────────────────────────────────────────────────────────────

function FleetPage() {
  const { fleet, setFleet, rentalAgreements, guardAction } = React.useContext(AppContext);
  const readyReturns = fleet.filter((v) => v.status === "Ready Returns");
  const [collapsed, setCollapsed] = React.useState(false);
  const [fleetGroupCollapsed, setFleetGroupCollapsed] = React.useState({
    available: true, needsCleaning: true, readyReturns: true, pm: true, damaged: true, onRent: true,
  });
  const toggleFleetGroup = (key) =>
    setFleetGroupCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  return React.createElement(
    "div",
    { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Branch Fleet"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(
      "section",
      { className: "dashboardSection" },
      React.createElement(
        "div",
        { className: "dashboardSection__header" },
        React.createElement(
          "div",
          { className: "dashboardSection__headerRow" },
          React.createElement("span", null, "Vehicle Status"),
          React.createElement(
            "button",
            {
              type: "button",
              className: "sectionToggleCircle",
              onClick: () => setCollapsed((c) => !c),
            },
            collapsed ? "+" : "-"
          )
        )
      ),
      !collapsed &&
        React.createElement(
          "div",
          { className: "dashboardSection__body" },
          (() => {
            const fmtShort = (iso) => {
              if (!iso) return "";
              const d = new Date(`${iso}T00:00:00`);
              return Number.isNaN(d.getTime()) ? iso
                : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
            };
            const fleetTable = (rows, showStatus) =>
              React.createElement(
                "table",
                { className: "dashboardTable" },
                React.createElement("thead", null,
                  React.createElement("tr", null,
                    ["Plate", "Vehicle", "Class", ...(showStatus ? ["Status"] : []), "Winter Tires"].map((col) =>
                      React.createElement("th", { key: col }, col)
                    )
                  )
                ),
                React.createElement("tbody", null,
                  rows.length === 0
                    ? React.createElement("tr", null, React.createElement("td", { colSpan: showStatus ? 5 : 4, style: { color: "#aaa", fontStyle: "italic" } }, "None"))
                    : rows.map((v) => {
                        const statusClass =
                          v.status === "Available" ? "fleetStatus--available"
                          : v.status === "Needs Cleaning" ? "fleetStatus--cleaning"
                          : v.status === "PM" ? "fleetStatus--pm"
                          : v.status === "Damaged" ? "fleetStatus--damaged"
                          : v.status === "On Rent" ? "fleetStatus--onRent"
                          : "";
                        return React.createElement("tr", { key: v.id },
                          React.createElement("td", null, React.createElement(PlateLink, { plate: v.plate })),
                          React.createElement("td", null, `${v.make} ${v.model}`),
                          React.createElement("td", null, v.vehicleClass),
                          ...(showStatus ? [React.createElement("td", null, React.createElement("span", { className: statusClass }, v.status))] : []),
                          React.createElement("td", null, v.winterTires || "")
                        );
                      })
                )
              );

            const avail    = fleet.filter((v) => v.status === "Available");
            const cleaning = fleet.filter((v) => v.status === "Needs Cleaning");
            const pm     = fleet.filter((v) => v.needsPm);
            const damaged  = fleet.filter((v) => v.status === "Damaged");
            const onRent   = fleet.filter((v) => v.status === "On Rent");

            const group = (label, cls, key, rows, showStatus, children) =>
              React.createElement("div", { className: "fleetGroup" },
                React.createElement("div", { className: `fleetGroupHeader fleetGroupHeader--${cls}` },
                  React.createElement("span", null, label),
                  React.createElement("div", { className: "fleetGroupHeaderRight" },
                    React.createElement("span", { className: "fleetGroupCount" }, rows.length),
                    React.createElement("button", {
                      type: "button",
                      className: "fleetGroupToggle",
                      onClick: () => toggleFleetGroup(key),
                    }, fleetGroupCollapsed[key] ? "+" : "−")
                  )
                ),
                ...(fleetGroupCollapsed[key] ? [] : (children || [fleetTable(rows, showStatus)]))
              );

            return React.createElement(React.Fragment, null,
              group("Available", "available", "available", avail, false),
              group("Needs Cleaning", "cleaning", "needsCleaning", cleaning, false),
              React.createElement("div", { className: "fleetGroup" },
                React.createElement("div", { className: "fleetGroupHeader fleetGroupHeader--readyReturns" },
                  React.createElement("span", null, "Ready Returns"),
                  React.createElement("div", { className: "fleetGroupHeaderRight" },
                    React.createElement("span", { className: "fleetGroupCount" }, readyReturns.length),
                    React.createElement("button", {
                      type: "button",
                      className: "fleetGroupToggle",
                      onClick: () => toggleFleetGroup("readyReturns"),
                    }, fleetGroupCollapsed.readyReturns ? "+" : "−")
                  )
                ),
                ...(!fleetGroupCollapsed.readyReturns ? [
                  React.createElement("table", { className: "dashboardTable" },
                    React.createElement("thead", null,
                      React.createElement("tr", null,
                        ["Plate", "Vehicle", "Type", "Location"].map((col) =>
                          React.createElement("th", { key: col }, col)
                        )
                      )
                    ),
                    React.createElement("tbody", null,
                      readyReturns.length === 0
                        ? React.createElement("tr", null, React.createElement("td", { colSpan: 4, style: { color: "#aaa", fontStyle: "italic" } }, "None"))
                        : readyReturns.map((r) => {
                            const matchRA = (rentalAgreements || []).find((a) => a.plate === r.plate && RA_IN_READY_RETURNS.includes(a.rentalAgreementStatus));
                            const loc = matchRA?.returnVehicleLocation || "";
                            return React.createElement("tr", { key: r.id },
                              React.createElement("td", null, React.createElement(PlateLink, { plate: r.plate })),
                              React.createElement("td", null, `${r.make} ${r.model}`),
                              React.createElement("td", null, r.fileType || ""),
                              React.createElement("td", null, loc)
                            );
                          })
                    )
                  ),
                ] : [])
              ),
              group("Preventative Maintenance", "pm", "pm", pm, false),
              group("Damaged", "damaged", "damaged", damaged, false),
              group("On Rent", "onRent", "onRent", onRent, true)
            );
          })()
        )
    )
  );
}

// ─── UnknownRepairDatePage ─────────────────────────────────────────────────────

function TORPage() {
  const { reservations, setReservations } = React.useContext(AppContext);

  const rows = reservations.filter(
    (r) =>
      ["bodyshop_dealership", "insurance"].includes(sourceBillingType(r.source)) &&
      !r.repairDateConfirmed
  );

  const handleConfirm = (resCode, date) => {
    if (!date) return;
    setReservations((prev) =>
      prev.map((r) =>
        r.resCode === resCode
          ? { ...r, returnDate: date, repairDateConfirmed: true }
          : r
      )
    );
    runWrite(supabase.from("reservations").update({ returnDate: date, repairDateConfirmed: true }).eq("resCode", resCode), "reservations update");
  };

  return React.createElement(
    "div",
    { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Unknown Repair Date"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(
      "section",
      { className: "dashboardSection" },
      React.createElement(
        "div",
        { className: "dashboardSection__header" },
        React.createElement(
          "div",
          { className: "dashboardSection__headerRow" },
          React.createElement("span", null, "Awaiting Confirmed Repair Date"),
          rows.length > 0 &&
            React.createElement(
              "span",
              { className: "aiTabDesc", style: { marginBottom: 0, marginLeft: 8 } },
              `${rows.length} reservation${rows.length !== 1 ? "s" : ""} pending`
            )
        )
      ),
      React.createElement(
        "div",
        { className: "dashboardSection__body" },
        rows.length === 0
          ? React.createElement(
              "div",
              { className: "resvEmpty" },
              "All repair dates have been confirmed."
            )
          : React.createElement(
              "table",
              { className: "dashboardTable" },
              React.createElement(
                "thead",
                null,
                React.createElement(
                  "tr",
                  null,
                  ["Customer", "Res Code", "Bodyshop / Dealership", "Confirm Repair Date"].map(
                    (col) => React.createElement("th", { key: col }, col)
                  )
                )
              ),
              React.createElement(
                "tbody",
                null,
                rows.map((row) =>
                  React.createElement(
                    "tr",
                    { key: row.resCode },
                    React.createElement("td", null, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.customer })),
                    React.createElement("td", null, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.resCode })),
                    React.createElement("td", null, row.sourceDetail || row.source),
                    React.createElement(
                      "td",
                      null,
                      React.createElement("input", {
                        type: "date",
                        className: "torDateInput",
                        defaultValue: "",
                        onChange: (e) => {
                          const val = e.target.value;
                          if (val) handleConfirm(row.resCode, val);
                        },
                      })
                    )
                  )
                )
              )
            )
      )
    )
  );
}

// ─── Fleet filter constants ────────────────────────────────────────────────────

const PROV_STATE_LIST = [
  { value: "All", label: "All Provinces / States" },
  // Canadian provinces
  { value: "NL", label: "NL - Newfoundland and Labrador" },
  { value: "NS", label: "NS - Nova Scotia" },
  { value: "NB", label: "NB - New Brunswick" },
  { value: "PE", label: "PE - Prince Edward Island" },
  { value: "QC", label: "QC - Quebec" },
  { value: "ON", label: "ON - Ontario" },
  { value: "MB", label: "MB - Manitoba" },
  { value: "SK", label: "SK - Saskatchewan" },
  { value: "AB", label: "AB - Alberta" },
  { value: "BC", label: "BC - British Columbia" },
  { value: "YT", label: "YT - Yukon" },
  { value: "NT", label: "NT - Northwest Territories" },
  { value: "NU", label: "NU - Nunavut" },
  // US states
  { value: "AK", label: "AK - Alaska" },
  { value: "AL", label: "AL - Alabama" },
  { value: "AR", label: "AR - Arkansas" },
  { value: "AZ", label: "AZ - Arizona" },
  { value: "CA", label: "CA - California" },
  { value: "CO", label: "CO - Colorado" },
  { value: "CT", label: "CT - Connecticut" },
  { value: "DC", label: "DC - Washington D.C." },
  { value: "DE", label: "DE - Delaware" },
  { value: "FL", label: "FL - Florida" },
  { value: "GA", label: "GA - Georgia" },
  { value: "HI", label: "HI - Hawaii" },
  { value: "IA", label: "IA - Iowa" },
  { value: "ID", label: "ID - Idaho" },
  { value: "IL", label: "IL - Illinois" },
  { value: "IN", label: "IN - Indiana" },
  { value: "KS", label: "KS - Kansas" },
  { value: "KY", label: "KY - Kentucky" },
  { value: "LA", label: "LA - Louisiana" },
  { value: "MA", label: "MA - Massachusetts" },
  { value: "MD", label: "MD - Maryland" },
  { value: "ME", label: "ME - Maine" },
  { value: "MI", label: "MI - Michigan" },
  { value: "MN", label: "MN - Minnesota" },
  { value: "MO", label: "MO - Missouri" },
  { value: "MS", label: "MS - Mississippi" },
  { value: "MT", label: "MT - Montana" },
  { value: "NC", label: "NC - North Carolina" },
  { value: "ND", label: "ND - North Dakota" },
  { value: "NE", label: "NE - Nebraska" },
  { value: "NH", label: "NH - New Hampshire" },
  { value: "NJ", label: "NJ - New Jersey" },
  { value: "NM", label: "NM - New Mexico" },
  { value: "NV", label: "NV - Nevada" },
  { value: "NY", label: "NY - New York" },
  { value: "OH", label: "OH - Ohio" },
  { value: "OK", label: "OK - Oklahoma" },
  { value: "OR", label: "OR - Oregon" },
  { value: "PA", label: "PA - Pennsylvania" },
  { value: "RI", label: "RI - Rhode Island" },
  { value: "SC", label: "SC - South Carolina" },
  { value: "SD", label: "SD - South Dakota" },
  { value: "TN", label: "TN - Tennessee" },
  { value: "TX", label: "TX - Texas" },
  { value: "UT", label: "UT - Utah" },
  { value: "VA", label: "VA - Virginia" },
  { value: "VT", label: "VT - Vermont" },
  { value: "WA", label: "WA - Washington" },
  { value: "WI", label: "WI - Wisconsin" },
  { value: "WV", label: "WV - West Virginia" },
  { value: "WY", label: "WY - Wyoming" },
];

// ─── Unit conversion ──────────────────────────────────────────────────────────
// Values are always STORED in the canonical unit (litres for tank size,
// kilometres for PM interval and odometer) so the gas charge maths and the PM
// threshold comparison never have to care what unit was typed. The toggles
// below only change how a number is displayed and entered.

const L_PER_GAL = 3.785411784;  // US liquid gallon
const KM_PER_MI = 1.609344;

const toDisplayUnits = (canonical, unit) => {
  if (canonical == null || canonical === "") return "";
  const n = parseFloat(canonical);
  if (!Number.isFinite(n)) return "";
  const converted = unit === "gal" ? n / L_PER_GAL
                  : unit === "mi"  ? n / KM_PER_MI
                  : n;
  // Trim float noise (50 / 3.785… * 3.785… must round-trip to 50, not 49.999997)
  return String(Math.round(converted * 100) / 100);
};

const toCanonicalUnits = (displayValue, unit) => {
  if (displayValue == null || String(displayValue).trim() === "") return null;
  const n = parseFloat(displayValue);
  if (!Number.isFinite(n)) return null;
  const canonical = unit === "gal" ? n * L_PER_GAL
                  : unit === "mi"  ? n * KM_PER_MI
                  : n;
  return Math.round(canonical * 100) / 100;
};

// Two-button unit switcher. Purely presentational: the caller keeps the
// canonical value in state and re-renders the input through toDisplayUnits.
function UnitToggle({ unit, setUnit, options }) {
  return React.createElement("span", { className: "unitToggle" },
    options.map((o) =>
      React.createElement("button", {
        key: o.value,
        type: "button",
        className: `unitToggleBtn${unit === o.value ? " unitToggleBtn--active" : ""}`,
        onClick: () => setUnit(o.value),
      }, o.label)
    )
  );
}

// The codes behind the Province / State dropdown, minus its "All" filter entry.
// Derived rather than retyped so the AI accepts exactly what the form offers.
const PROVINCE_CODES = PROV_STATE_LIST.filter((p) => p.value !== "All").map((p) => p.value);

const VOLUME_UNITS   = [{ value: "L",  label: "Litres" },   { value: "gal", label: "Gallons" }];
const DISTANCE_UNITS = [{ value: "km", label: "Kilometers" }, { value: "mi",  label: "Miles" }];

// ─── Preventative Maintenance gating ──────────────────────────────────────────
// PM is a flag (fleet.needsPm), not a status. A vehicle can be both
// 'Ready Returns' and PM-due at once, so it shows in both lists after a return.
//
// The moment staff advance it out of Ready Returns to a normal working status,
// PM takes over: the requested status is replaced with 'PM' so the vehicle
// cannot be handed out before it is serviced. It then lives only in the PM list
// until PM Complete clears the flag.
const PM_BLOCKED_STATUSES = ["Available", "Needs Cleaning", "Ready for Pickup"];

function resolvePmStatus(vehicle, requestedStatus) {
  if (!vehicle?.needsPm) return { status: requestedStatus, forced: false, message: null };
  if (!PM_BLOCKED_STATUSES.includes(requestedStatus)) {
    // Damaged / On Rent / PM are left alone: they are either more urgent or
    // already correct, and overriding them would hide a real problem.
    return { status: requestedStatus, forced: false, message: null };
  }
  return {
    status: "PM",
    forced: true,
    message: `${vehicle.plate} is due for preventative maintenance, so it has been set to PM instead of ${requestedStatus}. Use PM Complete on its detail page once serviced.`,
  };
}

// Soft block on renting out a vehicle that is due for preventative maintenance.
// Deliberately not a hard block: whether a flagged vehicle can still go out is
// an operator judgement, not something the system should decide. But it must
// never happen silently, and the safe choice is the default, since dismissing
// the dialog (Escape or Cancel) cancels the rental rather than allowing it.
//
// Overriding changes status only. needsPm is untouched, so the vehicle stays in
// the Preventative Maintenance list and in the reminder banner. PM Complete is
// still the only thing that clears the flag.
function confirmRentalDespitePm(vehicle) {
  if (!vehicle?.needsPm) return true;
  return window.confirm(
    `${vehicle.plate} is flagged for preventative maintenance.\n\n` +
    `It is due for service and should normally be sent to PM before going out again.\n\n` +
    `OK: rent it anyway. The PM flag stays on and the vehicle keeps showing under Preventative Maintenance.\n` +
    `Cancel: do not open the rental.`
  );
}

// ─── Shared write rules ──────────────────────────────────────────────────────
// These used to live inside React event handlers, which meant the command bar
// could reach the same tables without them. They are plain functions now so the
// UI and the AI executor apply one rule rather than two copies that drift.

// notesLog is not reliably an array. Some rows hold a JSON STRING instead, and
// the display code coerced anything non-array to [], which meant appending a
// note to such a row rewrote the log as a single entry and lost the history.
// Everything that reads notesLog goes through here.
function parseNotesLog(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* not JSON, fall through to empty rather than guessing */ }
  }
  return [];
}

// Statuses that mean the rental is over. Closing stamps the return time, so a
// closed agreement always carries when it came back.
const RA_CLOSING_STATUSES = ["close_pending", "closed"];

// The return timestamp written at the moment of close. Split out of
// CustomerPage so the command bar cannot close an agreement without it.
function raCloseStamp(now = new Date()) {
  let h = now.getHours();
  const m = now.getMinutes();
  const meridiem = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return {
    returnDate:     now.toISOString().slice(0, 10),
    returnTime:     String(h).padStart(2, "0") + String(m).padStart(2, "0"),
    returnMeridiem: meridiem,
  };
}

// Field rules for adding a vehicle. Every field is required. Returns the list of
// missing labels in form order plus a ready-to-show message, so the form and the
// command bar cannot disagree about what a complete vehicle looks like.
// Accepts canonical values: tankSizeLiters in litres, pmIntervalKm in km.
const VEHICLE_REQUIRED_FIELDS = [
  ["Plate Number",     "plate"],
  ["Province / State", "province"],
  ["Year",             "year"],
  ["Make",             "make"],
  ["Model",            "model"],
  ["Colour",           "colour"],
  ["Tank Size",        "tankSizeLiters"],
  ["Needs PM Every",   "pmIntervalKm"],
  ["Vehicle Class",    "vehicleClass"],
  ["VIN",              "vin"],
];

// The classes offered on the Add Vehicle form. Shared so the form, the AI and
// the validator cannot drift into offering different sets.
const FLEET_VEHICLE_CLASSES = [
  "Compact Car", "Regular Car", "Large Car",
  "Compact SUV", "Regular SUV", "Large SUV",
  "Minivan", "Truck",
];

// The classes a vehicle may be given: the company's own list once it has
// loaded, the built-in one otherwise. Kept in this block, and reading
// companyLists defensively, because the policy test runs these rules on their
// own, where that variable does not exist.
function fleetVehicleClasses() {
  const lists = typeof companyLists !== "undefined" ? companyLists : null;
  const mine = lists ? lists.vehicleClasses.filter((c) => c.active).map((c) => c.name) : [];
  return mine.length ? mine : FLEET_VEHICLE_CLASSES;
}

// A VIN is 17 characters by international standard (ISO 3779), and the letters
// I, O and Q are excluded from it precisely so they cannot be confused with the
// digits 1 and 0. Both of those are worth enforcing: the length catches a
// truncated paste, and the letter rule catches the O-for-zero typo that makes a
// VIN look right and match nothing.
//
// Stored uppercase, since that is the only form a VIN is ever written in.
const VIN_LENGTH  = 17;
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

const normalizeVin = (raw) => String(raw ?? "").trim().toUpperCase();

function validateVin(raw) {
  const vin = normalizeVin(raw);
  if (vin === "") return { ok: false, vin: "", error: "VIN is required." };
  if (vin.length !== VIN_LENGTH) {
    return {
      ok: false,
      vin,
      error: `A VIN is exactly ${VIN_LENGTH} characters. That one is ${vin.length}.`,
    };
  }
  if (!VIN_PATTERN.test(vin)) {
    return {
      ok: false,
      vin,
      error: "That VIN contains a character a VIN cannot have. VINs use letters and digits only, and never the letters I, O or Q.",
    };
  }
  return { ok: true, vin, error: null };
}

// Plate and VIN each identify one vehicle in the real world, so neither may be
// shared. The form checked only the plate, and only in its own submit handler,
// which is how three vehicles ended up carrying the same VIN and how the AI
// could add a second vehicle on an existing plate at all.
//
// `self` is the vehicle being edited, excluded so a vehicle never collides with
// itself when some other field is changed. Comparison is on the normalized
// forms, so "abc-123" and "ABC123" are recognised as the same plate.
function validateVehicleUniqueness(candidate, fleet, self) {
  const others = (fleet || []).filter((v) => {
    if (!self) return true;
    if (self.id != null && v.id != null) return String(v.id) !== String(self.id);
    return normalizePlate(v.plate) !== normalizePlate(self.plate);
  });

  const plate = normalizePlate(candidate?.plate);
  if (plate !== "") {
    const clash = others.find((v) => normalizePlate(v.plate) === plate);
    if (clash) {
      return { ok: false, field: "plate", error: "A vehicle with this plate already exists." };
    }
  }

  const vin = normalizeVin(candidate?.vin);
  if (vin !== "") {
    const clash = others.find((v) => normalizeVin(v.vin) === vin);
    if (clash) {
      return { ok: false, field: "vin", error: `That VIN is already on ${clash.plate}. A VIN identifies one vehicle, so no two can share it.` };
    }
  }

  return { ok: true, field: null, error: null };
}

const vehicleFieldLabel = (key) =>
  (VEHICLE_REQUIRED_FIELDS.find(([, k]) => k === key) || [key])[0];

// Never writable through the command bar. needsPm and lastPmOdometer are
// computed by resolvePmComplete from the reading on file, and currentOdometer is
// captured when a rental is returned. Typing any of the three rebaselines the
// service schedule to a number nobody measured, which is the one thing the PM
// logic cannot recover from. id and created_at are the row's identity.
const FLEET_PROTECTED_FIELDS = ["id", "created_at", "needsPm", "lastPmOdometer", "currentOdometer"];

// Field rules for editing a vehicle already in the fleet. Same ten fields the
// Add Vehicle form collects and the same per-field rules, but applied only to
// what was actually sent, since an edit names one or two fields rather than all
// ten. Blank is refused rather than treated as a clear: Add Vehicle requires
// every one of these, so emptying one would leave a vehicle the form itself
// would not have accepted.
function validateVehicleEdit(data, provinces) {
  const fields = Object.keys(data || {});
  if (!fields.length) return { ok: false, error: "No changes were given." };

  const blocked = fields.filter((f) => FLEET_PROTECTED_FIELDS.includes(f));
  if (blocked.length) {
    return {
      ok: false,
      error: `${blocked.join(" and ")} cannot be set directly. Preventative maintenance figures come from the vehicle's own odometer, recorded with PM Complete.`,
    };
  }

  // Walked in form order, not payload order, so the message names fields in the
  // same sequence validateVehicle does.
  const touched = VEHICLE_REQUIRED_FIELDS.map(([, k]) => k).filter((k) => fields.includes(k));

  const blank = touched.filter((k) => String(data[k] ?? "").trim() === "");
  if (blank.length) {
    const names = blank.map(vehicleFieldLabel);
    return {
      ok: false,
      error: names.length === 1
        ? `${names[0]} cannot be left blank.`
        : `These cannot be left blank: ${names.join(", ")}.`,
    };
  }

  const numbers = validateFleetNumerics(data);
  if (!numbers.ok) return numbers;

  if (touched.includes("year")) {
    const y = Number(String(data.year).trim());
    if (!Number.isInteger(y) || y < 1900 || y > 2100) {
      return { ok: false, error: "Year has to be a four digit year." };
    }
  }

  if (touched.includes("vehicleClass") && !fleetVehicleClasses().includes(String(data.vehicleClass).trim())) {
    return { ok: false, error: `Vehicle class has to be one of: ${fleetVehicleClasses().join(", ")}.` };
  }

  if (touched.includes("vin")) {
    const check = validateVin(data.vin);
    if (!check.ok) return { ok: false, error: check.error };
  }

  if (touched.includes("province") && provinces && provinces.length) {
    const p = String(data.province).trim().toUpperCase();
    if (!provinces.includes(p)) {
      return { ok: false, error: `${String(data.province).trim()} is not a province or state code. Use one of: ${provinces.join(", ")}.` };
    }
  }

  return { ok: true, error: null };
}

// The starting readings a vehicle is added with, required by the Add Vehicle
// form and the command bar alike: the customer app no longer takes readings at
// pickup, so a vehicle's first rental starts from these. currentOdometer is
// whole kilometres; currentFuelLevel is one of the fuel labels.
function validateStartingReadings(v) {
  const missing = [];
  const odo = String(v?.currentOdometer ?? "").trim();
  const fuel = String(v?.currentFuelLevel ?? "").trim();
  if (odo === "") missing.push("Current Odometer");
  if (fuel === "") missing.push("Current Fuel Level");
  if (missing.length) {
    return { ok: false, error: missing.length === 1 ? `${missing[0]} is required.` : `These fields are required: ${missing.join(", ")}.` };
  }
  const n = Number(odo);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Current odometer has to be a number of kilometres, zero or more." };
  if (!FUEL_LABELS.includes(fuel)) return { ok: false, error: `Current fuel level has to be one of: ${FUEL_LABELS.join(", ")}.` };
  return { ok: true, error: null, odometer: Math.round(n), fuelLevel: fuel };
}

function validateVehicle(v) {
  const missing = VEHICLE_REQUIRED_FIELDS
    .filter(([, key]) => String(v?.[key] ?? "").trim() === "")
    .map(([label]) => label);
  if (missing.length) {
    return {
      ok: false,
      missing,
      error: missing.length === 1
        ? `${missing[0]} is required.`
        : `These fields are required: ${missing.join(", ")}.`,
    };
  }
  // Both are canonical numbers by this point, so anything non-positive is a bad
  // value rather than a blank field.
  const tank = parseFloat(v.tankSizeLiters);
  const pm   = parseFloat(v.pmIntervalKm);
  if (!Number.isFinite(tank) || tank <= 0) return { ok: false, missing: [], error: "Tank size must be a positive number." };
  if (!Number.isFinite(pm)   || pm   <= 0) return { ok: false, missing: [], error: "Needs PM Every must be a positive number." };

  // Same rule the edit path applies, so the form and the AI cannot disagree
  // about what a VIN looks like.
  const vinCheck = validateVin(v.vin);
  if (!vinCheck.ok) return { ok: false, missing: [], error: vinCheck.error };

  return { ok: true, missing: [], error: null };
}

// Field rules for retiring a vehicle. The UI archives plate, disposal date and
// reason; a bare delete loses all of that, so both paths require them.
function validateRetirement(r) {
  const missing = [
    ["Disposal Date", "disposalDate"],
    ["Reason",        "reason"],
  ].filter(([, key]) => String(r?.[key] ?? "").trim() === "").map(([label]) => label);
  return missing.length
    ? { ok: false, missing, error: `Retiring a vehicle needs a ${missing.join(" and a ").toLowerCase()}.` }
    : { ok: true, missing: [], error: null };
}

// Field rules for a reservation. Deliberately short: a reservation is often
// taken over the phone with partial information, so this is the minimum that
// makes a row findable and actionable rather than everything on the form.
const RESERVATION_REQUIRED_FIELDS = [
  ["Customer",      "customer"],
  ["Pickup Date",   "date"],
  ["Pickup Time",   "time"],
  ["Location",      "location"],
  ["Vehicle Class", "vehicleClass"],
];

function validateReservation(r) {
  const missing = RESERVATION_REQUIRED_FIELDS
    .filter(([, key]) => String(r?.[key] ?? "").trim() === "")
    .map(([label]) => label);
  return missing.length
    ? {
        ok: false,
        missing,
        error: missing.length === 1
          ? `${missing[0]} is required.`
          : `These fields are required: ${missing.join(", ")}.`,
      }
    : { ok: true, missing: [], error: null };
}

// Tank size and PM interval are also editable on an existing vehicle, one field
// at a time, so they need a rule that checks only what was actually sent rather
// than demanding the whole vehicle. Values arriving here are already canonical
// (litres / kilometres); the unit conversion happens before this.
const FLEET_NUMERIC_FIELDS = [
  ["Tank Size",      "tankSizeLiters"],
  ["Needs PM Every", "pmIntervalKm"],
];

function validateFleetNumerics(data) {
  for (const [label, key] of FLEET_NUMERIC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(data || {}, key)) continue;
    const n = parseFloat(data[key]);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: `${label} must be a positive number.` };
    }
  }
  return { ok: true, error: null };
}

// What "PM Complete" means, in one place. The interval restarts from the current
// odometer reading and the flag clears, which is the only thing that releases a
// vehicle from the Preventative Maintenance list.
//
// Status is reset only when PM had taken it over. A vehicle still sitting in
// Ready Returns is left there for staff to finish the return normally.
function resolvePmComplete(vehicle) {
  if (!vehicle) {
    return { ok: false, patch: null, error: "That vehicle is not in the fleet." };
  }
  if (!vehicle.needsPm) {
    return { ok: false, patch: null, error: `${vehicle.plate} is not flagged for preventative maintenance, so there is nothing to record.` };
  }
  if (vehicle.currentOdometer == null) {
    return { ok: false, patch: null, error: "No odometer reading on file for this vehicle yet, so PM cannot be recorded. The odometer is captured when a rental is returned." };
  }
  const patch = { lastPmOdometer: vehicle.currentOdometer, needsPm: false };
  if (vehicle.status === "PM") patch.status = "Available";
  return { ok: true, patch, error: null };
}

// ─── Gas settings rules ──────────────────────────────────────────────────────
// The markup and the per-region price feed every automatic gas charge, so the
// settings page and the command bar validate them identically.
const GAS_SETTING_KEYS = ["gasMarkupPercent", "gasPrices"];

function validateGasMarkup(raw) {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, value: null, error: "The gas markup has to be a percentage of zero or more." };
  }
  return { ok: true, value: n, error: null };
}

function validateGasPrice(raw) {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, value: null, error: "a fuel price has to be a positive dollar amount per litre" };
  }
  return { ok: true, value: n, error: null };
}

// A price is only ever looked up by a vehicle's province, so one filed under a
// region no vehicle is in would sit there and never apply to anything. Both
// paths are limited to regions the fleet is actually in.
function validateGasPriceRegion(region, knownRegions) {
  const r = String(region ?? "").trim();
  if (!r) return { ok: false, region: null, error: "That price needs a region." };
  const hit = (knownRegions || []).find((k) => String(k).toLowerCase() === r.toLowerCase());
  if (!hit) {
    return {
      ok: false,
      region: null,
      error: `There is no ${r} region. Fuel prices can only be set for regions the fleet is in: ${(knownRegions || []).join(", ") || "none yet"}.`,
    };
  }
  return { ok: true, region: hit, error: null };
}

// Turns a settings payload into the list of app_settings writes it implies.
//
// gasPrices is MERGED into the current prices, never replaced. Sending the whole
// object would drop every region the model did not happen to mention, which is
// the same way a plain update to notesLog erases the earlier notes.
function resolveGasSettingsUpdate(data, currentPrices, knownRegions) {
  const keys = Object.keys(data || {});
  if (!keys.length) return { ok: false, writes: [], error: "No setting was given to change." };
  const unknown = keys.filter((k) => !GAS_SETTING_KEYS.includes(k));
  if (unknown.length) {
    return { ok: false, writes: [], error: `fleetr ai can only change these settings: ${GAS_SETTING_KEYS.join(", ")}.` };
  }

  const writes = [];
  if (keys.includes("gasMarkupPercent")) {
    const check = validateGasMarkup(data.gasMarkupPercent);
    if (!check.ok) return { ok: false, writes: [], error: check.error };
    writes.push(["gasMarkupPercent", check.value]);
  }
  if (keys.includes("gasPrices")) {
    const incoming = data.gasPrices;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return { ok: false, writes: [], error: 'Fuel prices are given per region, e.g. { "NL": 1.79 }.' };
    }
    const next = { ...(currentPrices || {}) };
    for (const [region, price] of Object.entries(incoming)) {
      const r = validateGasPriceRegion(region, knownRegions);
      if (!r.ok) return { ok: false, writes: [], error: r.error };
      const p = validateGasPrice(price);
      if (!p.ok) return { ok: false, writes: [], error: `For ${r.region}, ${p.error}.` };
      next[r.region] = p.value;
    }
    writes.push(["gasPrices", next]);
  }
  return { ok: true, writes, error: null };
}

// ─── Rental agreement lifecycle ──────────────────────────────────────────────
// The status lives on rental_agreements, not on reservations. The column of the
// same name on reservations is a stale mirror that gets overwritten from
// rental_agreements at load, so writing it directly looks like it worked and
// then silently reverts. Everything goes through syncRAStatus instead.
// In lifecycle order. validateRaStatus prints this list back on a refusal, so
// the order is what a person reads to understand the sequence.
const RA_STATUSES = ["reservation", "open_rental_agreement", "customer_return", "close_pending", "closed"];

function validateRaStatus(status) {
  const s = String(status ?? "").trim();
  if (!RA_STATUSES.includes(s)) {
    return { ok: false, status: null, error: `A rental agreement can only be set to: ${RA_STATUSES.join(", ")}.` };
  }
  return { ok: true, status: s, error: null };
}

const FLEET_STATUS_OPTS = [
  { value: "All",             label: "All Statuses",    bg: null,      fg: null      },
  { value: "Available",       label: "Available",        bg: "#d1fae5", fg: "#065f46" },
  { value: "Needs Cleaning",  label: "Needs Cleaning",   bg: "#fef3c7", fg: "#92400e" },
  { value: "Ready for Pickup",label: "Ready for Pickup", bg: "#fed7aa", fg: "#7c2d12" },
  { value: "PM",              label: "PM",               bg: "#ede9fe", fg: "#4c1d95" },
  { value: "Damaged",         label: "Damaged",          bg: "#fee2e2", fg: "#991b1b" },
  { value: "On Rent",         label: "On Rent",          bg: "#dbeafe", fg: "#1e3a8a" },
];

// ─── useFleetFilter hook ───────────────────────────────────────────────────────

function useFleetFilter(fleet) {
  const [plateFilt,    setPlateFilt]    = React.useState("");
  const [provinceFilt, setProvinceFilt] = React.useState("All");
  const [statusFilt,   setStatusFilt]   = React.useState("All");
  const [makeFilt,     setMakeFilt]     = React.useState("All");
  const [modelFilt,    setModelFilt]    = React.useState("All");

  const allMakes = React.useMemo(
    () => [...new Set(fleet.map((v) => v.make).filter(Boolean))].sort(),
    [fleet]
  );
  const allModels = React.useMemo(
    () => makeFilt !== "All"
      ? [...new Set(fleet.filter((v) => v.make === makeFilt).map((v) => v.model).filter(Boolean))].sort()
      : [],
    [fleet, makeFilt]
  );

  const filtered = React.useMemo(() =>
    fleet.filter((v) => {
      const extra = VEHICLE_EXTRA_DATA[v.plate] || {};
      if (plateFilt && !normalizePlate(v.plate).includes(normalizePlate(plateFilt))) return false;
      if (provinceFilt !== "All" && extra.province !== provinceFilt) return false;
      if (statusFilt !== "All" && v.status !== statusFilt) return false;
      if (makeFilt !== "All" && v.make !== makeFilt) return false;
      if (modelFilt !== "All" && v.model !== modelFilt) return false;
      return true;
    }),
    [fleet, plateFilt, provinceFilt, statusFilt, makeFilt, modelFilt]
  );

  const hasFilter = plateFilt !== "" || provinceFilt !== "All" || statusFilt !== "All" || makeFilt !== "All" || modelFilt !== "All";

  return {
    filtered,
    hasFilter,
    filterState: {
      plateFilt, setPlateFilt,
      provinceFilt, setProvinceFilt,
      statusFilt, setStatusFilt,
      makeFilt, setMakeFilt,
      modelFilt, setModelFilt,
      allMakes,
      allModels,
    },
  };
}

// ─── FleetFilterBar component ──────────────────────────────────────────────────

function FleetFilterBar({ filterState }) {
  const {
    plateFilt, setPlateFilt,
    provinceFilt, setProvinceFilt,
    statusFilt, setStatusFilt,
    makeFilt, setMakeFilt,
    modelFilt, setModelFilt,
    allMakes, allModels,
  } = filterState;

  return React.createElement(
    "div", { className: "fleetFilterBar" },
    React.createElement("input", {
      type: "text",
      className: "fleetFilterInput",
      placeholder: "Plate number",
      value: plateFilt,
      onChange: (e) => setPlateFilt(normalizePlate(e.target.value)),
    }),
    React.createElement(
      "select",
      { className: "fleetFilterSelect", value: provinceFilt, onChange: (e) => setProvinceFilt(e.target.value) },
      PROV_STATE_LIST.map((p) => React.createElement("option", { key: p.value, value: p.value }, p.label))
    ),
    React.createElement(
      "select",
      {
        className: "fleetFilterSelect",
        value: makeFilt,
        onChange: (e) => { setMakeFilt(e.target.value); setModelFilt("All"); },
      },
      React.createElement("option", { value: "All" }, "All Makes"),
      allMakes.map((m) => React.createElement("option", { key: m, value: m }, m))
    ),
    makeFilt !== "All" && React.createElement(
      "select",
      { className: "fleetFilterSelect", value: modelFilt, onChange: (e) => setModelFilt(e.target.value) },
      React.createElement("option", { value: "All" }, "All Models"),
      allModels.map((m) => React.createElement("option", { key: m, value: m }, m))
    )
  );
}

// ─── FleetVehiclesPage ─────────────────────────────────────────────────────────

function FleetVehiclesPage() {
  const { fleet, setFleet, rentalAgreements, guardAction } = React.useContext(AppContext);
  const { filtered, filterState } = useFleetFilter(fleet);

  // Status dropdown change: update fleet state immediately then persist
  const handleStatusChange = (vehicle, newStatus) => {
    const { status: finalStatus, forced, message } = resolvePmStatus(vehicle, newStatus);
    guardAction("vehicle.status", () => {
      setFleet((prev) => prev.map((fv) => fv.id === vehicle.id ? { ...fv, status: finalStatus } : fv));
      runWrite(supabase.from("fleet").update({ status: finalStatus }).eq("id", vehicle.id), "fleet status update");
      if (forced) window.alert(message);
    });
  };

  const [sectionCollapsed, setSectionCollapsed] = React.useState(false);
  const [fleetGroupCollapsed, setFleetGroupCollapsed] = React.useState({
    available: true, needsCleaning: true, readyReturns: true, pm: true, damaged: true, onRent: true,
  });
  const toggleFleetGroup = (key) =>
    setFleetGroupCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  // Winter Tires column: visible Nov 1 – Apr 30, hidden May 1 – Oct 31
  const _month = new Date().getMonth(); // 0=Jan … 11=Dec
  const showWinterTires = _month < 4 || _month >= 10;

  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Vehicles"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(FleetFilterBar, { filterState }),

    // Tank size is manual, so missing values are surfaced here rather than
    // failing quietly at return time as a skipped gas charge.
    (() => {
      const missing = fleet.filter((v) => v.tankSizeLiters == null);
      if (missing.length === 0) return null;
      return React.createElement("div", { className: "tankSizeBanner" },
        React.createElement("strong", null, `${missing.length} vehicle${missing.length === 1 ? "" : "s"} missing tank size: `),
        "gas charges can't be calculated automatically for ",
        missing.length === 1 ? "it" : "them",
        ". Set it on each vehicle's detail page: ",
        React.createElement("span", { className: "tankSizeBannerPlates" },
          missing.map((v) => v.plate).join(", ")
        )
      );
    })(),

    // Same treatment for a missing PM interval: without it the automatic
    // trigger can never fire for that vehicle.
    (() => {
      const missing = fleet.filter((v) => v.pmIntervalKm == null);
      if (missing.length === 0) return null;
      return React.createElement("div", { className: "tankSizeBanner" },
        React.createElement("strong", null, `${missing.length} vehicle${missing.length === 1 ? "" : "s"} missing a PM interval: `),
        "preventative maintenance won't be flagged automatically for ",
        missing.length === 1 ? "it" : "them",
        ". Set it on each vehicle's detail page: ",
        React.createElement("span", { className: "tankSizeBannerPlates" },
          missing.map((v) => v.plate).join(", ")
        )
      );
    })(),

    // Vehicles that came back already due for PM skip the Ready Returns queue,
    // because status is single-valued and PM takes precedence to stop the car
    // going straight back out. Surfaced here so that step is not silently lost.
    (() => {
      const duePm = fleet.filter((v) => v.needsPm);
      if (duePm.length === 0) return null;
      return React.createElement("div", { className: "pmBanner" },
        React.createElement("strong", null, `${duePm.length} vehicle${duePm.length === 1 ? "" : "s"} due for preventative maintenance: `),
        React.createElement("span", { className: "pmBannerPlates" }, duePm.map((v) => v.plate).join(", ")),
        ". ",
        duePm.length === 1 ? "It keeps its current status " : "They keep their current status ",
        "until moved on, then switches to PM automatically. Use PM Complete on the vehicle's detail page once serviced."
      );
    })(),

    React.createElement(
      "section",
      { className: "dashboardSection" },
      React.createElement(
        "div",
        { className: "dashboardSection__header" },
        React.createElement(
          "div",
          {
            className: "dashboardSection__headerRow",
            style: { cursor: "pointer" },
            onClick: () => setSectionCollapsed((c) => !c),
          },
          React.createElement("button", {
            type: "button",
            className: "sectionToggleCircle",
          }, sectionCollapsed ? "+" : "-"),
          React.createElement("span", null, "Vehicle Status")
        )
      ),
      !sectionCollapsed &&
        React.createElement(
          "div",
          { className: "dashboardSection__body" },
          (() => {
            const colSpan = 4 + (showWinterTires ? 1 : 0); // Plate + Vehicle + Class + Status + optional Winter Tires

            const fleetTable = (rows) =>
              React.createElement(
                "table",
                { className: "dashboardTable" },
                React.createElement("thead", null,
                  React.createElement("tr", null,
                    ["Plate", "Vehicle", "Class", "Status", ...(showWinterTires ? ["Winter Tires"] : [])].map((col) =>
                      React.createElement("th", { key: col }, col)
                    )
                  )
                ),
                React.createElement("tbody", null,
                  rows.length === 0
                    ? React.createElement("tr", null, React.createElement("td", { colSpan, style: { color: "#aaa", fontStyle: "italic" } }, "None"))
                    : rows.map((v) =>
                        React.createElement("tr", { key: v.id },
                          React.createElement("td", null, React.createElement(PlateLink, { plate: v.plate })),
                          React.createElement("td", null, `${v.make} ${v.model}`),
                          React.createElement("td", null, v.vehicleClass),
                          React.createElement("td", null,
                            React.createElement("select", {
                              className: "gasStatusSelect",
                              value: v.status || "",
                              onChange: (e) => handleStatusChange(v, e.target.value),
                            },
                              FLEET_STATUS_OPTS.filter((s) => s.value !== "All").map((s) =>
                                React.createElement("option", { key: s.value, value: s.value }, s.label)
                              )
                            )
                          ),
                          ...(showWinterTires ? [React.createElement("td", null, v.winterTires || "")] : [])
                        )
                      )
                )
              );

            const avail    = filtered.filter((v) => v.status === "Available");
            const cleaning = filtered.filter((v) => v.status === "Needs Cleaning");
            const pm     = filtered.filter((v) => v.needsPm);
            const damaged  = filtered.filter((v) => v.status === "Damaged");
            const onRent   = filtered.filter((v) => v.status === "On Rent");
            const filteredRR = filtered.filter((v) => v.status === "Ready Returns");

            const group = (label, cls, key, rows, children) =>
              React.createElement("div", { className: "fleetGroup" },
                React.createElement("div", {
                  className: `fleetGroupHeader fleetGroupHeader--${cls}`,
                  style: { cursor: "pointer" },
                  onClick: () => toggleFleetGroup(key),
                },
                  React.createElement("button", {
                    type: "button",
                    className: "fleetGroupToggle",
                  }, fleetGroupCollapsed[key] ? "+" : "−"),
                  React.createElement("span", null, label),
                  React.createElement("span", { className: "fleetGroupCount" }, rows.length)
                ),
                ...(fleetGroupCollapsed[key] ? [] : (children || [fleetTable(rows)]))
              );

            return React.createElement(React.Fragment, null,
              group("Available", "available", "available", avail),
              group("Needs Cleaning", "cleaning", "needsCleaning", cleaning),
              React.createElement("div", { className: "fleetGroup" },
                React.createElement("div", {
                  className: "fleetGroupHeader fleetGroupHeader--readyReturns",
                  style: { cursor: "pointer" },
                  onClick: () => toggleFleetGroup("readyReturns"),
                },
                  React.createElement("button", {
                    type: "button",
                    className: "fleetGroupToggle",
                  }, fleetGroupCollapsed.readyReturns ? "+" : "−"),
                  React.createElement("span", null, "Ready Returns"),
                  React.createElement("span", { className: "fleetGroupCount" }, filteredRR.length)
                ),
                ...(!fleetGroupCollapsed.readyReturns ? [
                  React.createElement("table", { className: "dashboardTable" },
                    React.createElement("thead", null,
                      React.createElement("tr", null,
                        ["Plate", "Vehicle", "Type", "Location"].map((col) =>
                          React.createElement("th", { key: col }, col)
                        )
                      )
                    ),
                    React.createElement("tbody", null,
                      filteredRR.length === 0
                        ? React.createElement("tr", null, React.createElement("td", { colSpan: 4, style: { color: "#aaa", fontStyle: "italic" } }, "None"))
                        : filteredRR.map((r) => {
                            const matchRA = (rentalAgreements || []).find((a) => a.plate === r.plate && RA_IN_READY_RETURNS.includes(a.rentalAgreementStatus));
                            const loc = matchRA?.returnVehicleLocation || "";
                            return React.createElement("tr", { key: r.id },
                              React.createElement("td", null, React.createElement(PlateLink, { plate: r.plate })),
                              React.createElement("td", null, `${r.make} ${r.model}`),
                              React.createElement("td", null, r.fileType || ""),
                              React.createElement("td", null, loc)
                            );
                          })
                    )
                  ),
                ] : [])
              ),
              group("Preventative Maintenance", "pm", "pm", pm),
              group("Damaged", "damaged", "damaged", damaged),
              group("On Rent", "onRent", "onRent", onRent)
            );
          })()
        )
    )
  );
}

// ─── FleetAdditionsPage ────────────────────────────────────────────────────────

function FleetAdditionsPage() {
  const { fleet, setFleet, guardAction, archivedVehicles, setArchivedVehicles, currentUser } = React.useContext(AppContext);
  const { filtered, filterState } = useFleetFilter(fleet);
  const [activeTab,  setActiveTab]  = React.useState("add");


  // tankSize / pmInterval are held in the CURRENTLY SELECTED display unit while
  // typing, and converted to canonical litres/km only at submit.
  const BLANK_ADD    = { plate: "", province: "NL", year: "", make: "", model: "", colour: "", vin: "", vehicleClass: defaultVehicleClass(FLEET_VEHICLE_CLASSES), tankSize: "", pmInterval: "", odometer: "", fuelLevel: "" };
  const [tankUnit, setTankUnit] = React.useState(fuelUnit);
  const [pmUnit,   setPmUnit]   = React.useState(distanceUnit);
  // Canonical litres / kilometres, kept alongside the displayed string so that
  // toggling units re-renders the number without ever rewriting the value.
  const [tankCanonical, setTankCanonical] = React.useState(null);
  const [pmCanonical,   setPmCanonical]   = React.useState(null);
  // The disposal date defaults to today, which is the answer almost every time
  // a vehicle is retired from the desk it is standing at.
  const BLANK_RETIRE = { plateId: "", disposalDate: isoOffset(0), reason: "" };
  const [addForm,    setAddForm]    = React.useState(BLANK_ADD);
  const [addError,   setAddError]   = React.useState("");
  const [addSuccess, setAddSuccess] = React.useState(false);
  const [retireForm, setRetireForm] = React.useState(BLANK_RETIRE);
  const [retireError,setRetireError]= React.useState("");

  const onAdd = (field, val) => { setAddForm((p) => ({ ...p, [field]: val })); setAddError(""); setAddSuccess(false); };

  const handleAddSubmit = (e) => {
    e.preventDefault();
    const plate = normalizePlate(addForm.plate);

    // Canonical values tracked alongside the inputs, so a unit toggle can't
    // have introduced rounding drift into what gets stored.
    const tankLiters = tankCanonical;
    const pmKm       = pmCanonical;

    // One rule, shared with the command bar. See validateVehicle.
    const candidate = {
      plate,
      province:       addForm.province,
      year:           addForm.year,
      make:           addForm.make,
      model:          addForm.model,
      colour:         addForm.colour,
      tankSizeLiters: tankLiters,
      pmIntervalKm:   pmKm,
      vehicleClass:   addForm.vehicleClass,
      vin:            normalizeVin(addForm.vin),
    };
    const check = validateVehicle(candidate);
    if (!check.ok) { setAddError(check.error); return; }
    // The starting readings. The customer app no longer takes them at pickup,
    // so a vehicle's first rental starts from these. Typed in the company's
    // distance unit, stored in whole kilometres.
    const odoTyped = String(addForm.odometer).trim();
    if (!/^\d+$/.test(odoTyped)) {
      setAddError(`Enter the current odometer as a whole number of ${distanceUnitWord()}.`);
      return;
    }
    if (!FUEL_LABELS.includes(addForm.fuelLevel)) {
      setAddError("Choose the current fuel level.");
      return;
    }
    const odometerKm = distanceToKm(Number(odoTyped));
    // Plate and VIN uniqueness, in the shared rule rather than inline here, so
    // the command bar enforces the same thing.
    const unique = validateVehicleUniqueness(candidate, fleet, null);
    if (!unique.ok) { setAddError(unique.error); return; }

    guardAction("vehicle.add", () => {
      const newVehicle = {
        plate, make: addForm.make, model: addForm.model,
        vehicleClass: addForm.vehicleClass || defaultVehicleClass(FLEET_VEHICLE_CLASSES),
        year: addForm.year || null,
        colour: addForm.colour || null,
        vin: candidate.vin,
        province: addForm.province || null,
        tankSizeLiters: tankLiters,
        pmIntervalKm: pmKm,
        lastPmOdometer: null,
        currentOdometer: odometerKm,
        currentFuelLevel: addForm.fuelLevel,
        winterTires: "No", status: "Needs Cleaning",
        currentRenter: null, dueBack: null, fileType: null,
      };
      setFleet((prev) => [...prev, newVehicle]);
      runWrite(supabase.from("fleet").insert(newVehicle).then((res) => { console.log("fleet insert response:", res); if (res.error) console.warn("fleet insert error:", res.error); }), "fleet insert");
      setAddForm(BLANK_ADD);
      setTankCanonical(null);
      setPmCanonical(null);
      setAddSuccess(true);
    }, { tableName: "fleet", recordId: plate, description: `Added ${addForm.year} ${addForm.make} ${addForm.model}, ${addForm.vehicleClass}, VIN ${candidate.vin}.` });
  };

  const handleRetireSubmit = (e) => {
    e.preventDefault();
    // The reason is no longer required. A mandatory free-text field that nobody
    // wants to fill gets filled with noise, and the archive is worse for it.
    if (!retireForm.plateId)     { setRetireError("Select a vehicle to retire."); return; }
    if (!retireForm.disposalDate) { setRetireError("A disposal date is required."); return; }
    const v = fleet.find((x) => x.id === retireForm.plateId);
    if (!v) { setRetireError("Vehicle not found."); return; }
    const extra  = VEHICLE_EXTRA_DATA[v.plate] || {};
    const reason = retireForm.reason.trim();
    // Everything the fleet row held, copied out before it is deleted. Prefer the
    // live row and fall back to the static extras, so a vehicle edited after it
    // was seeded archives what it actually became.
    const record = {
      plate:        v.plate,
      make:         v.make  || null,
      model:        v.model || null,
      year:         String(v.year ?? extra.year ?? "") || null,
      colour:       v.colour       || extra.colour   || null,
      province:     v.province     || extra.province || null,
      vin:          v.vin          || extra.vin      || null,
      vehicleClass: v.vehicleClass || null,
      disposalDate: retireForm.disposalDate,
      reason:       reason || null,
      retiredBy:    actorName(currentUser),
    };
    guardAction("vehicle.retire", async () => {
      // The archive is written FIRST and awaited. The fleet delete is what makes
      // this irreversible, so it must not run until the record that replaces it
      // is safely stored; the old order would have lost the vehicle outright if
      // the insert failed.
      const { data, error } = await supabase.from("archived_vehicles").insert(record);
      if (error) throw new Error(`archive failed, vehicle not retired: ${error.message}`);
      setArchivedVehicles((prev) => [...(data || [record]), ...prev]);
      setFleet((prev) => prev.filter((x) => x.id !== retireForm.plateId));
      runWrite(supabase.from("fleet").delete().eq("id", retireForm.plateId), "fleet delete");
      setRetireForm(BLANK_RETIRE);
    }, { tableName: "fleet", recordId: v.plate,
         description: `Retired ${v.make} ${v.model}. Disposal ${retireForm.disposalDate}${reason ? `, reason: ${reason}` : ""}.` });
  };

  const fmtDate = (iso) => {
    if (!iso) return "Not set";
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };

  const fi = (label, field, placeholder, type) =>
    React.createElement("div", { className: "addVehicleField" },
      React.createElement("label", { className: "addVehicleLabel" }, label),
      React.createElement("input", {
        type: type || "text", className: "addVehicleInput", placeholder, value: addForm[field],
        onChange: (e) => onAdd(field, e.target.value),
      })
    );

  // Numeric field with a unit switcher. The typed string is what the user sees;
  // setCanonical stores the converted value so the toggle can re-render the
  // number from it without a lossy string round trip.
  // No required marker: every field on this form is required, so singling any
  // one out would be misleading. Matches the Retire Vehicle form, which also
  // requires everything and simply says so on submit.
  const unitField = (label, field, placeholder, unit, setUnit, unitOpts, setCanonical) =>
    React.createElement("div", { className: "addVehicleField" },
      React.createElement("div", { className: "addVehicleLabelRow" },
        React.createElement("label", { className: "addVehicleLabel" }, label),
        React.createElement(UnitToggle, { unit, setUnit, options: unitOpts })
      ),
      React.createElement("input", {
        type: "number", min: "0", step: "0.1", className: "addVehicleInput",
        placeholder, value: addForm[field],
        onChange: (e) => {
          onAdd(field, e.target.value);
          setCanonical(toCanonicalUnits(e.target.value, unit));
        },
      })
    );

  // Switching units must never change the stored value. Converting the typed
  // string and writing it back drifts on every round trip (50 L -> 13.21 gal ->
  // 50.01 L), so the canonical number is kept separately and the displayed
  // string is re-derived from it instead.
  const switchUnit = (field, canonical, toUnit, setUnit) => {
    setUnit(toUnit);
    onAdd(field, canonical == null ? "" : toDisplayUnits(canonical, toUnit));
  };

  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Additions and Deletions"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(FleetFilterBar, { filterState }),
    React.createElement("div", { className: "aiSubTabs" },
      [{ key: "add", label: "Add Vehicle" }, { key: "retire", label: "Retire Vehicle" }].map(({ key, label }) =>
        React.createElement("button", {
          key, type: "button",
          className: `aiSubTab${activeTab === key ? " aiSubTab--active" : ""}`,
          onClick: () => setActiveTab(key),
        }, label)
      )
    ),

    activeTab === "add" && React.createElement(
      "section", { className: "dashboardSection" },
      React.createElement("div", { className: "dashboardSection__header" },
        React.createElement("div", { className: "dashboardSection__headerRow" }, React.createElement("span", null, "Add Vehicle to Fleet"))
      ),
      React.createElement("div", { className: "dashboardSection__body" },
        React.createElement("form", { className: "addVehicleForm", onSubmit: handleAddSubmit },
          React.createElement("div", { className: "addVehicleGrid" },
            React.createElement("div", { className: "addVehicleField" },
              React.createElement("label", { className: "addVehicleLabel" }, "Plate Number"),
              React.createElement("input", {
                type: "text", className: "addVehicleInput", placeholder: "e.g. ABC123",
                value: addForm.plate,
                onChange: (e) => onAdd("plate", normalizePlate(e.target.value)),
              })
            ),
            React.createElement("div", { className: "addVehicleField" },
              React.createElement("label", { className: "addVehicleLabel" }, "Province / State"),
              React.createElement("select", { className: "addVehicleInput", value: addForm.province, onChange: (e) => onAdd("province", e.target.value) },
                PROV_STATE_LIST.filter((p) => p.value !== "All").map((p) => React.createElement("option", { key: p.value, value: p.value }, p.value))
              )
            ),
            fi("Year",   "year",   "e.g. 2024"),
            fi("Make",   "make",   "e.g. Toyota"),
            fi("Model",  "model",  "e.g. Corolla"),
            fi("Colour", "colour", "e.g. White"),
            unitField("Tank Size", "tankSize",
              tankUnit === "L" ? "e.g. 50, needed for gas charges" : "e.g. 13, needed for gas charges",
              tankUnit, (u) => switchUnit("tankSize", tankCanonical, u, setTankUnit),
              VOLUME_UNITS, setTankCanonical),
            unitField("Needs PM Every", "pmInterval",
              pmUnit === "km" ? "e.g. 8000" : "e.g. 5000",
              pmUnit, (u) => switchUnit("pmInterval", pmCanonical, u, setPmUnit),
              DISTANCE_UNITS, setPmCanonical),
            fi(`Current Odometer (${distanceUnit()})`, "odometer", distanceUnit() === "mi" ? "e.g. 26000" : "e.g. 42000"),
            React.createElement("div", { className: "addVehicleField" },
              React.createElement("label", { className: "addVehicleLabel" }, "Current Fuel Level"),
              React.createElement("select", { className: "addVehicleInput", value: addForm.fuelLevel, onChange: (e) => onAdd("fuelLevel", e.target.value) },
                React.createElement("option", { value: "" }, "Choose"),
                FUEL_LABELS.map((f) => React.createElement("option", { key: f, value: f }, f))
              )
            ),
            React.createElement("div", { className: "addVehicleField" },
              React.createElement("label", { className: "addVehicleLabel" }, "Vehicle Class"),
              React.createElement("select", { className: "addVehicleInput", value: addForm.vehicleClass, onChange: (e) => onAdd("vehicleClass", e.target.value) },
                vehicleClassOptions(FLEET_VEHICLE_CLASSES, addForm.vehicleClass).map((vc) =>
                  React.createElement("option", { key: vc, value: vc }, vc)
                )
              )
            ),
            React.createElement("div", { className: "addVehicleField addVehicleField--full" },
              React.createElement("label", { className: "addVehicleLabel" }, "VIN"),
              React.createElement("input", {
                type: "text", className: "addVehicleInput", placeholder: "17-character VIN",
                value: addForm.vin, onChange: (e) => onAdd("vin", e.target.value),
              })
            )
          ),
          addError   && React.createElement("div", { className: "addVehicleError"   }, addError),
          addSuccess && React.createElement("div", { className: "addVehicleSuccess" }, "Vehicle added to fleet."),
          React.createElement("button", { type: "submit", className: "addVehicleBtn" }, "Add to Fleet")
        )
      )
    ),

    activeTab === "retire" && React.createElement(
      React.Fragment, null,
      React.createElement("section", { className: "dashboardSection" },
        React.createElement("div", { className: "dashboardSection__header" },
          React.createElement("div", { className: "dashboardSection__headerRow" }, React.createElement("span", null, "Retire Vehicle"))
        ),
        React.createElement("div", { className: "dashboardSection__body" },
          React.createElement("form", { className: "addVehicleForm", onSubmit: handleRetireSubmit },
            React.createElement("div", { className: "addVehicleGrid" },
              React.createElement("div", { className: "addVehicleField" },
                React.createElement("label", { className: "addVehicleLabel" }, "Vehicle"),
                React.createElement("select", {
                  className: "addVehicleInput", value: retireForm.plateId,
                  onChange: (e) => { setRetireForm((p) => ({ ...p, plateId: e.target.value })); setRetireError(""); },
                },
                  React.createElement("option", { value: "" }, filtered.length === fleet.length ? "Select vehicle" : `${filtered.length} of ${fleet.length} shown`),
                  filtered.map((v) => React.createElement("option", { key: v.id, value: v.id }, `${v.plate}, ${v.make} ${v.model}`))
                )
              ),
              React.createElement("div", { className: "addVehicleField" },
                React.createElement("label", { className: "addVehicleLabel" }, "Disposal Date"),
                React.createElement("input", {
                  type: "date", className: "addVehicleInput", value: retireForm.disposalDate,
                  onChange: (e) => { setRetireForm((p) => ({ ...p, disposalDate: e.target.value })); setRetireError(""); },
                })
              ),
              React.createElement("div", { className: "addVehicleField addVehicleField--full" },
                React.createElement("label", { className: "addVehicleLabel" }, "Reason for Retirement (optional)"),
                React.createElement("input", {
                  type: "text", className: "addVehicleInput", placeholder: "e.g. High mileage, Collision write-off",
                  value: retireForm.reason,
                  onChange: (e) => { setRetireForm((p) => ({ ...p, reason: e.target.value })); setRetireError(""); },
                })
              )
            ),
            retireError && React.createElement("div", { className: "addVehicleError" }, retireError),
            React.createElement("button", { type: "submit", className: "addVehicleBtn addVehicleBtn--retire" }, "Retire Vehicle")
          )
        )
      ),
      archivedVehicles.length > 0 && React.createElement(
        "section", { className: "dashboardSection", style: { marginTop: "20px" } },
        React.createElement("div", { className: "dashboardSection__header" },
          React.createElement("div", { className: "dashboardSection__headerRow" }, React.createElement("span", null, "Archived Vehicles"))
        ),
        React.createElement("div", { className: "dashboardSection__body" },
          React.createElement("table", { className: "dashboardTable" },
            React.createElement("thead", null,
              React.createElement("tr", null,
                ["Plate", "Make", "Model", "Year", "Disposal Date", "Reason"].map((col) => React.createElement("th", { key: col }, col))
              )
            ),
            React.createElement("tbody", null,
              archivedVehicles.map((v) =>
                React.createElement("tr", { key: v.id },
                  React.createElement("td", null, v.plate.replace(/-/g, "")),
                  React.createElement("td", null, v.make),
                  React.createElement("td", null, v.model),
                  React.createElement("td", null, v.year),
                  React.createElement("td", null, fmtDate(v.disposalDate)),
                  React.createElement("td", null, v.reason)
                )
              )
            )
          )
        )
      )
    )
  );
}

// ─── FleetDamageClaimsPage ─────────────────────────────────────────────────────

function FleetDamageClaimsPage() {
  const { fleet, setOpenRentalAgreementId, damageClaims, setDamageClaims, reservations, rentalAgreements, guardAction } = React.useContext(AppContext);
  const navigate = useNavigate();
  const { filtered, filterState } = useFleetFilter(fleet);
  const filteredPlates = React.useMemo(() => new Set(filtered.map((v) => v.plate)), [filtered]);

  const CLAIM_CLS = {
    "Open":      "claimStatus claimStatus--open",
    "In Review": "claimStatus claimStatus--inReview",
    "Settled":   "claimStatus claimStatus--settled",
    "Closed":    "claimStatus claimStatus--settled",
  };

  // Claims without a plate are shown regardless of the current fleet filter.
  const allClaims = damageClaims
    .filter((c) => !c.plate || filteredPlates.has(c.plate))
    .map((c) => enrichDamageClaim(c, rentalAgreements, reservations));

  const openClaims   = allClaims.filter((c) => c._status !== "resolved");
  const closedClaims = allClaims.filter((c) => c._status === "resolved");

  const handleResolve = (claim) => {
    guardAction("damage.resolve", () => {
      const now = new Date().toISOString();
      setDamageClaims((prev) =>
        prev.map((c) => c.id === claim.id ? { ...c, status: "resolved", resolvedAt: now, updatedAt: now } : c)
      );
      supabase.from("damage_claims").update({ status: "resolved", resolvedAt: now, updatedAt: now }).eq("id", claim.id).then(({ error }) => {
        if (error) console.warn("damage_claims update failed:", claim.id, error);
      }).catch((e) => console.warn("damage_claims update:", e));
    }, { tableName: "damage_claims", recordId: claim.resCode || claim.id, description: `Damage claim marked resolved${claim.plate ? ` on ${claim.plate}` : ""}.` });
  };

  const renderTable = (claims, showResolve) =>
    React.createElement("table", { className: "dashboardTable" },
      React.createElement("thead", null,
        React.createElement("tr", null,
          [...["Plate", "Vehicle", "Customer", "Res Code", "Damage Description", "Status", "Rentable"],
           ...(showResolve ? ["Action"] : [])].map((col) =>
            React.createElement("th", { key: col }, col)
          )
        )
      ),
      React.createElement("tbody", null,
        claims.map((c) =>
          React.createElement("tr", { key: c.id },
            React.createElement("td", null,
              c.plate
                ? React.createElement(PlateLink, { plate: c.plate })
                : "—"
            ),
            React.createElement("td", null, c.vehicle),
            React.createElement("td", null,
              React.createElement("button", {
                type: "button", className: "rentalAgreementLink rentalAgreementLink--dark",
                onClick: () => { setOpenRentalAgreementId(c.resCode); navigate("/rental-agreements"); },
              }, c.customer)
            ),
            React.createElement("td", null,
              React.createElement("button", {
                type: "button", className: "rentalAgreementLink rentalAgreementLink--dark",
                onClick: () => { setOpenRentalAgreementId(c.resCode); navigate("/rental-agreements"); },
              }, c.resCode)
            ),
            React.createElement("td", null, c.description),
            React.createElement("td", null,
              React.createElement("span", { className: CLAIM_CLS[c.claimStatus] || "claimStatus" }, c.claimStatus)
            ),
            React.createElement("td", null, vehicleRentableLabel(c.vehicleRentable)),
            showResolve && React.createElement("td", null,
              React.createElement("button", {
                type: "button",
                className: "resolveClaimBtn",
                onClick: () => handleResolve(c),
              }, "Mark as Resolved")
            )
          )
        )
      )
    );

  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Ongoing Damage Claims"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(FleetFilterBar, { filterState }),
    React.createElement(
      "section", { className: "dashboardSection" },
      React.createElement("div", { className: "dashboardSection__header" },
        React.createElement("div", { className: "dashboardSection__headerRow" },
          React.createElement("span", null, "Active Claims"),
          React.createElement("span", { className: "aiTabDesc", style: { marginBottom: 0, marginLeft: 8 } }, `${openClaims.length} active`)
        )
      ),
      React.createElement("div", { className: "dashboardSection__body" },
        openClaims.length === 0
          ? React.createElement("div", { className: "resvEmpty" }, "No active damage claims.")
          : renderTable(openClaims, true)
      )
    ),
    closedClaims.length > 0 && React.createElement(
      "section", { className: "dashboardSection", style: { marginTop: "20px" } },
      React.createElement("div", { className: "dashboardSection__header" },
        React.createElement("div", { className: "dashboardSection__headerRow" }, React.createElement("span", null, "Settled / Closed"))
      ),
      React.createElement("div", { className: "dashboardSection__body" }, renderTable(closedClaims, false))
    )
  );
}

// ─── GasCollectionsPage ───────────────────────────────────────────────────────

function GasCollectionsPage() {
  // Note: gas balances live on rental_agreements (gasOwed, gasCollected), not
  // reservations. reservations has no gas fields at all, and rental_agreements
  // has no "Partial" status, only a gasCollected boolean, so payment status
  // here is a plain Unpaid/Paid toggle rather than a three-state field.
  const { rentalAgreements, setRentalAgreements, guardAction } = React.useContext(AppContext);

  // Only show files with an outstanding balance (auto-removes when gasOwed hits 0)
  const rows = rentalAgreements.filter((a) => parseFloat(a.gasOwed || 0) > 0);

  // Every write on this page moves money, so both the amount field and the
  // paid toggle funnel through here and take the PIN.
  const updateRow = (id, patch, actionKey) => {
    guardAction(actionKey, () => {
      setRentalAgreements((prev) =>
        prev.map((a) => a.id === id ? { ...a, ...patch } : a)
      );
      supabase.from("rental_agreements").update(patch).eq("id", id).then(({ error }) => {
        if (error) console.warn("rental_agreements update failed:", id, error);
      }).catch((e) => console.warn("rental_agreements update:", e));
    });
  };

  const handleGasChange = (id, value) => {
    updateRow(id, { gasOwed: value }, "gas.amount");
  };

  const handleStatusChange = (id, value) => {
    // Marking as Paid zeros out the balance → triggers auto-removal
    updateRow(id, value === "Paid"
      ? { gasCollected: true, gasOwed: "0" }
      : { gasCollected: false }
    , "gas.collected");
  };

  return React.createElement("div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Gas Collections"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement("section", { className: "dashboardSection" },
      React.createElement("div", { className: "dashboardSection__body" },
        rows.length === 0
          ? React.createElement("div", { className: "resvEmpty" }, "No outstanding gas balances.")
          : React.createElement("table", { className: "dashboardTable" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  ["Customer", "Res Code", "Plate", "Gas Owed", "Payment Status"].map((col) =>
                    React.createElement("th", { key: col }, col)
                  )
                )
              ),
              React.createElement("tbody", null,
                rows.map((a) =>
                  React.createElement("tr", { key: a.id },
                    React.createElement("td", null,
                      React.createElement(CustomerLink, { name: a.customer, resCode: a.resCode, label: a.customer })
                    ),
                    React.createElement("td", null,
                      React.createElement(CustomerLink, { name: a.customer, resCode: a.resCode, label: a.resCode, hideBadge: true })
                    ),
                    React.createElement("td", null,
                      a.plate
                        ? React.createElement(PlateLink, { plate: a.plate })
                        : "—"
                    ),
                    React.createElement("td", null,
                      React.createElement("div", { className: "gasOwedWrap" },
                        React.createElement("span", { className: "gasOwedDollar" }, "$"),
                        React.createElement("input", {
                          type: "number",
                          className: "gasOwedInput",
                          value: a.gasOwed || "",
                          min: "0",
                          step: "0.01",
                          onChange: (e) => handleGasChange(a.id, e.target.value),
                        })
                      )
                    ),
                    React.createElement("td", null,
                      React.createElement("select", {
                        className: "gasStatusSelect",
                        value: a.gasCollected ? "Paid" : "Unpaid",
                        onChange: (e) => handleStatusChange(a.id, e.target.value),
                      },
                        ["Unpaid", "Paid"].map((opt) =>
                          React.createElement("option", { key: opt, value: opt }, opt)
                        )
                      )
                    )
                  )
                )
              )
          )
      )
    )
  );
}

// ─── ReportsPage ───────────────────────────────────────────────────────────────

function ReportsPage() {
  const SECTS = [
    { key: "daily",   title: "Daily Summary",          body: "Summarises the day’s rentals, returns, no-shows, and pre-rental check completions." },
    { key: "revenue", title: "Rental Revenue",         body: "Breakdown of rental revenue by file type (Retail, Insurance, Bodyshop/Dealership, Corporate) for the selected period." },
    { key: "util",    title: "Fleet Utilization",      body: "Utilisation rate per vehicle class and overall. Highlights idle vehicles and high-demand periods." },
    { key: "noshow",  title: "No-Show Report",         body: "No-show rate, AI call outcomes, and resolutions for the selected date range." },
    { key: "overdue", title: "Overdue Rentals Report", body: "All overdue rental agreements, including customer contact history and resolution status." },
  ];
  const [sect, setSect] = React.useState(Object.fromEntries(SECTS.map((s) => [s.key, true])));
  const toggle = (key) => setSect((p) => ({ ...p, [key]: !p[key] }));
  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Reports"),
    React.createElement("div", { className: "page__titleUnderline" }),
    SECTS.map(({ key, title, body }) =>
      React.createElement(
        "section", { key, className: "dashboardSection", style: { marginBottom: "16px" } },
        React.createElement("div", { className: "dashboardSection__header" },
          React.createElement("div", { className: "dashboardSection__headerRow" },
            React.createElement("span", null, title),
            React.createElement("button", { type: "button", className: "sectionToggleCircle", onClick: () => toggle(key) }, sect[key] ? "+" : "−")
          )
        ),
        !sect[key] && React.createElement("div", { className: "dashboardSection__body" },
          React.createElement("p", { className: "aiTabDesc", style: { marginBottom: 0 } }, body),
          React.createElement("div", { className: "resvEmpty", style: { marginTop: "16px" } }, "Report data will appear here.")
        )
      )
    )
  );
}

// ─── SettingsPage ──────────────────────────────────────────────────────────────

// ─── AuditLogPage ────────────────────────────────────────────────────────────
// Read only, deliberately. Nothing in the app writes here except guardAction,
// and an audit log staff can edit is not an audit log.
// Refusal reasons from set_staff_role and set_staff_active, turned into
// something a person can act on. not_found covers both "no such person" and
// "not at your branch": the database answers the same way for each on purpose,
// so this message must not distinguish them either.
// The old label was `role === "Admin" ? "Make Agent" : "Make Admin"`, written
// when Admin was the top. With Exec above it, an Exec's row offered "Make
// Admin", which is a demotion described as a promotion.
const roleToggleLabel = (role) =>
  role === "Exec"  ? "Make Admin" :
  role === "Admin" ? "Make Agent" : "Make Admin";

const STAFF_REASONS = {
  admin_only:     "Only an Admin can change staff.",
  exec_only:      "Only an Exec can do that.",
  not_yourself:   "You cannot change your own role, branch, PIN or status from here.",
  bad_role:       "That is not a role.",
  not_found:      "That person is not at this branch.",
  target_is_exec: "An Exec is not attached to a branch.",
  bad_location:   "That is not a branch of this company.",
  last_exec:      "This is the only Exec. Appoint another one first.",
  location_required: "Choose the branch they should move to.",
};

// The staff list and the join code live together because they are two halves of
// one job: the code is how somebody joins, this list is what happens to them
// afterwards. Splitting them across two screens means an Admin hands out a code
// and then goes looking for where the person turned up.
//
// Everything here is enforced in the database, not on this page. The Admin
// checks below decide what to RENDER; set_staff_role and set_staff_active make
// the same checks again and are the ones that matter. A page that hides a
// button is a page that can be edited in a browser console.
// Refusals from the company-wide RPCs. not_found covers both "no such branch"
// and "not your company", which the database answers identically on purpose.
const COMPANY_REASONS = {
  exec_only:      "Only an Exec can manage the company.",
  not_found:      "That branch is not part of this company.",
  bad_key:        "That setting cannot be changed from here.",
  bad_taxes:      "That did not work. Try again.",
  too_many_taxes: "A branch can have at most two taxes.",
  bad_tax_name:   "Give each tax a name of 1 to 20 characters.",
  bad_tax_rate:   "A tax rate is a percentage above 0 and below 100.",
  duplicate_tax:  "The two taxes need different names.",
  bad_name:       "Give the branch a name.",
  bad_code:       "A branch code is 2 to 8 letters or numbers.",
  code_required:  "A branch code is required.",
  code_taken:     "Another branch in this company already uses that code.",
  duplicate_name: "Another branch in this company already has that name.",
  is_default:     "This is where new staff start. Make another branch the default first.",
  has_staff:      "Move or deactivate this branch's staff before closing it.",
  last_location:  "This is the only open branch. A company needs one.",
  no_operator:    "This account is not attached to a company.",
  network:        "Could not reach the server.",
};

// The company screen. An Exec acts in one branch at a time, which is what keeps
// every tenant policy working unchanged; this is where the things that are
// genuinely about the company live instead.
//
// Everything here goes through operator-scoped RPCs. Nothing on this page reads
// or writes a table directly, because the table policies are correctly scoped
// to the acting branch and should stay that way.
// The address the current session was issued for. Needed to re-authenticate
// before a password change, and read from the session rather than rebuilt from
// the username so the two can never disagree.
function currentSessionEmail() {
  try {
    const sess = supabase.auth.session();
    return (sess && sess.user && sess.user.email) || "";
  } catch (e) { return ""; }
}

// Refusals from the account RPCs, plus the ones GoTrue produces.
const ACCOUNT_REASONS = {
  bad_email:         "Enter an email address you can actually receive mail at.",
  bad_pin:           "Your PIN must be 4 digits.",
  wrong_current_pin: "That is not your current PIN.",
  pin_failed:        "That PIN was not accepted.",
  not_signed_in:     "Your session has expired. Sign in again.",
  not_found:         "Could not load your account.",
  network:           "Could not reach the server.",
};

// Reachable by anyone signed in, whatever their role. Everything here is about
// the person, not the branch, which is why it is exempt from the branch guard:
// an Exec with no branch selected still has a password to change.
function AccountPage() {
  const { currentUser } = React.useContext(AppContext);
  const [account, setAccount] = React.useState(null);
  const [loadErr, setLoadErr] = React.useState("");

  const refresh = React.useCallback(async () => {
    const { data, error } = await supabase.rpc("my_account");
    if (error || !data || !data.ok) { setLoadErr("Could not load your account."); return; }
    setAccount(data);
  }, []);
  React.useEffect(() => { refresh(); }, [refresh]);

  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", null, "Your account"),
    loadErr && React.createElement("div", { className: "loginError" }, loadErr),

    React.createElement(
      "div", { className: "dashboardSection", style: { marginBottom: "24px" } },
      React.createElement("h2", null, "Who you are"),
      React.createElement("div", { style: { fontSize: "0.95rem", lineHeight: "1.9" } },
        React.createElement("div", null, `Username: ${account ? account.username : "…"}`),
        React.createElement("div", null, `Name: ${account ? account.name : "…"}`),
        React.createElement("div", null, `Role: ${account ? account.role : "…"}`)),
      React.createElement("div", { style: { opacity: 0.6, fontSize: "0.8rem", marginTop: "8px" } },
        "Your username and role are set by an Admin. Ask one if either is wrong.")
    ),

    React.createElement(ChangePassword),
    React.createElement(ChangePin, { hasPin: account && account.hasPin, onDone: refresh }),
    React.createElement(ChangeRecoveryEmail, { account, onDone: refresh })
  );
}

function ChangePassword() {
  const [current, setCurrent] = React.useState("");
  const [next,    setNext]    = React.useState("");
  const [again,   setAgain]   = React.useState("");
  const [msg,     setMsg]     = React.useState("");
  const [ok,      setOk]      = React.useState("");
  const [busy,    setBusy]    = React.useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(""); setOk("");
    if (next.length < PASSWORD_MIN) { setMsg(`Your new password must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`); return; }
    if (next !== again)   { setMsg("The two new passwords do not match."); return; }
    if (next === current) { setMsg("That is your current password."); return; }
    setBusy(true);
    // Re-authenticate first. supabase-js v1's update takes no current password,
    // so without this anyone who walks up to an unlocked terminal can change it.
    // Honest limitation: this is a check at the keyboard, not in the database.
    const who = currentSessionEmail();
    const { error: authErr } = await supabase.auth.signIn({ email: who, password: current });
    if (authErr) { setBusy(false); setMsg("That is not your current password."); return; }
    const { error } = await supabase.auth.update({ password: next });
    setBusy(false);
    if (error) { setMsg(error.message || "Could not change your password."); return; }
    setCurrent(""); setNext(""); setAgain("");
    setOk("Password changed. It applies the next time you sign in.");
  };

  return React.createElement(
    "div", { className: "dashboardSection", style: { marginBottom: "24px" } },
    React.createElement("h2", null, "Password"),
    React.createElement(
      "form", { onSubmit: submit, style: { display: "flex", flexDirection: "column", gap: "8px", maxWidth: "340px" } },
      React.createElement("input", { className: "resFormInput", type: "password", placeholder: "Current password", minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX,
        autoComplete: "current-password", value: current, onChange: (e) => { setCurrent(e.target.value); setMsg(""); } }),
      React.createElement("input", { className: "resFormInput", type: "password", placeholder: "New password", minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX,
        autoComplete: "new-password", value: next, onChange: (e) => { setNext(e.target.value); setMsg(""); } }),
      React.createElement("input", { className: "resFormInput", type: "password", placeholder: "New password again", minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX,
        autoComplete: "new-password", value: again, onChange: (e) => { setAgain(e.target.value); setMsg(""); } }),
      React.createElement("button", { className: "loginBtn", style: { width: "auto", padding: "8px 14px" }, disabled: busy },
        busy ? "Changing…" : "Change password"),
      msg && React.createElement("div", { className: "loginError" }, msg),
      ok  && React.createElement("div", { style: { color: "#3fbf7f", fontSize: "0.85rem" } }, ok)
    )
  );
}

function ChangePin({ hasPin, onDone }) {
  const [current, setCurrent] = React.useState("");
  const [next,    setNext]    = React.useState("");
  const [msg,     setMsg]     = React.useState("");
  const [ok,      setOk]      = React.useState("");
  const [busy,    setBusy]    = React.useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(""); setOk("");
    if (!/^[0-9]{4}$/.test(next)) { setMsg("Your PIN must be 4 digits."); return; }
    setBusy(true);
    const args = { new_pin: next };
    // Only sent when there is one to send. set_my_pin refuses a supplied
    // current PIN differently from a missing one, and an account with no PIN
    // has nothing to prove.
    if (hasPin) args.current_pin = current;
    const { data, error } = await supabase.rpc("set_my_pin", args);
    setBusy(false);
    if (error || !data || !data.ok) {
      setMsg(ACCOUNT_REASONS[data && data.reason] || "Could not change your PIN.");
      return;
    }
    setCurrent(""); setNext("");
    setOk(hasPin ? "PIN changed." : "PIN set.");
    onDone && onDone();
  };

  return React.createElement(
    "div", { className: "dashboardSection", style: { marginBottom: "24px" } },
    React.createElement("h2", null, hasPin ? "PIN" : "Set a PIN"),
    React.createElement("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
      hasPin
        ? "Confirms actions that are hard to undo. Keep it different from your password."
        : "You do not have a PIN yet, so actions that need one will ask you to set it. You can do that here instead."),
    React.createElement(
      "form", { onSubmit: submit, style: { display: "flex", flexDirection: "column", gap: "8px", maxWidth: "340px" } },
      hasPin && React.createElement("input", { className: "resFormInput", type: "password", inputMode: "numeric",
        maxLength: 4, placeholder: "Current PIN", value: current,
        onChange: (e) => { setCurrent(e.target.value.replace(/\D/g, "").slice(0, 4)); setMsg(""); } }),
      React.createElement("input", { className: "resFormInput", type: "password", inputMode: "numeric",
        maxLength: 4, placeholder: hasPin ? "New PIN" : "Choose a 4-digit PIN", value: next,
        onChange: (e) => { setNext(e.target.value.replace(/\D/g, "").slice(0, 4)); setMsg(""); } }),
      React.createElement("button", { className: "loginBtn", style: { width: "auto", padding: "8px 14px" }, disabled: busy },
        busy ? "Saving…" : (hasPin ? "Change PIN" : "Set PIN")),
      msg && React.createElement("div", { className: "loginError" }, msg),
      ok  && React.createElement("div", { style: { color: "#3fbf7f", fontSize: "0.85rem" } }, ok)
    )
  );
}

function ChangeRecoveryEmail({ account, onDone }) {
  const [addr, setAddr] = React.useState("");
  const [pin,  setPin]  = React.useState("");
  const [msg,  setMsg]  = React.useState("");
  const [ok,   setOk]   = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { setAddr((account && account.recoveryEmail) || ""); }, [account && account.recoveryEmail]);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(""); setOk("");
    setBusy(true);
    const { data, error } = await supabase.rpc("set_my_recovery_email", { new_email: addr, pin: pin });
    setBusy(false);
    if (error || !data || !data.ok) {
      setMsg(ACCOUNT_REASONS[data && data.reason] || "Could not change your recovery address.");
      return;
    }
    setPin("");
    setOk("Recovery address updated.");
    onDone && onDone();
  };

  const verified = account && account.recoveryEmailVerified;

  return React.createElement(
    "div", { className: "dashboardSection" },
    React.createElement("h2", null, "Recovery email"),
    React.createElement("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
      "The only real address we hold for you. Your login address is not a real mailbox, so this is how you get back in if you forget your password."),
    account && React.createElement("div", { style: { opacity: 0.7, fontSize: "0.85rem", marginBottom: "8px" } },
      account.recoveryEmail
        ? (verified ? "Confirmed." : "Not confirmed yet.")
        : "You have not set one."),
    account && account.recoveryEmail && !verified && React.createElement(
      "div", { style: { marginBottom: "12px" } },
      React.createElement("button", {
        type: "button", className: "loginBtn", style: { width: "auto", padding: "6px 12px" },
        onClick: (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          fetch(`${RESET_API_URL}/verify/request`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: account.username }),
          }).finally(() => { btn.textContent = "Sent, check your email"; });
        },
      }, "Send a confirmation link"),
      React.createElement("div", { style: { opacity: 0.6, fontSize: "0.78rem", marginTop: "6px" } },
        "Until it is confirmed this address cannot get you back into your account.")),
    React.createElement(
      "form", { onSubmit: submit, style: { display: "flex", flexDirection: "column", gap: "8px", maxWidth: "340px" } },
      React.createElement("input", { className: "resFormInput", type: "email", placeholder: "you@example.com",
        autoComplete: "email", value: addr, onChange: (e) => { setAddr(e.target.value); setMsg(""); } }),
      // PIN-gated because whoever can change this can later ask for a reset and
      // receive it. It is the back door, not a preference.
      React.createElement("input", { className: "resFormInput", type: "password", inputMode: "numeric",
        maxLength: 4, placeholder: "Your PIN", value: pin,
        onChange: (e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setMsg(""); } }),
      React.createElement("button", { className: "loginBtn", style: { width: "auto", padding: "8px 14px" }, disabled: busy },
        busy ? "Saving…" : "Update address"),
      msg && React.createElement("div", { className: "loginError" }, msg),
      ok  && React.createElement("div", { style: { color: "#3fbf7f", fontSize: "0.85rem" } }, ok)
    )
  );
}

function CompanyPage() {
  const { currentUser } = React.useContext(AppContext);
  const isExec = roleAtLeast(currentUser?.role, "Exec");

  const [branches, setBranches] = React.useState([]);
  const [gas,      setGas]      = React.useState([]);
  const [taxes,    setTaxes]    = React.useState([]);
  const [acting,   setActing]   = React.useState(null);
  const [busy,     setBusy]     = React.useState("");
  const [error,    setError]    = React.useState("");
  const [notice,   setNotice]   = React.useState("");

  const [newName, setNewName] = React.useState("");
  const [newCode, setNewCode] = React.useState("");

  const call = React.useCallback(async (fn, args) => {
    const { data, error: err } = await supabase.rpc(fn, args || {});
    if (err) return { ok: false, reason: "network", message: err.message };
    return data || { ok: false, reason: "empty" };
  }, []);

  const refresh = React.useCallback(async () => {
    const [ov, gs, act, tx] = await Promise.all([
      call("company_overview"), call("company_gas_settings"), call("my_acting_location"),
      call("company_sales_taxes"),
    ]);
    if (ov.ok)  setBranches(ov.branches || []);
    if (gs.ok)  setGas(gs.branches || []);
    if (tx.ok)  setTaxes(tx.branches || []);
    if (act.ok) setActing(act);
    if (!ov.ok) setError(COMPANY_REASONS[ov.reason] || "Could not load the company.");
  }, [call]);

  React.useEffect(() => { if (isExec) refresh(); }, [isExec, refresh]);

  const run = async (label, fn, args) => {
    setBusy(label); setError(""); setNotice("");
    const res = await call(fn, args);
    setBusy("");
    if (!res.ok) { setError(COMPANY_REASONS[res.reason] || res.message || "That did not work."); return false; }
    await refresh();
    return true;
  };

  if (!isExec) {
    return React.createElement(
      "div", { className: "page" },
      React.createElement("h1", null, "Company"),
      React.createElement("div", { className: "resvEmpty" },
        "This screen is for Execs. Your branch is managed from Staff and Settings.")
    );
  }

  const actingName = acting && acting.name;

  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", null, "Company"),
    error  && React.createElement("div", { className: "loginError" }, error),
    notice && React.createElement("div", { style: { color: "#3fbf7f", fontSize: "0.85rem", marginBottom: "12px" } }, notice),

    // ── Acting branch ──
    React.createElement(
      "div", { className: "dashboardSection", style: { marginBottom: "24px" } },
      React.createElement("h2", null, "Acting branch"),
      React.createElement("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
        actingName
          ? `You are working in ${actingName}. Reservations, fleet and settings all show that branch.`
          : "Choose a branch to work in. Until you do, the operational screens have nothing to show, because you are not standing in any branch."),
      React.createElement(
        "div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" } },
        React.createElement("select", {
          className: "resFormInput",
          style: { width: "auto" },
          value: (acting && acting.locationId) || "",
          onChange: (e) => run("acting", "set_acting_location", { location_id: e.target.value || null }),
        },
          React.createElement("option", { value: "" }, "No branch selected"),
          branches.filter((b) => b.active).map((b) =>
            React.createElement("option", { key: b.id, value: b.id }, b.name))
        ),
        busy === "acting" && React.createElement("span", { style: { opacity: 0.6, fontSize: "0.85rem" } }, "Switching…")
      )
    ),

    // ── Branches ──
    React.createElement(
      CompanySection, { title: "Branches", style: { marginBottom: "24px" } },
      React.createElement(
        "div", { style: { overflowX: "auto" } },
        React.createElement(
          "table", { className: "dashboardTable", style: { minWidth: "700px" } },
          React.createElement("thead", null, React.createElement("tr", null,
            ["Branch", "Code", "Staff", "Status", ""].map((h) => React.createElement("th", { key: h }, h)))),
          React.createElement("tbody", null, branches.map((b) =>
            React.createElement("tr", { key: b.id, style: b.active ? null : { opacity: 0.5 } },
              React.createElement("td", null, b.name,
                b.isDefault && React.createElement("span", {
                  style: { marginLeft: "8px", fontSize: "0.7rem", opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.08em" },
                }, "default")),
              React.createElement("td", null, b.code),
              React.createElement("td", null, String(b.staff)),
              React.createElement("td", null, b.active ? "Open" : "Closed"),
              React.createElement("td", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
                React.createElement("button", {
                  className: "loginBtn", style: { width: "auto", padding: "6px 10px" },
                  onClick: () => {
                    const name = window.prompt("New name for this branch", b.name);
                    if (name == null) return;
                    const code = window.prompt("Branch code (2 to 8 letters or numbers)", b.code || "");
                    if (code == null) return;
                    run("rename", "rename_location", { location_id: b.id, new_name: name, new_code: code });
                  },
                }, "Rename"),
                !b.isDefault && b.active && React.createElement("button", {
                  className: "loginBtn", style: { width: "auto", padding: "6px 10px" },
                  onClick: () => run("default", "set_default_location", { location_id: b.id }),
                }, "Make default"),
                b.active
                  ? React.createElement("button", {
                      className: "loginBtn", style: { width: "auto", padding: "6px 10px" },
                      // The refusals are the database's to make: a branch with
                      // staff, the default, or the last one open. Hiding the
                      // button would mean guessing all three here, and guessing
                      // wrong reads as the feature being broken.
                      onClick: () => run("close", "set_location_active", { location_id: b.id, is_active: false }),
                    }, "Close")
                  : React.createElement("button", {
                      className: "loginBtn", style: { width: "auto", padding: "6px 10px" },
                      onClick: () => run("open", "set_location_active", { location_id: b.id, is_active: true }),
                    }, "Reopen"))))))
      ),
      React.createElement(
        "div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "16px", alignItems: "center" } },
        React.createElement("input", {
          className: "resFormInput", style: { width: "auto" }, placeholder: "New branch name",
          value: newName, onChange: (e) => setNewName(e.target.value),
        }),
        React.createElement("input", {
          className: "resFormInput", style: { width: "110px" }, placeholder: "Code", maxLength: 8,
          value: newCode, onChange: (e) => setNewCode(e.target.value.toUpperCase()),
        }),
        React.createElement("button", {
          className: "loginBtn", style: { width: "auto", padding: "8px 14px" },
          onClick: async () => {
            if (await run("create", "create_location", { location_name: newName, location_code: newCode })) {
              setNewName(""); setNewCode(""); setNotice("Branch opened.");
            }
          },
        }, "Open a branch")
      )
    ),

    // ── Units ──
    React.createElement(CompanyUnitsSection, { onSaved: () => setNotice("Units saved.") }),

    // ── Pricing ──
    React.createElement(
      CompanySection, { title: "Fuel pricing" },
      React.createElement("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
        "Every branch at once. These two change what future customers are charged, so each edit is recorded against the branch it applies to, not the one you are acting in."),
      React.createElement(
        "div", { style: { overflowX: "auto" } },
        React.createElement(
          "table", { className: "dashboardTable", style: { minWidth: "620px" } },
          React.createElement("thead", null, React.createElement("tr", null,
            ["Branch", "Markup %", "Fuel prices", ""].map((h) => React.createElement("th", { key: h }, h)))),
          React.createElement("tbody", null, gas.filter((g) => g.active).map((g) =>
            React.createElement(GasRow, { key: g.locationId, row: g, busy, onSave: run }))))
      )
    ),

    // ── Sales tax ──
    React.createElement(
      CompanySection, { title: "Sales tax" },
      React.createElement("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
        "Up to two taxes per branch, each with a name and a rate, for example HST 15%, or GST 5% and PST 7%. They are added to every charge, and locked onto a rental agreement when the customer picks up, so a later change here does not reach rentals already out."),
      React.createElement(
        "div", { style: { overflowX: "auto" } },
        React.createElement(
          "table", { className: "dashboardTable", style: { minWidth: "620px" } },
          React.createElement("thead", null, React.createElement("tr", null,
            ["Branch", "First tax", "Second tax", ""].map((h) => React.createElement("th", { key: h }, h)))),
          React.createElement("tbody", null, taxes.filter((t) => t.active).map((t) =>
            React.createElement(SalesTaxRow, { key: t.locationId, row: t, busy, onSave: run }))))
      )
    ),

    // ── Lists and prices ──
    React.createElement(CompanyListsSections, { branches })
  );
}

// Its own component so each branch keeps its own draft. One shared draft object
// meant typing in one row and saving another wrote the wrong number into the
// wrong branch, which for a fuel price is a real charge to a real customer.
function GasRow({ row, busy, onSave }) {
  const [markup, setMarkup] = React.useState(
    row.gasMarkupPercent != null ? String(row.gasMarkupPercent) : "");
  const prices = row.gasPrices && typeof row.gasPrices === "object" ? row.gasPrices : {};

  return React.createElement(
    "tr", null,
    React.createElement("td", null, row.name),
    React.createElement("td", null,
      React.createElement("input", {
        className: "resFormInput", style: { width: "90px" },
        inputMode: "decimal", value: markup,
        onChange: (e) => setMarkup(e.target.value),
      })),
    React.createElement("td", { style: { fontSize: "0.85rem", opacity: 0.85 } },
      Object.keys(prices).length
        ? Object.entries(prices).map(([k, v]) => `${k} ${fuelPriceForDisplay(v) ?? v} / ${fuelUnit()}`).join("  ")
        : "—"),
    React.createElement("td", null,
      React.createElement("button", {
        className: "loginBtn", style: { width: "auto", padding: "6px 10px" },
        disabled: busy === "gas",
        onClick: () => {
          const n = Number(markup);
          if (!Number.isFinite(n) || n < 0) return;
          onSave("gas", "set_company_gas_setting", {
            location_id: row.locationId, setting_key: "gasMarkupPercent", setting_value: n,
          });
        },
      }, "Save"))
  );
}

// One branch's sales taxes. Its own component, for the reason GasRow is: each
// branch keeps its own draft. A tax with a blank name and rate is left out;
// both blank clears the branch's taxes. The database checks the rest.
function SalesTaxRow({ row, busy, onSave }) {
  const saved = Array.isArray(row.salesTaxes) ? row.salesTaxes : [];
  const toDraft = (t) => ({ name: t ? String(t.name ?? "") : "", rate: t && t.rate != null ? String(t.rate) : "" });
  const [drafts, setDrafts] = React.useState(() => [toDraft(saved[0]), toDraft(saved[1])]);
  const savedKey = JSON.stringify(saved);
  React.useEffect(() => { setDrafts([toDraft(saved[0]), toDraft(saved[1])]); }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (i, field, value) =>
    setDrafts((prev) => prev.map((d, j) => (j === i ? { ...d, [field]: value } : d)));

  const taxCell = (i) =>
    React.createElement("td", null,
      React.createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } },
        React.createElement("input", {
          className: "resFormInput", style: { width: "90px" }, placeholder: "Name", maxLength: 20,
          value: drafts[i].name, onChange: (e) => update(i, "name", e.target.value),
        }),
        React.createElement("input", {
          className: "resFormInput", style: { width: "70px" }, placeholder: "Rate", inputMode: "decimal",
          value: drafts[i].rate, onChange: (e) => update(i, "rate", e.target.value),
        }),
        React.createElement("span", { style: { opacity: 0.7 } }, "%")));

  return React.createElement(
    "tr", null,
    React.createElement("td", null, row.name),
    taxCell(0),
    taxCell(1),
    React.createElement("td", null,
      React.createElement("button", {
        className: "loginBtn", style: { width: "auto", padding: "6px 10px" },
        disabled: busy === "tax",
        onClick: () => {
          const list = drafts
            .filter((d) => d.name.trim() !== "" || d.rate.trim() !== "")
            .map((d) => ({ name: d.name.trim(), rate: d.rate.trim() === "" ? null : Number(d.rate) }));
          onSave("tax", "set_branch_sales_taxes", { p_location_id: row.locationId, p_taxes: list });
        },
      }, "Save"))
  );
}

// The company's fuel and distance units. Goes through set_company_units, which
// checks the role, takes the company from the caller's profile and writes the
// audit entry. Only what staff see changes: every stored figure stays in
// litres and kilometres.
const UNITS_REASONS = {
  exec_only:         "Only an Exec can change the units.",
  not_signed_in:     "You are signed out. Sign in again and retry.",
  bad_fuel_unit:     "Choose litres or US gallons.",
  bad_distance_unit: "Choose kilometres or miles.",
  not_found:         "This account is not attached to a company.",
  network:           "Could not reach the server.",
};

function CompanyUnitsSection({ onSaved }) {
  const [fuel,     setFuel]     = React.useState(fuelUnit);
  const [distance, setDistance] = React.useState(distanceUnit);
  const [busy,     setBusy]     = React.useState(false);
  const [error,    setError]    = React.useState("");
  const changed = fuel !== fuelUnit() || distance !== distanceUnit();

  const save = async () => {
    setBusy(true); setError("");
    const { data, error: err } = await supabase.rpc("set_company_units", { p_fuel: fuel, p_distance: distance });
    setBusy(false);
    if (err || !data || !data.ok) {
      setError(err ? UNITS_REASONS.network : (UNITS_REASONS[data && data.reason] || "That did not work."));
      return;
    }
    companyUnits = { fuel: data.fuelUnit, distance: data.distanceUnit };
    if (onSaved) onSaved();
  };

  const select = (label, value, setValue, options) =>
    React.createElement("label", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("select", {
        className: "resFormInput", style: { width: "auto" },
        value, disabled: busy, onChange: (e) => setValue(e.target.value),
      }, options.map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label))));

  return React.createElement(
    CompanySection, { title: "Units" },
    React.createElement("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
      "How every branch reads and enters fuel and distance: tank sizes, fuel prices, odometer readings, PM intervals and charges. Figures already on file are converted for display, never changed."),
    error && React.createElement("div", { className: "loginError" }, error),
    React.createElement("div", { style: { display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "flex-end" } },
      select("Fuel", fuel, setFuel, VOLUME_UNIT_OPTIONS),
      select("Distance", distance, setDistance, DISTANCE_UNIT_OPTIONS),
      React.createElement("button", {
        className: "loginBtn", style: { width: "auto", padding: "8px 14px" },
        disabled: busy || !changed, onClick: save,
      }, busy ? "Saving…" : "Save"))
  );
}

// ─── Company lists: the Exec's editing sections ──────────────────────────────
// Pickup locations, vehicle classes, sources, daily rates and protection
// products. Every change goes through the Exec-only functions in
// reference_data.sql, which check the role, take the company from the caller's
// profile and write the audit entry. Nothing here writes a table.
//
// After each change the lists are read again into companyLists, which is what
// the forms, the validator and the AI prompt read, so the rest of the app has
// the change the next time it draws, without a reload.
const LIST_REASONS = {
  exec_only:        "Only an Exec can change these lists.",
  not_signed_in:    "You are signed out. Sign in again and retry.",
  bad_name:         "Give it a name of 1 to 60 characters.",
  bad_code:         "A code is up to 8 letters or numbers, with no spaces.",
  not_found:        "That entry is not part of this company.",
  bad_branch:       "That branch is closed or is not part of this company.",
  duplicate_name:   "There is already an entry with that name.",
  code_taken:       "Another pickup location at this branch already uses that code.",
  bad_billing_type: "Choose a billing type.",
  bad_source:       "That source is not part of this company.",
  bad_class:        "That vehicle class is not part of this company.",
  bad_product:      "That protection product is not part of this company.",
  bad_amount:       "A price has to be a number from 0 to 99,999.",
  bad_kind:         "That list cannot be changed from here.",
  bad_active:       "That did not work. Try again.",
  network:          "Could not reach the server.",
  wording_too_long: "The customer wording is too long. Keep it to 600 characters.",
  decline_too_long: "The decline wording is too long. Keep it to 300 characters.",
  no_links:         "Links are not allowed in the wording.",
  bad_required:     "That did not work. Try again.",
  empty_body:       "The acknowledgements cannot be empty.",
  body_too_long:    "The acknowledgements are too long. Keep them to 4,000 characters.",
};

const BILLING_TYPE_LABELS = [
  ["insurance",           "Insurance"],
  ["bodyshop_dealership", "Bodyshop or dealership"],
  ["corporate",           "Corporate"],
  ["retail",              "Retail"],
];

// A section of the Company page. Closed until its header is tapped, so the
// page opens as a short list of headings rather than seven screens of tables.
// What is inside is only drawn while it is open.
function CompanySection({ title, style, children }) {
  const [open, setOpen] = React.useState(false);
  const toggle = () => setOpen((o) => !o);
  return React.createElement(
    "div", { className: "dashboardSection", style },
    React.createElement("h2", {
      role: "button", tabIndex: 0, "aria-expanded": open,
      style: { cursor: "pointer", userSelect: "none" },
      onClick: toggle,
      onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } },
    }, `${open ? "▾" : "▸"} ${title}`),
    open && children
  );
}

// One price in a grid. Keeps its own draft, for the reason GasRow does: a
// shared draft would let typing in one cell save into another. Saves when the
// cell is left, and only if it changed. Blank means no price.
function ListPriceCell({ value, disabled, onSave }) {
  const shown = value == null ? "" : String(value);
  const [draft, setDraft] = React.useState(shown);
  React.useEffect(() => { setDraft(shown); }, [shown]);
  return React.createElement(
    "span", { style: { display: "inline-flex", alignItems: "center", gap: "3px" } },
    React.createElement("span", { style: { opacity: 0.7 } }, "$"),
    React.createElement("input", {
      className: "resFormInput", style: { width: "62px", padding: "4px 6px" },
      inputMode: "decimal", value: draft, disabled,
      onChange: (e) => setDraft(e.target.value),
      onKeyDown: (e) => { if (e.key === "Enter") e.currentTarget.blur(); },
      onBlur: async () => {
        const typed = draft.trim();
        if (typed === shown) { setDraft(shown); return; }
        if (!(await onSave(typed))) setDraft(shown);
      },
    })
  );
}

// An entry's name, renamed where it stands: click it, type, Enter or Save.
// Escape or Cancel puts it back. A pickup location's code is edited with it.
function ListInlineName({ name, code, withCode, disabled, onSave }) {
  const [editing, setEditing] = React.useState(false);
  const [draft,   setDraft]   = React.useState(name);
  const [draftCode, setDraftCode] = React.useState(code || "");

  const start = () => {
    if (disabled) return;
    setDraft(name); setDraftCode(code || ""); setEditing(true);
  };
  const save = async () => {
    if (draft.trim() === name && (!withCode || draftCode.trim() === (code || ""))) { setEditing(false); return; }
    if (await onSave(draft, draftCode)) setEditing(false);
  };
  const onKeyDown = (e) => {
    if (e.key === "Enter")  { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
  };

  if (!editing) {
    return React.createElement("span", {
      role: "button", tabIndex: 0, title: "Click to rename",
      style: { cursor: "text" },
      onClick: start,
      onKeyDown: (e) => { if (e.key === "Enter") start(); },
    }, withCode && code ? `${name} (${code})` : name);
  }
  const small = { width: "auto", padding: "5px 9px" };
  return React.createElement(
    "span", { style: { display: "inline-flex", gap: "6px", flexWrap: "wrap", alignItems: "center" } },
    React.createElement("input", {
      className: "resFormInput", style: { width: "180px", padding: "5px 8px" }, maxLength: 60,
      autoFocus: true, value: draft, disabled, onKeyDown,
      onChange: (e) => setDraft(e.target.value),
    }),
    withCode && React.createElement("input", {
      className: "resFormInput", style: { width: "90px", padding: "5px 8px" }, maxLength: 8,
      placeholder: "Code", value: draftCode, disabled, onKeyDown,
      onChange: (e) => setDraftCode(e.target.value.toUpperCase()),
    }),
    React.createElement("button", { className: "loginBtn", style: small, disabled, onClick: save }, "Save"),
    React.createElement("button", { className: "loginBtn", style: small, disabled, onClick: () => setEditing(false) }, "Cancel")
  );
}

// The "add one" row under a list. Its own component so each list, and each
// branch and source within one, keeps its own draft.
function ListAddRow({ placeholder, label, withCode, withType, disabled, onAdd }) {
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [type, setType] = React.useState("");
  return React.createElement(
    "div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "10px", alignItems: "center" } },
    React.createElement("input", {
      className: "resFormInput", style: { width: "auto" }, placeholder, maxLength: 60,
      value: name, onChange: (e) => setName(e.target.value),
    }),
    withCode && React.createElement("input", {
      className: "resFormInput", style: { width: "110px" }, placeholder: "Code (optional)", maxLength: 8,
      value: code, onChange: (e) => setCode(e.target.value.toUpperCase()),
    }),
    withType && React.createElement("select", {
      className: "resFormInput", style: { width: "auto" },
      value: type, onChange: (e) => setType(e.target.value),
    },
      React.createElement("option", { value: "" }, "Billing type"),
      BILLING_TYPE_LABELS.map(([v, l]) => React.createElement("option", { key: v, value: v }, l))),
    React.createElement("button", {
      className: "loginBtn", style: { width: "auto", padding: "8px 14px" }, disabled,
      onClick: async () => {
        if (await onAdd(name, code, type)) { setName(""); setCode(""); setType(""); }
      },
    }, label)
  );
}

// What the customer reads about one protection product at pickup, edited the
// way Settings > Customer texts are: the preview until Edit is pressed, then
// the boxes with their character counts, Save and Cancel. Required is a
// switch beside it and saves on its own, keeping the wording as it is.
const PROTECTION_WORDING_MAX = 600;
const PROTECTION_DECLINE_MAX = 300;
const PROTECTION_DECLINE_DEFAULT = "I decline this protection and accept responsibility for the costs it would have covered.";

function ProtectionDetailsCard({ product, busy, onSave }) {
  const savedWording = product.customerWording || "";
  const savedDecline = product.declineWording || PROTECTION_DECLINE_DEFAULT;
  const [editing, setEditing] = React.useState(false);
  const [wording, setWording] = React.useState(savedWording);
  const [decline, setDecline] = React.useState(savedDecline);

  const w = wording.trim();
  const d = decline.trim();
  const wordingOver = w.length > PROTECTION_WORDING_MAX;
  const declineOver = d.length > PROTECTION_DECLINE_MAX;
  const unchanged = w === savedWording && (d || PROTECTION_DECLINE_DEFAULT) === savedDecline;

  const open = () => { setWording(savedWording); setDecline(savedDecline); setEditing(true); };
  const save = async () => {
    if (await onSave(w, d, !!product.required)) setEditing(false);
  };
  const el = React.createElement;

  return el("div", { style: { marginBottom: "22px", opacity: product.active ? 1 : 0.5 } },
    el("div", { className: "gasSettingSubhead" }, product.active ? product.name : `${product.name} (off)`),
    el("label", { style: { display: "inline-flex", alignItems: "center", gap: "8px", cursor: "pointer", margin: "4px 0 8px" } },
      el("input", {
        type: "checkbox", checked: !!product.required, disabled: busy,
        onChange: (e) => onSave(savedWording, savedDecline, e.target.checked),
      }),
      "Required: included with every rental it is priced for, with no Decline"),

    !editing && el(React.Fragment, null,
      el("p", { className: "closeRentalHint" }, "What the customer reads:"),
      el("div", { className: "closeRentalSummary" },
        savedWording || "No wording yet. The customer sees the name and price per day only."),
      !product.required && el(React.Fragment, null,
        el("p", { className: "closeRentalHint" }, "What the customer ticks to decline:"),
        el("div", { className: "closeRentalSummary" }, savedDecline)),
      el("div", { className: "closeRentalActions" },
        el("button", { type: "button", className: "resModalSubmit", disabled: busy, onClick: open }, "Edit"))),

    editing && el(React.Fragment, null,
      el("p", { className: "closeRentalHint" }, "What the customer reads. Leave it blank to show only the name and price per day."),
      el("textarea", {
        className: "resFormInput resFormTextarea", rows: 4, value: wording, autoFocus: true,
        "aria-label": `${product.name} customer wording`,
        onChange: (e) => setWording(e.target.value),
      }),
      el("p", { className: "closeRentalHint" }, `${w.length} of ${PROTECTION_WORDING_MAX} characters.`),
      wordingOver && el("div", { className: "closeRentalWarning" },
        `The wording is ${w.length - PROTECTION_WORDING_MAX} characters over the ${PROTECTION_WORDING_MAX} allowed and cannot be saved.`),

      el("p", { className: "closeRentalHint" }, "What the customer ticks to decline. Leave it blank for the default."),
      el("textarea", {
        className: "resFormInput resFormTextarea", rows: 2, value: decline,
        "aria-label": `${product.name} decline wording`,
        onChange: (e) => setDecline(e.target.value),
      }),
      el("p", { className: "closeRentalHint" }, `${d.length} of ${PROTECTION_DECLINE_MAX} characters.`),
      declineOver && el("div", { className: "closeRentalWarning" },
        `The decline wording is ${d.length - PROTECTION_DECLINE_MAX} characters over the ${PROTECTION_DECLINE_MAX} allowed and cannot be saved.`),

      el("div", { className: "gasSettingSubhead" }, "Preview"),
      el("div", { className: "closeRentalSummary" }, w || "No wording. The customer sees the name and price per day only."),
      !product.required && el("div", { className: "closeRentalSummary" }, d || PROTECTION_DECLINE_DEFAULT),

      el("div", { className: "closeRentalActions" },
        el("button", { type: "button", className: "resModalCancel", disabled: busy, onClick: () => setEditing(false) }, "Cancel"),
        el("button", {
          type: "button", className: "resModalSubmit",
          disabled: busy || unchanged || wordingOver || declineOver,
          onClick: save,
        }, busy ? "Saving..." : "Save")))
  );
}

// One row of deductibles: the company default, or one vehicle class's own.
// Keeps its own drafts, for the reason GasRow does. A blank amount clears it;
// on a class that means the company default applies.
function DeductibleRow({ label, collision, comprehensive, placeholder, busy, onSave }) {
  const shown = (v) => (v == null ? "" : String(Number(v)));
  const [coll, setColl] = React.useState(shown(collision));
  const [comp, setComp] = React.useState(shown(comprehensive));
  React.useEffect(() => { setColl(shown(collision)); setComp(shown(comprehensive)); }, [collision, comprehensive]); // eslint-disable-line react-hooks/exhaustive-deps
  const unchanged = coll.trim() === shown(collision) && comp.trim() === shown(comprehensive);
  const el = React.createElement;
  const money = (value, setValue, ph, name) =>
    el("span", { style: { display: "inline-flex", alignItems: "center", gap: "3px" } },
      el("span", { style: { opacity: 0.7 } }, "$"),
      el("input", {
        className: "resFormInput", style: { width: "100px" }, inputMode: "decimal",
        placeholder: ph, value, disabled: busy, "aria-label": `${label} ${name}`,
        onChange: (e) => setValue(e.target.value),
      }));
  return el("tr", null,
    el("td", { style: { fontWeight: 600 } }, label),
    el("td", null, money(coll, setColl, placeholder.collision, "collision")),
    el("td", null, money(comp, setComp, placeholder.comprehensive, "comprehensive")),
    el("td", null,
      el("button", {
        className: "loginBtn", style: { width: "auto", padding: "6px 10px" },
        disabled: busy || unchanged, onClick: () => onSave(coll.trim(), comp.trim()),
      }, "Save")));
}

// The contract acknowledgements: the current version as the customer will
// read it, an Edit that saves a new version, and every earlier version.
const CONTRACT_ACK_MAX = 4000;
function ContractAcknowledgementsCard({ versions, busy, onSave }) {
  const current = versions[0] || null;
  const [editing, setEditing] = React.useState(false);
  const [draft,   setDraft]   = React.useState("");
  const [shownVersion, setShownVersion] = React.useState(null);
  const el = React.createElement;
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
  };
  const body = (text) => el("div", { className: "closeRentalSummary", style: { whiteSpace: "pre-line" } }, text);
  const d = draft.trim();
  const over = d.length > CONTRACT_ACK_MAX;

  const open = () => { setDraft(current ? current.body : ""); setEditing(true); };
  const save = async () => { if (await onSave(d)) setEditing(false); };

  return el(React.Fragment, null,
    !editing && el(React.Fragment, null,
      el("p", { className: "closeRentalHint" },
        current ? `Version ${current.version}, saved ${when(current.createdAt)}. What the customer acknowledges:` : "No acknowledgements yet."),
      current && body(current.body),
      el("div", { className: "closeRentalActions" },
        el("button", { type: "button", className: "resModalSubmit", disabled: busy, onClick: open }, "Edit"))),

    editing && el(React.Fragment, null,
      el("p", { className: "closeRentalHint" },
        "One statement per line. Saving makes a new version; the earlier ones are kept exactly as they were."),
      el("textarea", {
        className: "resFormInput resFormTextarea", rows: 10, value: draft, autoFocus: true,
        "aria-label": "Contract acknowledgements", onChange: (e) => setDraft(e.target.value),
      }),
      el("p", { className: "closeRentalHint" }, `${d.length} of ${CONTRACT_ACK_MAX.toLocaleString("en-CA")} characters.`),
      over && el("div", { className: "closeRentalWarning" },
        `This is ${d.length - CONTRACT_ACK_MAX} characters over the ${CONTRACT_ACK_MAX.toLocaleString("en-CA")} allowed and cannot be saved.`),
      el("div", { className: "gasSettingSubhead" }, "Preview"),
      body(d || "Nothing yet."),
      el("div", { className: "closeRentalActions" },
        el("button", { type: "button", className: "resModalCancel", disabled: busy, onClick: () => setEditing(false) }, "Cancel"),
        el("button", {
          type: "button", className: "resModalSubmit",
          disabled: busy || !d || over || (current && d === current.body),
          onClick: save,
        }, busy ? "Saving..." : "Save as a new version"))),

    versions.length > 1 && el(React.Fragment, null,
      el("div", { className: "gasSettingSubhead", style: { marginTop: "18px" } }, "Version history"),
      versions.slice(1).map((v) => el("div", { key: v.id, style: { marginBottom: "8px" } },
        el("button", {
          type: "button", className: "loginBtn", style: { width: "auto", padding: "6px 10px" },
          onClick: () => setShownVersion(shownVersion === v.id ? null : v.id),
        }, `${shownVersion === v.id ? "\u25be" : "\u25b8"} Version ${v.version}, saved ${when(v.createdAt)}`),
        shownVersion === v.id && body(v.body))))
  );
}

function CompanyListsSections({ branches }) {
  const { currentUser } = React.useContext(AppContext);
  const [ready,  setReady]  = React.useState(false);
  const [busy,   setBusy]   = React.useState(false);
  // { at, text }: a refusal is shown in the section it happened in.
  const [error,  setError]  = React.useState(null);
  const [prices, setPrices] = React.useState([]);
  const [driverPrices, setDriverPrices] = React.useState([]);
  const [deductibles,  setDeductibles]  = React.useState(null);
  const [overrides,    setOverrides]    = React.useState([]);
  const [ackVersions,  setAckVersions]  = React.useState([]);
  const [, setDrawn] = React.useState(0);
  // Which sources are expanded to show their specific sources.
  const [openSources, setOpenSources] = React.useState({});
  // "kind:id" of the entry whose Delete is waiting to be confirmed.
  const [confirming, setConfirming] = React.useState("");
  // The product whose price grid is on screen.
  const [priceProduct, setPriceProduct] = React.useState("");
  // { listKey, from, over } while a row is being dragged.
  const [drag, setDrag] = React.useState(null);
  const dragRef = React.useRef(null);

  const reload = React.useCallback(async () => {
    await loadCompanyLists(currentUser);
    const op = currentUser?.operatorId ?? null;
    const [pp, odp, cd, dov, ack] = await Promise.all([
      supabase.from("protection_prices").select("productId,vehicleClassId,sourceId,amount").eq("operatorId", op),
      supabase.from("other_driver_prices").select("vehicleClassId,sourceId,amount").eq("operatorId", op),
      supabase.from("company_deductibles").select("collision,comprehensive").eq("operatorId", op).maybeSingle(),
      supabase.from("deductible_overrides").select("vehicleClassId,collision,comprehensive").eq("operatorId", op),
      supabase.from("contract_acknowledgements").select("id,version,body,createdAt").eq("operatorId", op)
        .order("version", { ascending: false }),
    ]);
    if (!pp.error)  setPrices(pp.data || []);
    if (!odp.error) setDriverPrices(odp.data || []);
    if (!cd.error)  setDeductibles(cd.data || null);
    if (!dov.error) setOverrides(dov.data || []);
    if (!ack.error) setAckVersions(ack.data || []);
    setReady(true);
    setDrawn((n) => n + 1);
  }, [currentUser]);

  React.useEffect(() => { reload(); }, [reload]);

  const refusal = (data, err) =>
    err ? LIST_REASONS.network : (LIST_REASONS[data && data.reason] || "That did not work.");

  const act = async (at, fn, args) => {
    setBusy(true); setError(null);
    const { data, error: err } = await supabase.rpc(fn, args);
    const ok = !err && !!(data && data.ok);
    if (ok) await reload(); else setError({ at, text: refusal(data, err) });
    setBusy(false);
    return ok;
  };

  // Moves one entry to a new place, then renumbers whatever is out of step, so
  // the order holds however the numbers stood before.
  const reorderTo = async (at, list, from, to, saveCall) => {
    if (from === to || to < 0 || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setBusy(true); setError(null);
    for (let i = 0; i < next.length; i++) {
      if (next[i].sortOrder === i + 1) continue;
      const [fn, args] = saveCall(next[i], i + 1);
      const { data, error: err } = await supabase.rpc(fn, args);
      if (err || !(data && data.ok)) { setError({ at, text: refusal(data, err) }); break; }
    }
    await reload();
    setBusy(false);
  };

  // Dragging is done with pointer events rather than the browser's own drag
  // and drop, which does nothing on a touch screen. The handle takes the
  // press; the row under the pointer when it lifts is where the entry lands.
  const startDrag = (e, info) => {
    if (busy) return;
    e.preventDefault();
    dragRef.current = { ...info, over: info.from };
    setDrag({ listKey: info.listKey, from: info.from, over: info.from });
    const onMove = (ev) => {
      const cur = dragRef.current;
      if (!cur) return;
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const row = under && under.closest && under.closest("[data-reorder-list]");
      if (!row || row.getAttribute("data-reorder-list") !== cur.listKey) return;
      const over = Number(row.getAttribute("data-reorder-index"));
      if (over === cur.over) return;
      cur.over = over;
      setDrag({ listKey: cur.listKey, from: cur.from, over });
    };
    const finish = (ev) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (cur && ev.type === "pointerup") reorderTo(cur.at, cur.list, cur.from, cur.over, cur.saveCall);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const parsePrice = (at, typed) => {
    if (typed === "") return { ok: true, amount: null };
    const n = Number(typed);
    if (!Number.isFinite(n) || n < 0 || n > 99999) {
      setError({ at, text: LIST_REASONS.bad_amount });
      return { ok: false };
    }
    return { ok: true, amount: n };
  };

  const el = React.createElement;
  const btn = (label, onClick, off) => el("button", {
    className: "loginBtn", style: { width: "auto", padding: "6px 10px" },
    disabled: busy || !!off, onClick,
  }, label);
  const errorLine = (at) => error && error.at === at && el("div", { className: "loginError" }, error.text);
  const section = (title, intro, at, ...children) => el(
    CompanySection, { title, style: { marginTop: "24px" } },
    el("p", { style: { opacity: 0.8, fontSize: "0.9rem" } }, intro),
    errorLine(at),
    ...children
  );
  const subHeading = (text, faded) => el("div", {
    style: { fontWeight: 600, margin: "18px 0 8px", opacity: faded ? 0.5 : 1 },
  }, text);
  const table = (minWidth, heads, rows) => el(
    "div", { style: { overflowX: "auto" } },
    el("table", { className: "dashboardTable", style: { minWidth } },
      el("thead", null, el("tr", null, heads.map((h, i) => el("th", { key: i }, h)))),
      el("tbody", null, rows)));

  // One entry in a list: drag handle, name, anything extra, on/off, Delete.
  //   reorder   { listKey, list, index, saveCall } or null when the list has
  //             no order of its own
  //   rename    (name, code) => the save to make
  //   goesWith  what a delete takes with it, as a sentence, or ""
  const entryRow = ({ at, kind, entry, reorder, rename, withCode, goesWith, lead, extra, indent }) => {
    const key = `${kind}:${entry.id}`;
    const dragging = drag && reorder && drag.listKey === reorder.listKey;
    const isFrom   = dragging && drag.from === reorder.index;
    const isOver   = dragging && drag.over === reorder.index && drag.over !== drag.from;
    const style = {
      ...(entry.active ? null : { opacity: 0.5 }),
      ...(isFrom ? { opacity: 0.35 } : null),
      ...(isOver ? { outline: "2px solid currentColor", outlineOffset: "-2px" } : null),
    };
    const rowProps = { key: entry.id, style };
    if (reorder) {
      rowProps["data-reorder-list"]  = reorder.listKey;
      rowProps["data-reorder-index"] = reorder.index;
    }
    return el("tr", rowProps,
      el("td", { style: { width: "1%", paddingRight: 0 } },
        reorder
          ? el("span", {
              title: "Drag to reorder", "aria-label": "Drag to reorder",
              style: { cursor: busy ? "default" : "grab", touchAction: "none", userSelect: "none", padding: "4px 6px", opacity: 0.6 },
              onPointerDown: (e) => startDrag(e, {
                at, listKey: reorder.listKey, list: reorder.list, from: reorder.index, saveCall: reorder.saveCall,
              }),
            }, "⋮⋮")
          : null),
      el("td", { style: indent ? { paddingLeft: "28px" } : null },
        lead || null,
        el(ListInlineName, {
          name: entry.name, code: entry.code, withCode, disabled: busy,
          onSave: (name, code) => { const [fn, args] = rename(name, code); return act(at, fn, args); },
        })),
      extra || el("td", null),
      el("td", null,
        el("label", { style: { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" } },
          el("input", {
            type: "checkbox", checked: !!entry.active, disabled: busy,
            onChange: () => act(at, "set_reference_active", { p_kind: kind, p_id: entry.id, p_active: !entry.active }),
          }),
          entry.active ? "On" : "Off")),
      confirming === key
        ? el("td", { style: { whiteSpace: "normal", minWidth: "260px" } },
            el("div", { style: { marginBottom: "6px" } },
              `Delete ${entry.name}? ${goesWith ? goesWith + " " : ""}Old records keep the name.`),
            el("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
              btn("Delete", async () => {
                await act(at, "delete_reference", { p_kind: kind, p_id: entry.id });
                setConfirming("");
              }),
              btn("Cancel", () => setConfirming(""))))
        : el("td", null, btn("Delete", () => setConfirming(key))));
  };

  if (!ready) {
    return el("div", { className: "dashboardSection", style: { marginTop: "24px" } },
      el("h2", null, "Lists and prices"),
      el("p", { style: { opacity: 0.8, fontSize: "0.9rem" } }, "Loading…"));
  }
  if (!companyLists) {
    return el("div", { className: "dashboardSection", style: { marginTop: "24px" } },
      el("h2", null, "Lists and prices"),
      el("div", { className: "loginError" },
        "The company's lists could not be loaded, so they cannot be edited right now. Reload the page to try again."));
  }

  const { pickupLocations, vehicleClasses, sources, protectionProducts, rates } = companyLists;
  const activeClasses  = vehicleClasses.filter((c) => c.active);
  const activeSources  = sources.filter((x) => x.active);
  const activeProducts = protectionProducts.filter((pr) => pr.active);
  const shownProduct   = activeProducts.find((pr) => pr.id === priceProduct) || activeProducts[0] || null;

  // A closed branch is listed only if it still has pickup locations to show.
  const pickupBranches = (branches || []).filter((b) =>
    b.active || pickupLocations.some((p) => p.locationId === b.id));

  // Compact, with the vehicle class column and the header row held in place
  // while the rest scrolls. The background on the held cells is the table's
  // own, so what scrolls underneath does not show through.
  const held = { position: "sticky", background: "#F9F9F7" };
  const priceGrid = (at, valueFor, saveFor) =>
    (!activeClasses.length || !activeSources.length)
      ? el("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
          "Prices need at least one vehicle class and one source switched on.")
      : el("div", { style: { overflow: "auto", maxHeight: "70vh" } },
          el("table", { className: "dashboardTable", style: { minWidth: `${170 + activeSources.length * 104}px` } },
            el("thead", null, el("tr", null,
              el("th", { style: { ...held, top: 0, left: 0, zIndex: 3, padding: "6px 10px" } }, "Vehicle class"),
              activeSources.map((x) => el("th", {
                key: x.id, style: { ...held, top: 0, zIndex: 2, padding: "6px 8px" },
              }, x.name)))),
            el("tbody", null, activeClasses.map((c) => el("tr", { key: c.id },
              el("td", { style: { ...held, left: 0, zIndex: 1, padding: "4px 10px", fontWeight: 600 } }, c.name),
              activeSources.map((x) => el("td", { key: x.id, style: { padding: "4px 8px" } },
                el(ListPriceCell, {
                  value: valueFor(c, x), disabled: busy,
                  onSave: (typed) => {
                    const parsed = parsePrice(at, typed);
                    return parsed.ok ? saveFor(c, x, parsed.amount) : Promise.resolve(false);
                  },
                }))))))));

  const protectionPrice = (product, c, x) => {
    const row = prices.find((r) =>
      r.productId === product.id && r.vehicleClassId === c.id && r.sourceId === x.id);
    return row ? Number(row.amount) : null;
  };

  const saveClass   = (c, order) => ["save_vehicle_class", { p_id: c.id, p_name: c.name, p_sort: order }];
  const saveSource  = (x, order) => ["save_source",
    { p_id: x.id, p_name: x.name, p_billing_type: x.billingType, p_sort: order }];
  const saveProduct = (pr, order) => ["save_protection_product", { p_id: pr.id, p_name: pr.name, p_sort: order }];
  const savePickup  = (pl, order) => ["save_pickup_location",
    { p_id: pl.id, p_location_id: pl.locationId, p_name: pl.name, p_code: pl.code || "", p_sort: order }];

  const listHeads = (name, middle) => ["", name, middle || "", "On", ""];

  return el(React.Fragment, null,

    // ── Pickup locations ──
    section("Pickup locations",
      "Where a reservation can be picked up, branch by branch. Staff see only their own branch's list. A branch with none still shows the old location codes.",
      "pickup",
      pickupBranches.map((b) => {
        const mine = pickupLocations.filter((p) => p.locationId === b.id);
        return el("div", { key: b.id },
          subHeading(b.active ? b.name : `${b.name} (closed)`, !b.active),
          mine.length > 0 && table("520px", listHeads("Pickup location"),
            mine.map((entry, i) => entryRow({
              at: "pickup", kind: "pickup_location", entry, withCode: true,
              reorder: { listKey: `pickup:${b.id}`, list: mine, index: i, saveCall: savePickup },
              rename: (name, code) => ["save_pickup_location", {
                p_id: entry.id, p_location_id: entry.locationId, p_name: name, p_code: code, p_sort: null,
              }],
            }))),
          b.active && el(ListAddRow, {
            placeholder: "New pickup location", label: "Add", withCode: true, disabled: busy,
            onAdd: (name, code) => act("pickup", "save_pickup_location", {
              p_id: null, p_location_id: b.id, p_name: name, p_code: code, p_sort: null,
            }),
          }));
      })),

    // ── Vehicle classes ──
    section("Vehicle classes",
      "One list for reservations, the fleet and rates, in the order shown here.",
      "classes",
      table("520px", listHeads("Vehicle class"),
        vehicleClasses.map((entry, i) => entryRow({
          at: "classes", kind: "vehicle_class", entry,
          reorder: { listKey: "classes", list: vehicleClasses, index: i, saveCall: saveClass },
          rename: (name) => ["save_vehicle_class", { p_id: entry.id, p_name: name, p_sort: null }],
          goesWith: "Its daily rates and protection prices go with it.",
        }))),
      el(ListAddRow, {
        placeholder: "New vehicle class", label: "Add", disabled: busy,
        onAdd: (name) => act("classes", "save_vehicle_class", { p_id: null, p_name: name, p_sort: null }),
      })),

    // ── Sources ──
    section("Sources",
      "Who the work comes from. The billing type decides which billing fields a reservation asks for, so a source can be renamed freely. Open a source to see the specific sources under it.",
      "sources",
      table("640px", listHeads("Source", "Billing type"),
        sources.map((entry, i) => {
          const isOpen = !!openSources[entry.id];
          const n = entry.details.length;
          const rows = [entryRow({
            at: "sources", kind: "source", entry,
            reorder: { listKey: "sources", list: sources, index: i, saveCall: saveSource },
            rename: (name) => ["save_source", {
              p_id: entry.id, p_name: name, p_billing_type: entry.billingType, p_sort: null,
            }],
            goesWith: `Its ${n} specific source${n === 1 ? "" : "s"}, its daily rates and its protection prices go with it.`,
            lead: el("button", {
              type: "button", "aria-expanded": isOpen,
              title: isOpen ? "Hide specific sources" : "Show specific sources",
              style: { background: "none", border: "none", color: "inherit", font: "inherit", cursor: "pointer", padding: "0 8px 0 0" },
              onClick: () => setOpenSources((p) => ({ ...p, [entry.id]: !p[entry.id] })),
            }, isOpen ? "▾" : "▸"),
            extra: el("td", null,
              el("select", {
                className: "resFormInput", style: { width: "auto", padding: "5px 8px" }, disabled: busy,
                value: entry.billingType,
                onChange: (e) => act("sources", "save_source", {
                  p_id: entry.id, p_name: entry.name, p_billing_type: e.target.value, p_sort: null,
                }),
              }, BILLING_TYPE_LABELS.map(([v, l]) => el("option", { key: v, value: v }, l)))),
          })];
          if (isOpen) {
            entry.details.forEach((d) => rows.push(entryRow({
              at: "sources", kind: "source_detail", entry: d, reorder: null, indent: true,
              rename: (name) => ["save_source_detail", { p_id: d.id, p_source_id: entry.id, p_name: name }],
              extra: el("td", null, "Specific source"),
            })));
            rows.push(el("tr", { key: `${entry.id}:add` },
              el("td", null),
              el("td", { colSpan: 4, style: { paddingLeft: "28px" } },
                el(ListAddRow, {
                  placeholder: `New specific source under ${entry.name}`, label: "Add", disabled: busy,
                  onAdd: (name) => act("sources", "save_source_detail", {
                    p_id: null, p_source_id: entry.id, p_name: name,
                  }),
                }))));
          }
          return rows;
        })),
      subHeading("Add a source"),
      el(ListAddRow, {
        placeholder: "New source", label: "Add source", withType: true, disabled: busy,
        onAdd: (name, code, type) => act("sources", "save_source", {
          p_id: null, p_name: name, p_billing_type: type, p_sort: null,
        }),
      })),

    // ── Daily rates ──
    section("Daily rates",
      "The rate filled in when a source and a vehicle class are chosen on a customer's file. A cell saves when you leave it. Blank means no rate, and staff type one in.",
      "rates",
      priceGrid("rates",
        (c, x) => (rates[x.name] && rates[x.name][c.name] != null ? rates[x.name][c.name] : null),
        (c, x, amount) => act("rates", "set_daily_rate", {
          p_class_id: c.id, p_source_id: x.id, p_amount: amount,
        }))),

    // ── Protection products ──
    section("Protection products",
      "Each product has a price per day for every vehicle class and source. Pick a product to see its prices. A cell saves when you leave it. Blank means no price.",
      "protection",
      protectionProducts.length > 0 && table("520px", listHeads("Protection product"),
        protectionProducts.map((entry, i) => entryRow({
          at: "protection", kind: "protection_product", entry,
          reorder: { listKey: "products", list: protectionProducts, index: i, saveCall: saveProduct },
          rename: (name) => ["save_protection_product", { p_id: entry.id, p_name: name, p_sort: null }],
          goesWith: "Its protection prices go with it.",
        }))),
      el(ListAddRow, {
        placeholder: "New protection product", label: "Add", disabled: busy,
        onAdd: (name) => act("protection", "save_protection_product", { p_id: null, p_name: name, p_sort: null }),
      }),
      protectionProducts.length > 0 && subHeading("What the customer sees at pickup"),
      protectionProducts.map((pr) => el(ProtectionDetailsCard, {
        key: pr.id, product: pr, busy,
        onSave: (wording, decline, required) => act("protection", "set_protection_details", {
          p_id: pr.id, p_wording: wording, p_decline_wording: decline, p_required: required,
        }),
      })),
      shownProduct
        ? el("div", null,
            el("div", { style: { display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", margin: "18px 0 8px" } },
              el("span", { style: { fontWeight: 600 } }, "Price per day for"),
              el("select", {
                className: "resFormInput", style: { width: "auto" },
                value: shownProduct.id, onChange: (e) => setPriceProduct(e.target.value),
              }, activeProducts.map((pr) => el("option", { key: pr.id, value: pr.id }, pr.name)))),
            // Keyed by product, so a cell's draft never carries from one
            // product's grid into another's.
            el("div", { key: shownProduct.id },
              priceGrid("protection",
                (c, x) => protectionPrice(shownProduct, c, x),
                (c, x, amount) => act("protection", "set_protection_price", {
                  p_product_id: shownProduct.id, p_class_id: c.id, p_source_id: x.id, p_amount: amount,
                }))))
        : el("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
            "Switch a product on to set its prices.")),

    // ── Other driver price ──
    section("Other driver price",
      "The price per day for each additional driver, for every vehicle class and source. A cell saves when you leave it. Blank means no charge.",
      "otherDriver",
      priceGrid("otherDriver",
        (c, x) => {
          const row = driverPrices.find((r) => r.vehicleClassId === c.id && r.sourceId === x.id);
          return row ? Number(row.amount) : null;
        },
        (c, x, amount) => act("otherDriver", "set_other_driver_price", {
          p_class_id: c.id, p_source_id: x.id, p_amount: amount,
        }))),

    // ── Deductibles ──
    section("Deductibles",
      "The company's collision and comprehensive deductibles, and any vehicle class that has its own. A blank amount on a class means it uses the company's.",
      "deductibles",
      table("560px", ["", "Collision", "Comprehensive", ""], [
        el(DeductibleRow, {
          key: "company", label: "Company default", busy,
          collision: deductibles?.collision ?? null, comprehensive: deductibles?.comprehensive ?? null,
          placeholder: { collision: "Not set", comprehensive: "Not set" },
          onSave: (coll, comp) => {
            const a = parsePrice("deductibles", coll), b = parsePrice("deductibles", comp);
            if (!a.ok || !b.ok) return Promise.resolve(false);
            return act("deductibles", "set_company_deductibles", { p_collision: a.amount, p_comprehensive: b.amount });
          },
        }),
        ...activeClasses.map((c) => {
          const o = overrides.find((r) => r.vehicleClassId === c.id);
          const dflt = (v) => (v == null ? "Company default" : `Default ${Number(v)}`);
          return el(DeductibleRow, {
            key: c.id, label: c.name, busy,
            collision: o?.collision ?? null, comprehensive: o?.comprehensive ?? null,
            placeholder: { collision: dflt(deductibles?.collision), comprehensive: dflt(deductibles?.comprehensive) },
            onSave: (coll, comp) => {
              const a = parsePrice("deductibles", coll), b = parsePrice("deductibles", comp);
              if (!a.ok || !b.ok) return Promise.resolve(false);
              return act("deductibles", "set_deductible_override", {
                p_class_id: c.id, p_collision: a.amount, p_comprehensive: b.amount,
              });
            },
          });
        }),
      ])),

    // ── Contract acknowledgements ──
    section("Contract acknowledgements",
      "What the customer acknowledges on the rental contract. Every save is a new version, and earlier versions are kept unchanged.",
      "acknowledgements",
      el(ContractAcknowledgementsCard, {
        versions: ackVersions, busy,
        onSave: (text) => act("acknowledgements", "save_contract_acknowledgements", { p_body: text }),
      }))
  );
}

function StaffPage() {
  const { currentUser, guardAction } = React.useContext(AppContext);
  const isAdmin = roleAtLeast(currentUser?.role, "Admin");

  const [rows,    setRows]    = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error,   setError]   = React.useState("");
  const [busyId,  setBusyId]  = React.useState("");
  const [branches, setBranches] = React.useState([]);
  // Defaults to where the person doing the moving is, which is the branch they
  // are almost always moving somebody to.
  const [moveTo,  setMoveTo]  = React.useState({});

  const [code,       setCode]       = React.useState("");
  const [codeSetAt,  setCodeSetAt]  = React.useState("");
  const [codeShown,  setCodeShown]  = React.useState(false);
  const [codeError,  setCodeError]  = React.useState("");
  const [rotating,   setRotating]   = React.useState(false);
  const [defaultLocation, setDefaultLocation] = React.useState("");
  // Reported by my_join_code rather than derived from the role here, so the
  // rule lives in one place: the database already decides it.
  const [canRotate,  setCanRotate]  = React.useState(false);
  const isExec = roleAtLeast(currentUser?.role, "Exec");
  // Where the person doing the moving currently is. For an Admin that is their
  // own branch; for an Exec it is whichever branch they are acting in, which
  // the cached profile cannot say because an Exec's locationId is null.
  const [actingLocation, setActingLocation] = React.useState("");
  const homeBranch = actingLocation || currentUser?.locationId || "";

  const loadStaff = React.useCallback(async () => {
    // No location filter. The read policy already scopes this to the caller's
    // own branch, or to the whole company for an Exec, and a filter here would
    // only hide a policy failure rather than prevent one.
    const { data, error: err } = await supabase
      .from("users").select("id,username,name,role,active,locationId").order("username");
    if (err) setError(err.message || "Could not load the staff list.");
    else { setRows(data || []); setError(""); }
    setLoading(false);
  }, []);

  // Named columns, never select("*"). locations has been column-granted since
  // step 10, so * expands to include a column nobody may read and the whole
  // query comes back 403.
  const loadBranches = React.useCallback(async () => {
    const { data } = await supabase
      .from("locations").select("id,name,code,active").order("name");
    setBranches((data || []).filter((b) => b.active));
  }, []);

  const loadCode = React.useCallback(async () => {
    const { data, error: err } = await supabase.rpc("my_join_code");
    if (err || !data || !data.ok) { setCodeError("Could not load the join code."); return; }
    setCode(data.code);
    setCodeSetAt(data.setAt || "");
    setDefaultLocation(data.defaultLocation || "");
    setCanRotate(data.canRotate === true);
    setCodeError("");
  }, []);

  // Fetched on mount, not on Show. canRotate and the default branch are needed
  // to render the panel honestly: without them an Exec was told only an Exec
  // could rotate the code. The code arrives in the same response and simply is
  // not displayed, which is what Show actually controls.
  React.useEffect(() => {
    loadStaff(); loadBranches(); loadCode();
    supabase.rpc("my_acting_location").then(({ data }) => {
      if (data && data.ok && data.locationId) setActingLocation(data.locationId);
    });
  }, [loadStaff, loadBranches, loadCode]);

  const rotate = () => {
    setRotating(true);
    supabase.rpc("regenerate_join_code")
      .then(({ data, error: err }) => {
        if (err || !data || !data.ok) { setCodeError("Could not generate a new code."); return; }
        setCode(data.code);
        setCodeSetAt(new Date().toISOString());
        setCodeShown(true);
        setCodeError("");
      })
      .then(() => setRotating(false), () => setRotating(false));
  };

  // Both mutations go through guardAction, so they are PIN gated and land in
  // the audit log with the target named. A role change nobody can point at
  // afterwards is the kind of thing this log exists for.
  const runStaffAction = (row, actionKey, rpc, args, describe) => {
    guardAction(actionKey, async () => {
      setBusyId(row.id);
      try {
        const { data, error: err } = await supabase.rpc(rpc, args);
        if (err) throw new Error(err.message);
        if (!data || !data.ok) throw new Error(STAFF_REASONS[data && data.reason] || "Refused.");
        await loadStaff();
      } finally {
        setBusyId("");
      }
    }, {
      tableName:   "users",
      recordId:    row.username,
      description: describe,
    });
  };

  const changeRole = (row) => {
    const next = row.role === "Admin" ? "Agent" : "Admin";
    // Leaving Exec needs somewhere to land: users_location_by_role refuses a
    // non-Exec with no branch, so without this the write fails on a constraint
    // rather than on anything the person could act on.
    const args = { target_id: row.id, new_role: next };
    if (row.role === "Exec") {
      args.new_location_id = moveTo[row.id] || homeBranch || (branches[0] || {}).id;
      if (!args.new_location_id) { setError(STAFF_REASONS.location_required); return; }
    }
    runStaffAction(row, "staff.role", "set_staff_role", args,
      `${row.username}: ${row.role} to ${next}`);
  };

  const toggleActive = (row) => runStaffAction(
    row, "staff.active", "set_staff_active",
    { target_id: row.id, is_active: !row.active },
    `${row.username}: ${row.active ? "deactivated" : "reactivated"}`);

  const reassign = (row) => {
    const dest = moveTo[row.id] || homeBranch || "";
    if (!dest) { setError(STAFF_REASONS.location_required); return; }
    const name = (branches.find((b) => b.id === dest) || {}).name || dest;
    runStaffAction(row, "staff.reassign", "reassign_staff",
      { target_id: row.id, location_id: dest },
      `${row.username} moved to ${name}.`);
  };

  const resetPin = (row) => {
    if (!window.confirm(
      `Clear ${row.username}'s PIN?\n\n` +
      `They will be asked to set a new one the next time they confirm an action. ` +
      `You will not see it, and you cannot choose it for them.`)) return;
    runStaffAction(row, "staff.resetPin", "reset_staff_pin",
      { target_id: row.id }, `${row.username}: PIN cleared.`);
  };

  const branchName = (id) =>
    (branches.find((b) => b.id === id) || {}).name || (id ? "another branch" : "\u2014");

  if (!isAdmin) {
    return React.createElement(
      "div", { className: "page" },
      React.createElement("h1", null, "Staff"),
      React.createElement("div", { className: "resvEmpty" },
        "Only an Admin can manage staff. Ask an Admin at your branch if you need an account changed.")
    );
  }

  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", null, "Staff"),

    // ── Join code ──
    React.createElement(
      "div", { className: "dashboardSection", style: { marginBottom: "24px" } },
      React.createElement("h2", null, "Join code"),
      React.createElement("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
        "New staff enter this code when they create their account. One code for the whole company: treat it like a door key, because anyone who has it can create an account here."),
      defaultLocation && React.createElement("p", { style: { opacity: 0.8, fontSize: "0.9rem" } },
        `New accounts start at ${defaultLocation}. Move them from the list below if they belong somewhere else.`),
      React.createElement(
        "div", { style: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" } },
        React.createElement("code", {
          style: { fontSize: "1.4rem", letterSpacing: "0.15em", padding: "8px 14px", borderRadius: "6px", background: "rgba(66,164,255,0.12)" },
        }, codeShown && code ? code : "••••••••"),
        React.createElement("button", {
          className: "loginBtn",
          style: { width: "auto", padding: "8px 14px" },
          // Hidden by default because a code on screen is a code on screen while
          // a customer is standing at the counter.
          onClick: () => setCodeShown((v) => !v),
        }, codeShown ? "Hide" : "Show"),
        canRotate && React.createElement("button", {
          className: "loginBtn",
          style: { width: "auto", padding: "8px 14px" },
          disabled: rotating,
          onClick: rotate,
        }, rotating ? "Generating…" : "Generate new code")
      ),
      codeSetAt && codeShown && React.createElement("div", { style: { opacity: 0.6, fontSize: "0.8rem", marginTop: "8px" } },
        `Set ${new Date(codeSetAt).toLocaleDateString("en-CA")}`),
      React.createElement("div", { style: { opacity: 0.6, fontSize: "0.8rem", marginTop: "8px" } },
        canRotate
          ? "Generating a new code stops the old one working immediately, at every branch. Anyone who was given the old code will need the new one."
          : "Only an Exec can generate a new code, since it covers the whole company."),
      codeError && React.createElement("div", { className: "loginError" }, codeError)
    ),

    // ── Staff list ──
    React.createElement(
      "div", { className: "dashboardSection" },
      React.createElement("h2", null,
        isExec ? "People in this company" : "People at this branch"),
      error   && React.createElement("div", { className: "loginError" }, error),
      loading && React.createElement("div", { className: "resvEmpty" }, "Loading…"),
      !loading && rows.length === 0 && React.createElement("div", { className: "resvEmpty" }, "Nobody else has joined yet."),
      !loading && rows.length > 0 && React.createElement(
        "div", { style: { overflowX: "auto" } },
        React.createElement(
        "table", { className: "dashboardTable", style: { minWidth: "760px" } },
        React.createElement("thead", null, React.createElement("tr", null,
          ["Username", "Name", "Role", "Branch", "Status", ""].map((h) =>
            React.createElement("th", { key: h }, h)))),
        React.createElement("tbody", null, rows.map((row) => {
          const isSelf = row.id === currentUser?.id;
          return React.createElement("tr", { key: row.id, style: row.active ? null : { opacity: 0.5 } },
            React.createElement("td", null, row.username),
            React.createElement("td", null, row.name),
            React.createElement("td", null, row.role),
            // An Exec has no branch at all, which is the point of the role, so
            // it reads as such rather than as a missing value.
            React.createElement("td", null,
              row.role === "Exec" ? "Company-wide" : branchName(row.locationId)),
            React.createElement("td", null, row.active ? "Active" : "Deactivated"),
            // Was nowrap, which pushed the last controls off the right edge
            // once the row grew from two buttons to four and a picker.
            React.createElement("td", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" } },
              // Your own row carries no buttons. An Admin who demotes or
              // deactivates themselves has locked the company out of its own
              // staff administration, and there is nobody left with the rights
              // to undo it. The database refuses it too; this just means the
              // button is never there to be clicked by accident.
              isSelf
                ? React.createElement("span", { style: { opacity: 0.6, fontSize: "0.85rem" } }, "You")
                : React.createElement(React.Fragment, null,
                    React.createElement("button", {
                      className: "loginBtn",
                      style: { width: "auto", padding: "6px 10px" },
                      disabled: busyId === row.id,
                      onClick: () => changeRole(row),
                    }, roleToggleLabel(row.role)),
                    React.createElement("button", {
                      className: "loginBtn",
                      style: { width: "auto", padding: "6px 10px" },
                      disabled: busyId === row.id,
                      onClick: () => toggleActive(row),
                    }, row.active ? "Deactivate" : "Reactivate"),
                    React.createElement("button", {
                      className: "loginBtn",
                      style: { width: "auto", padding: "6px 10px" },
                      disabled: busyId === row.id,
                      onClick: () => resetPin(row),
                    }, "Reset PIN"),
                    // An Exec belongs to no branch, so there is nothing to move.
                    row.role !== "Exec" && branches.length > 1 && React.createElement(
                      "span", { style: { whiteSpace: "nowrap" } },
                      React.createElement("select", {
                        className: "resFormInput",
                        style: { width: "auto", padding: "5px" },
                        value: moveTo[row.id] || homeBranch || "",
                        onChange: (e) => setMoveTo((p) => ({ ...p, [row.id]: e.target.value })),
                      }, branches.map((b) => React.createElement("option", { key: b.id, value: b.id }, b.name))),
                      React.createElement("button", {
                        className: "loginBtn",
                        style: { width: "auto", padding: "6px 10px" },
                        disabled: busyId === row.id,
                        onClick: () => reassign(row),
                      }, "Move")))));
        }))
      ))
    )
  );
}

function AuditLogPage() {
  const [rows,    setRows]    = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error,   setError]   = React.useState("");

  const [actorFilt,   setActorFilt]   = React.useState("All");
  const [actionFilt,  setActionFilt]  = React.useState("All");
  const [outcomeFilt, setOutcomeFilt] = React.useState("All");
  const [fromDate,    setFromDate]    = React.useState("");
  const [toDate,      setToDate]      = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      // Capped rather than unbounded: this table only grows, and a page that
      // tries to render every entry gets slower every week it runs.
      const { data, error: err } = await supabase
        .from("audit_log").select("*").order("timestamp", { ascending: false }).limit(500);
      if (cancelled) return;
      if (err) setError(err.message || "Could not load the audit log.");
      else setRows(data || []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const actors  = React.useMemo(() => [...new Set(rows.map((r) => r.actor).filter(Boolean))].sort(), [rows]);
  const actions = React.useMemo(() => [...new Set(rows.map((r) => r.actionType).filter(Boolean))].sort(), [rows]);

  const filtered = rows.filter((r) => {
    if (actorFilt   !== "All" && r.actor      !== actorFilt)   return false;
    if (actionFilt  !== "All" && r.actionType !== actionFilt)  return false;
    if (outcomeFilt !== "All" && r.outcome    !== outcomeFilt) return false;
    // Compared on the local calendar day, so "today" means the staff member's
    // today rather than UTC's.
    const day = r.timestamp ? new Date(r.timestamp).toLocaleDateString("en-CA") : "";
    if (fromDate && day < fromDate) return false;
    if (toDate   && day > toDate)   return false;
    return true;
  });

  const fmtWhen = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const outcomeClass = (o) =>
    o === "completed" ? "auditOutcome auditOutcome--completed"
    : o === "cancelled" ? "auditOutcome auditOutcome--cancelled"
    : "auditOutcome auditOutcome--refused";

  const select = (label, value, onChange, options) =>
    React.createElement("div", { className: "auditFilter" },
      React.createElement("label", { className: "auditFilterLabel" }, label),
      React.createElement("select",
        { className: "auditFilterInput", value, onChange: (e) => onChange(e.target.value) },
        options.map((o) => React.createElement("option", { key: o, value: o }, o))
      )
    );

  const dateInput = (label, value, onChange) =>
    React.createElement("div", { className: "auditFilter" },
      React.createElement("label", { className: "auditFilterLabel" }, label),
      React.createElement("input", {
        type: "date", className: "auditFilterInput", value,
        onChange: (e) => onChange(e.target.value),
      })
    );

  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Audit Log"),
    React.createElement("div", { className: "page__titleUnderline" }),

    React.createElement("p", { className: "aiTabDesc", style: { marginBottom: "14px" } },
      "Every action that changes something, by whom and when, from the app and from fleetr ai alike. ",
      "Cancelled and refused attempts are recorded too, not just the ones that went through. ",
      "This view is read only."
    ),

    React.createElement("section", { className: "dashboardSection", style: { marginBottom: "16px" } },
      React.createElement("div", { className: "dashboardSection__body" },
        React.createElement("div", { className: "auditFilters" },
          select("Actor",   actorFilt,   setActorFilt,   ["All", ...actors]),
          select("Action",  actionFilt,  setActionFilt,  ["All", ...actions]),
          select("Outcome", outcomeFilt, setOutcomeFilt, ["All", "completed", "cancelled", "refused"]),
          dateInput("From", fromDate, setFromDate),
          dateInput("To",   toDate,   setToDate),
          React.createElement("button", {
            type: "button", className: "auditClearBtn",
            onClick: () => { setActorFilt("All"); setActionFilt("All"); setOutcomeFilt("All"); setFromDate(""); setToDate(""); },
          }, "Clear")
        )
      )
    ),

    React.createElement("section", { className: "dashboardSection" },
      React.createElement("div", { className: "dashboardSection__header" },
        React.createElement("div", { className: "dashboardSection__headerRow" },
          React.createElement("span", null, `Entries (${filtered.length}${filtered.length !== rows.length ? ` of ${rows.length}` : ""})`)
        )
      ),
      React.createElement("div", { className: "dashboardSection__body" },
        error
          ? React.createElement("div", { className: "addVehicleError" }, error)
        : loading
          ? React.createElement("div", { className: "resvEmpty" }, "Loading…")
        : filtered.length === 0
          ? React.createElement("div", { className: "resvEmpty" },
              rows.length === 0 ? "Nothing recorded yet." : "No entries match these filters.")
          : React.createElement("table", { className: "dashboardTable" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  ["When", "Actor", "Action", "Record", "Tier", "Outcome", "Details"].map((c) =>
                    React.createElement("th", { key: c }, c))
                )
              ),
              React.createElement("tbody", null,
                filtered.map((r) =>
                  React.createElement("tr", { key: r.id },
                    React.createElement("td", { style: { whiteSpace: "nowrap" } }, fmtWhen(r.timestamp)),
                    React.createElement("td", null, r.actor || "—"),
                    React.createElement("td", null,
                      React.createElement("div", null, r.actionLabel || r.actionType),
                      React.createElement("div", { className: "auditActionKey" }, r.actionType)
                    ),
                    React.createElement("td", null,
                      r.recordId || "—",
                      r.tableName && React.createElement("div", { className: "auditActionKey" }, r.tableName)
                    ),
                    React.createElement("td", null, r.tier || "—"),
                    React.createElement("td", null,
                      React.createElement("span", { className: outcomeClass(r.outcome) }, r.outcome || "—")),
                    React.createElement("td", { className: "auditDescription" }, r.description || "—")
                  )
                )
              )
            )
      )
    )
  );
}

// Settings > Customer texts. Exec only: the section is not rendered for anyone
// else, and set_message_template refuses them regardless.
//
// The cancel link is not in the text box and cannot be typed into it. The
// worker adds it when it sends, which is why the preview shows it after the
// wording rather than inside it.
function CustomerTextsSettings() {
  const { logAudit } = React.useContext(AppContext);
  const [saved,   setSaved]   = React.useState({});   // kind -> the company's own wording, if any
  const [drafts,  setDrafts]  = React.useState({});   // kind -> what is in the box
  const [names,   setNames]   = React.useState({ company: null, location: null });
  const [loaded,  setLoaded]  = React.useState(false);
  const [loadErr, setLoadErr] = React.useState(false);
  const [busy,    setBusy]    = React.useState(null);
  const [notice,  setNotice]  = React.useState({});   // kind -> { ok, text }
  const [editing, setEditing] = React.useState({});   // kind -> true while its text box is open
  const boxes = React.useRef({});                      // kind -> its text box, for inserting at the cursor

  React.useEffect(() => {
    let live = true;
    (async () => {
      const [tpl, op, loc] = await Promise.all([
        supabase.from("message_templates").select("kind, body"),
        supabase.from("operators").select("name").limit(1),
        supabase.from("locations").select("name").limit(1),
      ]);
      if (!live) return;
      if (tpl.error) { console.warn("message_templates load failed:", tpl.error); setLoadErr(true); }
      const own = Object.fromEntries((tpl.data || []).map((t) => [t.kind, t.body]));
      setSaved(own);
      setDrafts(Object.fromEntries(TEXT_TEMPLATE_KINDS.map((k) => [k.kind, own[k.kind] ?? k.fallback])));
      setNames({ company: op.data?.[0]?.name || null, location: loc.data?.[0]?.name || null });
      setLoaded(true);
    })();
    return () => { live = false; };
  }, []);

  // A made-up customer, with this company's real name where it is known, so
  // the preview reads like the text a customer would get.
  const sample = {
    "[first name]": "Alex",
    "[company]":    names.company || "your company",
    "[location]":   names.location || "Main Branch",
    "[date]":       "Oct 6",
    "[time]":       "10:00 AM",
  };

  const save = async (k, body) => {
    setBusy(k.kind);
    setNotice((p) => ({ ...p, [k.kind]: null }));
    const { data, error } = await supabase.rpc("set_message_template", { p_kind: k.kind, p_body: body });
    setBusy(null);
    const entry = { actionType: "texts.template", tableName: "message_templates", recordId: k.kind };
    if (error || !data?.ok) {
      if (error) console.warn("set_message_template failed:", error);
      const text = error ? "The wording could not be saved. Check your connection and try again." : textTemplateRefusal(data);
      setNotice((p) => ({ ...p, [k.kind]: { ok: false, text } }));
      logAudit({ ...entry, outcome: "refused", description: `${k.title} wording not changed (${error ? "request failed" : data?.reason}).` });
      return false;
    }
    const reset = !!data.reset;
    setSaved((p) => { const next = { ...p }; if (reset) delete next[k.kind]; else next[k.kind] = data.body; return next; });
    setDrafts((p) => ({ ...p, [k.kind]: reset ? k.fallback : data.body }));
    setNotice((p) => ({ ...p, [k.kind]: { ok: true, text: reset ? "Back to the default wording." : "Wording saved." } }));
    logAudit({ ...entry, outcome: "completed",
      description: reset ? `${k.title} wording reset to the default.` : `${k.title} wording changed to: ${data.body}` });
    setEditing((p) => ({ ...p, [k.kind]: false }));
    return true;
  };

  // Puts a placeholder where the cursor is in that text's box, replacing any
  // selected text, and leaves the cursor just after it.
  const insertPlaceholder = (kind, placeholder) => {
    const box = boxes.current[kind];
    const value = drafts[kind] ?? "";
    const start = box ? box.selectionStart : value.length;
    const end   = box ? box.selectionEnd   : value.length;
    setDrafts((p) => ({ ...p, [kind]: value.slice(0, start) + placeholder + value.slice(end) }));
    setNotice((p) => ({ ...p, [kind]: null }));
    // After React has put the new value in, which moves the cursor to the end.
    setTimeout(() => {
      const b = boxes.current[kind];
      if (!b) return;
      b.focus();
      b.setSelectionRange(start + placeholder.length, start + placeholder.length);
    }, 0);
  };

  if (!loaded) return React.createElement("div", { className: "resvEmpty" }, "Loading the current wording...");

  return React.createElement(React.Fragment, null,
    React.createElement("p", { className: "aiTabDesc" },
      "The wording of the texts your customers receive, for every branch of the company. ",
      "Use these placeholders and each customer's own details are filled in: ",
      React.createElement("strong", null, TEXT_PLACEHOLDERS.join(", ")),
      ". The system adds the rest automatically, and it cannot be removed or edited: the reservation code to the confirmation; the customer's personal app link to the confirmation, Pre-Rental Check and return reminder; and a link to cancel to the confirmation and Pre-Rental Check. The links' tokens in the preview are stand-ins of the real length, so the count is the real count."),
    loadErr && React.createElement("div", { className: "closeRentalWarning" },
      "The saved wording could not be loaded, so the default wording is shown. Saving here will replace whatever is saved."),

    TEXT_TEMPLATE_KINDS.map((k) => {
      const draft    = drafts[k.kind] ?? "";
      const trimmed  = draft.trim();
      const current  = saved[k.kind] ?? k.fallback;
      const isCustom = saved[k.kind] != null;
      const preview  = fillTextTemplate(trimmed, sample) + k.suffix;
      const m        = measureText(preview);
      const tooLong  = trimmed.length > TEXT_TEMPLATE_MAX;
      const unknown  = (trimmed.match(/\[[^\][]*\]/g) || []).filter((ph) => !TEXT_PLACEHOLDERS.includes(ph.toLowerCase()));
      const note     = notice[k.kind];

      const isEditing = !!editing[k.kind];
      // What the customer gets today, shown when the box is closed.
      const savedPreview = fillTextTemplate(current, sample) + k.suffix;

      const measures = [
        React.createElement("p", { key: "len", className: "closeRentalHint" },
          `${m.length} characters${k.suffixNote ? ` with ${k.suffixNote}` : ""}, sent as ${m.segments} text${m.segments === 1 ? "" : "s"} ` +
          `(${m.perSegment} characters fit in one). A longer name, company or branch adds to this.`),
        m.segments > 1 && React.createElement("div", { key: "seg", className: "closeRentalWarning" },
          `This is over one text segment, so each customer is sent ${m.segments} texts' worth and it costs ${m.segments} times as much. ` +
          "Shorten the wording to bring it back to one."),
        m.costly.length > 0 && React.createElement("div", { key: "cost", className: "closeRentalWarning" },
          `These characters raise the cost: ${m.costly.map((ch) => (ch === "\n" ? "line break" : ch)).join("  ")}. ` +
          "A text containing any of them holds 70 characters per segment instead of 160. Curly quotes and apostrophes are the usual cause: retype them as straight ones."),
        tooLong && React.createElement("div", { key: "long", className: "closeRentalWarning" },
          `The wording is ${trimmed.length - TEXT_TEMPLATE_MAX} characters over the ${TEXT_TEMPLATE_MAX} allowed and cannot be saved.`),
        unknown.length > 0 && React.createElement("div", { key: "ph", className: "closeRentalWarning" },
          `${unknown.join(", ")} ${unknown.length === 1 ? "is not a placeholder" : "are not placeholders"} and cannot be saved. Use only ${TEXT_PLACEHOLDERS.join(", ")}.`),
      ];

      return React.createElement("div", { key: k.kind, style: { marginBottom: "22px" } },
        React.createElement("div", { className: "gasSettingSubhead" }, k.title),
        React.createElement("p", { className: "closeRentalHint" },
          `${k.when} ${isCustom ? "Using your company's own wording." : "Using the default wording."}`),

        !isEditing && React.createElement(React.Fragment, null,
          React.createElement("div", { className: "closeRentalSummary" }, savedPreview),
          note && React.createElement("div", { className: note.ok ? "addVehicleSuccess" : "closeRentalWarning" }, note.text),
          React.createElement("div", { className: "closeRentalActions" },
            React.createElement("button", {
              type: "button", className: "resModalCancel",
              disabled: busy === k.kind || !isCustom,
              onClick: () => save(k, ""),
            }, "Use default wording"),
            React.createElement("button", {
              type: "button", className: "resModalSubmit",
              disabled: busy === k.kind,
              onClick: () => {
                setDrafts((p) => ({ ...p, [k.kind]: current }));
                setNotice((p) => ({ ...p, [k.kind]: null }));
                setEditing((p) => ({ ...p, [k.kind]: true }));
              },
            }, "Edit"))),

        isEditing && React.createElement(React.Fragment, null,
          React.createElement("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" } },
            TEXT_PLACEHOLDER_BUTTONS.map(([label, placeholder]) =>
              React.createElement("button", {
                key: placeholder, type: "button", className: "resModalCancel",
                // Keeps the cursor in the box, so the insert lands where it was.
                onMouseDown: (e) => e.preventDefault(),
                onClick: () => insertPlaceholder(k.kind, placeholder),
              }, label))),
          React.createElement("textarea", {
            className: "resFormInput resFormTextarea", rows: 4, value: draft,
            "aria-label": `${k.title} wording`, autoFocus: true,
            ref: (node) => { boxes.current[k.kind] = node; },
            onChange: (e) => { setDrafts((p) => ({ ...p, [k.kind]: e.target.value })); setNotice((p) => ({ ...p, [k.kind]: null })); },
          }),
          React.createElement("p", { className: "closeRentalHint" },
            `${trimmed.length} of ${TEXT_TEMPLATE_MAX} characters of wording.`),

          React.createElement("div", { className: "gasSettingSubhead" }, "Preview"),
          React.createElement("div", { className: "closeRentalSummary" }, preview),
          ...measures,
          note && React.createElement("div", { className: note.ok ? "addVehicleSuccess" : "closeRentalWarning" }, note.text),

          React.createElement("div", { className: "closeRentalActions" },
            React.createElement("button", {
              type: "button", className: "resModalCancel",
              disabled: busy === k.kind,
              onClick: () => {
                setDrafts((p) => ({ ...p, [k.kind]: current }));
                setNotice((p) => ({ ...p, [k.kind]: null }));
                setEditing((p) => ({ ...p, [k.kind]: false }));
              },
            }, "Cancel"),
            React.createElement("button", {
              type: "button", className: "resModalSubmit",
              disabled: busy === k.kind || !trimmed || trimmed === current || tooLong || unknown.length > 0,
              onClick: () => save(k, trimmed),
            }, busy === k.kind ? "Saving..." : "Save")))
      );
    })
  );
}

function SettingsPage() {
  const { appSettings, saveSetting, fleet, guardAction, currentUser } = React.useContext(AppContext);
  const isExec = roleAtLeast(currentUser?.role, "Exec");

  const SECTS = [
    { key: "branch",  title: "Branch Information",    body: "Branch name, address, phone number, operating hours, and SIPP codes." },
    // Roles are described here but nothing enforces them: there is no users
    // table and the PIN is checked against the single signed-in user. Said
    // plainly so the panel does not read as a working feature.
    { key: "users",   title: "User Accounts",         body: "Staff, roles and join codes have moved to the Staff page. Roles are real for staff administration: only an Admin can promote, deactivate, or see the join code. Everywhere else in the app, an Agent and an Admin still have the same access." },
    { key: "notifs",  title: "Notification Settings", body: "Configure which events trigger notifications and to which staff members." },
    { key: "twilio",  title: "Twilio SMS Setup",      body: "Twilio Account SID, Auth Token, and sending phone number for AI call and text automation." },
    { key: "billing", title: "Billing Configuration", body: "Billing address, HST registration number, and invoice export settings." },
  ];
  const [sect, setSect] = React.useState({ gas: false, texts: true, ...Object.fromEntries(SECTS.map((s) => [s.key, true])) });
  const toggle = (key) => setSect((p) => ({ ...p, [key]: !p[key] }));

  // ── Gas collection settings ────────────────────────────────────────────────
  // Regions offered are the provinces/states actually represented in the fleet,
  // since a price is only ever looked up by a vehicle's province.
  const fleetRegions = React.useMemo(() => {
    const set = new Set(fleet.map((v) => v.province).filter(Boolean));
    const dflt = appSettings.gasDefaultRegion;
    if (dflt) set.add(dflt);
    return [...set].sort();
  }, [fleet, appSettings.gasDefaultRegion]);

  const gasPrices = appSettings.gasPrices || {};

  const [markupDraft, setMarkupDraft] = React.useState("");
  const [priceDrafts, setPriceDrafts] = React.useState({});
  const [savedFlash,  setSavedFlash]  = React.useState("");

  React.useEffect(() => {
    setMarkupDraft(appSettings.gasMarkupPercent != null ? String(appSettings.gasMarkupPercent) : "");
  }, [appSettings.gasMarkupPercent]);

  React.useEffect(() => {
    setPriceDrafts(Object.fromEntries(fleetRegions.map((r) => [r, gasPrices[r] != null ? String(fuelPriceForDisplay(gasPrices[r])) : ""])));
  }, [fleetRegions.join(","), JSON.stringify(gasPrices)]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (msg) => { setSavedFlash(msg); setTimeout(() => setSavedFlash(""), 2000); };

  // Both commits validate through the same shared rules the command bar uses, so
  // a number the settings page rejects is a number fleetr ai rejects too. An
  // unusable entry is reverted to the saved value rather than left on screen.
  const commitMarkup = async () => {
    const raw   = markupDraft.trim();
    const check = raw === "" ? { ok: false } : validateGasMarkup(raw);
    if (!check.ok) {
      setMarkupDraft(appSettings.gasMarkupPercent != null ? String(appSettings.gasMarkupPercent) : "");
      return;
    }
    const n = check.value;
    if (n === appSettings.gasMarkupPercent) return;
    guardAction("gas.markup", async () => {
      if (await saveSetting("gasMarkupPercent", n)) flash("Markup saved.");
    }, { tableName: "app_settings", recordId: "gasMarkupPercent", description: `Gas markup ${appSettings.gasMarkupPercent ?? "unset"}% -> ${n}%.` });
  };

  const commitPrice = async (region) => {
    const raw = (priceDrafts[region] || "").trim();
    // Blank clears the price for that region, which is a real choice: it puts
    // that region's gas charges back to manual entry.
    const check = raw === "" ? { ok: true, value: null } : validateGasPrice(raw);
    if (!check.ok) {
      setPriceDrafts((p) => ({ ...p, [region]: gasPrices[region] != null ? String(fuelPriceForDisplay(gasPrices[region])) : "" }));
      return;
    }
    // Typed per the company's fuel unit, stored per litre. An unchanged
    // gallon figure is not saved again, which would only move it by rounding.
    if (check.value !== null && check.value === fuelPriceForDisplay(gasPrices[region])) return;
    const n = check.value === null ? null : fuelPriceToLitre(check.value);
    if (n === (gasPrices[region] ?? null)) return;
    const next = { ...gasPrices };
    if (n === null) delete next[region]; else next[region] = n;
    guardAction("gas.regionPrice", async () => {
      if (await saveSetting("gasPrices", next)) flash(`${region} price saved.`);
    }, { tableName: "app_settings", recordId: region, description: `${region} fuel price ${gasPrices[region] ?? "unset"} -> ${n ?? "cleared"} per litre.` });
  };

  const missingTank = fleet.filter((v) => v.tankSizeLiters == null).length;

  const gasBody = React.createElement(React.Fragment, null,
    React.createElement("p", { className: "aiTabDesc" },
      "On return, if the vehicle comes back with less fuel than it left with, the charge is calculated as ",
      React.createElement("em", null, `${fuelUnitWord()} short × price per ${fuelUnitWord(false)} × (1 + markup)`),
      " and written to Gas Collections automatically. Any missing value below leaves the charge blank for manual entry."
    ),

    React.createElement("div", { className: "gasSettingRow" },
      React.createElement("label", { className: "gasSettingLabel" }, "Markup"),
      React.createElement("div", { className: "gasSettingControl" },
        React.createElement("input", {
          type: "number", min: "0", step: "1", className: "gasSettingInput",
          placeholder: "e.g. 15", value: markupDraft,
          onChange: (e) => setMarkupDraft(e.target.value),
          onBlur: commitMarkup,
          onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); },
        }),
        React.createElement("span", { className: "gasSettingUnit" }, "%")
      )
    ),

    React.createElement("div", { className: "gasSettingSubhead" }, `Price per ${fuelUnitWord(false)} by region`),
    fleetRegions.length === 0
      ? React.createElement("div", { className: "resvEmpty", style: { textAlign: "left", padding: "10px 0" } },
          "No vehicle regions yet. Add a vehicle with a province to set its fuel price.")
      : fleetRegions.map((region) =>
          React.createElement("div", { className: "gasSettingRow", key: region },
            React.createElement("label", { className: "gasSettingLabel" }, region),
            React.createElement("div", { className: "gasSettingControl" },
              React.createElement("span", { className: "gasSettingUnit" }, "$"),
              React.createElement("input", {
                type: "number", min: "0", step: "0.001", className: "gasSettingInput",
                placeholder: "Not set", value: priceDrafts[region] ?? "",
                onChange: (e) => setPriceDrafts((p) => ({ ...p, [region]: e.target.value })),
                onBlur: () => commitPrice(region),
                onKeyDown: (e) => { if (e.key === "Enter") e.target.blur(); },
              }),
              React.createElement("span", { className: "gasSettingUnit" }, `/ ${fuelUnit()}`),
              gasPrices[region] == null &&
                React.createElement("span", { className: "tankSizeMissing" }, "Not set")
            )
          )
        ),

    missingTank > 0 && React.createElement("div", { className: "tankSizeBanner", style: { marginTop: "14px", marginBottom: 0 } },
      React.createElement("strong", null, `${missingTank} vehicle${missingTank === 1 ? "" : "s"} still missing a tank size`),
      ". Gas charges stay manual for ", missingTank === 1 ? "it" : "them",
      " until set on the vehicle's detail page."
    ),

    savedFlash && React.createElement("div", { className: "addVehicleSuccess", style: { marginTop: "12px" } }, savedFlash)
  );
  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Settings"),
    React.createElement("div", { className: "page__titleUnderline" }),

    React.createElement(
      "section", { className: "dashboardSection", style: { marginBottom: "16px" } },
      React.createElement("div", { className: "dashboardSection__header" },
        React.createElement("div", { className: "dashboardSection__headerRow" },
          React.createElement("span", null, "Gas Collection"),
          React.createElement("button", { type: "button", className: "sectionToggleCircle", onClick: () => toggle("gas") }, sect.gas ? "+" : "−")
        )
      ),
      !sect.gas && React.createElement("div", { className: "dashboardSection__body" }, gasBody)
    ),

    isExec && React.createElement(
      "section", { className: "dashboardSection", style: { marginBottom: "16px" } },
      React.createElement("div", { className: "dashboardSection__header" },
        React.createElement("div", { className: "dashboardSection__headerRow" },
          React.createElement("span", null, "Customer texts"),
          React.createElement("button", { type: "button", className: "sectionToggleCircle", onClick: () => toggle("texts") }, sect.texts ? "+" : "−")
        )
      ),
      !sect.texts && React.createElement("div", { className: "dashboardSection__body" }, React.createElement(CustomerTextsSettings))
    ),

    SECTS.map(({ key, title, body }) =>
      React.createElement(
        "section", { key, className: "dashboardSection", style: { marginBottom: "16px" } },
        React.createElement("div", { className: "dashboardSection__header" },
          React.createElement("div", { className: "dashboardSection__headerRow" },
            React.createElement("span", null, title),
            React.createElement("button", { type: "button", className: "sectionToggleCircle", onClick: () => toggle(key) }, sect[key] ? "+" : "−")
          )
        ),
        !sect[key] && React.createElement("div", { className: "dashboardSection__body" },
          React.createElement("p", { className: "aiTabDesc", style: { marginBottom: 0 } }, body),
          React.createElement("div", { className: "resvEmpty", style: { marginTop: "16px" } }, "Settings UI will appear here.")
        )
      )
    )
  );
}

// ─── useMobile ───────────────────────────────────────────────────────────────

function useMobile() {
  const [isMobile, setIsMobile] = React.useState(
    () => window.matchMedia("(max-width: 767px)").matches
  );
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

// ─── MobileNav ───────────────────────────────────────────────────────────────

function MobileNav() {
  const [open, setOpen] = React.useState(false);
  const { signOut } = React.useContext(AppContext);
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "header",
      { className: "mobileTopbar" },
      React.createElement(
        "button",
        {
          type: "button",
          className: "mobileHamburger",
          "aria-label": open ? "Close menu" : "Open menu",
          onClick: () => setOpen((o) => !o),
        },
        React.createElement(
          "svg",
          { width: "20", height: "20", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" },
          open
            ? React.createElement(React.Fragment, null,
                React.createElement("line", { x1: "18", y1: "6", x2: "6", y2: "18" }),
                React.createElement("line", { x1: "6", y1: "6", x2: "18", y2: "18" })
              )
            : React.createElement(React.Fragment, null,
                React.createElement("line", { x1: "3", y1: "6", x2: "21", y2: "6" }),
                React.createElement("line", { x1: "3", y1: "12", x2: "21", y2: "12" }),
                React.createElement("line", { x1: "3", y1: "18", x2: "21", y2: "18" })
              )
        )
      ),
      React.createElement("span", { className: "mobileTopbar__wordmark" }, "fleetr"),
      React.createElement(
        "button",
        {
          type: "button",
          className: "mobileTopbar__signOut",
          onClick: signOut,
        },
        "Sign Out"
      )
    ),
    open && React.createElement(
      "div",
      {
        className: "mobileNavOverlay",
        onClick: (e) => { if (e.target === e.currentTarget) setOpen(false); },
      },
      React.createElement(
        "nav",
        { className: "mobileNavDrawer" },
        visibleNavSections().map((section) =>
          React.createElement(
            "section",
            { key: section.header, className: "mobileNavSection" },
            React.createElement("h2", { className: "mobileNavSectionHeader" }, section.header),
            section.items.map((item) =>
              React.createElement(
                NavLink,
                {
                  key: item.path,
                  to: item.path,
                  className: ({ isActive }) =>
                    isActive ? "mobileNavItem mobileNavItem--active" : "mobileNavItem",
                  onClick: () => setOpen(false),
                },
                item.label
              )
            )
          )
        )
      )
    )
  );
}

// ─── MobileCommandBar ────────────────────────────────────────────────────────

// The bar used to render a collapsed "pill" button that only set expanded
// state, swapping in the real FleetrCommandBar on tap. The pill was a mock-up:
// same rounded shape, same mic glyph, same "Ask fleetr ai…" text, but no input
// and no mic button behind it. So the first tap only brought the real controls
// into existence and the second tap was the one that did anything, which is
// what made the bar feel like it needed two taps to wake up.
//
// Rendering the real bar always removes the problem at the source rather than
// working around it. Tapping the input is a plain tap on a real input, so the
// browser focuses it and raises the keyboard itself, with no programmatic
// focus() that mobile Safari could refuse for happening outside a gesture. The
// mic is the real button, so one tap starts listening. This is also how the bar
// behaves on desktop, which is what the two were supposed to match.
function MobileCommandBar() {
  return React.createElement(
    "div",
    { className: "mobileBottomBar" },
    React.createElement(FleetrCommandBar)
  );
}

// ─── Topbar ──────────────────────────────────────────────────────────────────

function Topbar() {
  const { signOut } = React.useContext(AppContext);
  return React.createElement(
    "header",
    { className: "topbar" },
    React.createElement("div", { className: "topbar__pills" },
      React.createElement("select", {
        className: "pill pill--select",
        defaultValue: "",
      }, React.createElement("option", { value: "", disabled: true }, "Location")),
      React.createElement("select", {
        className: "pill pill--select",
        defaultValue: "",
      }, React.createElement("option", { value: "", disabled: true }, "Region"))
    ),
    // Not rendered at all when the company has it off. Sign Out is pushed
    // right by its own margin-left: auto, so the topbar needs no stand-in.
    isFeatureEnabled("ai_command_bar") && React.createElement(FleetrCommandBar),
    React.createElement("button", {
      onClick: signOut,
      style: {
        marginLeft: "auto",
        background: "transparent",
        border: "1px solid rgba(255,255,255,0.15)",
        color: "rgba(255,255,255,0.45)",
        fontFamily: "'Inter', sans-serif",
        fontSize: "0.78rem",
        fontWeight: "500",
        padding: "5px 14px",
        borderRadius: "999px",
        cursor: "pointer",
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      },
    }, "Sign Out")
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar() {
  return React.createElement(
    "aside",
    { className: "sidebar" },
    visibleNavSections().map((section) =>
      React.createElement(
        "section",
        { key: section.header, className: "sidebar__section" },
        React.createElement(
          "h2",
          { className: "sidebar__sectionHeader" },
          section.header
        ),
        React.createElement(
          "nav",
          { className: "nav" },
          section.items.map((item) =>
            React.createElement(
              NavLink,
              {
                key: item.path,
                to: item.path,
                className: ({ isActive }) =>
                  isActive ? "nav__item nav__item--active" : "nav__item",
              },
              React.createElement("span", { className: "nav__label" }, item.label)
            )
          )
        )
      )
    )
  );
}

// ─── PlaceholderPage ─────────────────────────────────────────────────────────

function PlaceholderPage({ title }) {
  return React.createElement(
    "div",
    { className: "page" },
    React.createElement("h1", { className: "page__title" }, title),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(
      "p",
      { className: "page__body" },
      "Placeholder content. Replace this section with the module UI for ",
      title,
      "."
    )
  );
}

// ─── Fleetr AI Command Bar ───────────────────────────────────────────────────

// What the command bar says when asked about intake for a company that has
// non_drive_intake off. One string, used by the prompt and by both refusals,
// so the answer is the same whichever of them catches the request.
const NDI_DISABLED_MESSAGE = "Non-drive intake isn't enabled for this company.";

// Pre-rental check has no table of its own: it is the preRentalCheck field on
// reservations. So with pre_rental_check off, that field is stripped from the
// reservations the command bar sends, and an update that would set it is
// refused. Inserts are unaffected, since a new reservation always takes the
// default status regardless of what the model asks for.
const PRC_DISABLED_MESSAGE = "Pre-rental check isn't enabled for this company.";
const isPreRentalCheckEdit = (table, operation, data) =>
  table === "reservations" && operation === "update" &&
  !!data && Object.prototype.hasOwnProperty.call(data, "preRentalCheck");

function FleetrCommandBar() {
  const { guardAction, logAudit, currentUser, reservations, setReservations, rentalAgreements, setRentalAgreements, syncRAStatus, fleet, setFleet, ndiRows, setNdiRows, noShows, setNoShows, damageClaims, setDamageClaims, appSettings, saveSetting } = React.useContext(AppContext);
  const [command,        setCommand]        = React.useState("");
  const [aiMessage,      setAiMessage]      = React.useState("");
  const [pendingAction,  setPendingAction]  = React.useState(null);
  const [aiLoading,      setAiLoading]      = React.useState(false);
  const [actionLoading,  setActionLoading]  = React.useState(false);
  const [actionDone,     setActionDone]     = React.useState(false);
  const [editableData,   setEditableData]   = React.useState({});
  const [showPopover,    setShowPopover]    = React.useState(false);
  const [isListening,    setIsListening]    = React.useState(false);
  const wrapperRef     = React.useRef(null);
  const recognitionRef = React.useRef(null);
  const micTimeoutRef  = React.useRef(null);

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const speechSupported   = !!SpeechRecognition;

  // The regions a fuel price can be set for, computed the same way the Settings
  // page computes them: the provinces the fleet is actually in, plus the default.
  const gasRegions = React.useMemo(() => {
    const set = new Set(fleet.map((v) => v.province).filter(Boolean));
    if (appSettings.gasDefaultRegion) set.add(appSettings.gasDefaultRegion);
    return [...set].sort();
  }, [fleet, appSettings.gasDefaultRegion]);

  const stopMic = () => {
    clearTimeout(micTimeoutRef.current);
    recognitionRef.current?.stop();
  };

  const handleMic = () => {
    if (!speechSupported) return;
    if (isListening) {
      stopMic();
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang            = "en-US";
    recognition.continuous      = true;
    recognition.interimResults  = true;
    recognition.maxAlternatives = 1;
    recognition.onstart  = () => setIsListening(true);
    recognition.onend    = () => { clearTimeout(micTimeoutRef.current); setIsListening(false); };
    recognition.onerror  = () => { clearTimeout(micTimeoutRef.current); setIsListening(false); };
    recognition.onresult = (e) => {
      // Accumulate all final segments; append latest interim for real-time feedback
      let finalText = "";
      let interimText = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText    += e.results[i][0].transcript;
        else                       interimText  += e.results[i][0].transcript;
      }
      setCommand((finalText + interimText).trim());
    };
    recognitionRef.current = recognition;
    recognition.start();
    // Auto-stop after 60 seconds
    micTimeoutRef.current = setTimeout(() => recognition.stop(), 60000);
  };

  // Close popover when clicking outside
  React.useEffect(() => {
    if (!showPopover) return;
    function onOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowPopover(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [showPopover]);

  // Sync editableData whenever a new pendingAction arrives
  React.useEffect(() => {
    setEditableData(pendingAction?.data ? { ...pendingAction.data } : {});
  }, [pendingAction]); // eslint-disable-line react-hooks/exhaustive-deps

  // Parse Claude's raw text — strip markdown fences if present, then JSON.parse
  const parseClaudeJSON = (raw) => {
    try {
      const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      return JSON.parse(stripped);
    } catch {
      return { message: raw };
    }
  };

  const callClaude = async (trimmed) => {
    console.log("callClaude fired");
    setAiLoading(true);
    setAiMessage("");
    setPendingAction(null);
    setActionDone(false);
    setShowPopover(true);
    try {
      const userMsg =
        // With pre_rental_check off, each reservation goes without its
        // preRentalCheck field, and the model is told why so it can say so.
        (isFeatureEnabled("pre_rental_check")
          ? `Reservations data: ${JSON.stringify(reservations)}\n\n`
          : `Reservations data: ${JSON.stringify(reservations.map(({ preRentalCheck, ...r }) => r))}\n\n` +
            `Pre-rental check: not enabled for this company, so pre-rental check status is not provided. ` +
            `If the command asks to view or change pre-rental check status (preRentalCheck on reservations), ` +
            `reply with the message "${PRC_DISABLED_MESSAGE}" and no action.\n\n`) +
        `Rental agreements data: ${JSON.stringify(rentalAgreements)}\n\n` +
        `Fleet data: ${JSON.stringify(fleet)}\n\n` +
        // With non_drive_intake off the rows are not sent at all, so they cannot
        // be read back, and the model is told why so it can say so.
        (isFeatureEnabled("non_drive_intake")
          ? `Non-drive intake data: ${JSON.stringify(ndiRows)}\n\n`
          : `Non-drive intake: not enabled for this company, so no intake data is provided. ` +
            `If the command asks to view or change non-drive intake (ndi_rows), reply with the message ` +
            `"${NDI_DISABLED_MESSAGE}" and no action.\n\n`) +
        `No-shows data: ${JSON.stringify(noShows)}\n\n` +
        `Damage claims data: ${JSON.stringify(damageClaims)}\n\n` +
        // Settings are read straight from app_settings rather than a table dump,
        // so the model can answer "what is the markup" without a write.
        `App settings: ${JSON.stringify(appSettings)}\n\n` +
        `Fleet regions with a fuel price that can be set: ${JSON.stringify(gasRegions)}\n\n` +
        `User command: ${trimmed}`;
      // The proxy verifies this token before spending anything on our Anthropic
      // key. Without it the endpoint was open to anyone who read this file and
      // found the URL, which is every visitor.
      const aiSession = supabase.auth.session();
      if (!aiSession) {
        // The finally below clears the loading state, so this only has to say
        // what happened. Matches how the other failure paths here report.
        setAiMessage("Your session has expired. Sign in again to use fleetr ai.");
        return;
      }
      const res = await fetch(CLAUDE_API_URL, {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
          "authorization":     `Bearer ${aiSession.access_token}`,
        },
        body: JSON.stringify({
          model:      CLAUDE_MODEL,
          max_tokens: 1024,
          system:     claudeSystem(),
          messages:   [{ role: "user", content: userMsg }],
        }),
      });
      const data = await res.json();
      console.log("Fleetr AI response:", res.status, res.ok, data);
      if (!res.ok) {
        console.warn("Fleetr AI API error:", data);
        setAiMessage(data?.error?.message || "fleetr ai returned an error. Please try again.");
      } else {
        const raw = data?.content?.[0]?.text || "{}";
        const parsed = parseClaudeJSON(raw);
        let hasAction = !!(parsed.action && parsed.action.table && parsed.action.operation);
        // The prompt asks the model not to propose intake actions when the
        // feature is off; this makes sure one never reaches the Confirm card if
        // it does anyway.
        if (hasAction && parsed.action.table === "ndi_rows" && !isFeatureEnabled("non_drive_intake")) {
          console.warn("Fleetr AI proposed an ndi_rows action with non_drive_intake off; dropped.");
          parsed.message = NDI_DISABLED_MESSAGE;
          hasAction = false;
        }
        if (hasAction && !isFeatureEnabled("pre_rental_check") &&
            isPreRentalCheckEdit(parsed.action.table, parsed.action.operation, parsed.action.data)) {
          console.warn("Fleetr AI proposed a preRentalCheck edit with pre_rental_check off; dropped.");
          parsed.message = PRC_DISABLED_MESSAGE;
          hasAction = false;
        }
        // "Done." next to a Confirm button that has not been pressed is the same
        // lie the tense rule in the system prompt exists to prevent, so the
        // fallback depends on whether anything is still waiting to run.
        setAiMessage(parsed.message || (hasAction ? "Review the action below." : "Done."));
        if (hasAction) {
          setPendingAction(parsed.action);
        }
        console.log("Fleetr command submitted:", trimmed, "| parsed:", parsed);
      }
    } catch (e) {
      console.warn("Fleetr AI network error:", e);
      setAiMessage("Could not reach fleetr ai. Check your connection and API key.");
    } finally {
      setAiLoading(false);
    }
  };

  // Execute the pending Supabase action and update React state.
  //
  // This used to raise the PIN for every operation without exception, which made
  // the command bar stricter than the UI it is meant to mirror. It now resolves
  // the same ACTION_POLICY the UI uses, so a note and a deletion are no longer
  // treated alike. Pressing Confirm on the action card is itself the affirmative
  // step, so the "confirm" tier runs directly from here.
  //
  // The tier is computed from the EDITED payload, not the model's original, so a
  // staff member who types a money field into the card cannot land in the lighter
  // tier than the field deserves.
  // Reuses the same channel a failed Supabase write reports through, and drops
  // the pending action so the Confirm button cannot be pressed again.
  // A refusal happens before guardAction is ever reached, so it has to record
  // itself. These are worth keeping: they are the attempts the rules stopped.
  const abortAction = (msg, ctx) => {
    console.warn("Fleetr AI action blocked by a write rule:", msg, ctx);
    const key = commandBarActionKey({
      table:     pendingAction?.table,
      operation: pendingAction?.operation,
      data:      editableData,
      pmVehicle: ctx?.pmVehicle,
    });
    logAudit({
      actor:       AI_ACTOR,
      actionType:  key,
      tableName:   pendingAction?.table || null,
      recordId:    auditRecordId(pendingAction?.table, pendingAction?.match, editableData, { damageClaims, rentalAgreements }),
      outcome:     "refused",
      description: `${msg} Asked by ${actorName(currentUser)}.`,
    });
    setAiMessage(msg);
    setPendingAction(null);
    setActionLoading(false);
  };

  const confirmAction = () => {
    // The rules run BEFORE the PIN, not inside the write. Asking someone to
    // authenticate an action that was already going to be refused teaches them
    // that the PIN prompt means nothing, and the two PM prompts are decisions to
    // make before authenticating rather than after.
    const plan = planAction();
    if (!plan.ok) return void abortAction(plan.error, { pendingAction, data: editableData });

    // The tier is computed from the RESOLVED plan, so it reflects the operation
    // actually about to run rather than the model's original wording, and a
    // staff member who types a money field into the card cannot land in a
    // lighter tier than the field deserves.
    const key = commandBarActionKey(plan);
    console.log("Fleetr command bar action tier:", key, actionTier(key));
    // Signed as fleetr ai, with the staff member who confirmed it named in the
    // description so the entry still leads back to a person.
    guardAction(key, () => executeAction(plan), {
      actor:       AI_ACTOR,
      tableName:   plan.table,
      recordId:    auditRecordId(plan.table, plan.match, plan.data, { damageClaims, rentalAgreements }),
      description: `${auditDescribe(plan.data) || plan.operation}. Asked by ${actorName(currentUser)}.`,
    });
  };

  // Resolves the pending action against the shared write rules and returns the
  // plan the write will follow, or the reason it cannot run. Touches no state
  // and reaches no network, so it is safe to run before the PIN is raised.
  const planAction = () => {
    if (!pendingAction) return { ok: false, error: "There is nothing to confirm." };
    const { table, match } = pendingAction;
    let operation = pendingAction.operation;
    let data = editableData; // use user-edited values
    const fail = (error) => ({ ok: false, error });

    // The last line of defence for a gated feature: nothing writes to
    // ndi_rows through here while the company has it off, and the refusal is
    // audited like any other rule that stops an action.
    if (table === "ndi_rows" && !isFeatureEnabled("non_drive_intake")) return fail(NDI_DISABLED_MESSAGE);
    // Checked against the edited payload, so a field typed into the card is
    // caught as well as one the model proposed.
    if (!isFeatureEnabled("pre_rental_check") && isPreRentalCheckEdit(table, operation, data)) {
      return fail(PRC_DISABLED_MESSAGE);
    }

    // rentalAgreementStatus on reservations is a stale mirror of the column on
    // rental_agreements, refreshed from there at load. A plain update to it
    // reported success and then reverted on the next refresh, and it never moved
    // the vehicle to On Rent or Ready Returns. Anything asking for it is routed
    // to the lifecycle path below, which is what the UI buttons use.
    if (operation === "update" && data.rentalAgreementStatus &&
        (table === "reservations" || table === "rental_agreements")) {
      operation = "raStatus";
    }

    // Resolving a damage claim through the AI should stamp resolvedAt/updatedAt
    // the same way the "Mark as Resolved" button does.
    if (table === "damage_claims" && ["resolved", "settled", "closed"].includes(data.status)) {
      const now = new Date().toISOString();
      data = { ...data, resolvedAt: now, updatedAt: now };
    }

    // ── Shared write rules ────────────────────────────────────────────────────
    // Everything below is the same guard the UI runs. It used to live only in
    // React handlers, which is how the command bar was able to release a vehicle
    // from PM, open a rental on a flagged vehicle, and close an agreement with no
    // return time. Failing here stops the action before the PIN, let alone
    // before any Supabase call.

    if (table === "fleet" && operation === "insert") {
      if (data.vin)   data = { ...data, vin: normalizeVin(data.vin) };
      if (data.plate) data = { ...data, plate: normalizePlate(data.plate) };
      const check = validateVehicle(data);
      if (!check.ok) return fail(check.error);
      const readings = validateStartingReadings(data);
      if (!readings.ok) return fail(readings.error);
      data = { ...data, currentOdometer: readings.odometer, currentFuelLevel: readings.fuelLevel };
      // The AI could previously add a second vehicle on an existing plate; the
      // duplicate check lived only in the form's submit handler.
      const unique = validateVehicleUniqueness(data, fleet, null);
      if (!unique.ok) return fail(unique.error);
    }

    if (table === "fleet" && operation === "delete") {
      const check = validateRetirement(data);
      if (!check.ok) return fail(`${check.error} Retire it from Additions and Deletions so the archive keeps a record.`);
    }

    if (table === "reservations" && operation === "insert") {
      const check = validateReservation(data);
      if (!check.ok) return fail(check.error);
    }

    // Every field the Add Vehicle form collects is correctable on a vehicle
    // already in the fleet, under the same per-field rules the form applies.
    // A status change carries none of these and passes straight through.
    if (table === "fleet" && operation === "update") {
      const check = validateVehicleEdit(data, PROVINCE_CODES);
      if (!check.ok) return fail(check.error);

      // Stored the way the form stores them, so a spoken "a b c 1 2 3" and a
      // typed one land on the same string.
      if (data.plate)    data = { ...data, plate: normalizePlate(data.plate) };
      if (data.province) data = { ...data, province: String(data.province).trim().toUpperCase() };
      if (data.vin)      data = { ...data, vin: normalizeVin(data.vin) };

      const target = fleet.find((v) => Object.entries(match || {}).every(([k, val]) =>
        k === "plate" ? normalizePlate(v.plate) === normalizePlate(val) : String(v[k]) === String(val)
      ));

      // Passed as `self` so a vehicle keeping its own plate or VIN while some
      // other field changes is not reported as colliding with itself.
      const unique = validateVehicleUniqueness(data, fleet, target);
      if (!unique.ok) return fail(unique.error);

      // Other tables point at a vehicle by its plate string rather than its id,
      // so renaming a plate mid-rental orphans the agreement and any damage
      // claim against it. Corrections are for vehicles that are not out.
      if (data.plate) {
        const oldPlate = target?.plate;
        if (oldPlate && normalizePlate(oldPlate) !== normalizePlate(data.plate)) {
          const openRa = rentalAgreements.find((ra) =>
            normalizePlate(ra.plate || "") === normalizePlate(oldPlate) &&
            ra.rentalAgreementStatus && ra.rentalAgreementStatus !== "closed");
          if (openRa) {
            return fail(`${oldPlate} has a rental agreement that is not closed yet (${openRa.resCode}). Renaming its plate now would leave that agreement pointing at a plate no vehicle has. Close it first.`);
          }
        }
      }
    }

    // PM takes over a status change the same way it does in the UI.
    if (table === "fleet" && operation === "update" && data.status) {
      const target = fleet.find((v) => Object.entries(match || {}).every(([k, val]) => String(v[k]) === String(val)));
      const { status: finalStatus, forced, message } = resolvePmStatus(target, data.status);
      if (forced) {
        data = { ...data, status: finalStatus };
        window.alert(message);
      }
    }

    // ── Rental agreement lifecycle ────────────────────────────────────────────
    // Resolved up front so the PM soft block is raised before the PIN, matching
    // the order on the reservation page: staff are not asked to authenticate an
    // action they are about to cancel.
    let raResCode = null;
    if (operation === "raStatus") {
      const extra = Object.keys(data).filter((k) => k !== "rentalAgreementStatus");
      if (extra.length) {
        return fail(`A rental agreement status change cannot carry other fields (${extra.join(", ")}). Change those separately.`);
      }
      const check = validateRaStatus(data.rentalAgreementStatus);
      if (!check.ok) return fail(check.error);
      data = { rentalAgreementStatus: check.status };

      // The status is keyed by resCode whichever table the request named, so a
      // match on a rental agreement id resolves back to its reservation first.
      const matches = (row) => Object.entries(match || {}).every(([k, val]) => String(row[k]) === String(val));
      const raRow   = table === "rental_agreements" ? rentalAgreements.find(matches) : null;
      const res     = table === "rental_agreements"
        ? reservations.find((r) => r.resCode === raRow?.resCode)
        : reservations.find(matches);
      raResCode = res?.resCode || raRow?.resCode;
      if (!raResCode) return fail("Could not find that rental agreement.");

      // The same rule the buttons follow. Without this the command bar is a way
      // around them: the model can be asked to close an open rental and the
      // write is the one the buttons stopped offering.
      const fromStatus =
        rentalAgreements.find((x) => x.resCode === raResCode)?.rentalAgreementStatus
        || res?.rentalAgreementStatus;
      const allowed = manualRaTransition(fromStatus, check.status);
      if (!allowed.ok) return fail(allowed.error);

      if (check.status === "open_rental_agreement") {
        const ra    = raRow || rentalAgreements.find((x) => x.resCode === raResCode);
        const plate = ra?.plate || res?.plate;
        const veh   = plate ? fleet.find((v) => normalizePlate(v.plate) === normalizePlate(plate)) : null;
        if (!confirmRentalDespitePm(veh)) return fail("Cancelled. The vehicle is still flagged for preventative maintenance.");
      }
    }

    // ── PM Complete ───────────────────────────────────────────────────────────
    // The patch is computed here rather than taken from the model, so the new
    // baseline is always the odometer actually on file.
    let pmVehicle = null;
    if (operation === "pmComplete") {
      if (table !== "fleet") return fail("PM Complete only applies to a vehicle.");
      pmVehicle = fleet.find((v) => Object.entries(match || {}).every(([k, val]) =>
        k === "plate" ? normalizePlate(v.plate) === normalizePlate(val) : String(v[k]) === String(val)
      ));
      const check = resolvePmComplete(pmVehicle);
      if (!check.ok) return fail(check.error);
      data = check.patch;
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    let settingWrites = null;
    if (table === "app_settings") {
      if (operation !== "update") return fail("Settings can only be changed, not added or removed.");
      const check = resolveGasSettingsUpdate(data, appSettings.gasPrices, gasRegions);
      if (!check.ok) return fail(check.error);
      settingWrites = check.writes;
    }

    return { ok: true, table, operation, match, data, raResCode, pmVehicle, settingWrites };
  };

  const executeAction = async (plan) => {
    if (!plan?.ok) return;
    setActionLoading(true);
    const { table, operation, match, data, raResCode, pmVehicle, settingWrites } = plan;

    // One place that knows which React setter owns which table. The update,
    // insert and delete branches each used to carry their own if/else chain over
    // a DIFFERENT subset of tables, which is how deleting an ndi_rows, no_shows
    // or damage_claims row could succeed in Supabase while the row stayed on
    // screen until the next refresh.
    const SETTERS = {
      reservations:      setReservations,
      rental_agreements: setRentalAgreements,
      fleet:             setFleet,
      ndi_rows:          setNdiRows,
      no_shows:          setNoShows,
      damage_claims:     setDamageClaims,
    };
    const setLocal = SETTERS[table];
    const isMatch  = (row) => Object.keys(match || {}).every((k) => String(row[k]) === String(match[k]));

    try {
      let error = null;
      if (operation === "raStatus") {
        // syncRAStatus owns this: it writes rental_agreements, creates the
        // agreement if the reservation has none yet, and moves the vehicle to
        // On Rent or Ready Returns. Reproducing any of that here is how the two
        // paths would drift.
        await syncRAStatus(raResCode, data.rentalAgreementStatus);
        setReservations((prev) => prev.map((r) =>
          r.resCode === raResCode ? { ...r, rentalAgreementStatus: data.rentalAgreementStatus } : r
        ));
        // Closing stamps the return time, so a closed agreement always records
        // when the vehicle came back.
        if (RA_CLOSING_STATUSES.includes(data.rentalAgreementStatus)) {
          const stamp = raCloseStamp();
          ({ error } = await supabase.from("reservations").update(stamp).eq("resCode", raResCode));
          if (!error) {
            setReservations((prev) => prev.map((r) => (r.resCode === raResCode ? { ...r, ...stamp } : r)));
          }
        }
      } else if (operation === "pmComplete") {
        ({ error } = await supabase.from("fleet").update(data).eq("id", pmVehicle.id));
        if (!error) setFleet((prev) => prev.map((v) => (v.id === pmVehicle.id ? { ...v, ...data } : v)));
      } else if (table === "app_settings") {
        // saveSetting mirrors into appSettings state itself, so there is no
        // entry for app_settings in SETTERS.
        for (const [key, value] of settingWrites) {
          if (!(await saveSetting(key, value))) {
            error = { message: `Could not save ${key}.` };
            break;
          }
        }
      } else if (operation === "update") {
        let q = supabase.from(table).update(data);
        if (match) Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
        ({ error } = await q);
        if (!error && setLocal) {
          setLocal((prev) => prev.map((row) => (isMatch(row) ? { ...row, ...data } : row)));
        }
      } else if (operation === "insert") {
        let insertData = data;
        if (table === "reservations") {
          const resCode = await generateUniqueResCode();
          insertData = { ...data, resCode };
        } else if (table === "fleet") {
          insertData = { status: "Needs Cleaning", winterTires: "No", currentRenter: null, dueBack: null, fileType: null, ...data };
        }
        ({ error } = await supabase.from(table).insert(insertData));
        if (!error && setLocal) setLocal((prev) => [...prev, insertData]);
        if (!error && table === "reservations") requestReservationConfirmation(insertData.resCode);
      } else if (operation === "delete") {
        let q = supabase.from(table).delete();
        if (match) Object.entries(match).forEach(([k, v]) => { q = q.eq(k, v); });
        ({ error } = await q);
        if (!error && setLocal) setLocal((prev) => prev.filter((row) => !isMatch(row)));
      } else if (operation === "addNote") {
        // notesLog is an array and every UI path appends to it. A plain update
        // would replace the whole log and erase the history, so this reads the
        // current value first and pushes onto it. The read is the reason this is
        // its own operation rather than a field on update.
        const noteText = String(data?.text ?? data?.note ?? "").trim();
        if (!noteText) {
          error = { message: "A note needs some text." };
        } else {
          const idCol = table === "reservations" ? "resCode" : "id";
          const idVal = match?.[idCol] ?? Object.values(match || {})[0];
          const { data: rows, error: readErr } = await supabase
            .from(table).select(`${idCol},notesLog`).eq(idCol, idVal).limit(1);
          if (readErr) {
            error = readErr;
          } else if (!rows || rows.length === 0) {
            error = { message: "Could not find that record to add a note to." };
          } else {
            const existing = parseNotesLog(rows[0].notesLog);
            const newLog   = [...existing, { author: actorName(currentUser), text: noteText }];
            ({ error } = await supabase.from(table).update({ notesLog: newLog }).eq(idCol, idVal));
            if (!error && setLocal) {
              setLocal((prev) => prev.map((row) => (String(row[idCol]) === String(idVal) ? { ...row, notesLog: newLog } : row)));
            }
          }
        }
      } else if (operation === "confirmPickup" && table === "no_shows") {
        const row = noShows.find((r) => String(r.id) === String(match?.id));
        if (!row) {
          error = { message: "No-show record not found." };
        } else {
          const nameParts = (row.customer || "").trim().split(/\s+/);
          const newRes = {
            resCode:               row.rescode,
            customer:              row.customer || "",
            firstName:             nameParts[0] || "",
            lastName:              nameParts.slice(1).join(" ") || "",
            date:                  row.date || "",
            time:                  row.time || "",
            location:              row.location || "",
            vehicleClass:          row.vehicleClass || "",
            phone:                 row.phone || "",
            email:                 "",
            returnDate:            "",
            returnTime:            "",
            winterTires:           "No",
            source:                "",
            sourceDetail:          "",
            ratesVehicleClass:     "",
            dailyRate:             "",
            adjusterName:          "",
            claimNumber:           "",
            fileNumber:            "",
            authNumber:            "",
            poNumber:              "",
            paymentMethod:         "",
            preRentalCheck:        "NOT Pre-Rental Check'd",
            notesLog:              [],
            rentalAgreementStatus: "reservation",
            pickupStatus:          "Confirmed",
          };
          ({ error } = await supabase.from("reservations").insert(newRes));
          if (!error) {
            setReservations((prev) => [...prev, newRes]);
            ({ error } = await supabase.from("no_shows").delete().eq("id", row.id));
            if (!error) {
              setNoShows((prev) => prev.filter((r) => r.id !== row.id));
            }
          }
        }
      }
      if (error) {
        console.warn("Fleetr AI action error:", error);
        setAiMessage("Action failed: " + (error.message || "Unknown error."));
      } else {
        setActionDone(true);
        setPendingAction(null);
        console.log("Fleetr AI action executed:", operation, table, match, data);
      }
    } catch (e) {
      console.warn("Fleetr AI action exception:", e);
      setAiMessage("Action failed: " + e.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSend = () => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if (isListening) stopMic();
    setCommand("");
    callClaude(trimmed);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleSend(); }
  };

  return React.createElement(
    "div",
    { className: "fleetrCommandBar", ref: wrapperRef },

    // Mic button (left)
    React.createElement(
      "button",
      {
        type: "button",
        className: "fleetrCommandBar__iconBtn" + (isListening ? " fleetrCommandBar__iconBtn--listening" : ""),
        "aria-label": speechSupported ? (isListening ? "Stop listening" : "Voice input") : "Voice not supported in this browser",
        title: speechSupported ? undefined : "Voice not supported in this browser",
        onClick: handleMic,
        onKeyDown: (e) => { if (e.key === "Enter" && command.trim()) { e.preventDefault(); handleSend(); } },
        disabled: !speechSupported,
        style: speechSupported ? { outline: "none" } : { cursor: "not-allowed", opacity: 0.35, outline: "none" },
      },
      React.createElement(
        "svg",
        { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" },
        React.createElement("rect", { x: "9", y: "2", width: "6", height: "12", rx: "3" }),
        React.createElement("path", { d: "M5 10a7 7 0 0 0 14 0" }),
        React.createElement("line", { x1: "12", y1: "19", x2: "12", y2: "22" }),
        React.createElement("line", { x1: "8",  y1: "22", x2: "16", y2: "22" })
      )
    ),

    // Text input
    React.createElement("input", {
      type:        "text",
      className:   "fleetrCommandBar__input",
      placeholder: "Ask fleetr ai…",
      value:       command,
      onChange:    (e) => setCommand(e.target.value),
      onKeyDown:   handleKeyDown,
    }),

    // Send button (right)
    React.createElement(
      "button",
      { type: "button", className: "fleetrCommandBar__sendBtn", "aria-label": "Send command", onClick: handleSend },
      React.createElement(
        "svg",
        { width: "15", height: "15", viewBox: "0 0 24 24", fill: "currentColor" },
        React.createElement("path", { d: "M2 21l21-9L2 3v7l15 2-15 2z" })
      )
    ),

    // Response popover
    showPopover && React.createElement(
      "div",
      { className: "fleetrCommandBar__popover" },
      React.createElement(
        "div",
        { className: "fleetrCommandBar__popoverHeader" },
        React.createElement("span", null, "fleetr ai")
      ),
      React.createElement(
        "div",
        { className: "fleetrCommandBar__popoverBody" },
        aiLoading
          ? React.createElement(
              "div",
              { className: "fleetrCommandBar__thinking" },
              React.createElement("span", { className: "fleetrCommandBar__dot" }),
              React.createElement("span", { className: "fleetrCommandBar__dot" }),
              React.createElement("span", { className: "fleetrCommandBar__dot" })
            )
          : React.createElement(
              React.Fragment,
              null,
              React.createElement("p", { className: "fleetrCommandBar__responseText" }, aiMessage),
              // Editable fields + Confirm — only when action is present and complete
              pendingAction && !actionDone && (() => {
                // Uses the shared validator rather than its own list. The old
                // local list also demanded returnDate, which no reservation form
                // has ever required, so the command bar was refusing bookings the
                // UI accepts.
                const isResInsert = pendingAction.table === "reservations" && pendingAction.operation === "insert";
                if (isResInsert && !validateReservation(pendingAction.data).ok) return null;
                return React.createElement(
                  React.Fragment,
                  null,
                  // Editable inputs for each data field — time fields get a time+AM/PM picker
                  Object.keys(editableData).length > 0 && (() => {
                    const isTimeKey      = (k) => /time/i.test(k) && !/date/i.test(k);
                    const isMeridiemKey  = (k) => /meridiem/i.test(k);
                    const isRawTimeKey   = (k) => k.toLowerCase() === "time"; // redundant when pickupTime present
                    const meridiemKeyFor = (tk) =>
                      tk.toLowerCase() === "time" ? "meridiem" : tk.replace(/Time$/, "Meridiem");
                    const meridiemValFor = (tk) => {
                      const mk = meridiemKeyFor(tk);
                      if (editableData[mk]) return editableData[mk];
                      return normalizeTo12h(editableData[tk], "AM").meridiem;
                    };
                    const timeDisplayFor = (tk) => {
                      const { digits } = normalizeTo12h(editableData[tk], meridiemValFor(tk));
                      return toDisplayTime(digits);
                    };
                    // Convert camelCase / lowercase key to "Title Case With Spaces"
                    const fieldLabel = (k) => {
                      // Insert space before each uppercase letter, then title-case each word
                      const spaced = k
                        .replace(/([A-Z])/g, " $1")          // camelCase → "camel Case"
                        .replace(/^./, (c) => c.toUpperCase()) // capitalise first char
                        .trim();
                      // Title-case every word
                      return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
                    };
                    const hasDedicatedTimeKey = Object.keys(editableData).some(
                      (k) => k.toLowerCase() === "pickuptime"
                    );
                    return React.createElement(
                      "div",
                      { className: "fleetrCommandBar__editFields" },
                      Object.entries(editableData)
                        .filter(([k]) => !isMeridiemKey(k)) // meridiem rendered alongside its time field
                        .filter(([k]) => !(isRawTimeKey(k) && hasDedicatedTimeKey)) // hide "time" when "pickupTime" present
                        .map(([key, val]) => {
                          if (isTimeKey(key)) {
                            const mk = meridiemKeyFor(key);
                            return React.createElement(
                              "label",
                              { key, className: "fleetrCommandBar__editLabel" },
                              React.createElement("span", { className: "fleetrCommandBar__editKey" }, fieldLabel(key)),
                              React.createElement(
                                "div",
                                { style: { display: "flex", gap: "4px", flex: 1 } },
                                React.createElement("input", {
                                  type: "text",
                                  inputMode: "numeric",
                                  placeholder: "H:MM",
                                  className: "fleetrCommandBar__editInput",
                                  style: { maxWidth: "72px" },
                                  value: timeDisplayFor(key),
                                  onChange: (e) => setEditableData((prev) => ({ ...prev, [key]: e.target.value.slice(0, 4) })),
                                }),
                                React.createElement(
                                  "select",
                                  {
                                    className: "fleetrCommandBar__editInput",
                                    style: { maxWidth: "62px", paddingLeft: "6px" },
                                    value: meridiemValFor(key),
                                    onChange: (e) => setEditableData((prev) => ({ ...prev, [mk]: e.target.value })),
                                  },
                                  React.createElement("option", { value: "AM" }, "AM"),
                                  React.createElement("option", { value: "PM" }, "PM")
                                )
                              )
                            );
                          }
                          return React.createElement(
                            "label",
                            { key, className: "fleetrCommandBar__editLabel" },
                            React.createElement("span", { className: "fleetrCommandBar__editKey" }, fieldLabel(key)),
                            React.createElement("input", {
                              type: "text",
                              className: "fleetrCommandBar__editInput",
                              value: val ?? "",
                              onChange: (e) => setEditableData((prev) => ({ ...prev, [key]: e.target.value })),
                            })
                          );
                        })
                    );
                  })(),
                  React.createElement(
                    "div",
                    { className: "fleetrCommandBar__actionRow" },
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "fleetrCommandBar__confirmBtn",
                        onClick: confirmAction,
                        disabled: actionLoading,
                      },
                      actionLoading ? "Applying…" : "Confirm"
                    )
                  )
                );
              })(),
              // Success badge after action completes
              actionDone && React.createElement(
                "div",
                { className: "fleetrCommandBar__actionDone" },
                "✓ Applied"
              )
            )
      )
    )
  );
}

function Layout() {
  const isMobile = useMobile();
  if (isMobile) {
    // The fixed bottom bar has room reserved for it below the content and in
    // the nav drawer. app--noCommandBar releases that room when the company
    // has the bar off, so there is no empty strip where it would have been.
    const showCommandBar = isFeatureEnabled("ai_command_bar");
    return React.createElement(
      "div",
      { className: showCommandBar ? "app app--mobile" : "app app--mobile app--noCommandBar" },
      React.createElement(MobileNav),
      React.createElement("main", { className: "content" }, React.createElement(AppRoutes)),
      showCommandBar && React.createElement(MobileCommandBar)
    );
  }
  return React.createElement(
    "div",
    { className: "app" },
    React.createElement(Sidebar),
    React.createElement(
      "div",
      { className: "main" },
      React.createElement(Topbar),
      React.createElement("main", { className: "content" }, React.createElement(AppRoutes))
    )
  );
}

// ─── PreRentalCheckPage ─────────────────────────────────────────────────────────────────

// What the pre-rental text did, from its notifications_sent row. status is
// what the worker did (claimed, then sent or failed); deliveryStatus is what
// Twilio reported afterwards through /twilio-status.
function preRentalTextStatus(note) {
  if (!note) return { label: "Not sent yet", title: "The text goes out automatically the business day before pickup." };
  if (note.status === "failed") return { label: "Failed", title: "Twilio refused the message when it was sent." };
  if (note.status !== "sent") return { label: "Queued", title: "Being sent now." };
  const d = note.deliveryStatus;
  if (d === "delivered" || d === "read") return { label: "Delivered", title: "Delivered to the customer's phone." };
  if (d === "undelivered" || d === "failed") {
    return { label: "Failed", title: `The carrier did not deliver it${note.errorCode ? ` (Twilio error ${note.errorCode})` : ""}.` };
  }
  if (d === "sent" || d === "sending") return { label: "Sent", title: "Handed to the carrier; waiting for delivery." };
  return { label: "Queued", title: "Accepted by Twilio; waiting to go out." };
}

// How often the page re-reads the statuses while it is open. Twilio's receipts
// land within seconds to minutes, and Realtime is not enabled on this project
// (see the note in App), so the page asks again rather than being told.
const PRE_RENTAL_STATUS_POLL_MS = 20000;

function PreRentalCheckPage() {
  const { reservations } = React.useContext(AppContext);
  const tomorrowIso = isoOffset(1);
  const tomorrowLabel = (() => {
    const d = new Date(`${tomorrowIso}T00:00:00`);
    return d.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  })();

  const tomorrowRows = reservations.filter((r) => r.date === tomorrowIso);

  // Each row's pre_rental text, by res code. Re-read on an interval and when
  // the tab comes back into view, so a status moves without a reload.
  const resCodesKey = tomorrowRows.map((r) => r.resCode).filter(Boolean).sort().join(",");
  const [textNotes, setTextNotes] = React.useState({});
  React.useEffect(() => {
    const codes = resCodesKey ? resCodesKey.split(",") : [];
    if (codes.length === 0) { setTextNotes({}); return undefined; }
    let live = true;
    const load = async () => {
      const { data, error } = await supabase.from("notifications_sent")
        .select("resCode, status, deliveryStatus, errorCode")
        .eq("type", "pre_rental").in("resCode", codes);
      if (!live) return;
      if (error) { console.warn("pre-rental text status load failed:", error); return; }
      setTextNotes(Object.fromEntries((data || []).map((n) => [n.resCode, n])));
    };
    load();
    const timer = setInterval(load, PRE_RENTAL_STATUS_POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [resCodesKey]);

  return React.createElement(
    "div",
    { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Pre-Rental Check"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(
      "p",
      { className: "aiTabDesc" },
      "An automated text is sent to each customer the business day before their pickup. No staff involvement required."
    ),
    React.createElement(
      "section",
      { className: "dashboardSection" },
      React.createElement(
        "div",
        { className: "dashboardSection__header" },
        React.createElement(
          "div",
          { className: "dashboardSection__headerRow" },
          React.createElement("span", null, "Tomorrow\u2019s Pickups \u2014 ",
            React.createElement("strong", null, tomorrowLabel)
          )
        )
      ),
      React.createElement(
        "div",
        { className: "dashboardSection__body" },
        tomorrowRows.length === 0
          ? React.createElement("div", { className: "resvEmpty" }, "No reservations scheduled for tomorrow.")
          : React.createElement(
              "table",
              { className: "dashboardTable" },
              React.createElement(
                "thead",
                null,
                React.createElement(
                  "tr",
                  null,
                  ["Time", "Location", "Res Code", "Customer", "Vehicle Class", "Winter Tires", "Text Status"].map((col) =>
                    React.createElement("th", { key: col }, col)
                  )
                )
              ),
              React.createElement(
                "tbody",
                null,
                tomorrowRows.map((row) =>
                  React.createElement(
                    "tr",
                    { key: row.resCode },
                    React.createElement("td", { key: `${row.resCode}-0` }, fmt12h(row.time)),
                    React.createElement("td", { key: `${row.resCode}-1` }, row.location),
                    React.createElement("td", { key: `${row.resCode}-2` }, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.resCode })),
                    React.createElement("td", { key: `${row.resCode}-3` }, React.createElement(CustomerLink, { name: row.customer, resCode: row.resCode, label: row.customer })),
                    React.createElement("td", { key: `${row.resCode}-4` }, row.vehicleClass),
                    React.createElement("td", { key: `${row.resCode}-5` }, row.winterTires),
                    React.createElement("td", { key: `${row.resCode}-6` }, (() => {
                      const st = preRentalTextStatus(textNotes[row.resCode]);
                      return React.createElement("span", { className: "preRentalCheckDone", title: st.title }, st.label);
                    })())
                  )
                )
              )
            )
      )
    )
  );
}


// ─── RentalAgreementDetail ────────────────────────────────────────────────────────────

// ─── AgreementVehicleHistory ─────────────────────────────────────────────────
// Every vehicle one rental agreement has been on, oldest first, from
// rental_agreement_vehicles. Make, model and plate come from the fleet by the
// row's vehicleId; a vehicle since retired has lost that link and shows as no
// longer in the fleet. Rows are identified to staff by position and plate,
// never by id.
const vehicleHistoryLabel = (leg, isLast) => {
  if (!leg.pickedUpAt) return "Pickup pending";
  if (!leg.endedAt) return "Current";
  if (leg.endReason === "switched_out") return "Switched out";
  if (leg.endReason === "returned") return "Returned";
  // Rows closed before endReason existed: a later row means the customer moved
  // onto another vehicle, none means this one came back at the end.
  return isLast ? "Returned" : "Switched out";
};

// The protection the customer accepted or declined at pickup, as
// complete_pickup recorded it: names and prices as they stood then, so a later
// rename or reprice does not change what is shown. Read-only.
function ProtectionChoicesList({ rentalAgreementId }) {
  const { rentalAgreements } = React.useContext(AppContext);
  const ra = rentalAgreementId
    ? (rentalAgreements || []).find((a) => String(a.id) === String(rentalAgreementId))
    : null;
  const choices = ra && Array.isArray(ra.protectionChoices) ? ra.protectionChoices : null;
  const el = React.createElement;

  if (!choices) {
    return el("div", { className: "customerPlaceholder" },
      ra ? "This rental was opened before protection was offered on the fleetr app." : "Shown once the customer picks up on the fleetr app.");
  }
  if (choices.length === 0) {
    return el("div", { className: "customerPlaceholder" }, "No protection was offered for this rental's source and vehicle class.");
  }
  const fmtWhen = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime())
      ? d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "-";
  };
  const fmtPrice = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : "-");
  return el("div", { style: { overflowX: "auto" } },
    el("table", { className: "dashboardTable", style: { minWidth: "520px" } },
      el("thead", null, el("tr", null,
        ["Product", "Choice", "Price per day", "Time"].map((h) => el("th", { key: h }, h)))),
      el("tbody", null, choices.map((c, i) => el("tr", { key: c.productId || i },
        el("td", null, c.name || "-"),
        el("td", null, c.accepted ? (c.required ? "Included" : "Accepted") : "Declined"),
        el("td", null, fmtPrice(c.pricePerDay)),
        el("td", null, fmtWhen(c.decidedAt)))))));
}

// ─── The contract signed at pickup ────────────────────────────────────────────
// What complete_pickup recorded from the customer app's Contract step: the
// drivers, the deductibles and the acknowledgements version, with the pickup
// signature. Read-only. An agreement from before the Contract step has none
// of it, and the sections are then left out altogether.
const contractDrivers = (ra) => (ra && Array.isArray(ra.drivers) && ra.drivers.length ? ra.drivers : null);
const contractDeductibles = (ra) =>
  (ra && ra.deductibles && typeof ra.deductibles === "object" ? ra.deductibles : null);

const fmtContractDate = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return iso || "-";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
};
const fmtContractMoney = (n) => (n != null && Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : "Not set");

function ContractDriversList({ rentalAgreementId }) {
  const { rentalAgreements } = React.useContext(AppContext);
  const ra = (rentalAgreements || []).find((a) => String(a.id) === String(rentalAgreementId)) || null;
  const drivers = contractDrivers(ra);
  if (!drivers) return null;
  const el = React.createElement;
  return el("div", { style: { overflowX: "auto" } },
    el("table", { className: "dashboardTable", style: { minWidth: "760px" } },
      el("thead", null, el("tr", null,
        ["", "Name", "Address", "Date of birth", "Licence", "Province", "Issued", "Expires"].map((h, i) => el("th", { key: i }, h)))),
      el("tbody", null, drivers.map((d, i) => el("tr", { key: i },
        el("td", { style: { fontWeight: 600 } }, i === 0 ? "Main" : "Other driver"),
        el("td", null, [d.firstName, d.lastName].filter(Boolean).join(" ") || "-"),
        el("td", null, [d.street, d.city, [d.province, d.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "-"),
        el("td", null, fmtContractDate(d.dateOfBirth)),
        el("td", null, d.licenceNumber || "-"),
        el("td", null, d.licenceProvince || d.province || "-"),
        el("td", null, fmtContractDate(d.licenceIssued)),
        el("td", null, fmtContractDate(d.licenceExpiry)))))));
}

function ContractDeductiblesList({ rentalAgreementId }) {
  const { rentalAgreements } = React.useContext(AppContext);
  const ra = (rentalAgreements || []).find((a) => String(a.id) === String(rentalAgreementId)) || null;
  const ded = contractDeductibles(ra);
  if (!ded) return null;
  const el = React.createElement;
  return el("div", { className: "rentalAgreementFields" },
    el("div", { className: "rentalAgreementField" },
      el("span", { className: "rentalAgreementFieldLabel" }, "Collision"),
      el("span", { className: "rentalAgreementFieldValue" }, fmtContractMoney(ded.collision))),
    el("div", { className: "rentalAgreementField" },
      el("span", { className: "rentalAgreementFieldLabel" }, "Comprehensive"),
      el("span", { className: "rentalAgreementFieldValue" }, fmtContractMoney(ded.comprehensive))));
}

// The version is read by its id, so the text shown is exactly what the
// customer read, whatever the company has saved since.
function ContractAcknowledgementRecord({ rentalAgreementId }) {
  const { rentalAgreements } = React.useContext(AppContext);
  const ra = (rentalAgreements || []).find((a) => String(a.id) === String(rentalAgreementId)) || null;
  const ackId = ra?.acknowledgementId || null;
  const [version, setVersion] = React.useState(undefined);
  React.useEffect(() => {
    if (!ackId) { setVersion(undefined); return undefined; }
    let live = true;
    supabase.from("contract_acknowledgements").select("version,body,createdAt").eq("id", ackId).maybeSingle()
      .then(({ data, error }) => { if (live) setVersion(error ? null : data || null); });
    return () => { live = false; };
  }, [ackId]);
  if (!ackId) return null;
  const el = React.createElement;
  const sig = /^data:image\/(png|jpeg);base64,/.test(String(ra?.pickupSignature || "")) ? ra.pickupSignature : null;
  return el("div", null,
    version === undefined && el("div", { className: "customerPlaceholder" }, "Loading\u2026"),
    version === null && el("div", { className: "customerPlaceholder" }, "The acknowledgements could not be loaded."),
    version && el(React.Fragment, null,
      el("p", { className: "closeRentalHint" }, `Version ${version.version}, agreed to at pickup:`),
      el("div", { className: "closeRentalSummary", style: { whiteSpace: "pre-line" } }, version.body)),
    sig && el(React.Fragment, null,
      el("p", { className: "closeRentalHint" }, "Signature"),
      el("img", { src: sig, alt: "Pickup signature", style: { maxWidth: "320px", width: "100%", background: "#fff", borderRadius: "6px" } })));
}

// ─── Photos & Signatures ──────────────────────────────────────────────────────
// Every photo taken for one rental, from its folder in the private
// damage-photos bucket (<operatorId>/rental-agreements/<id>/), and the
// signatures on file.
//
// Photos are listed and shown through signed links that expire after five
// minutes, minted again when one is opened full size. Both the listing and
// the link are reads, and the bucket's "read own" policy only lets staff read
// their own company's folder, so another company's rental shows nothing.
//
// Where a photo belongs comes from its file name and when it was taken:
//   pickup-*        the customer app at pickup. Matched to the vehicle the
//                   customer picked up then: the first is the Pickup, a later
//                   one is the pickup after a switch-out.
//   return-*        the customer app at return: the Return.
//   <stamp>-<id>    staff, in Close Rental or Switch Out: matched to the
//                   vehicle whose time on the rental ended nearest to it, a
//                   Return or a Switch-out depending on how that time ended.
const RENTAL_PHOTO_LINK_SECONDS = 300;

const rentalPhotoLink = async (path) => {
  const res = await supabase.storage.from(DAMAGE_PHOTO_BUCKET).createSignedUrl(path, RENTAL_PHOTO_LINK_SECONDS);
  return res?.data?.signedURL || res?.data?.signedUrl || res?.signedURL || null;
};

// When a photo was taken, from its file name, else when it was stored.
function rentalPhotoTime(name, createdAt) {
  const customer = /-(\d{12,14})-\d+\.\w+$/.exec(name);
  if (customer) return new Date(Number(customer[1]));
  const staff = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/.exec(name);
  if (staff) return new Date(Date.UTC(+staff[1], +staff[2] - 1, +staff[3], +staff[4], +staff[5], +staff[6]));
  const d = createdAt ? new Date(createdAt) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

const RENTAL_PHOTO_LABELS = {
  "pickup-damage": "Damage", "pickup-odometer": "Odometer",
  "return-damage": "Damage", "return-odometer": "Odometer", "return-fuel": "Fuel",
};

// Which event and vehicle a photo belongs to. legs are the rental's vehicle
// history rows, oldest first.
function placeRentalPhoto(name, time, legs) {
  const t = time ? time.getTime() : null;
  const ms = (iso) => (iso ? new Date(iso).getTime() : NaN);
  const prefix = (/^(pickup|return)-[a-z]+/.exec(name) || [])[0] || null;
  const label = RENTAL_PHOTO_LABELS[prefix] || "Staff photo";

  if (prefix && prefix.startsWith("pickup")) {
    // The latest vehicle picked up at or before the photo. Photos upload just
    // after the pickup is recorded, so a minute of slack covers clock drift.
    let idx = -1;
    legs.forEach((l, i) => { if (t != null && ms(l.pickedUpAt) <= t + 60000) idx = i; });
    if (idx < 0 && legs.length) idx = 0;
    return { event: idx > 0 ? "Switch-out" : "Pickup", leg: legs[idx] || null, label };
  }
  if (prefix && prefix.startsWith("return")) {
    const returned = [...legs].reverse().find((l) => l.endReason === "returned") || legs[legs.length - 1] || null;
    return { event: "Return", leg: returned, label };
  }
  // Staff: the vehicle whose time ended nearest the photo.
  let best = null, bestGap = Infinity;
  legs.forEach((l) => {
    const end = ms(l.endedAt);
    if (Number.isNaN(end) || t == null) return;
    const gap = Math.abs(end - t);
    if (gap < bestGap) { bestGap = gap; best = l; }
  });
  return { event: best && best.endReason === "switched_out" ? "Switch-out" : "Return", leg: best || legs[legs.length - 1] || null, label };
}

function RentalPhotoTile({ photo, onOpen }) {
  const [url, setUrl] = React.useState(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    rentalPhotoLink(photo.path)
      .then((u) => { if (!live) return; if (u) setUrl(u); else setFailed(true); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [photo.path]);
  const when = photo.time
    ? photo.time.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "Time unknown";
  return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px", width: "96px" } },
    failed
      ? React.createElement("div", { className: "damagePhotoThumb damagePhotoThumb--empty" }, "Photo unavailable")
      : !url
        ? React.createElement("div", { className: "damagePhotoThumb damagePhotoThumb--empty" }, "Loading...")
        : React.createElement("button", {
            type: "button", className: "damagePhotoThumb", "aria-label": `View ${photo.label} photo full size`,
            onClick: () => onOpen(photo.path),
          }, React.createElement("img", { src: url, alt: `${photo.label} photo` })),
    React.createElement("div", { style: { fontSize: "11px", lineHeight: 1.3 } }, photo.label),
    React.createElement("div", { style: { fontSize: "11px", lineHeight: 1.3, opacity: 0.7 } }, when));
}

function RentalPhotosAndSignatures({ rentalAgreementId }) {
  const { rentalAgreements, fleet, archivedVehicles } = React.useContext(AppContext);
  const ra = rentalAgreementId
    ? (rentalAgreements || []).find((a) => String(a.id) === String(rentalAgreementId))
    : null;
  const [state, setState] = React.useState({ loading: true, photos: [], legs: [], error: null });
  const [viewing, setViewing] = React.useState(null);

  React.useEffect(() => {
    if (!ra?.id || !ra?.operatorId) { setState({ loading: false, photos: [], legs: [], error: null }); return undefined; }
    let live = true;
    setState((p) => ({ ...p, loading: true, error: null }));
    (async () => {
      const folder = `${ra.operatorId}/rental-agreements/${ra.id}`;
      const [listed, legsRes] = await Promise.all([
        supabase.storage.from(DAMAGE_PHOTO_BUCKET).list(folder, { limit: 1000, sortBy: { column: "name", order: "asc" } }),
        supabase.from("rental_agreement_vehicles")
          .select("id, vehicleId, startedAt, pickedUpAt, endedAt, endReason, pickupSignature")
          .eq("rentalAgreementId", ra.id).order("startedAt", { ascending: true }),
      ]);
      if (!live) return;
      if (listed?.error) console.warn("rental photos list failed:", listed.error);
      if (legsRes?.error) console.warn("rental photos vehicle history failed:", legsRes.error);
      const legs = legsRes?.data || [];
      const photos = (listed?.data || [])
        .filter((f) => f && f.name && /\.(jpe?g|png|heic|webp)$/i.test(f.name))
        .map((f) => {
          const time = rentalPhotoTime(f.name, f.created_at);
          return { path: `${folder}/${f.name}`, name: f.name, time, ...placeRentalPhoto(f.name, time, legs) };
        });
      setState({ loading: false, photos, legs, error: listed?.error || null });
    })().catch((e) => { if (live) { console.warn("rental photos:", e); setState({ loading: false, photos: [], legs: [], error: e }); } });
    return () => { live = false; };
  }, [ra?.id, ra?.operatorId]);

  const vehicleName = (leg) => {
    const id = leg?.vehicleId;
    const v = id != null
      ? (fleet || []).find((f) => String(f.id) === String(id)) || (archivedVehicles || []).find((f) => String(f.id) === String(id))
      : null;
    if (v) return [v.plate, [v.make, v.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
    return leg ? "Vehicle no longer on file" : (ra?.plate || "Vehicle");
  };

  // Full size: a fresh link, so one opened late is not already expired.
  const open = async (path) => {
    const u = await rentalPhotoLink(path).catch(() => null);
    if (u) setViewing(u);
  };

  const el = React.createElement;
  const sub = (text) => el("div", { className: "cdetailSubGroup" }, text);
  const note = (text) => el("div", { className: "customerPlaceholder" }, text);
  const isImage = (v) => /^data:image\/(png|jpeg);base64,/.test(String(v || ""));
  const signature = (label, value) => el("div", { key: label, style: { display: "flex", flexDirection: "column", gap: "4px" } },
    el("div", { style: { fontSize: "12px", fontWeight: 600 } }, label),
    el("img", { src: value, alt: `${label} signature`, style: { maxWidth: "280px", width: "100%", border: "1px solid #d9dee8", borderRadius: "8px", background: "#ffffff" } }));

  if (!ra) return note("Shown once the customer picks up on the fleetr app.");

  const events = ["Pickup", "Switch-out", "Return"];
  const grouped = events.map((event) => {
    const mine = state.photos.filter((p) => p.event === event);
    const byVehicle = new Map();
    mine.forEach((p) => {
      const key = p.leg ? p.leg.id : "none";
      if (!byVehicle.has(key)) byVehicle.set(key, { leg: p.leg, photos: [] });
      byVehicle.get(key).photos.push(p);
    });
    byVehicle.forEach((g) => g.photos.sort((a, b) => (a.time?.getTime() || 0) - (b.time?.getTime() || 0)));
    // Vehicles in the order they were on the rental: after a switch-out, the
    // one coming back before the one going out.
    const order = (g) => { const i = state.legs.findIndex((l) => g.leg && l.id === g.leg.id); return i < 0 ? 999 : i; };
    return { event, vehicles: [...byVehicle.values()].sort((a, b) => order(a) - order(b)) };
  }).filter((g) => g.vehicles.length);

  const signatures = [
    isImage(ra.pickupSignature) ? ["Pickup", ra.pickupSignature] : null,
    ...state.legs.slice(1).filter((l) => isImage(l.pickupSignature))
      .map((l) => [`Pickup after switch-out, ${vehicleName(l)}`, l.pickupSignature]),
    isImage(ra.returnSignature) ? ["Return", ra.returnSignature] : null,
  ].filter(Boolean);

  return el("div", null,
    state.loading
      ? note("Loading photos...")
      : state.error
        ? note("The photos could not be loaded. Reload the page to try again.")
        : grouped.length === 0
          ? note("No photos for this rental yet.")
          : grouped.map((g) => el("div", { key: g.event },
              sub(g.event),
              g.vehicles.map((v) => el("div", { key: v.leg ? v.leg.id : "none", style: { marginBottom: "12px" } },
                el("div", { style: { fontSize: "12px", fontWeight: 600, margin: "4px 0 8px" } }, vehicleName(v.leg)),
                el("div", { className: "damagePhotoRow" },
                  v.photos.map((p) => el(RentalPhotoTile, { key: p.path, photo: p, onOpen: open }))))))),
    sub("Signatures"),
    signatures.length
      ? el("div", { style: { display: "flex", gap: "16px", flexWrap: "wrap" } }, signatures.map(([label, value]) => signature(label, value)))
      : note("No signatures on file yet."),
    viewing && el(DamagePhotoViewer, { url: viewing, onClose: () => setViewing(null) })
  );
}

function AgreementVehicleHistory({ rentalAgreementId, resCode }) {
  const { fleet } = React.useContext(AppContext);
  const [state, setState] = React.useState({ id: null, legs: [], error: null, loading: true });

  React.useEffect(() => {
    if (!rentalAgreementId) { setState({ id: null, legs: [], error: null, loading: false }); return undefined; }
    let live = true;
    setState({ id: rentalAgreementId, legs: [], error: null, loading: true });
    supabase.from("rental_agreement_vehicles")
      .select("vehicleId, startedAt, endedAt, endReason, pickedUpAt, pickupMileage, pickupGas, closingMileage, closingGas")
      .eq("rentalAgreementId", rentalAgreementId)
      .order("startedAt", { ascending: true })
      .then(({ data, error }) => {
        if (!live) return;
        if (error) console.warn("vehicle history load failed:", error);
        setState({ id: rentalAgreementId, legs: data || [], error: error || null, loading: false });
      });
    return () => { live = false; };
  }, [rentalAgreementId]);

  const fmtWhen = (iso) => {
    if (!iso) return "-";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "-"
      : d.toLocaleString("en-CA", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const fmtKm = (n) => fmtDistance(n) ?? "-";
  const label = resCode || "this rental agreement";

  if (!rentalAgreementId) {
    return React.createElement("div", { className: "resvEmpty" }, "No rental agreement yet, so no vehicles to show.");
  }
  if (state.loading) return React.createElement("div", { className: "resvEmpty" }, "Loading vehicles...");
  if (state.error) return React.createElement("div", { className: "resvEmpty" }, `The vehicles for ${label} could not be loaded.`);
  if (state.legs.length === 0) return React.createElement("div", { className: "resvEmpty" }, `No vehicles recorded for ${label} yet.`);

  return React.createElement("div", { style: { overflowX: "auto" } },
    React.createElement("table", { className: "dashboardTable" },
      React.createElement("thead", null,
        React.createElement("tr", null,
          ["Plate", "Vehicle", "Start", "End", "Start mileage", "End mileage", "Start fuel", "End fuel", "Status"]
            .map((col) => React.createElement("th", { key: col }, col))
        )
      ),
      React.createElement("tbody", null,
        state.legs.map((leg, i) => {
          const v = leg.vehicleId ? (fleet || []).find((f) => f.id === leg.vehicleId) || null : null;
          return React.createElement("tr", { key: i },
            React.createElement("td", null, v?.plate ? React.createElement(PlateLink, { plate: v.plate }) : "-"),
            React.createElement("td", null, v ? ([v.make, v.model].filter(Boolean).join(" ") || "-") : "No longer in the fleet"),
            React.createElement("td", null, fmtWhen(leg.pickedUpAt)),
            React.createElement("td", null, fmtWhen(leg.endedAt)),
            React.createElement("td", null, fmtKm(leg.pickupMileage)),
            React.createElement("td", null, fmtKm(leg.closingMileage)),
            React.createElement("td", null, leg.pickupGas || "-"),
            React.createElement("td", null, leg.closingGas || "-"),
            React.createElement("td", null, vehicleHistoryLabel(leg, i === state.legs.length - 1))
          );
        })
      )
    )
  );
}

function RentalAgreementDetail({ rentalAgreement, onBack, setRentalAgreements }) {
  const { rentalAgreements: allAgreements } = React.useContext(AppContext);
  const raRecord = (allAgreements || []).find((a) => String(a.id) === String(rentalAgreement.raId)) || null;
  const [sect, setSect] = React.useState({
    resInfo: true, vehicles: true, datesRates: true, billTo: true, charges: true, notes: true,
  });
  const toggle = (key) => setSect((p) => ({ ...p, [key]: !p[key] }));

  const [raNotesLog, setRaNotesLog] = React.useState(
    parseNotesLog(rentalAgreement.notesLog)
  );
  const [noteInput, setNoteInput] = React.useState("");

  const handleAddNote = () => {
    const text = noteInput.trim();
    if (!text) return;
    const newNote = { author: "Connor Nash", text, at: new Date().toISOString() };
    const newLog = [...raNotesLog, newNote];
    setRaNotesLog(newLog);
    setNoteInput("");
    if (setRentalAgreements) {
      setRentalAgreements((prev) =>
        prev.map((r) => r.id === rentalAgreement.raId ? { ...r, notesLog: newLog } : r)
      );
    }
    if (rentalAgreement.raId) {
      supabase.from("rental_agreements").update({ notesLog: newLog }).eq("id", rentalAgreement.raId)
        .then((res) => console.log("rental_agreements notes update:", res))
        .catch((e) => console.warn("rental_agreements notes update:", e));
    }
  };

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };

  const fmtInspectedDate = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
  };

  const fmtInspectedTime = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  };

  const statusClass = raBadgeClass(rentalAgreement.status);

  const section = (key, title, content) =>
    React.createElement("section", { className: "dashboardSection", key },
      React.createElement("div", { className: "dashboardSection__header" },
        React.createElement("div", { className: "dashboardSection__headerRow" },
          React.createElement("span", null, title),
          React.createElement("button", {
            type: "button", className: "sectionToggleCircle",
            onClick: () => toggle(key),
          }, sect[key] ? "+" : "-")
        )
      ),
      !sect[key] && React.createElement("div", { className: "dashboardSection__body" }, content)
    );

  const field = (label, value) =>
    React.createElement("div", { className: "rentalAgreementField", key: label },
      React.createElement("span", { className: "rentalAgreementFieldLabel" }, label),
      React.createElement("span", { className: "rentalAgreementFieldValue" }, value || "—")
    );

  const pickupDateDisplay = fmtInspectedDate(rentalAgreement.inspectedAt) || fmtDate(rentalAgreement.pickupDate);
  const pickupTimeDisplay = fmtInspectedTime(rentalAgreement.inspectedAt);

  const notesContent = React.createElement("div", { style: { padding: "14px" } },
    raNotesLog.length === 0
      ? React.createElement("p", { style: { color: "#7b8fa8", fontStyle: "italic", margin: "0 0 12px" } }, "No notes yet.")
      : React.createElement("div", { style: { marginBottom: "12px" } },
          raNotesLog.map((n, i) =>
            React.createElement("div", { key: i, style: { marginBottom: "8px", padding: "8px 10px", background: "#131f1e", borderRadius: "6px" } },
              React.createElement("div", { style: { fontSize: "0.72rem", color: "#7b8fa8", marginBottom: "3px" } },
                (n.author || "ADJ") + (n.at
                  ? " — " + new Date(n.at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
                  : "")
              ),
              React.createElement("div", { style: { fontSize: "0.9rem", color: "#e0e8f0" } }, n.text)
            )
          )
        ),
    React.createElement("div", { style: { display: "flex", gap: "8px", marginTop: "4px" } },
      React.createElement("input", {
        className: "resFormInput", type: "text", placeholder: "Add a note…",
        value: noteInput,
        onChange: (e) => setNoteInput(e.target.value),
        onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); handleAddNote(); } },
        style: { flex: 1 },
      }),
      React.createElement("button", {
        type: "button", className: "addPaymentBtn",
        style: { whiteSpace: "nowrap", flexShrink: 0 },
        onClick: handleAddNote,
      }, "Save Note")
    )
  );

  return React.createElement("div", null,
    React.createElement("div", { className: "rentalAgreementDetailHeader" },
      React.createElement("button", { type: "button", className: "rentalAgreementBackBtn", onClick: onBack }, "← Back"),
      React.createElement("div", { className: "rentalAgreementDetailTitle" },
        React.createElement("h1", { className: "page__title", style: { margin: 0 } }, rentalAgreement.resCode ? `${rentalAgreement.customer} — ${rentalAgreement.resCode}` : rentalAgreement.customer),
        React.createElement("span", { className: statusClass }, statusLabel(rentalAgreement.status))
      )
    ),
    React.createElement("div", { className: "page__titleUnderline" }),
    section("resInfo", "Reservation Information",
      React.createElement("div", { className: "rentalAgreementFields" },
        field("Res Code", rentalAgreement.resCode),
        field("Customer", rentalAgreement.customer),
        field("Status", statusLabel(rentalAgreement.status)),
        field("Vehicle", rentalAgreement.vehicle),
        field("Vehicle Class", rentalAgreement.vehicleClass),
        field("Pickup Date", pickupDateDisplay),
        pickupTimeDisplay ? field("Pickup Time", pickupTimeDisplay) : null
      )
    ),
    section("vehicles", "Vehicles",
      React.createElement(AgreementVehicleHistory, { rentalAgreementId: rentalAgreement.raId, resCode: rentalAgreement.resCode })
    ),
    section("protection", "Protection",
      React.createElement(ProtectionChoicesList, { rentalAgreementId: rentalAgreement.raId })
    ),
    contractDrivers(raRecord) && section("drivers", "Drivers",
      React.createElement(ContractDriversList, { rentalAgreementId: rentalAgreement.raId })
    ),
    contractDeductibles(raRecord) && section("deductibles", "Deductibles",
      React.createElement(ContractDeductiblesList, { rentalAgreementId: rentalAgreement.raId })
    ),
    raRecord?.acknowledgementId && section("acknowledgements", "Acknowledgements",
      React.createElement(ContractAcknowledgementRecord, { rentalAgreementId: rentalAgreement.raId })
    ),
    section("photos", "Photos & Signatures",
      React.createElement(RentalPhotosAndSignatures, { rentalAgreementId: rentalAgreement.raId })
    ),
    section("datesRates", "Dates & Rates",
      React.createElement("div", { className: "rentalAgreementFields" },
        field("Pickup Date", pickupDateDisplay),
        field("Return Date", "—"),
        field("Daily Rate", "—"),
        field("Duration", "—")
      )
    ),
    section("billTo", "Bill-To Information",
      React.createElement("div", { className: "rentalAgreementFields" },
        field("Bill To", "—"),
        field("PO Number", "—"),
        field("Authorization #", "—"),
        field("Insurance Co.", "—")
      )
    ),
    section("charges", "Charges & Payments",
      React.createElement("div", { className: "rentalAgreementFields" },
        field("Base Charge", "—"),
        field("Additional Charges", "—"),
        field("Taxes & Fees", "—"),
        field("Total", "—"),
        field("Amount Paid", "—"),
        field("Balance Due", "—")
      )
    ),
    section("notes", "Notes", notesContent)
  );
}

// ─── RentalAgreementsPage ─────────────────────────────────────────────────────────────

function RentalAgreementsPage() {
  const { openRentalAgreementId, setOpenRentalAgreementId, reservations, rentalAgreements, setRentalAgreements } = React.useContext(AppContext);
  const TABS = [
    { label: "Open",          value: "open_rental_agreement" },
    { label: "Customer Return", value: "customer_return" },
    { label: "Close Pending", value: "close_pending" },
    { label: "Closed",        value: "closed" },
  ];
  const [activeTab, setActiveTab]   = React.useState("open_rental_agreement");
  const [selectedId, setSelectedId] = React.useState(null);

  const [srchFirst, setSrchFirst] = React.useState("");
  const [srchLast,  setSrchLast]  = React.useState("");
  const [srchPhone, setSrchPhone] = React.useState("");
  const [srchRes,   setSrchRes]   = React.useState("");

  const [srchPickup,      setSrchPickup]      = React.useState("");
  const [pickupOpen,      setPickupOpen]      = React.useState(false);
  const [pickupAnchor,    setPickupAnchor]    = React.useState({ x: 0, y: 0 });
  const [pickupMonth,     setPickupMonth]     = React.useState(null);

  const [srchReturn,      setSrchReturn]      = React.useState("");
  const [returnOpen,      setReturnOpen]      = React.useState(false);
  const [returnAnchor,    setReturnAnchor]    = React.useState({ x: 0, y: 0 });
  const [returnMonth,     setReturnMonth]     = React.useState(null);

  const todayIso = new Date().toISOString().slice(0, 10);

  React.useEffect(() => {
    if (openRentalAgreementId) { setSelectedId(openRentalAgreementId); setOpenRentalAgreementId(null); }
  }, [openRentalAgreementId]);

  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };

  const statusBadgeClass = (s) => raBadgeClass(s);

  const selectedRes = selectedId ? reservations.find((r) => r.resCode === selectedId) : null;
  if (selectedRes) {
    const matchingRa = rentalAgreements.find((ra) => ra.resCode === selectedRes.resCode);
    const selectedRentalAgreement = {
      id:          selectedRes.resCode,
      raId:        matchingRa?.id || null,
      resCode:     selectedRes.resCode,
      customer:    selectedRes.customer,
      // The agreement is authoritative; the column on the reservation is a
      // mirror that is only refreshed at load, so it reads as Open on an
      // agreement that moved to close_pending somewhere else in the session.
      // Same precedence as the overdue list.
      status:      matchingRa?.rentalAgreementStatus || selectedRes.rentalAgreementStatus,
      vehicle:     [selectedRes.vehicleYear, selectedRes.vehicleMake, selectedRes.vehicleModel].filter(Boolean).join(" ") || selectedRes.vehicleClass || "—",
      vehicleClass: selectedRes.vehicleClass || "—",
      pickupDate:  selectedRes.date,
      returnDate:  selectedRes.returnDate,
      inspectedAt: matchingRa?.inspectedAt || null,
      notesLog:    matchingRa?.notesLog    || [],
    };
    return React.createElement("div", { className: "page" },
      React.createElement(RentalAgreementDetail, { rentalAgreement: selectedRentalAgreement, onBack: () => setSelectedId(null), setRentalAgreements })
    );
  }

  const buildCalDays = (srchVal, monthState) => {
    const monthIso = monthState || `${(srchVal || todayIso).slice(0, 7)}-01`;
    const [y, m] = monthIso.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const cells = [];
    for (let i = 0; i < monthStart.getDay(); i++) cells.push(null);
    for (let d = 1; d <= new Date(y, m, 0).getDate(); d++)
      cells.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    while (cells.length % 7 !== 0) cells.push(null);
    return { monthStart, cells };
  };

  const moveMonth = (setMonth, monthState, srchVal, delta) => {
    const base = monthState || `${(srchVal || todayIso).slice(0, 7)}-01`;
    const [y, m] = base.split("-").map(Number);
    const next = new Date(y, m - 1 + delta, 1);
    setMonth(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`);
  };

  const renderCalPopover = (anchor, srchVal, setSrch, monthState, setMonth, setOpen) => {
    const { monthStart, cells } = buildCalDays(srchVal, monthState);
    return React.createElement(
      "div",
      { className: "calendarPopover", style: { left: `${anchor.x}px`, top: `${anchor.y}px` } },
      React.createElement("div", { className: "calendarHeader" },
        React.createElement("button", { type: "button", className: "calendarArrow", onClick: () => moveMonth(setMonth, monthState, srchVal, -1) }, "<"),
        React.createElement("div", { className: "calendarMonthLabel" }, monthStart.toLocaleDateString("en-CA", { month: "long", year: "numeric" })),
        React.createElement("button", { type: "button", className: "calendarArrow", onClick: () => moveMonth(setMonth, monthState, srchVal, 1) }, ">")
      ),
      React.createElement("div", { className: "calendarWeekdays" },
        ["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => React.createElement("div", { key: d, className: "calendarWeekday" }, d))
      ),
      React.createElement("div", { className: "calendarGrid" },
        cells.map((iso, idx) =>
          React.createElement("button", {
            type: "button", key: `cal-${idx}`,
            className: !iso ? "calendarDay calendarDay--empty"
              : iso === todayIso
                ? iso === srchVal ? "calendarDay calendarDay--today calendarDay--selected" : "calendarDay calendarDay--today"
                : iso === srchVal ? "calendarDay calendarDay--selected" : "calendarDay",
            disabled: !iso,
            onClick: () => { if (!iso) return; setSrch(iso); setOpen(false); },
          }, iso ? Number(iso.slice(-2)) : "")
        )
      )
    );
  };

  const renderDatePicker = (label, srchVal, setSrch, open, setOpen, anchor, setAnchor, monthState, setMonth) =>
    React.createElement("div", { className: "resvDatePickerWrap" },
      React.createElement("button", {
        type: "button",
        className: srchVal ? "resvSearchInput resvDateBtn resvDateBtn--active" : "resvSearchInput resvDateBtn",
        onClick: (e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
          setOpen((o) => !o);
        },
      }, srchVal ? fmtDate(srchVal) : label),
      srchVal && React.createElement("button", {
        type: "button", className: "resvDateClear",
        onClick: () => { setSrch(""); setMonth(null); },
      }, "\u00d7"),
      open && renderCalPopover(anchor, srchVal, setSrch, monthState, setMonth, setOpen)
    );

  const filtered = reservations
    .filter((r) => r.rentalAgreementStatus === activeTab)
    .filter((r) => {
      const parts = (r.customer || "").trim().split(/\s+/);
      const first = parts[0] || "";
      const last  = parts.length > 1 ? parts[parts.length - 1] : "";
      if (srchFirst  && !first.toLowerCase().includes(srchFirst.toLowerCase()))  return false;
      if (srchLast   && !last.toLowerCase().includes(srchLast.toLowerCase()))    return false;
      if (srchPhone  && !(r.phone || "").includes(srchPhone))                    return false;
      if (srchRes    && !(r.resCode || "").toLowerCase().includes(srchRes.toLowerCase())) return false;
      if (srchPickup && r.date !== srchPickup)                                   return false;
      if (srchReturn && r.returnDate !== srchReturn)                             return false;
      return true;
    });

  return React.createElement("div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Rental Agreements"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement("div", { className: "resvSearchBar" },
      renderDatePicker("Pickup date",  srchPickup, setSrchPickup, pickupOpen, setPickupOpen, pickupAnchor, setPickupAnchor, pickupMonth, setPickupMonth),
      renderDatePicker("Return date",  srchReturn, setSrchReturn, returnOpen, setReturnOpen, returnAnchor, setReturnAnchor, returnMonth, setReturnMonth),
      React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "First name",   value: srchFirst, onChange: (e) => setSrchFirst(e.target.value) }),
      React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "Last name",    value: srchLast,  onChange: (e) => setSrchLast(e.target.value)  }),
      React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "Phone number", value: srchPhone, onChange: (e) => setSrchPhone(e.target.value) }),
      React.createElement("input", { className: "resvSearchInput", type: "text", placeholder: "Res Code",   value: srchRes,   onChange: (e) => setSrchRes(e.target.value)   })
    ),
    React.createElement("div", { className: "resvTabBar" },
      TABS.map((tab) =>
        React.createElement("button", {
          key: tab.value, type: "button",
          className: tab.value === activeTab ? "resvPageTab resvPageTab--active" : "resvPageTab",
          onClick: () => { setActiveTab(tab.value); setSelectedId(null); },
        }, tab.label)
      )
    ),
    React.createElement("section", { className: "dashboardSection" },
      React.createElement("div", { className: "dashboardSection__body" },
        filtered.length === 0
          ? React.createElement("div", { className: "resvEmpty" }, "No rental agreements in this category.")
          : React.createElement("table", { className: "dashboardTable" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  ["Res Code", "Customer", "Vehicle", "Pickup Date", "Status"].map((col) =>
                    React.createElement("th", { key: col }, col)
                  )
                )
              ),
              React.createElement("tbody", null,
                filtered.map((r) =>
                  React.createElement("tr", { key: r.resCode },
                    React.createElement("td", null,
                      React.createElement(CustomerLink, { name: r.customer, resCode: r.resCode, label: r.resCode })
                    ),
                    React.createElement("td", null,
                      React.createElement(CustomerLink, { name: r.customer, resCode: r.resCode, label: r.customer })
                    ),
                    React.createElement("td", null, (() => {
                      const raRow = rentalAgreements.find((ra) => ra.resCode === r.resCode);
                      return raRow?.plate
                        ? React.createElement(PlateLink, { plate: raRow.plate })
                        : React.createElement("span", null, "—");
                    })()),
                    React.createElement("td", null, fmtDate(r.date)),
                    React.createElement("td", null,
                      React.createElement("span", { className: statusBadgeClass(r.rentalAgreementStatus) }, statusLabel(r.rentalAgreementStatus))
                    )
                  )
                )
              )
            )
      )
    )
  );
}

// ─── CloseRentalPage ──────────────────────────────────────────────────────────
// Close Rental, one screen per step:
//   1. Find the open rental agreement being returned.
//   2. Enter the closing mileage and gas level.
//   3. Review the damage already on record, and say whether there is new damage.
//   4. Photograph the new damage with the live camera. Only after a Yes in
//      step 3; a No goes straight to step 5.
//   5. Final charges. Not built yet: a placeholder showing what steps 1 to 4
//      collected.
//
// Reads only what the app already loaded. Nothing here writes anything or
// uploads anything: the values entered and the photos taken are held in
// memory and handed forward to the next step.
//
// Plates are compared through normalizePlate, with spaces, dashes and case
// stripped, because the fleet holds both "ABC-123" and "JXR 841" and staff
// type whichever they see.

// The gas scale the customer app uses for pickup and return (fleetr-customer,
// FUEL_LABELS): nine steps in eighths. The label itself is what gets stored,
// as in rental_agreements.fuelAtPickup, so the gas charge maths can compare a
// pickup and a closing reading directly.
const FUEL_LABELS = ["Empty", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞", "Full"];

// Step 2. Starts empty every time: nothing is pre-filled, because both values
// are read off the vehicle by staff at return.
//
// The mileage check compares against the highest reading on file for this
// vehicle, either the fleet's currentOdometer or this agreement's pickup
// mileage. A lower figure is warned about, not refused: an odometer reset or
// an earlier typo can make a correct reading look low, so staff confirm it
// and carry on.
const CLOSE_READINGS_LABELS = {
  pageTitle:      "Close Rental",
  stepTitle:      "Closing mileage and gas",
  mileageLabel:   "Closing mileage",
  mileageMissing: "Enter the closing mileage.",
  gasLabel:       "Closing gas level",
  gasMissing:     "Set the closing gas level.",
};

function CloseRentalReadingsStep({ row, rentalAgreementId, readings, setReadings, onBack, onNext, labels }) {
  const L = { ...CLOSE_READINGS_LABELS, ...(labels || {}) };
  const [attempted, setAttempted] = React.useState(false);
  const { mileage, gasIndex, lowConfirmed } = readings;

  // Readings are stored in kilometres and typed in the company's unit. The
  // last reading is shown and compared in that unit too.
  const lastReadingKm = [row?.odometerOnFile, row?.pickupMileage]
    .map((v) => (v === null || v === undefined || v === "" ? NaN : Number(v)))
    .filter((v) => Number.isFinite(v))
    .reduce((max, v) => (max === null || v > max ? v : max), null);
  const lastReading = lastReadingKm === null ? null : kmToDistance(lastReadingKm);
  const unit = distanceUnit();

  const trimmed    = String(mileage).trim();
  const mileageNum = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
  const isLow      = mileageNum !== null && lastReading !== null && mileageNum < lastReading;

  const mileageError = trimmed === ""
    ? L.mileageMissing
    : mileageNum === null ? `Enter the mileage as a whole number of ${distanceUnitWord()}, digits only.` : null;
  const gasError = gasIndex === null ? L.gasMissing : null;
  const lowError = isLow && !lowConfirmed ? "Confirm the lower reading to continue." : null;

  const setGas = (value) => setReadings((prev) => ({ ...prev, gasIndex: Number(value) }));

  // The fuel slider takes the finger directly. iPhone Safari does not honour
  // touch-action on a range input and lets a drag that strays even slightly
  // vertical scroll the page, and a tap focuses the input and can scroll it
  // into view. React's touch listeners are passive and cannot preventDefault,
  // so these are attached by hand with passive: false: the page never sees
  // the touch, and the value follows the finger along the track. Mouse and
  // keyboard still go through onChange.
  const fuelRef = React.useRef(null);
  React.useEffect(() => {
    const range = fuelRef.current;
    if (!range) return undefined;
    const onTouch = (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const r    = range.getBoundingClientRect();
      const pad  = Math.min(12, r.width / 10); // the thumb's centre stops short of each end
      const frac = Math.min(1, Math.max(0, (e.touches[0].clientX - r.left - pad) / (r.width - 2 * pad)));
      setGas(Math.round(frac * 8));
    };
    range.addEventListener("touchstart", onTouch, { passive: false });
    range.addEventListener("touchmove",  onTouch, { passive: false });
    return () => {
      range.removeEventListener("touchstart", onTouch);
      range.removeEventListener("touchmove",  onTouch);
    };
  }, []);

  const handleNext = () => {
    setAttempted(true);
    if (mileageError || gasError || lowError) return;
    onNext({ rentalAgreementId, closingMileage: distanceToKm(mileageNum), closingGasLevel: FUEL_LABELS[gasIndex] });
  };

  const errorLine = (msg) => attempted && msg && React.createElement("div", { className: "closeRentalError" }, msg);

  return React.createElement("div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, L.pageTitle),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement("div", { className: "closeRentalSummary" },
      React.createElement("div", { className: "closeRentalSummary__main" }, row ? row.vehicle : "Rental agreement"),
      React.createElement("div", { className: "closeRentalSummary__meta" },
        row ? [row.customer, row.plate || null].filter(Boolean).join(" · ") : "Rental not found")
    ),
    React.createElement("h2", { className: "closeRentalStepTitle" }, L.stepTitle),
    React.createElement("div", { className: "closeRentalForm" },
      React.createElement("label", { className: "resFormGroup" },
        React.createElement("span", { className: "resFormLabel" }, `${L.mileageLabel} (${unit})`),
        React.createElement("input", {
          className: "resFormInput closeRentalMileage", type: "number", inputMode: "numeric",
          min: 0, step: 1, placeholder: "e.g. 42500", autoComplete: "off",
          value: mileage,
          onChange: (e) => setReadings((prev) => ({ ...prev, mileage: e.target.value, lowConfirmed: false })),
        }),
        React.createElement("span", { className: "closeRentalHint" },
          lastReading !== null
            ? `Last recorded: ${lastReading.toLocaleString("en-CA")} ${unit}`
            : "No previous reading on file for this vehicle.")
      ),
      errorLine(mileageError),
      isLow && React.createElement("div", { className: "closeRentalWarning" },
        React.createElement("div", null,
          `This is lower than the last recorded reading of ${lastReading.toLocaleString("en-CA")} ${unit}. ` +
          "That can happen after an odometer reset or an earlier data error. Check the reading before continuing."),
        React.createElement("label", { className: "closeRentalWarning__confirm" },
          React.createElement("input", {
            type: "checkbox", checked: lowConfirmed,
            onChange: (e) => setReadings((prev) => ({ ...prev, lowConfirmed: e.target.checked })),
          }),
          "The reading is correct, continue anyway"
        )
      ),
      errorLine(lowError),
      React.createElement("div", { className: "resFormGroup" },
        React.createElement("span", { className: "resFormLabel", id: "closeRentalGasLabel" }, L.gasLabel),
        React.createElement("div", { className: "closeRentalFuel__value" }, gasIndex === null ? "Not set" : FUEL_LABELS[gasIndex]),
        React.createElement("input", {
          ref: fuelRef,
          type: "range", min: 0, max: 8, step: 1,
          className: gasIndex === null ? "closeRentalFuel closeRentalFuel--unset" : "closeRentalFuel",
          "aria-labelledby": "closeRentalGasLabel",
          "aria-valuetext": gasIndex === null ? "Not set" : FUEL_LABELS[gasIndex],
          value: gasIndex === null ? 0 : gasIndex,
          onChange: (e) => setGas(e.target.value),
          // A click on the thumb's current spot fires no change event, so an
          // unset slider could never be set to Empty. The click catches it.
          onClick: (e) => setGas(e.currentTarget.value),
        }),
        React.createElement("div", { className: "closeRentalFuel__labels" },
          ["Empty", "¼", "½", "¾", "Full"].map((l) => React.createElement("span", { key: l }, l))
        )
      ),
      errorLine(gasError)
    ),
    React.createElement("div", { className: "closeRentalActions" },
      React.createElement("button", { type: "button", className: "resModalCancel", onClick: onBack }, "Back"),
      React.createElement("button", { type: "button", className: "resModalSubmit", onClick: handleNext }, "Next")
    )
  );
}

// A damage_claims photo is either a full URL, used as it is, or a path in the
// private damage-photos bucket (<operatorId>/vehicles/<id>/<file>), which has
// no public URL and is shown through a signed link that expires after an hour.
// Minting the link is a read: the storage policies decide whether this user
// may see the photo at all. No photo is stored anywhere yet (every claim's
// photos array is empty today), so this is ready for when uploads exist.
const DAMAGE_PHOTO_BUCKET = "damage-photos";

function useDamagePhotoUrl(value) {
  const direct = /^(https?:|data:|blob:)/i.test(String(value || ""));
  const [url, setUrl] = React.useState(direct ? value : null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (direct || !value) { setUrl(direct ? value : null); return; }
    let live = true;
    setUrl(null); setFailed(false);
    supabase.storage.from(DAMAGE_PHOTO_BUCKET).createSignedUrl(value, 3600)
      .then((res) => {
        if (!live) return;
        const signed = res?.data?.signedURL || res?.data?.signedUrl || res?.signedURL || null;
        if (res?.error || !signed) {
          console.warn("damage photo link failed:", value, res?.error);
          setFailed(true);
        } else {
          setUrl(signed);
        }
      })
      .catch((e) => { if (live) { console.warn("damage photo link:", e); setFailed(true); } });
    return () => { live = false; };
  }, [value, direct]);
  return { url, failed };
}

function DamagePhotoThumb({ value, onOpen }) {
  const { url, failed } = useDamagePhotoUrl(value);
  if (failed) return React.createElement("div", { className: "damagePhotoThumb damagePhotoThumb--empty" }, "Photo unavailable");
  if (!url)   return React.createElement("div", { className: "damagePhotoThumb damagePhotoThumb--empty" }, "Loading...");
  return React.createElement("button", {
    type: "button", className: "damagePhotoThumb", onClick: () => onOpen(url), "aria-label": "View photo full size",
  }, React.createElement("img", { src: url, alt: "Damage photo" }));
}

// Full-size view. Closes on the button, a click outside the photo, or Escape.
function DamagePhotoViewer({ url, onClose }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return React.createElement("div", {
    className: "damagePhotoViewer", role: "dialog", "aria-modal": "true", "aria-label": "Damage photo",
    onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
  },
    React.createElement("button", { type: "button", className: "damagePhotoViewer__close", onClick: onClose, "aria-label": "Close photo" }, "×"),
    React.createElement("img", { className: "damagePhotoViewer__img", src: url, alt: "Damage photo, full size" })
  );
}

// Step 3. Everything already on record for the vehicle, whatever the claim's
// status: a settled claim is not proof the damage was repaired, and anything
// left off this list is damage the returning customer could be wrongly
// charged for. Newest first.
//
// Then a Yes/No for new damage, with no default, so the answer is always a
// deliberate one. Yes needs a description before moving on.
function CloseRentalDamageStep({ row, damageDraft, setDamageDraft, onBack, onNext, pageTitle }) {
  const { damageClaims, rentalAgreements } = React.useContext(AppContext);
  const [viewing,   setViewing]   = React.useState(null);
  const [attempted, setAttempted] = React.useState(false);
  const { choice, note, rentable } = damageDraft;

  const fmtDate = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null
      : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };

  // A claim names its vehicle by plate, or failing that through its rental
  // agreement's plate, the same fallback enrichDamageClaim uses.
  const vehiclePlate = normalizePlate(row?.plate);
  const previous = !vehiclePlate ? [] : (damageClaims || [])
    .filter((c) => {
      const plate = c.plate || (rentalAgreements || []).find((a) => a.id === c.rentalAgreementId)?.plate;
      return normalizePlate(plate) === vehiclePlate;
    })
    .sort((a, b) => String(b.reportedAt || b.createdAt || "").localeCompare(String(a.reportedAt || a.createdAt || "")));

  const noteError = choice === "yes" && !note.trim() ? "Describe the new damage." : null;
  const rentableError = choice === "yes" && !rentable ? "Choose whether the vehicle can still be rented." : null;

  const handleNext = () => {
    setAttempted(true);
    if (!choice || noteError || rentableError) return;
    onNext({
      newDamageFound:  choice === "yes",
      newDamageNote:   choice === "yes" ? note.trim() : null,
      vehicleRentable: choice === "yes" ? rentable === "rentable" : null,
    });
  };

  const rentableBtn = (value, label) =>
    React.createElement("button", {
      type: "button", "aria-pressed": rentable === value,
      className: rentable === value ? "closeRentalChoice closeRentalChoice--active" : "closeRentalChoice",
      onClick: () => setDamageDraft((prev) => ({ ...prev, rentable: value })),
    }, label);

  const choiceBtn = (value, label) =>
    React.createElement("button", {
      type: "button", "aria-pressed": choice === value,
      className: choice === value ? "closeRentalChoice closeRentalChoice--active" : "closeRentalChoice",
      onClick: () => setDamageDraft((prev) => ({ ...prev, choice: value })),
    }, label);

  return React.createElement("div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, pageTitle || "Close Rental"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement("div", { className: "closeRentalSummary" },
      React.createElement("div", { className: "closeRentalSummary__main" }, row ? row.vehicle : "Rental agreement"),
      React.createElement("div", { className: "closeRentalSummary__meta" },
        row ? [row.customer, row.plate || null].filter(Boolean).join(" · ") : "Rental not found")
    ),
    React.createElement("h2", { className: "closeRentalStepTitle" }, "Previous damage"),
    React.createElement("div", { className: "closeRentalDamageList" },
      previous.length === 0
        ? React.createElement("div", { className: "closeRentalDamageEmpty" },
            vehiclePlate ? "No damage on record for this vehicle." : "This rental has no plate on file, so previous damage cannot be looked up.")
        : previous.map((c) => {
            const photos = Array.isArray(c.photos) ? c.photos.filter(Boolean) : [];
            const when = fmtDate(c.reportedAt || c.createdAt);
            return React.createElement("div", { key: c.id, className: "closeRentalDamageItem" },
              React.createElement("div", { className: "closeRentalDamageItem__desc" }, c.description || "No description"),
              React.createElement("div", { className: "closeRentalDamageItem__meta" },
                [damageClaimStatusLabel(c.status), when && `reported ${when}`].filter(Boolean).join(" · ")),
              photos.length === 0
                ? React.createElement("div", { className: "closeRentalHint" }, "No photo on file.")
                : React.createElement("div", { className: "damagePhotoRow" },
                    photos.map((p, i) => React.createElement(DamagePhotoThumb, { key: `${c.id}-${i}`, value: p, onOpen: setViewing }))
                  )
            );
          })
    ),
    React.createElement("h2", { className: "closeRentalStepTitle" }, "New damage found?"),
    React.createElement("div", { className: "closeRentalChoiceRow", role: "group", "aria-label": "New damage found?" },
      choiceBtn("yes", "Yes"),
      choiceBtn("no",  "No")
    ),
    choice === "yes" && React.createElement("div", { className: "closeRentalForm", style: { marginTop: 14 } },
      React.createElement("label", { className: "resFormGroup" },
        React.createElement("span", { className: "resFormLabel" }, "Describe the new damage"),
        React.createElement("textarea", {
          className: "resFormInput resFormTextarea closeRentalNote", rows: 4,
          placeholder: "Where it is and what it looks like, e.g. 10 cm scratch on the rear passenger door",
          value: note,
          onChange: (e) => setDamageDraft((prev) => ({ ...prev, note: e.target.value })),
        })
      ),
      attempted && noteError && React.createElement("div", { className: "closeRentalError" }, noteError),
      React.createElement("h2", { className: "closeRentalStepTitle" }, "Can the vehicle still be rented?"),
      React.createElement("div", { className: "closeRentalChoiceRow", role: "group", "aria-label": "Can the vehicle still be rented?" },
        rentableBtn("rentable",   "Rentable"),
        rentableBtn("unrentable", "Unrentable")
      ),
      React.createElement("div", { className: "closeRentalHint" },
        "Rentable sends it to Needs Cleaning, or to PM if it is due for service. Unrentable sends it to Damaged."),
      attempted && rentableError && React.createElement("div", { className: "closeRentalError" }, rentableError)
    ),
    React.createElement("div", { className: "closeRentalActions" },
      React.createElement("button", { type: "button", className: "resModalCancel", onClick: onBack }, "Back"),
      choice && React.createElement("button", { type: "button", className: "resModalSubmit", onClick: handleNext }, "Next")
    ),
    viewing && React.createElement(DamagePhotoViewer, { url: viewing, onClose: () => setViewing(null) })
  );
}

// ─── Close Rental step 4: new damage photos ──────────────────────────────────
// Live camera only, deliberately. There is no file input anywhere in this
// step and none may be added: a photo picked from the camera roll could have
// been taken at any time, on any car, and these photos are the evidence that
// the damage was found at this return. Every photo here is a frame grabbed
// from the camera while this screen is open.
//
// Photos are JPEG blobs held in memory and handed forward. Nothing is uploaded
// yet. Each is kept under the damage-photos bucket's 10 MB limit so it will
// not be refused when uploads are wired up.

const CLOSE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

function cameraErrorMessage(err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Camera access was blocked. Allow camera access for this site in the browser settings, then tap Try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera was found on this device.";
  if (name === "NotReadableError" || name === "AbortError")
    return "The camera could not be started. It may be in use by another app. Close that app, then tap Try again.";
  return "The camera could not be started. Tap Try again.";
}

// Grabs the current video frame at the camera's full resolution. Quality steps
// down only if a frame would be over the bucket limit, which at normal phone
// resolutions it never is.
async function captureVideoFrame(video) {
  const width = video.videoWidth, height = video.videoHeight;
  if (!width || !height) throw new Error("camera not ready");
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  for (const quality of [0.9, 0.75, 0.6, 0.45]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= CLOSE_PHOTO_MAX_BYTES) return { blob, width, height };
  }
  throw new Error("photo too large");
}

const releasePhotos = (list) => (list || []).forEach((p) => { if (p?.url) URL.revokeObjectURL(p.url); });

// Captured photos into the private damage-photos bucket, under the folder the
// storage policy expects: <operatorId>/rental-agreements/<rentalAgreementId>/.
// The operatorId prefix is what the policy compares against current_operator(),
// so it comes from the signed-in profile, never from anything typed on screen.
//
// Each photo is uploaded on its own and a failure is recorded rather than
// thrown: a photo that will not upload must not cost staff the rest of the
// close, and the count of what did not make it is shown at the end so the gap
// is known rather than silent. There is no delete policy on this bucket, so a
// partial upload leaves the photos that did land, which is the right way round
// for evidence.
async function uploadDamagePhotos({ operatorId, rentalAgreementId, photos }) {
  const paths = [], failures = [];
  if (!operatorId || !rentalAgreementId) {
    return { paths, failures: (photos || []).map((p) => p.id), reason: "no operator or agreement on file" };
  }
  for (const photo of photos || []) {
    const stamp = (photo.capturedAt || new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 14);
    const path  = `${operatorId}/rental-agreements/${rentalAgreementId}/${stamp}-${photo.id}.jpg`;
    try {
      const res = await supabase.storage.from(DAMAGE_PHOTO_BUCKET)
        .upload(path, photo.blob, { contentType: photo.type || "image/jpeg", cacheControl: "3600" });
      if (res?.error) { console.warn("damage photo upload failed:", path, res.error); failures.push(photo.id); }
      else paths.push(path);
    } catch (e) {
      console.warn("damage photo upload threw:", path, e);
      failures.push(photo.id);
    }
  }
  return { paths, failures, reason: null };
}

function CloseRentalPhotoStep({ row, note, photos, setPhotos, onBack, onNext, pageTitle }) {
  const videoRef   = React.useRef(null);
  const streamRef  = React.useRef(null);
  const pendingRef = React.useRef(null);
  const [camera,      setCamera]      = React.useState("starting");
  const [cameraError, setCameraError] = React.useState(null);
  const [attempt,     setAttempt]     = React.useState(0);
  const [pending,     setPending]     = React.useState(null);
  const [busy,        setBusy]        = React.useState(false);
  const [captureError, setCaptureError] = React.useState(null);
  const [viewing,     setViewing]     = React.useState(null);

  pendingRef.current = pending;

  const stopCamera = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Rear camera preferred, since staff are photographing a car, but any camera
  // is accepted. Restarted by Try again. Always stopped on the way out, so the
  // camera light goes off the moment this screen closes.
  React.useEffect(() => {
    let cancelled = false;
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== "function") {
      setCamera("error");
      setCameraError(window.isSecureContext === false
        ? "The camera only works over a secure (https) connection."
        : "This browser cannot open the camera.");
      return undefined;
    }
    setCamera("starting");
    setCameraError(null);
    md.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }).then((stream) => {
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        video.muted = true;
        const played = video.play();
        if (played && played.catch) played.catch(() => {});
      }
      setCamera("live");
    }).catch((err) => {
      if (cancelled) return;
      console.warn("close rental camera:", err);
      setCamera("error");
      setCameraError(cameraErrorMessage(err));
    });
    return () => { cancelled = true; stopCamera(); };
  }, [attempt]);

  // A still that was never accepted or retaken is dropped with the screen.
  React.useEffect(() => () => { if (pendingRef.current) URL.revokeObjectURL(pendingRef.current.url); }, []);

  const resumePreview = () => {
    const video = videoRef.current;
    if (video && video.paused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
  };

  const takePhoto = async () => {
    if (busy || !videoRef.current) return;
    setBusy(true);
    setCaptureError(null);
    try {
      const { blob, width, height } = await captureVideoFrame(videoRef.current);
      setPending({ blob, width, height, url: URL.createObjectURL(blob), capturedAt: new Date().toISOString() });
    } catch (e) {
      console.warn("close rental capture:", e);
      setCaptureError("That photo could not be taken. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const retake = () => {
    if (pending) URL.revokeObjectURL(pending.url);
    setPending(null);
    resumePreview();
  };

  const accept = () => {
    if (!pending) return;
    const photo = {
      id: crypto.randomUUID(), blob: pending.blob, url: pending.url, type: pending.blob.type || "image/jpeg",
      size: pending.blob.size, width: pending.width, height: pending.height, capturedAt: pending.capturedAt,
    };
    setPhotos((prev) => [...prev, photo]);
    setPending(null);
    resumePreview();
  };

  const removePhoto = (id) => {
    setPhotos((prev) => {
      releasePhotos(prev.filter((p) => p.id === id));
      return prev.filter((p) => p.id !== id);
    });
  };

  const leave = (fn) => () => {
    stopCamera();
    if (pending) { URL.revokeObjectURL(pending.url); setPending(null); }
    fn();
  };

  const stage = pending
    ? React.createElement("img", { className: "closeRentalCamera__still", src: pending.url, alt: "Photo just taken" })
    : null;

  return React.createElement("div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, pageTitle || "Close Rental"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement("div", { className: "closeRentalSummary" },
      React.createElement("div", { className: "closeRentalSummary__main" }, row ? row.vehicle : "Rental agreement"),
      React.createElement("div", { className: "closeRentalSummary__meta" },
        row ? [row.customer, row.plate || null].filter(Boolean).join(" · ") : "Rental not found")
    ),
    React.createElement("h2", { className: "closeRentalStepTitle" }, "Photos of the new damage"),
    note && React.createElement("p", { className: "closeRentalPhotoNote" },
      React.createElement("span", { className: "resFormLabel" }, "Damage noted"), " ", note),
    React.createElement("div", { className: "closeRentalCamera" },
      // Always mounted, so the stream has somewhere to go the moment it
      // arrives. Hidden, not removed, while a still is being reviewed, which
      // keeps the camera warm for a retake.
      React.createElement("video", {
        ref: videoRef, className: "closeRentalCamera__video", playsInline: true, muted: true, autoPlay: true,
        style: { visibility: camera === "live" && !pending ? "visible" : "hidden" },
      }),
      stage,
      camera === "starting" && React.createElement("div", { className: "closeRentalCamera__status" }, "Starting camera..."),
      camera === "error" && React.createElement("div", { className: "closeRentalCamera__status" },
        React.createElement("div", null, cameraError),
        React.createElement("button", {
          type: "button", className: "resModalSubmit", style: { marginTop: 12 },
          onClick: () => setAttempt((n) => n + 1),
        }, "Try again")
      )
    ),
    captureError && React.createElement("div", { className: "closeRentalError", style: { marginTop: 8 } }, captureError),
    pending
      ? React.createElement("div", { className: "closeRentalCameraControls" },
          React.createElement("button", { type: "button", className: "resModalCancel", onClick: retake }, "Retake"),
          React.createElement("button", { type: "button", className: "resModalSubmit", onClick: accept }, "Use photo")
        )
      : React.createElement("div", { className: "closeRentalCameraControls" },
          React.createElement("button", {
            type: "button", className: "closeRentalShutter", onClick: takePhoto,
            disabled: camera !== "live" || busy,
          }, busy ? "Taking photo..." : "Take photo")
        ),
    React.createElement("div", { className: "closeRentalPhotoListTitle" },
      photos.length === 0 ? "No photos yet" : `${photos.length} photo${photos.length === 1 ? "" : "s"} taken`),
    photos.length > 0 && React.createElement("div", { className: "damagePhotoRow" },
      photos.map((p, i) =>
        React.createElement("div", { key: p.id, className: "closeRentalPhotoItem" },
          React.createElement("button", {
            type: "button", className: "damagePhotoThumb", onClick: () => setViewing(p.url),
            "aria-label": `View photo ${i + 1} full size`,
          }, React.createElement("img", { src: p.url, alt: `New damage photo ${i + 1}` })),
          React.createElement("button", {
            type: "button", className: "closeRentalPhotoItem__remove", onClick: () => removePhoto(p.id),
            "aria-label": `Remove photo ${i + 1}`,
          }, "×")
        )
      )
    ),
    React.createElement("div", { className: "closeRentalActions" },
      React.createElement("button", { type: "button", className: "resModalCancel", onClick: leave(onBack) }, "Back"),
      React.createElement("button", {
        type: "button", className: "resModalSubmit", disabled: photos.length === 0,
        title: photos.length === 0 ? "Take at least one photo to continue" : undefined,
        onClick: leave(() => onNext(photos)),
      }, "Next")
    ),
    photos.length === 0 && React.createElement("div", { className: "closeRentalHint", style: { marginTop: 8 } }, "Take at least one photo to continue."),
    viewing && React.createElement(DamagePhotoViewer, { url: viewing, onClose: () => setViewing(null) })
  );
}

const EMPTY_CLOSE_READINGS = { mileage: "", gasIndex: null, lowConfirmed: false };
const EMPTY_DAMAGE_DRAFT   = { choice: null, note: "", rentable: null };

// Whether a vehicle that came back damaged can still go out. Asked whenever
// damage is marked, because damage covers everything from a scuffed bumper to
// a car that cannot be driven, and only the second belongs in Damaged: sending
// every marked vehicle there took rentable cars out of the fleet until someone
// noticed. null means the question was never asked, which is every claim
// raised before it existed and every claim raised through Flag Damage.
function vehicleRentableLabel(rentable) {
  if (rentable === true)  return "Rentable";
  if (rentable === false) return "Unrentable";
  return "Not recorded";
}

// The status a returning vehicle is ASKED to take. Callers pass the result
// through resolvePmStatus, which still has the last word on its own terms: a
// Rentable vehicle due for preventative maintenance goes to PM instead of Needs
// Cleaning, while an Unrentable one stays Damaged, because resolvePmStatus
// treats Damaged as the more urgent of the two and leaves it alone.
function returnedVehicleStatus(damageFound, rentable) {
  return damageFound && rentable === false ? "Damaged" : "Needs Cleaning";
}

// Where a closed rental lands. Every close used to land on close_pending
// because there was no charges screen, so nothing could be called finished.
// Most returns owe nothing: the vehicle came back undamaged and as full as it
// went out, and holding those open made close_pending a pile of finished work
// with the few that need attention buried in it.
//
// So: close_pending when there is something to charge for, closed otherwise.
//
//   damage        a claim to settle, whatever the fuel says
//   fuel shortage returned lower than it went out, which is the gas charge
//                 complete_return already computes into gasOwed
//
// Unknown either side is treated as a shortage. A missing or unrecognised level
// means the comparison could not be made, and closing an agreement because a
// value was absent is the one outcome that cannot be undone by a person
// noticing later.
//
// No prepaid-fuel exemption, because there is no such field. The system has
// gasOwed, gasCollected, gasMarkupPercent and gasPrices, all about charging for
// fuel after the fact, and nothing recording that a customer bought a tank up
// front. If that is added, it belongs here.
// What to tell the person, for each reason closeRentalOutcome holds an
// agreement open. A closed agreement has no reason and says nothing: the
// status is the whole story there.
//
// fuel_unknown names the pickup level specifically, which is where it comes
// from in practice: the closing level is picked from FUEL_LABELS on the
// readings step and cannot be anything else, while fuelAtPickup is nullable on
// agreements written before the customer app filled it in.
const CLOSE_RENTAL_REASONS = {
  damage:       "Damage marked",
  fuel_short:   "Returned with less fuel",
  fuel_unknown: "Pickup fuel level unknown",
};

function closeRentalOutcome({ damageFound, pickupGas, returnGas }) {
  if (damageFound) return { status: "close_pending", reason: "damage" };

  const from = FUEL_LABELS.indexOf(pickupGas);
  const to   = FUEL_LABELS.indexOf(returnGas);
  if (from === -1 || to === -1) return { status: "close_pending", reason: "fuel_unknown" };
  if (to < from)                return { status: "close_pending", reason: "fuel_short" };

  return { status: "closed", reason: null };
}

// The gas charge for a return that came back lower than it went out. This is
// the same sum complete_return does in SQL for a customer self-return
// (customer_return_status.sql), ported here because a staff close never ran it:
// the customer app charged for fuel and Close Rental did not, so the same
// shortage cost nothing when a staff member processed the return.
//
//   eighths short / 8 x tank litres x price per litre x (1 + markup)
//
// The price comes from the vehicle's own province, falling back to the
// configured default region, because that is the province the fuel was bought
// in. Markup is optional and treated as zero when unset.
//
// Returns null rather than zero whenever the sum cannot be made: no tank size
// on the vehicle, no price for its region, or a level either side that is not
// one of FUEL_LABELS. Null means "leave gasOwed alone for manual entry", which
// is what the Gas Collection settings page promises. Zero would read as a
// settled balance and drop the rental off Gas Collections entirely.
function gasChargeForReturn({ pickupGas, returnGas, vehicle, appSettings }) {
  const from = FUEL_LABELS.indexOf(pickupGas);
  const to   = FUEL_LABELS.indexOf(returnGas);
  if (from === -1 || to === -1 || to >= from) return null;

  const tank = parseFloat(vehicle?.tankSizeLiters);
  if (!Number.isFinite(tank) || tank <= 0) return null;

  const region = vehicle?.province || appSettings?.gasDefaultRegion || null;
  const price  = region ? parseFloat((appSettings?.gasPrices || {})[region]) : NaN;
  if (!Number.isFinite(price) || price <= 0) return null;

  const markupRaw = parseFloat(appSettings?.gasMarkupPercent);
  const markup    = Number.isFinite(markupRaw) ? markupRaw : 0;

  const charge = ((from - to) / 8) * tank * price * (1 + markup / 100);
  if (!Number.isFinite(charge) || charge <= 0) return null;
  // Two decimals as a string, matching the column: gasOwed is text everywhere
  // else in the app, and Gas Collections parses it back out.
  return (Math.round(charge * 100) / 100).toFixed(2);
}

// ─── Open rental search, shared by Close Rental and Switch Out ───────────────
// One row per rental the caller may act on, joined to its reservation
// (customer, pickup date) and its vehicle (description, province). The
// agreement's plate wins; the reservation's is the fallback for an agreement
// whose plate was never filled in, the same fallback syncRAStatus uses.
//
// The two flows do not reach the same rentals, which is why this takes an
// option rather than one of them filtering the other's rows afterwards.
//
// Both reach an open agreement. Only Close Rental reaches a SELF-RETURN: an
// agreement the customer app already moved to close_pending, whose vehicle is
// sitting in Ready Returns waiting for someone to look at it. complete_return
// records what the customer entered and moves the vehicle to that queue, and
// nothing after that inspects it, so without this those rentals had no way
// through the flow that exists to inspect them.
//
// The vehicle being in Ready Returns is part of the test, not decoration. A
// close_pending agreement whose vehicle has already been moved on has been
// dealt with by someone, and offering it again would invite a second close
// over the top of the first.
//
// Switch Out still reaches open agreements only. A vehicle that is back is not
// one a customer can be switched onto another of, so close_pending is as out
// of reach there as it ever was. Neither flow reaches closed.
function useOpenRentalRows({ includeSelfReturns = false } = {}) {
  const { reservations, rentalAgreements, fleet } = React.useContext(AppContext);
  return React.useMemo(() => {
    const resByCode = Object.fromEntries((reservations || []).map((r) => [r.resCode, r]));
    return (rentalAgreements || [])
      .map((ra) => {
        const res = resByCode[ra.resCode] || {};
        const rowPlate = ra.plate || res.plate || "";
        const vehicle = rowPlate
          ? (fleet || []).find((v) => normalizePlate(v.plate) === normalizePlate(rowPlate)) || null
          : null;
        const parts = String(res.customer || "").trim().split(/\s+/);
        return {
          id:         ra.id,
          customer:   res.customer || "-",
          lastName:   res.lastName || (parts.length > 1 ? parts[parts.length - 1] : ""),
          plate:      rowPlate,
          province:   vehicle?.province || "",
          vehicle:    [vehicle?.year, vehicle?.make, vehicle?.model].filter(Boolean).join(" ")
                      || [res.vehicleYear, res.vehicleMake, res.vehicleModel].filter(Boolean).join(" ")
                      || res.vehicleClass || "-",
          pickupDate: res.date || "",
          pickupMileage:  ra.mileage ?? null,
          odometerOnFile: vehicle?.currentOdometer ?? null,
          // Carried on the row so the flow does not have to re-derive it, and
          // so the screens can say which kind of return they are handling.
          // customer_return says so on its own. close_pending with the vehicle
          // still in Ready Returns is the same thing recorded before that
          // status existed, and stays recognised so those rentals remain
          // processable; it needs the vehicle check because close_pending is
          // also where a staff-processed rental sits.
          selfReturn: ra.rentalAgreementStatus === "customer_return"
                      || (ra.rentalAgreementStatus === "close_pending"
                          && vehicle?.status === "Ready Returns"),
          raStatus:   ra.rentalAgreementStatus,
        };
      })
      .filter((row) =>
        row.raStatus === "open_rental_agreement" || (includeSelfReturns && row.selfReturn));
  }, [reservations, rentalAgreements, fleet, includeSelfReturns]);
}

// Plate and province, or customer last name. Nothing is listed until something
// is typed, so the screen never opens on a wall of every open rental. A vehicle
// with no province on file still matches a chosen province: it cannot be ruled
// out, and hiding it would leave that rental impossible to find here.
function OpenRentalSearch({ rows, onSelect }) {
  const isMobile = useMobile();
  const [mode,     setMode]     = React.useState("plate");
  const [plate,    setPlate]    = React.useState("");
  const [province, setProvince] = React.useState("All");
  const [lastName, setLastName] = React.useState("");

  const fmtDate = (iso) => {
    if (!iso) return "-";
    const d = new Date(`${iso}T00:00:00`);
    return Number.isNaN(d.getTime()) ? iso
      : d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
  };

  const plateQuery = normalizePlate(plate);
  const nameQuery  = lastName.trim().toLowerCase();
  const query      = mode === "plate" ? plateQuery : nameQuery;
  const matches = !query ? [] : rows.filter((row) => {
    if (mode === "plate") {
      if (!normalizePlate(row.plate).includes(plateQuery)) return false;
      if (province !== "All" && row.province && row.province !== province) return false;
      return true;
    }
    return row.lastName.toLowerCase().includes(nameQuery);
  });

  const modeTab = (value, label) =>
    React.createElement("button", {
      key: value, type: "button",
      className: mode === value ? "resvPageTab resvPageTab--active" : "resvPageTab",
      onClick: () => setMode(value),
    }, label);

  const results = !query
    ? React.createElement("div", { className: "resvEmpty" },
        mode === "plate" ? "Type a plate number to find the open rental." : "Type the customer's last name to find the open rental.")
    : matches.length === 0
      ? React.createElement("div", { className: "resvEmpty" }, "No open rental agreements match.")
      : isMobile
        ? matches.map((row) =>
            React.createElement("button", {
              key: row.id, type: "button", className: "dashCard closeRentalCard",
              onClick: () => onSelect(row.id),
            },
              React.createElement("div", { className: "dashCard__header" },
                React.createElement("span", null, row.customer),
                React.createElement("span", { className: "dashCard__resCode" }, row.plate || "-")
              ),
              React.createElement("div", { className: "dashCard__meta" },
                React.createElement("span", { className: "dashCard__chip" }, row.vehicle),
                React.createElement("span", { className: "dashCard__chip" }, `Picked up ${fmtDate(row.pickupDate)}`)
              )
            )
          )
        : React.createElement("section", { className: "dashboardSection" },
            React.createElement("div", { className: "dashboardSection__body" },
              React.createElement("table", { className: "dashboardTable" },
                React.createElement("thead", null,
                  React.createElement("tr", null,
                    ["Vehicle", "Customer", "Plate", "Pickup Date"].map((col) => React.createElement("th", { key: col }, col))
                  )
                ),
                React.createElement("tbody", null,
                  matches.map((row) =>
                    React.createElement("tr", {
                      key: row.id, className: "closeRentalRow", tabIndex: 0,
                      onClick: () => onSelect(row.id),
                      onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(row.id); } },
                    },
                      React.createElement("td", null, row.vehicle),
                      React.createElement("td", null, row.customer),
                      React.createElement("td", null, row.plate || "-"),
                      React.createElement("td", null, fmtDate(row.pickupDate))
                    )
                  )
                )
              )
            )
          );

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "resvPageTabs" },
      modeTab("plate", "Plate & province"),
      modeTab("lastName", "Customer last name")
    ),
    mode === "plate"
      ? React.createElement("div", { className: "resvSearchBar" },
          React.createElement("input", {
            className: "resvSearchInput", type: "text", placeholder: "Plate number",
            autoFocus: true, autoCapitalize: "characters", autoComplete: "off",
            value: plate, onChange: (e) => setPlate(e.target.value),
          }),
          React.createElement("select", {
            className: "resvSearchInput", value: province, onChange: (e) => setProvince(e.target.value),
          }, PROV_STATE_LIST.map((p) => React.createElement("option", { key: p.value, value: p.value }, p.label)))
        )
      : React.createElement("div", { className: "resvSearchBar" },
          React.createElement("input", {
            className: "resvSearchInput", type: "text", placeholder: "Last name",
            autoFocus: true, autoComplete: "off",
            value: lastName, onChange: (e) => setLastName(e.target.value),
          })
        ),
    results
  );
}

// ─── Pending pickups ─────────────────────────────────────────────────────────
// Switch Out moves a rental onto a vehicle the customer then picks up in the
// customer app. Until they do, the agreement's open history row has no
// pickedUpAt, and neither Close Rental nor another Switch Out may touch it:
// there is nothing to close, and no vehicle the customer is actually on to
// switch away from.
async function fetchPendingPickup(rentalAgreementId) {
  const { data, error } = await supabase.from("rental_agreement_vehicles")
    .select("id, vehicleId").eq("rentalAgreementId", rentalAgreementId)
    .is("endedAt", null).is("pickedUpAt", null).maybeSingle();
  return { leg: data || null, error: error || null };
}

// The same check for the agreement a flow has selected, so a pending pickup is
// refused as soon as the rental is picked rather than after every step. A
// failed check blocks nothing here; the check made again before writing does.
function usePendingPickup(rentalAgreementId) {
  const { fleet } = React.useContext(AppContext);
  const [state, setState] = React.useState({ id: null, leg: null });
  React.useEffect(() => {
    if (!rentalAgreementId) { setState({ id: null, leg: null }); return undefined; }
    let live = true;
    fetchPendingPickup(rentalAgreementId).then((r) => { if (live) setState({ id: rentalAgreementId, leg: r.leg }); });
    return () => { live = false; };
  }, [rentalAgreementId]);
  const leg = state.id === rentalAgreementId ? state.leg : null;
  if (!leg) return null;
  const vehicle = (fleet || []).find((v) => v.id === leg.vehicleId) || null;
  return { ...leg, plate: vehicle?.plate || null };
}

const PENDING_PICKUP_CHECK_FAILED =
  "Could not check whether this rental has a vehicle waiting to be picked up. Try again.";

const closeRentalPendingMessage = (plate) =>
  `The customer hasn't picked up the new vehicle${plate ? ` (${plate})` : ""} yet. ` +
  "They need to pick it up in the customer app before this rental can be closed.";

const switchOutPendingMessage = (plate) =>
  `This rental is already switched to ${plate || "another vehicle"}, and the customer hasn't picked it up yet. ` +
  "They need to pick it up in the customer app before it can be switched again.";

function PendingPickupRefusal({ pageTitle, message, onBack }) {
  return React.createElement("div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, pageTitle),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement("div", { className: "closeRentalWarning" }, message),
    React.createElement("div", { className: "closeRentalActions" },
      React.createElement("button", { type: "button", className: "resModalCancel", onClick: onBack }, "Back")
    )
  );
}

// The check made immediately before a flow writes anything, outside
// guardAction so a refusal is not audited as the action. Returns the message
// to show, or null when the flow may go ahead.
async function pendingPickupRefusal(rentalAgreementId, fleet, messageFor) {
  const { leg, error } = await fetchPendingPickup(rentalAgreementId);
  if (error) return PENDING_PICKUP_CHECK_FAILED;
  if (!leg) return null;
  const plate = (fleet || []).find((v) => v.id === leg.vehicleId)?.plate || null;
  return messageFor(plate);
}

function CloseRentalPage() {
  const { reservations, setReservations, rentalAgreements, setRentalAgreements, fleet, setFleet, syncRAStatus, setDamageClaims, appSettings, guardAction, currentUser } =
    React.useContext(AppContext);
  const navigate = useNavigate();
  const location = useLocation();
  const [selectedId, setSelectedId] = React.useState(null);
  const [readings,   setReadings]   = React.useState(EMPTY_CLOSE_READINGS);
  const [closing,    setClosing]    = React.useState(null);
  const [damageDraft, setDamageDraft] = React.useState(EMPTY_DAMAGE_DRAFT);
  const [review,     setReview]     = React.useState(null);
  const [photos,     setPhotos]     = React.useState([]);
  const [final,      setFinal]      = React.useState(null);
  const [busy,       setBusy]       = React.useState(false);
  const [done,       setDone]       = React.useState(null);
  const [refusal,    setRefusal]    = React.useState(null);
  const pendingPickup = usePendingPickup(selectedId);

  // Captured photos live only in memory, as object URLs over their blobs.
  // Released when the page closes, so a walk away mid-flow leaks nothing.
  const photosRef = React.useRef(photos);
  photosRef.current = photos;
  React.useEffect(() => () => releasePhotos(photosRef.current), []);
  const clearPhotos = () => { releasePhotos(photosRef.current); setPhotos([]); };

  // Self-returns included: this is the flow that inspects a vehicle the
  // customer app already sent to Ready Returns. Switch Out leaves the default.
  const openRows = useOpenRentalRows({ includeSelfReturns: true });

  // Arriving from the Close Rental button on a customer page, which is now the
  // only way an open or customer_return agreement can be moved at all. Taken
  // once, and only for a rental this screen would have listed anyway: an id
  // that is not in openRows means it is not closeable, and seeding it would
  // strand the flow on a step with no rental behind it.
  const handoffId = location.state?.rentalAgreementId || null;
  const handoffTaken = React.useRef(false);
  React.useEffect(() => {
    if (handoffTaken.current || !handoffId) return;
    if (!openRows.some((r) => r.id === handoffId)) return;
    handoffTaken.current = true;
    setSelectedId(handoffId);
  }, [handoffId, openRows]);
  const row     = openRows.find((r) => r.id === (final?.rentalAgreementId || selectedId)) || null;
  const ra      = (rentalAgreements || []).find((a) => a.id === final?.rentalAgreementId) || null;
  const vehicle = row?.plate
    ? (fleet || []).find((v) => normalizePlate(v.plate) === normalizePlate(row.plate)) || null
    : null;

  // The status the returned vehicle lands on, the same rule staff get when
  // they move one out of Ready Returns: damage reported beats the default, and
  // resolvePmStatus has the last word, so a vehicle flagged for preventative
  // maintenance goes to PM rather than back into service.
  const vehicleStatus = resolvePmStatus(vehicle, returnedVehicleStatus(!!final?.newDamageFound, final?.vehicleRentable));

  // Where the agreement lands. Independent of the vehicle's status: a vehicle
  // can need cleaning without the customer owing anything for it.
  const agreementOutcome = React.useMemo(() => closeRentalOutcome({
    damageFound: !!final?.newDamageFound,
    pickupGas:   ra?.fuelAtPickup,
    returnGas:   final?.closingGasLevel,
  }), [final?.newDamageFound, ra?.fuelAtPickup, final?.closingGasLevel]);

  // What the shortage costs, when the shortage is what is holding the agreement
  // open. Only for fuel_short: a damage close and a close with an unreadable
  // pickup level both stay out of Gas Collections, the first because the fuel
  // says nothing and the second because there is nothing to measure against.
  const gasCharge = React.useMemo(() => (
    agreementOutcome.reason === "fuel_short"
      ? gasChargeForReturn({
          pickupGas: ra?.fuelAtPickup, returnGas: final?.closingGasLevel, vehicle, appSettings,
        })
      : null
  ), [agreementOutcome.reason, ra?.fuelAtPickup, final?.closingGasLevel, vehicle, appSettings]);

  const resetFlow = () => {
    setSelectedId(null); setReadings(EMPTY_CLOSE_READINGS); setClosing(null);
    setDamageDraft(EMPTY_DAMAGE_DRAFT); setReview(null); setFinal(null); setRefusal(null); clearPhotos();
  };

  // Closing the rental. One audited action: the leg this vehicle just finished
  // is written down, its photos go to the bucket, the agreement advances and
  // the vehicle takes its resulting status.
  //
  // close_pending, not closed: the vehicle is back and the inspection is done,
  // but the charges screen does not exist yet, so calling the paperwork
  // finished would be a claim nothing has earned. It is the status the return
  // already used everywhere else, and Close Pending is where an agreement
  // waiting on charges belongs.
  // When the vehicle actually came back. For a staff return that is now. For a
  // self-return it is what the customer app stamped on the agreement at the
  // time, and the staff inspection may be hours later: writing "now" would
  // record the moment someone got round to looking at it as the moment the
  // customer brought it back, which is the one fact this flow must not invent.
  // Falls back to now if returnedAt is missing or unparseable, since a wrong
  // timestamp is worse than a late one.
  const returnedAtIso = React.useMemo(() => {
    if (!row?.selfReturn || !ra?.returnedAt) return null;
    const d = new Date(ra.returnedAt);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [row?.selfReturn, ra?.returnedAt]);

  const completeClose = async () => {
    if (!final || !ra) return;
    // A rental switched onto a vehicle the customer has not collected has
    // nothing to close. Checked again here, since the pickup may have been
    // assigned after the rental was selected.
    setRefusal(null);
    setBusy(true);
    const refused = await pendingPickupRefusal(ra.id, fleet, closeRentalPendingMessage);
    setBusy(false);
    if (refused) { setRefusal(refused); return; }
    guardAction("ra.advance", async () => {
      setBusy(true);
      try {
        // The leg. Pickup readings come off the agreement's own record, which
        // is where the vehicle went out on them; the closing pair is what was
        // just entered. A non-null endedAt is what makes this leg finished and
        // lets the next one open, and it is when the vehicle came back rather
        // than when this ran, which differ on a self-return.
        const legClose = {
          endedAt:           returnedAtIso || new Date().toISOString(),
          endReason:         "returned",
          closingMileage:    final.closingMileage,
          closingGas:        final.closingGasLevel,
          damageReported:    !!final.newDamageFound,
          damageNote:        final.newDamageFound ? final.newDamageNote : null,
          // Nothing in this app captures a signature. The customer app takes
          // one at return and stores it on the agreement, so a self-service
          // return carries its signature onto the leg and a staff-run close
          // leaves it empty rather than inventing one.
          signature:         ra.returnSignature || null,
        };
        // The leg to close: the open one, which pickup opens for every
        // agreement, or the one a self-return already closed, which these
        // readings supersede. Only an agreement with neither, one opened here
        // by a status change, gets a leg inserted, so a close never leaves a
        // second row beside the first.
        const existingLeg = await supabase.from("rental_agreement_vehicles")
          .select("id").eq("rentalAgreementId", ra.id)
          .or("endedAt.is.null,endReason.eq.returned")
          .order("startedAt", { ascending: false }).limit(1).maybeSingle();
        // A failed lookup writes nothing: inserting blind could be the duplicate
        // this is here to prevent. The done screen reports it as not saved.
        let legRes;
        if (existingLeg?.error) {
          legRes = existingLeg;
        } else if (existingLeg?.data?.id) {
          legRes = await supabase.from("rental_agreement_vehicles").update(legClose).eq("id", existingLeg.data.id);
        } else {
          const leg = {
            rentalAgreementId: ra.id,
            vehicleId:         vehicle?.id || null,
            pickupMileage:     ra.mileage ?? null,
            pickupGas:         ra.fuelAtPickup ?? null,
            ...legClose,
          };
          // startedAt defaults to now, which would be wrong for a leg that is
          // ending: it began when the vehicle went out. The pickup inspection
          // stamp is the closest thing on record, and its absence leaves the
          // default rather than a guessed date.
          if (ra.inspectedAt) leg.startedAt = ra.inspectedAt;
          legRes = await supabase.from("rental_agreement_vehicles").insert(leg);
        }
        if (legRes?.error) console.warn("close rental: vehicle leg write failed:", legRes.error);

        const upload = final.photos.length
          ? await uploadDamagePhotos({
              operatorId: currentUser?.operatorId, rentalAgreementId: ra.id, photos: final.photos,
            })
          : { paths: [], failures: [] };

        // Damage found on a return is a claim, the same as damage a staff
        // member flags by hand. It was only written onto the leg before, which
        // nothing reads, so a customer could be owed for damage that appeared
        // on no screen anybody looks at.
        //
        // After the upload, so the claim carries the paths rather than an empty
        // array somebody has to go and fill. The customer and the reservation
        // code are not stored: enrichDamageClaim derives both from
        // rentalAgreementId, so that is the field that has to be right.
        let claimRes = null;
        if (final.newDamageFound) {
          const claim = {
            id:                crypto.randomUUID(),
            plate:             vehicle?.plate || ra.plate || row?.plate || null,
            rentalAgreementId: ra.id,
            description:       final.newDamageNote || null,
            photos:            upload.paths,
            status:            "open",
            vehicleRentable:   final.vehicleRentable,
          };
          claimRes = await supabase.from("damage_claims").insert(claim);
          if (claimRes?.error) {
            console.warn("close rental: damage claim insert failed:", claimRes.error);
          } else {
            setDamageClaims((prev) => [...prev, { ...claim, reportedAt: new Date().toISOString() }]);
          }
        }

        // syncRAStatus owns the status change: it writes rental_agreements,
        // and moves the vehicle for open_rental_agreement and close_pending.
        // It does NOT touch reservations, so the mirror on the reservation is
        // patched into local state below, as every other caller of it does.
        // Closing also stamps the return time, exactly as the status control
        // on the agreement page does.
        // skipFleet: the vehicle is this flow's to set, a few lines down, from
        // what the return actually found. Letting syncRAStatus move it to Ready
        // Returns as well put two writes on one row with no order between them.
        await syncRAStatus(ra.resCode, agreementOutcome.status, { skipFleet: true });

        // The fuel charge, written onto the agreement so the rental shows up on
        // Gas Collections. That screen lists every agreement with a gasOwed
        // above zero, so writing the amount is the whole of putting it there.
        //
        // After syncRAStatus, which writes this same row: two updates to one
        // row with no order between them is the race skipFleet was added to
        // stop, and it would be no better here.
        //
        // Nothing is written when the charge could not be worked out. The row
        // keeps whatever it had, which on a self-return is the amount
        // complete_return already calculated, and a blank stays blank for
        // manual entry rather than being overwritten with a zero that reads as
        // paid.
        let gasSaved = true;
        if (gasCharge) {
          const gasRes = await supabase.from("rental_agreements").update({ gasOwed: gasCharge }).eq("id", ra.id);
          if (gasRes?.error) {
            gasSaved = false;
            console.warn("close rental: gas charge write failed:", gasRes.error);
          } else {
            setRentalAgreements((prev) => prev.map((a) => (a.id === ra.id ? { ...a, gasOwed: gasCharge } : a)));
          }
        }

        const stamp = raCloseStamp(returnedAtIso ? new Date(returnedAtIso) : new Date());
        runWrite(supabase.from("reservations").update(stamp).eq("resCode", ra.resCode), "close rental: return stamp");
        setReservations((prev) => prev.map((r) => (
          r.resCode === ra.resCode ? { ...r, ...stamp, rentalAgreementStatus: agreementOutcome.status } : r
        )));

        // The vehicle, from what this return found: Needs Cleaning, or Damaged,
        // or PM when it is due for service. Ready Returns is the queue for a
        // vehicle that is back and has not been looked at, and this flow has
        // just looked at it, so it goes straight to where the inspection puts
        // it, with its renter fields cleared.
        //
        // The only write to this row now, which is why there is no read-back.
        // There used to be one: syncRAStatus fired its own un-awaited Ready
        // Returns write above, the two could land in either order, and reading
        // the row afterwards was how that was caught. skipFleet stops the
        // second write existing, so the ordering it guarded against cannot
        // arise.
        if (vehicle) {
          const patch = { status: vehicleStatus.status, currentRenter: null, dueBack: null, fileType: null };
          await supabase.from("fleet").update(patch).eq("id", vehicle.id);
          setFleet((prev) => prev.map((v) => (v.id === vehicle.id ? { ...v, ...patch } : v)));
        }

        clearPhotos();
        setDone({
          resCode:       ra.resCode || null,
          plate:         row?.plate || null,
          closingMileage: final.closingMileage,
          closingGas:    final.closingGasLevel,
          damageFound:   !!final.newDamageFound,
          vehicleRentable: final.newDamageFound ? final.vehicleRentable : null,
          agreementStatus: agreementOutcome.status,
          agreementReason: agreementOutcome.reason,
          vehicleStatus: vehicle ? vehicleStatus.status : null,
          forcedMessage: vehicle && vehicleStatus.forced ? vehicleStatus.message : null,
          legSaved:      !legRes?.error,
          claimSaved:    !claimRes?.error,
          gasOwed:       gasCharge,
          gasSaved,
          gasUncharged:  agreementOutcome.reason === "fuel_short" && !gasCharge,
          photosTaken:   final.photos.length,
          photosUploaded: upload.paths.length,
          photosFailed:  upload.failures.length,
        });
      } finally {
        setBusy(false);
      }
    }, {
      tableName: "rental_agreements",
      recordId: ra.resCode || ra.id,
      description: `Closed rental agreement ${ra.resCode || ra.id}: ${row?.plate || "vehicle"} back at ` +
        `${fmtDistance(final.closingMileage)}, gas ${final.closingGasLevel}, ` +
        (final.newDamageFound ? `new damage reported (${final.newDamageNote})` : "no new damage") +
        (gasCharge ? `, gas charge $${gasCharge}` : "") + ".",
    });
  };

  // The rental is closed. What was written is spelled out rather than summed
  // up as "saved", because anything that did not land is the one thing staff
  // need to act on before the customer leaves.
  if (done) {
    const line = (label, value) =>
      React.createElement("p", { className: "page__body" }, `${label} `, React.createElement("strong", null, value));
    return React.createElement("div", { className: "page" },
      React.createElement("h1", { className: "page__title" }, "Close Rental"),
      React.createElement("div", { className: "page__titleUnderline" }),
      React.createElement("h2", { className: "closeRentalStepTitle" }, "Rental closed"),
      done.resCode && line("Rental agreement", done.resCode),
      done.plate && line("Vehicle", done.plate),
      line("Closing mileage", fmtDistance(done.closingMileage)),
      line("Closing gas level", done.closingGas),
      line("New damage found", done.damageFound ? "Yes" : "No"),
      done.damageFound && line("Vehicle", vehicleRentableLabel(done.vehicleRentable)),
      line("Agreement status", statusLabel(done.agreementStatus)),
      done.agreementReason && CLOSE_RENTAL_REASONS[done.agreementReason] &&
        line("Reason", CLOSE_RENTAL_REASONS[done.agreementReason]),
      done.gasOwed && line("Gas owed", `$${done.gasOwed}`),
      done.vehicleStatus && line("Vehicle status", done.vehicleStatus),
      done.forcedMessage && React.createElement("div", { className: "closeRentalWarning" }, done.forcedMessage),
      !done.plate && React.createElement("div", { className: "closeRentalWarning" },
        "This agreement has no vehicle on file, so no vehicle status was changed. Check the fleet by hand."),
      !done.gasSaved && React.createElement("div", { className: "closeRentalWarning" },
        `The gas charge of $${done.gasOwed} could not be saved, so this rental is not on Gas Collections. Enter it there by hand.`),
      done.gasUncharged && React.createElement("div", { className: "closeRentalWarning" },
        "The vehicle came back with less fuel, but the charge could not be worked out: the vehicle needs a tank size and its " +
        "region needs a fuel price. Enter the amount by hand on Gas Collections."),
      !done.claimSaved && React.createElement("div", { className: "closeRentalWarning" },
        "The damage claim could not be saved, so this damage is not in Ongoing Damage Claims. " +
        "Flag it by hand from the customer's page before anyone is billed."),
      !done.legSaved && React.createElement("div", { className: "closeRentalWarning" },
        "The vehicle's return record could not be saved. The agreement and the vehicle were still updated. Tell support before this vehicle goes out again."),
      done.photosTaken > 0 && line("Damage photos uploaded", `${done.photosUploaded} of ${done.photosTaken}`),
      done.photosFailed > 0 && React.createElement("div", { className: "closeRentalWarning" },
        `${done.photosFailed} photo${done.photosFailed === 1 ? "" : "s"} could not be uploaded. Photograph the damage again from the vehicle's page.`),
      React.createElement("div", { className: "closeRentalActions" },
        React.createElement("button", { type: "button", className: "resModalCancel", onClick: () => { setDone(null); resetFlow(); } }, "Close another rental"),
        React.createElement("button", { type: "button", className: "resModalSubmit", onClick: () => navigate("/dashboard") }, "Back to Dashboard")
      )
    );
  }

  // Any step, once the selected rental turns out to have a pickup pending.
  if (selectedId && pendingPickup) {
    return React.createElement(PendingPickupRefusal, {
      pageTitle: "Close Rental", message: closeRentalPendingMessage(pendingPickup.plate), onBack: resetFlow,
    });
  }

  // Step 5. Everything steps 1 to 4 collected, and the button that writes it.
  // Back returns to whichever step came before it: photos after a Yes, damage
  // review after a No.
  if (final) {
    const line = (label, value) =>
      React.createElement("p", { className: "page__body" }, `${label} `, React.createElement("strong", null, value));
    return React.createElement("div", { className: "page" },
      React.createElement("button", {
        type: "button", className: "rentalAgreementBackBtn", disabled: busy,
        onClick: () => { setFinal(null); if (!final.newDamageFound) setReview(null); },
      }, final.newDamageFound ? "← Back to photos" : "← Back to damage review"),
      React.createElement("h1", { className: "page__title" }, "Close Rental"),
      React.createElement("div", { className: "page__titleUnderline" }),
      React.createElement("h2", { className: "closeRentalStepTitle" }, "Confirm the close"),
      line("Rental agreement", ra?.resCode || "—"),
      line("Closing mileage", fmtDistance(final.closingMileage)),
      line("Closing gas level", final.closingGasLevel),
      line("New damage found", final.newDamageFound ? "Yes" : "No"),
      final.newDamageFound && line("New damage note", final.newDamageNote),
      final.newDamageFound && line("Vehicle", vehicleRentableLabel(final.vehicleRentable)),
      final.newDamageFound && line("New damage photos", String(final.photos.length)),
      final.photos.length > 0 && React.createElement("div", { className: "damagePhotoRow", style: { marginBottom: 12 } },
        final.photos.map((p, i) => React.createElement("div", { key: p.id, className: "damagePhotoThumb" },
          React.createElement("img", { src: p.url, alt: `New damage photo ${i + 1}` })))
      ),
      line("Agreement moves to", statusLabel(agreementOutcome.status)),
      agreementOutcome.reason && CLOSE_RENTAL_REASONS[agreementOutcome.reason] &&
        line("Reason", CLOSE_RENTAL_REASONS[agreementOutcome.reason]),
      gasCharge && line("Gas owed", `$${gasCharge}`),
      agreementOutcome.reason === "fuel_short" && !gasCharge &&
        React.createElement("div", { className: "closeRentalWarning" },
          "The vehicle came back with less fuel, but the charge cannot be worked out: the vehicle needs a tank size and its " +
          "region needs a fuel price. It will have to be entered by hand on Gas Collections."),
      vehicle && line("Vehicle moves to", vehicleStatus.status),
      vehicle && vehicleStatus.forced && React.createElement("div", { className: "closeRentalWarning" }, vehicleStatus.message),
      React.createElement("p", { className: "page__body" }, "Final charges are coming soon."),
      refusal && React.createElement("div", { className: "closeRentalWarning" }, refusal),
      React.createElement("div", { className: "closeRentalActions" },
        React.createElement("button", {
          type: "button", className: "resModalCancel", disabled: busy,
          onClick: () => { setFinal(null); if (!final.newDamageFound) setReview(null); },
        }, "Back"),
        React.createElement("button", { type: "button", className: "resModalSubmit", onClick: completeClose, disabled: busy },
          busy ? "Closing..." : "Complete Close")
      )
    );
  }

  // Step 4, reached only after a Yes. Back returns to step 3 with its answer
  // and note intact. Photos already taken are kept here, so they are still
  // there if staff come forward again.
  if (review) {
    return React.createElement(CloseRentalPhotoStep, {
      row: openRows.find((r) => r.id === review.rentalAgreementId) || null,
      note: review.newDamageNote,
      photos, setPhotos,
      onBack: () => setReview(null),
      onNext: (taken) => setFinal({ ...review, photos: taken }),
    });
  }

  // Step 3. Back returns to step 2 with its values intact; they live here,
  // not in the step, so they survive the round trip. A No skips photos and
  // goes straight to step 5, dropping any photos taken under an earlier Yes.
  if (closing) {
    return React.createElement(CloseRentalDamageStep, {
      row: openRows.find((r) => r.id === closing.rentalAgreementId) || null,
      damageDraft, setDamageDraft,
      onBack: () => setClosing(null),
      onNext: (answer) => {
        const next = { ...closing, ...answer };
        setReview(next);
        if (!answer.newDamageFound) { clearPhotos(); setFinal({ ...next, photos: [] }); }
      },
    });
  }

  // Step 2. Back returns to search and drops what was entered, so the next
  // agreement picked starts empty.
  if (selectedId) {
    return React.createElement(CloseRentalReadingsStep, {
      row: openRows.find((r) => r.id === selectedId) || null,
      rentalAgreementId: selectedId,
      readings, setReadings,
      onBack: () => { setSelectedId(null); setReadings(EMPTY_CLOSE_READINGS); setDamageDraft(EMPTY_DAMAGE_DRAFT); clearPhotos(); },
      onNext: setClosing,
    });
  }

  return React.createElement("div", { className: "page" },
    React.createElement("button", { type: "button", className: "rentalAgreementBackBtn", onClick: () => navigate("/dashboard") }, "\u2190 Dashboard"),
    React.createElement("h1", { className: "page__title" }, "Close Rental"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(OpenRentalSearch, { rows: openRows, onSelect: setSelectedId })
  );
}

// ─── Switch Out ──────────────────────────────────────────────────────────────
// One rental, two vehicles: the customer brings a vehicle back mid-rental and
// leaves in another one. The agreement, the customer, the dates and everything
// billed carry on untouched; only the vehicle on it changes.
//
// Steps 1 to 4 are Close Rental's own screens, reused as they are: find the
// open agreement, closing mileage and gas, previous damage and a new damage
// answer, and live camera photos when there is new damage. Then the
// replacement vehicle and a confirm. There is no charges screen: nothing new
// is billed by a switch.
//
// The replacement is not handed over here. It goes to Ready for Pickup with a
// pending history row, and the customer picks it up in the customer app,
// which records its starting mileage, gas, photos and signature. Until then
// the rental can be neither closed nor switched again.

// Only a vehicle sitting Available can be handed over. Ready for Pickup is
// deliberately not included: it is prepared for a particular booking, and
// taking it here would strand that one.
const SWITCH_OUT_AVAILABLE_STATUS = "Available";

// Step 5. Plate and province, the same rule as the rental search: a vehicle
// with no province on file matches any province asked for. A plate that
// matches a vehicle which is not Available says what that vehicle is doing
// instead, rather than reporting nothing found.
function SwitchOutVehicleStep({ row, onBack, onNext }) {
  const { fleet } = React.useContext(AppContext);
  const isMobile = useMobile();
  const [plate,    setPlate]    = React.useState("");
  const [province, setProvince] = React.useState("All");

  const query = normalizePlate(plate);
  const matchesPlate = (v) =>
    normalizePlate(v.plate).includes(query) &&
    (province === "All" || !v.province || v.province === province);

  const candidates  = !query ? [] : (fleet || []).filter(matchesPlate);
  const available   = candidates.filter((v) => v.status === SWITCH_OUT_AVAILABLE_STATUS);
  const unavailable = candidates.filter((v) => v.status !== SWITCH_OUT_AVAILABLE_STATUS);

  const describe = (v) => [v.year, v.make, v.model].filter(Boolean).join(" ") || v.vehicleClass || "-";

  const results = !query
    ? React.createElement("div", { className: "resvEmpty" }, "Type a plate number to find the replacement vehicle.")
    : available.length === 0
      ? React.createElement("div", { className: "resvEmpty" },
          unavailable.length === 0
            ? "No vehicle with that plate and province."
            : `${unavailable[0].plate} is ${unavailable[0].status}, so it cannot be switched to. Only vehicles showing Available can.`)
      : isMobile
        ? available.map((v) =>
            React.createElement("button", {
              key: v.id, type: "button", className: "dashCard closeRentalCard",
              onClick: () => onNext(v),
            },
              React.createElement("div", { className: "dashCard__header" },
                React.createElement("span", null, describe(v)),
                React.createElement("span", { className: "dashCard__resCode" }, v.plate || "-")
              ),
              React.createElement("div", { className: "dashCard__meta" },
                React.createElement("span", { className: "dashCard__chip" }, v.province || "No province on file"),
                React.createElement("span", { className: "dashCard__chip" }, v.vehicleClass || "-")
              )
            )
          )
        : React.createElement("section", { className: "dashboardSection" },
            React.createElement("div", { className: "dashboardSection__body" },
              React.createElement("table", { className: "dashboardTable" },
                React.createElement("thead", null,
                  React.createElement("tr", null,
                    ["Vehicle", "Plate", "Province", "Class"].map((col) => React.createElement("th", { key: col }, col))
                  )
                ),
                React.createElement("tbody", null,
                  available.map((v) =>
                    React.createElement("tr", {
                      key: v.id, className: "closeRentalRow", tabIndex: 0,
                      onClick: () => onNext(v),
                      onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onNext(v); } },
                    },
                      React.createElement("td", null, describe(v)),
                      React.createElement("td", null, v.plate || "-"),
                      React.createElement("td", null, v.province || "-"),
                      React.createElement("td", null, v.vehicleClass || "-")
                    )
                  )
                )
              )
            )
          );

  return React.createElement("div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Switch Out"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement("div", { className: "closeRentalSummary" },
      React.createElement("div", { className: "closeRentalSummary__main" }, row ? row.vehicle : "Rental agreement"),
      React.createElement("div", { className: "closeRentalSummary__meta" },
        [row?.customer, row?.plate ? `out of ${row.plate}` : null].filter(Boolean).join(" \u00b7 "))
    ),
    React.createElement("h2", { className: "closeRentalStepTitle" }, "Replacement vehicle"),
    React.createElement("div", { className: "resvSearchBar" },
      React.createElement("input", {
        className: "resvSearchInput", type: "text", placeholder: "Plate number",
        autoFocus: true, autoCapitalize: "characters", autoComplete: "off",
        value: plate, onChange: (e) => setPlate(e.target.value),
      }),
      React.createElement("select", {
        className: "resvSearchInput", value: province, onChange: (e) => setProvince(e.target.value),
      }, PROV_STATE_LIST.map((pv) => React.createElement("option", { key: pv.value, value: pv.value }, pv.label)))
    ),
    results,
    React.createElement("div", { className: "closeRentalActions" },
      React.createElement("button", { type: "button", className: "resModalCancel", onClick: onBack }, "Back")
    )
  );
}

// Step 6. Everything the switch is about to change, then one button. The
// vehicle statuses shown are the ones that will be written, PM override
// included, so nothing is decided after the confirm.
function SwitchOutConfirmStep({ row, closing, review, photos, newVehicle, oldVehicleStatus, refusal, onBack, onComplete, busy }) {
  const line = (label, value) =>
    React.createElement("p", { className: "page__body" }, `${label} `, React.createElement("strong", null, value));
  const describe = (v) => [v.year, v.make, v.model].filter(Boolean).join(" ") || v.vehicleClass || "-";

  return React.createElement("div", { className: "page" },
    React.createElement("h1", { className: "page__title" }, "Switch Out"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement("div", { className: "closeRentalSummary" },
      React.createElement("div", { className: "closeRentalSummary__main" }, row ? row.customer : "Rental agreement"),
      React.createElement("div", { className: "closeRentalSummary__meta" }, "The rental agreement, dates and charges stay as they are.")
    ),
    React.createElement("h2", { className: "closeRentalStepTitle" }, "Confirm the switch"),
    line("Vehicle coming back", `${row?.vehicle || "-"} (${row?.plate || "-"})`),
    line("Closing mileage", fmtDistance(closing.closingMileage)),
    line("Closing gas level", closing.closingGasLevel),
    line("New damage found", review.newDamageFound ? "Yes" : "No"),
    review.newDamageFound && line("New damage note", review.newDamageNote),
    review.newDamageFound && line("Vehicle", vehicleRentableLabel(review.vehicleRentable)),
    review.newDamageFound && line("New damage photos", String(photos.length)),
    line("Its new status", oldVehicleStatus.status),
    oldVehicleStatus.forced && React.createElement("div", { className: "closeRentalWarning" }, oldVehicleStatus.message),
    React.createElement("h2", { className: "closeRentalStepTitle", style: { marginTop: 18 } }, "Picked up next"),
    line("Replacement vehicle", `${describe(newVehicle)} (${newVehicle.plate})`),
    line("Its new status", "Ready for Pickup"),
    React.createElement("p", { className: "page__body" },
      `The customer must now pick up ${newVehicle.plate} in the customer app, which records its starting mileage and gas. ` +
      "Until they do, this rental cannot be closed or switched again."),
    refusal && React.createElement("div", { className: "closeRentalWarning" }, refusal),
    React.createElement("div", { className: "closeRentalActions" },
      React.createElement("button", { type: "button", className: "resModalCancel", onClick: onBack, disabled: busy }, "Back"),
      React.createElement("button", { type: "button", className: "resModalSubmit", onClick: onComplete, disabled: busy },
        busy ? "Switching..." : "Complete Switch")
    )
  );
}

function SwitchOutPage() {
  const { reservations, rentalAgreements, setRentalAgreements, fleet, setFleet, setDamageClaims, guardAction, currentUser } =
    React.useContext(AppContext);
  const navigate = useNavigate();
  const [selectedId,  setSelectedId]  = React.useState(null);
  const [readings,    setReadings]    = React.useState(EMPTY_CLOSE_READINGS);
  const [closing,     setClosing]     = React.useState(null);
  const [damageDraft, setDamageDraft] = React.useState(EMPTY_DAMAGE_DRAFT);
  const [review,      setReview]      = React.useState(null);
  const [photos,      setPhotos]      = React.useState([]);
  const [photosDone,  setPhotosDone]  = React.useState(false);
  const [newVehicle,  setNewVehicle]  = React.useState(null);
  const [busy,        setBusy]        = React.useState(false);
  const [done,        setDone]        = React.useState(null);
  const [refusal,     setRefusal]     = React.useState(null);
  const pendingPickup = usePendingPickup(selectedId);

  // As in Close Rental: photos are object URLs over blobs held in memory only,
  // released when the page closes.
  const photosRef = React.useRef(photos);
  photosRef.current = photos;
  React.useEffect(() => () => releasePhotos(photosRef.current), []);
  const clearPhotos = () => { releasePhotos(photosRef.current); setPhotos([]); };

  const openRows = useOpenRentalRows();
  const row      = openRows.find((r) => r.id === selectedId) || null;
  const ra       = (rentalAgreements || []).find((a) => a.id === selectedId) || null;
  const res      = ra ? (reservations || []).find((r) => r.resCode === ra.resCode) || null : null;
  const oldVehicle = row?.plate
    ? (fleet || []).find((v) => normalizePlate(v.plate) === normalizePlate(row.plate)) || null
    : null;

  // The status the vehicle coming back lands on. Damage reported beats the
  // default, and resolvePmStatus has the last word: a vehicle flagged for
  // preventative maintenance goes to PM instead, exactly as it does when staff
  // move one out of Ready Returns.
  const oldVehicleStatus = resolvePmStatus(
    oldVehicle,
    returnedVehicleStatus(!!review?.newDamageFound, review?.vehicleRentable)
  );

  const resetFlow = () => {
    setSelectedId(null); setReadings(EMPTY_CLOSE_READINGS); setClosing(null);
    setDamageDraft(EMPTY_DAMAGE_DRAFT); setReview(null); setPhotosDone(false);
    setNewVehicle(null); setRefusal(null);
    clearPhotos();
  };

  // The switch itself. One audited action: the old vehicle is released, the
  // new one is set aside for the customer, and the agreement moves onto it.
  // Its starting mileage and gas are the customer's to record at pickup, so
  // the agreement's mileage and fuelAtPickup are left for complete_switch_pickup
  // to write. Nothing about the customer, the dates or the money is touched.
  const completeSwitch = async () => {
    if (!ra || !newVehicle || !closing || !review) return;
    const customer  = row?.customer && row.customer !== "-" ? row.customer : (res?.customer || null);
    const dueBack   = ra.returnDate || res?.returnDate || null;
    const raPatch = {
      plate:        newVehicle.plate,
      make:         newVehicle.make  || null,
      model:        newVehicle.model || null,
    };

    // A second switch while the first is uncollected would strand the vehicle
    // already set aside. Checked again here, since it may have been assigned
    // after this rental was selected, and outside guardAction so a refusal is
    // not audited as a switch.
    setRefusal(null);
    setBusy(true);
    const refused = await pendingPickupRefusal(ra.id, fleet, switchOutPendingMessage);
    setBusy(false);
    if (refused) { setRefusal(refused); return; }

    guardAction("ra.switchOut", async () => {
      setBusy(true);
      try {
        // The leg the old vehicle just finished. It is closed where it exists,
        // and written closed where it does not: an agreement opened before this
        // table existed, or through the customer app, has no open leg, and the
        // switch is no reason to lose what the vehicle came back on.
        const legClose = {
          endedAt:        new Date().toISOString(),
          endReason:      "switched_out",
          closingMileage: closing.closingMileage,
          closingGas:     closing.closingGasLevel,
          damageReported: !!review.newDamageFound,
          damageNote:     review.newDamageFound ? review.newDamageNote : null,
        };
        //
        // The two history rows are written before anything else. If either
        // fails the switch stops there, before any photo, claim, vehicle status
        // or agreement write, so a failure leaves nothing half switched. undo
        // puts the old leg back as it was if the new one cannot be opened.
        const openLeg = await supabase.from("rental_agreement_vehicles")
          .select("id").eq("rentalAgreementId", ra.id).is("endedAt", null).maybeSingle();
        let closeError = openLeg?.error || null;
        let undoClose  = null;
        if (!closeError && openLeg?.data?.id) {
          const res = await supabase.from("rental_agreement_vehicles").update(legClose).eq("id", openLeg.data.id);
          closeError = res?.error || null;
          if (!closeError) {
            undoClose = () => supabase.from("rental_agreement_vehicles").update({
              endedAt: null, endReason: null, closingMileage: null, closingGas: null, damageReported: false, damageNote: null,
            }).eq("id", openLeg.data.id);
          }
        } else if (!closeError) {
          // No signature: a switch is not a return, and nothing in this flow
          // collects one. The agreement's own signatures belong to the pickup
          // and to the final return, so neither is this leg's.
          const res = await supabase.from("rental_agreement_vehicles").insert({
            rentalAgreementId: ra.id,
            vehicleId:         oldVehicle?.id || null,
            pickupMileage:     ra.mileage ?? null,
            pickupGas:         ra.fuelAtPickup ?? null,
            ...(ra.inspectedAt ? { startedAt: ra.inspectedAt } : {}),
            ...legClose,
          }).select("id").single();
          closeError = res?.error || null;
          if (!closeError) undoClose = () => supabase.from("rental_agreement_vehicles").delete().eq("id", res.data.id);
        }
        if (closeError) console.warn("switch out: closing the old leg failed:", closeError);

        // The leg starting now, pending: no readings and no pickedUpAt until
        // the customer picks the vehicle up in the customer app. Opened only
        // after the old one is closed: one agreement may hold one open leg.
        const openRes = closeError ? null : await supabase.from("rental_agreement_vehicles").insert({
          rentalAgreementId: ra.id,
          vehicleId:         newVehicle.id,
          startedAt:         new Date().toISOString(),
        });
        if (openRes?.error) console.warn("switch out: opening the new leg failed:", openRes.error);

        if (closeError || openRes?.error) {
          let undone = true;
          if (undoClose) {
            const undoRes = await undoClose();
            if (undoRes?.error) { undone = false; console.warn("switch out: undoing the old leg failed:", undoRes.error); }
          }
          setRefusal(undone
            ? "Nothing was switched: the vehicle history could not be saved. Try again."
            : `Nothing was switched: the vehicle history could not be saved, and the history record for ${row?.plate || "the vehicle coming back"} ` +
              "was left closed. Tell support before trying again.");
          // Thrown so the audit log records the attempt as failed, not completed.
          throw new Error("vehicle history could not be saved; nothing was switched");
        }

        const upload = photos.length
          ? await uploadDamagePhotos({
              operatorId: currentUser?.operatorId, rentalAgreementId: ra.id, photos,
            })
          : { paths: [], failures: [] };

        // Damage on the vehicle coming back is a claim, as it is on a return.
        // The plate is the OLD vehicle's: the agreement is about to carry the
        // replacement's, and a claim naming the vehicle that was not damaged
        // would be worse than no claim at all.
        let claimRes = null;
        if (review.newDamageFound) {
          const claim = {
            id:                crypto.randomUUID(),
            plate:             oldVehicle?.plate || row?.plate || null,
            rentalAgreementId: ra.id,
            description:       review.newDamageNote || null,
            photos:            upload.paths,
            status:            "open",
            vehicleRentable:   review.vehicleRentable,
          };
          claimRes = await supabase.from("damage_claims").insert(claim);
          if (claimRes?.error) {
            console.warn("switch out: damage claim insert failed:", claimRes.error);
          } else {
            setDamageClaims((prev) => [...prev, { ...claim, reportedAt: new Date().toISOString() }]);
          }
        }

        // The vehicle coming back. Its renter fields are cleared, as they are
        // when a returned vehicle is marked collected. Every write from here
        // is awaited, and local state follows only the ones that landed.
        let oldRes = null;
        if (oldVehicle) {
          const oldPatch = { status: oldVehicleStatus.status, currentRenter: null, dueBack: null, fileType: null };
          oldRes = await supabase.from("fleet").update(oldPatch).eq("id", oldVehicle.id);
          if (oldRes?.error) console.warn("switch out: old vehicle failed:", oldRes.error);
          else setFleet((prev) => prev.map((v) => (v.id === oldVehicle.id ? { ...v, ...oldPatch } : v)));
        }

        // The replacement, set aside for this customer until they pick it up.
        const newPatch = { status: "Ready for Pickup", currentRenter: customer, dueBack };
        const newRes = await supabase.from("fleet").update(newPatch).eq("id", newVehicle.id);
        if (newRes?.error) console.warn("switch out: new vehicle failed:", newRes.error);
        else setFleet((prev) => prev.map((v) => (v.id === newVehicle.id ? { ...v, ...newPatch } : v)));

        const raRes = await supabase.from("rental_agreements").update(raPatch).eq("id", ra.id);
        if (raRes?.error) console.warn("switch out: rental agreement failed:", raRes.error);
        else setRentalAgreements((prev) => prev.map((a) => (a.id === ra.id ? { ...a, ...raPatch } : a)));

        clearPhotos();
        setDone({
          oldPlate: row?.plate || null,
          oldDamageFound: !!review.newDamageFound,
          oldVehicleRentable: review.newDamageFound ? review.vehicleRentable : null,
          oldStatus: oldVehicle ? oldVehicleStatus.status : null,
          forcedMessage: oldVehicle && oldVehicleStatus.forced ? oldVehicleStatus.message : null,
          newPlate: newVehicle.plate,
          resCode: ra.resCode || null,
          oldVehicleSaved: !oldRes?.error,
          newVehicleSaved: !newRes?.error,
          agreementSaved: !raRes?.error,
          claimSaved: !claimRes?.error,
          photosTaken: photos.length,
          photosUploaded: upload.paths.length,
          photosFailed: upload.failures.length,
        });
      } finally {
        setBusy(false);
      }
    }, {
      tableName: "rental_agreements",
      recordId: ra.resCode || ra.id,
      description: `Switched ${row?.plate || "the vehicle"} out for ${newVehicle.plate} on rental agreement ${ra.resCode || ra.id}: ` +
        `back at ${fmtDistance(closing.closingMileage)}, gas ${closing.closingGasLevel}, ` +
        (review.newDamageFound ? `new damage reported (${review.newDamageNote})` : "no new damage") +
        `. ${newVehicle.plate} is Ready for Pickup; the customer must now pick it up in the customer app.`,
    });
  };

  if (done) {
    const line = (label, value) =>
      React.createElement("p", { className: "page__body" }, `${label} `, React.createElement("strong", null, value));
    return React.createElement("div", { className: "page" },
      React.createElement("h1", { className: "page__title" }, "Switch Out"),
      React.createElement("div", { className: "page__titleUnderline" }),
      React.createElement("h2", { className: "closeRentalStepTitle" }, "Switch complete"),
      done.resCode && line("Rental agreement", done.resCode),
      done.oldPlate && line("Came back", `${done.oldPlate}${done.oldStatus ? `, now ${done.oldStatus}` : ""}`),
      done.oldDamageFound && line("New damage found", `Yes, ${vehicleRentableLabel(done.oldVehicleRentable).toLowerCase()}`),
      !done.oldStatus && React.createElement("div", { className: "closeRentalWarning" },
        "The vehicle coming back is not in the fleet list under that plate, so its status was left alone. Check it by hand."),
      done.forcedMessage && React.createElement("div", { className: "closeRentalWarning" }, done.forcedMessage),
      line("Replacement", `${done.newPlate}, Ready for Pickup`),
      React.createElement("p", { className: "page__body" },
        `The customer must now pick up ${done.newPlate} in the customer app, which records its starting mileage and gas. ` +
        "Until they do, this rental cannot be closed or switched again."),
      !done.claimSaved && React.createElement("div", { className: "closeRentalWarning" },
        "The damage claim could not be saved, so this damage is not in Ongoing Damage Claims. " +
        "Flag it by hand from the customer's page before anyone is billed."),
      !done.oldVehicleSaved && React.createElement("div", { className: "closeRentalWarning" },
        `${done.oldPlate || "The vehicle coming back"} could not be moved to ${done.oldStatus}. Set its status by hand on the fleet page.`),
      !done.newVehicleSaved && React.createElement("div", { className: "closeRentalWarning" },
        `${done.newPlate} could not be moved to Ready for Pickup. Set its status by hand on the fleet page.`),
      !done.agreementSaved && React.createElement("div", { className: "closeRentalWarning" },
        `The rental agreement could not be moved onto ${done.newPlate}, so it still shows ${done.oldPlate || "the old vehicle"}. Tell support before the customer arrives.`),
      done.photosTaken > 0 && line("Damage photos uploaded", `${done.photosUploaded} of ${done.photosTaken}`),
      done.photosFailed > 0 && React.createElement("div", { className: "closeRentalWarning" },
        `${done.photosFailed} photo${done.photosFailed === 1 ? "" : "s"} could not be uploaded. Photograph the damage again from the vehicle's page.`),
      React.createElement("div", { className: "closeRentalActions" },
        React.createElement("button", {
          type: "button", className: "resModalCancel",
          onClick: () => { setDone(null); resetFlow(); },
        }, "Switch another"),
        React.createElement("button", { type: "button", className: "resModalSubmit", onClick: () => navigate("/dashboard") }, "Done")
      )
    );
  }

  // Any step, once the selected rental turns out to have a pickup pending.
  if (selectedId && pendingPickup) {
    return React.createElement(PendingPickupRefusal, {
      pageTitle: "Switch Out", message: switchOutPendingMessage(pendingPickup.plate), onBack: resetFlow,
    });
  }

  // Step 6: confirm.
  if (newVehicle) {
    return React.createElement(SwitchOutConfirmStep, {
      row, closing, review, photos, newVehicle, oldVehicleStatus, refusal, busy,
      onBack: () => { setNewVehicle(null); setRefusal(null); },
      onComplete: completeSwitch,
    });
  }

  // Step 5: which vehicle the customer leaves in.
  if (review && photosDone) {
    return React.createElement(SwitchOutVehicleStep, {
      row,
      onBack: () => { if (review.newDamageFound) setPhotosDone(false); else { setPhotosDone(false); setReview(null); } },
      onNext: setNewVehicle,
    });
  }

  // Step 4: photos, only after a Yes.
  if (review) {
    return React.createElement(CloseRentalPhotoStep, {
      row, note: review.newDamageNote,
      photos, setPhotos, pageTitle: "Switch Out",
      onBack: () => setReview(null),
      onNext: () => setPhotosDone(true),
    });
  }

  // Step 3: previous damage, and whether there is new damage.
  if (closing) {
    return React.createElement(CloseRentalDamageStep, {
      row,
      damageDraft, setDamageDraft, pageTitle: "Switch Out",
      onBack: () => setClosing(null),
      onNext: (answer) => {
        setReview({ ...closing, ...answer });
        if (!answer.newDamageFound) { clearPhotos(); setPhotosDone(true); }
      },
    });
  }

  // Step 2: the returning vehicle's closing readings.
  if (selectedId) {
    return React.createElement(CloseRentalReadingsStep, {
      row, rentalAgreementId: selectedId,
      readings, setReadings,
      labels: { pageTitle: "Switch Out" },
      onBack: resetFlow,
      onNext: setClosing,
    });
  }

  // Step 1: find the open rental.
  return React.createElement("div", { className: "page" },
    React.createElement("button", { type: "button", className: "rentalAgreementBackBtn", onClick: () => navigate("/dashboard") }, "\u2190 Dashboard"),
    React.createElement("h1", { className: "page__title" }, "Switch Out"),
    React.createElement("div", { className: "page__titleUnderline" }),
    React.createElement(OpenRentalSearch, { rows: openRows, onSelect: setSelectedId })
  );
}

// ─── CustomerPage data ────────────────────────────────────────────────────────

const DEFAULT_LINE_ITEMS = [
  { key: "vehicle", label: "Vehicle Cost",     applies: true,  amount: "", qty: "", qtyPlaceholder: "Days"   },
  { key: "winter",  label: "Winter Tires",     applies: false, amount: "", qty: "", qtyPlaceholder: "Days", customerPay: false },
  { key: "gas",     label: "Gas",              applies: false, amount: "", qty: "", qtyPlaceholder: "Litres" },
  { key: "mileage", label: "Mileage",          applies: false, amount: "", qty: "", qtyPlaceholder: "Miles"  },
];

// The protection lines on a customer's charges are the products they accepted
// at pickup, one line each, priced per day as recorded then. Agreements made
// before this kept three fixed lines under these keys; those still load from
// lineItems as they were saved and behave as they always did.
const LEGACY_PROTECTION_KEYS = ["waiver", "roadside", "injury"];
// The other driver's daily charge is treated the same way: an additional
// charge the customer pays unless it is marked covered by the bill-to, priced
// per day and refilled with the rental days.
const isProtectionLine = (item) => !!item.protection || !!item.otherDriver || LEGACY_PROTECTION_KEYS.includes(item.key);

// Adds a line for each accepted product the charges do not have yet. A line
// already there is left as staff last saved it.
function withAcceptedProtection(items, choices, days) {
  if (!Array.isArray(choices)) return items;
  const have = new Set(items.map((it) => it.key));
  const added = choices
    .filter((c) => c && c.accepted && c.productId != null && !have.has(`protection:${c.productId}`))
    .map((c) => ({
      key: `protection:${c.productId}`, label: c.name || "Protection", protection: true,
      applies: true, amount: c.pricePerDay != null ? String(c.pricePerDay) : "",
      qty: days ? String(days) : "", qtyPlaceholder: "Days", coveredByBillTo: false,
    }));
  return added.length ? [...items, ...added] : items;
}

// Adds the other driver's line, at the daily charge complete_pickup recorded,
// when the agreement has an other driver and the charges do not have the line
// yet. A line already there is left as staff last saved it.
function withOtherDriver(items, otherDriver, days) {
  if (!otherDriver || typeof otherDriver !== "object") return items;
  if (items.some((it) => it.key === "otherDriver")) return items;
  const charge = otherDriver.dailyCharge;
  return [...items, {
    key: "otherDriver", label: otherDriver.name ? `Other driver: ${otherDriver.name}` : "Other driver",
    otherDriver: true, applies: true, amount: charge != null ? String(charge) : "",
    qty: days ? String(days) : "", qtyPlaceholder: "Days", coveredByBillTo: false,
  }];
}

// What a charge line's quantity counts. Gas and mileage follow the company's
// units; every other line is charged by the day. Worked out from the key, not
// the saved line, so a line saved before the units changed shows the unit the
// company uses now.
const chargeQtyUnit = (item) =>
  item.key === "gas" ? fuelUnit() : item.key === "mileage" ? distanceUnit() : "days";
const chargeQtyPlaceholder = (item) =>
  item.key === "gas"     ? (fuelUnit() === "gal" ? "Gallons" : "Litres")
  : item.key === "mileage" ? (distanceUnit() === "mi" ? "Miles" : "Kilometres")
  : item.qtyPlaceholder;

const DAILY_RATES = {
  "Bodyshop/Dealership": { Car: 35, SUV: 45, Minivan: 55, Truck: 55 },
  "Insurance":           { Car: 35, SUV: 45, Minivan: 55, Truck: 55 },
  "Corporate":           { Car: 45, SUV: 55, Minivan: 65, Truck: 65 },
  "Retail":              { Car: 55, SUV: 65, Minivan: 75, Truck: 75 },
};
const RATES_SOURCE_CATS = {
  "Bodyshop/Dealership": ["Avalon Ford", "Fix Auto", "CarStar", "Collision Clinic Topsail", "Capital Collision", "Janes Autobody", "Custom Automotive", "Brian's Autobody", "RDS Autobody"],
  "Insurance":           ["TD Insurance", "Bel-Air Direct", "Intact", "CAA", "Desjardins Insurance", "The Co-operators", "Aviva Canada"],
  "Corporate":           ["MyEHTrip", "NBA", "NHL", "Nike", "Microsoft"],
  "Retail":              [],
};

// insurance_rentals decides whether Insurance is offered as a source for new
// work. A record that already says Insurance keeps it as a choice, so its
// picker still shows what it is instead of quietly landing on another option.
// Nothing else about insurance rentals changes when the flag is off: existing
// insurance records display and bill exactly as before.
function offerInsuranceSource(current) {
  return isFeatureEnabled("insurance_rentals") || sourceBillingType(current) === "insurance";
}

function sourceCatsFor(current) {
  if (companyLists) {
    // The same rule on the company's own list: an insurance source is offered
    // when the feature is on, or when it is what the record already says.
    const curCat = String(current || "").split(LIST_SEP)[0];
    const cats = {};
    companyLists.sources.forEach((x) => {
      const isCurrent = x.name === curCat;
      if (!x.active && !isCurrent) return;
      if (x.billingType === "insurance" && !isFeatureEnabled("insurance_rentals") && !isCurrent) return;
      cats[x.name] = x.details.filter((d) => d.active).map((d) => d.name);
    });
    if (curCat && !cats[curCat]) cats[curCat] = [];
    return cats;
  }
  if (offerInsuranceSource(current)) return RATES_SOURCE_CATS;
  const { Insurance, ...rest } = RATES_SOURCE_CATS;
  return rest;
}
const RATES_VCLASS_CATS = {
  "Car":     ["Compact", "Regular", "Large"],
  "SUV":     ["Compact", "Regular", "Large"],
  "Minivan": [],
  "Truck":   [],
};

// ─── CustomerPage ─────────────────────────────────────────────────────────────

function CustomerPage() {
  const { openCustomer, reservations, setReservations, rentalAgreements, setRentalAgreements, fleet, syncRAStatus, guardAction, logAudit, setDamageClaims } = React.useContext(AppContext);
  const navigate = useNavigate();
  const name   = openCustomer?.name   || "Customer";
  const resCode = openCustomer?.resCode || null;

  // ── Single source of truth: raw Supabase record ───────────────────────────
  const [localRecord,   setLocalRecord]   = React.useState(null);
  const [recordLoading, setRecordLoading] = React.useState(true);

  const [resInfoForm, setResInfoForm] = React.useState({
    firstName: "", lastName: "", phone: "", email: "",
    pickupDate: "", pickupTime: "", pickupMeridiem: "AM",
    returnDate: "", returnTime: "", returnMeridiem: "AM",
    licenseNumber: "", licenseCountry: "", licenseState: "", licenseExpiry: "",
  });
  const updateRI = (f, value) => setResInfoForm((p) => ({ ...p, [f]: value }));

  const [openCal,  setOpenCal]  = React.useState(null);
  const [calAnchor, setCalAnchor] = React.useState({ x: 0, y: 0 });
  const [calMonths, setCalMonths] = React.useState({});
  const todayIso = new Date().toISOString().slice(0, 10);

  const openCalFor = (key, e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setCalAnchor({ x: rect.left, y: rect.bottom + 4 });
    setOpenCal((prev) => (prev === key ? null : key));
  };
  const moveCalMonth = (key, delta) => {
    setCalMonths((prev) => {
      const base = prev[key] || `${(resInfoForm[key] || todayIso).slice(0, 7)}-01`;
      const [y, m] = base.split("-").map(Number);
      const next = new Date(y, m - 1 + delta, 1);
      return { ...prev, [key]: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01` };
    });
  };
  const getCalDays = (key) => {
    const monthIso = calMonths[key] || `${(resInfoForm[key] || todayIso).slice(0, 7)}-01`;
    const [y, m] = monthIso.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const cells = [];
    for (let i = 0; i < monthStart.getDay(); i++) cells.push(null);
    for (let d = 1; d <= new Date(y, m, 0).getDate(); d++)
      cells.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    while (cells.length % 7 !== 0) cells.push(null);
    return { monthStart, cells };
  };

  const PLACEHOLDER_SECTIONS = [];

  const [customerNotesLog, setCustomerNotesLog] = React.useState([]);
  const [customerNoteInput, setCustomerNoteInput] = React.useState("");

  const handleAddCustomerNote = () => {
    const text = customerNoteInput.trim();
    if (!text || !resCode) return;
    const newNote = { author: "Connor Nash", text, at: new Date().toISOString() };
    const newLog = [...customerNotesLog, newNote];
    setCustomerNotesLog(newLog);
    setCustomerNoteInput("");
    setLocalRecord((prev) => prev ? { ...prev, notesLog: newLog } : prev);
    setReservations((prev) =>
      prev.map((r) => r.resCode === resCode ? { ...r, notesLog: newLog } : r)
    );
    supabase.from("reservations").update({ notesLog: newLog }).eq("resCode", resCode)
      .then((res) => console.log("reservations notes update:", res))
      .catch((e) => console.warn("reservations notes update:", e));
  };

  const [chargesTab,  setChargesTab]  = React.useState("Charges");
  const [lineItems,   setLineItems]   = React.useState(DEFAULT_LINE_ITEMS);
  const [payments,    setPayments]    = React.useState([]);

  const [ratesForm, setRatesForm] = React.useState({
    source: "", vehicleClass: "", winterTires: "No",
  });
  // Picking a source or a vehicle class refills the daily rate from the
  // company's rates, blank when there is none for the pair. Only a change
  // does: opening a file leaves the rate it was saved with, including one
  // staff typed over.
  const updateRates = (f, v) => {
    const next = { ...ratesForm, [f]: v };
    setRatesForm(next);
    if ((f === "source" || f === "vehicleClass") && next.source && next.vehicleClass) {
      const rate = dailyRateFor(next.source, next.vehicleClass);
      setBillToForm((p) => ({ ...p, dailyRate: rate !== undefined ? String(rate) : "" }));
    }
  };
  const [openRatesPicker, setOpenRatesPicker] = React.useState(null);
  const [ratesPickerAnchor, setRatesPickerAnchor] = React.useState({ x: 0, y: 0 });
  const [ratesHoverCat, setRatesHoverCat] = React.useState(null);

  const [billToForm, setBillToForm] = React.useState({
    adjusterName: "", fileNumber: "", claimNumber: "",
    dailyRate: "", authNumber: "", poNumber: "", paymentMethod: "Credit Card",
  });
  const updateBillTo = (f, v) => setBillToForm((p) => ({ ...p, [f]: v }));

  const [customerVehicleForm, setCustomerVehicleForm] = React.useState({
    year: "", make: "", model: "",
  });
  const updateCustVeh = (f, v) => setCustomerVehicleForm((p) => ({ ...p, [f]: v }));

  const [rentalVehicle, setRentalVehicle] = React.useState({
    year: "", make: "", model: "", plate: "", vehicleClass: "", province: "", colour: "", vin: "", damage: "", fuelLevel: "", mileage: "",
  });

  // Derived from rentalAgreements for read-only fields and auto-population
  const ra = rentalAgreements.find((r) => r.resCode === resCode) || null;

  // Sales tax. The taxes locked onto the agreement at pickup, or for an
  // agreement with none locked (no agreement yet, one made before taxes, or a
  // branch with none set at pickup) the branch's current taxes.
  const taxBranchId = ra?.locationId || localRecord?.locationId || null;
  const [branchTaxes, setBranchTaxes] = React.useState([]);
  React.useEffect(() => {
    if (!taxBranchId) { setBranchTaxes([]); return undefined; }
    let live = true;
    supabase.from("locations").select("salesTaxes").eq("id", taxBranchId).maybeSingle()
      .then(({ data, error }) => {
        if (!live) return;
        if (error) console.warn("Sales tax could not be loaded:", error.message);
        setBranchTaxes(!error && Array.isArray(data?.salesTaxes) ? data.salesTaxes : []);
      });
    return () => { live = false; };
  }, [taxBranchId]);
  const salesTaxes = (Array.isArray(ra?.salesTaxes) ? ra.salesTaxes : branchTaxes)
    .filter((t) => t && String(t.name ?? "").trim() !== "" && Number(t.rate) > 0)
    .slice(0, 2);

  // Populate rental vehicle from rental_agreements when an RA exists for this resCode.
  // Year and province come from the fleet record first, falling back to VEHICLE_EXTRA_DATA.
  React.useEffect(() => {
    if (!resCode) return;
    const ra = rentalAgreements.find((r) => r.resCode === resCode);
    if (!ra) return;
    const extra       = VEHICLE_EXTRA_DATA[ra.plate] || {};
    const fleetVehicle = fleet.find((v) => v.plate === ra.plate) || {};
    setRentalVehicle({
      plate:        ra.plate              || "",
      make:         ra.make               || "",
      model:        ra.model              || "",
      vehicleClass: ra.vehicleClass       || "",
      year:         fleetVehicle.year     ? String(fleetVehicle.year) : (extra.year ? String(extra.year) : ""),
      province:     fleetVehicle.province || extra.province || "",
      colour:       fleetVehicle.colour   || extra.colour   || "",
      vin:          fleetVehicle.vin      || extra.vin      || "",
      fuelLevel:    ra.fuelAtPickup       || "",
      mileage:      ra.mileage            ? String(ra.mileage) : "",
      damage:       "",
    });
  }, [resCode, rentalAgreements, fleet]);

  // ── Fetch latest record from Supabase ───────────────────────────────────────
  const fetchRecord = React.useCallback(async () => {
    if (!resCode) return;
    setRecordLoading(true);
    try {
      const { data, error } = await supabase
        .from("reservations").select("*").eq("resCode", resCode).maybeSingle();
      if (!error && data) setLocalRecord(data);
    } catch (e) {
      console.warn("CustomerPage fetchRecord error:", e);
    } finally {
      setRecordLoading(false);
    }
  }, [resCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch on mount
  React.useEffect(() => { fetchRecord(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate all form states whenever localRecord changes (initial load or post-save re-fetch)
  React.useEffect(() => {
    if (!localRecord) return;
    const np = normalizeTo12h(localRecord.time || localRecord.pickupTime || "", localRecord.pickupMeridiem || "AM");
    const nr = normalizeTo12h(localRecord.returnTime || "", localRecord.returnMeridiem || "AM");
    setResInfoForm({
      firstName:      localRecord.firstName      || "",
      lastName:       localRecord.lastName       || "",
      phone:          localRecord.phone          || "",
      email:          localRecord.email          || "",
      pickupDate:     localRecord.date           || "",
      pickupTime:     np.digits,
      pickupMeridiem: np.meridiem,
      returnDate:     localRecord.returnDate     || "",
      returnTime:     nr.digits,
      returnMeridiem: nr.meridiem,
      licenseNumber:  localRecord.licenseNum     || localRecord.licenseNumber || "",
      licenseCountry: localRecord.licenseCountry || "",
      licenseState:   localRecord.licenseProvince || localRecord.licenseState || "",
      licenseExpiry:  localRecord.licenseExpiry  || "",
    });
    const srcStr = localRecord.sourceDetail
      ? `${localRecord.source} — ${localRecord.sourceDetail}`
      : (localRecord.source || "");
    // One vehicle class for the whole reservation: the one it was booked with.
    setRatesForm({ source: srcStr, vehicleClass: localRecord.vehicleClass || "", winterTires: localRecord.winterTires || "No" });
    setBillToForm({
      adjusterName:  localRecord.adjusterName  || "",
      fileNumber:    localRecord.fileNumber    || "",
      claimNumber:   localRecord.claimNumber   || "",
      dailyRate:     localRecord.dailyRate     || "",
      authNumber:    localRecord.authNumber    || "",
      poNumber:      localRecord.poNumber      || "",
      paymentMethod: localRecord.paymentMethod || "Credit Card",
    });
    setCustomerVehicleForm({
      year:  localRecord.vehicleYear  || "",
      make:  localRecord.vehicleMake  || "",
      model: localRecord.vehicleModel || "",
    });
    setCustomerNotesLog(parseNotesLog(localRecord.notesLog));
  }, [localRecord]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate lineItems and payments once from rental_agreements when the RA record first loads
  const raHydratedId = React.useRef(null);
  React.useEffect(() => {
    if (!ra?.id || ra.id === raHydratedId.current) return;
    raHydratedId.current = ra.id;
    const saved = Array.isArray(ra.lineItems) && ra.lineItems.length > 0 ? ra.lineItems : null;
    const startDays = (() => {
      const d1 = resInfoForm.pickupDate ? new Date(`${resInfoForm.pickupDate}T00:00:00`) : null;
      const d2 = resInfoForm.returnDate ? new Date(`${resInfoForm.returnDate}T00:00:00`) : null;
      if (!d1 || !d2) return 0;
      const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
      return diff > 0 ? diff : 0;
    })();
    setLineItems((prev) => withOtherDriver(
      withAcceptedProtection(saved || prev, ra.protectionChoices, startDays), ra.otherDriver, startDays));
    if (Array.isArray(ra.payments)) {
      setPayments(ra.payments);
    }
  }, [ra]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const d1 = resInfoForm.pickupDate ? new Date(`${resInfoForm.pickupDate}T00:00:00`) : null;
    const d2 = resInfoForm.returnDate ? new Date(`${resInfoForm.returnDate}T00:00:00`) : null;
    if (!d1 || !d2) return;
    const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
    const days = diff > 0 ? diff : 0;
    setLineItems((prev) => prev.map((item) =>
      ["vehicle", "winter"].includes(item.key) || isProtectionLine(item)
        ? { ...item, qty: String(days) }
        : item
    ));
  }, [resInfoForm.pickupDate, resInfoForm.returnDate]);

  React.useEffect(() => {
    const checked = ratesForm.winterTires === "Yes";
    setLineItems((prev) => prev.map((item) =>
      item.key === "winter" ? { ...item, applies: checked } : item
    ));
  }, [ratesForm.winterTires]);

  React.useEffect(() => {
    setLineItems((prev) => prev.map((item) =>
      item.key === "vehicle" ? { ...item, amount: billToForm.dailyRate } : item
    ));
  }, [billToForm.dailyRate]);

  const [saveStatus, setSaveStatus] = React.useState("idle"); // "idle" | "saving" | "error"

  const handleSave = async () => {
    if (!resCode) return;
    setSaveStatus("saving");
    try {
      const srcParts = ratesForm.source.includes(" — ")
        ? ratesForm.source.split(" — ") : [ratesForm.source, ""];
      // Build the full candidate payload (form → Supabase field names)
      const candidate = {
        firstName:       resInfoForm.firstName,
        lastName:        resInfoForm.lastName,
        phone:           resInfoForm.phone,
        email:           resInfoForm.email,
        date:            resInfoForm.pickupDate,
        time:            `${toDisplayTime(resInfoForm.pickupTime)} ${resInfoForm.pickupMeridiem}`.trim(),
        pickupTime:      resInfoForm.pickupTime,
        pickupMeridiem:  resInfoForm.pickupMeridiem,
        returnDate:      resInfoForm.returnDate,
        returnTime:      resInfoForm.returnTime,
        returnMeridiem:  resInfoForm.returnMeridiem,
        licenseNum:      resInfoForm.licenseNumber,
        licenseCountry:  resInfoForm.licenseCountry,
        licenseProvince: resInfoForm.licenseState,
        licenseExpiry:   resInfoForm.licenseExpiry,
        source:          srcParts[0] || "",
        sourceDetail:    srcParts[1] || "",
        vehicleClass:    ratesForm.vehicleClass,
        dailyRate:       billToForm.dailyRate,
        winterTires:     ratesForm.winterTires,
        vehicleYear:     customerVehicleForm.year,
        vehicleMake:     customerVehicleForm.make,
        vehicleModel:    customerVehicleForm.model,
      };
      // Diff against localRecord — only write fields that actually changed
      const patch = Object.fromEntries(
        Object.entries(candidate).filter(
          ([k, v]) => String(localRecord?.[k] ?? "") !== String(v ?? "")
        )
      );
      if (Object.keys(patch).length > 0) {
        const res = await supabase.from("reservations").update(patch).eq("resCode", resCode);
        console.log("reservations save — patch:", patch, "response:", res);
      } else {
        console.log("reservations save — no changes detected, skipping write");
      }
      // Save lineItems and payments to rental_agreements
      if (ra?.id) {
        const raRes = await supabase
          .from("rental_agreements")
          .update({ "lineItems": lineItems, "payments": payments })
          .eq("id", ra.id);
        console.log("rental_agreements charges save — response:", raRes);
        if (!raRes.error) {
          setRentalAgreements((prev) =>
            prev.map((r) => r.id !== ra.id ? r : { ...r, lineItems, payments })
          );
        }
      }
      // Re-fetch fresh record from Supabase and update both local and global state
      const { data: fresh } = await supabase
        .from("reservations").select("*").eq("resCode", resCode).maybeSingle();
      if (fresh) {
        setLocalRecord(fresh);
        setReservations((prev) =>
          prev.map((r) => r.resCode !== resCode ? r : { ...r, ...fresh })
        );
      } else {
        // Fallback: merge candidate into global state even without a re-fetch
        setReservations((prev) =>
          prev.map((r) => r.resCode !== resCode ? r : { ...r, ...candidate })
        );
      }
      navigate(-1);
    } catch (e) {
      console.warn("reservations save error:", e);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    }
  };

  const [sect, setSect] = React.useState({
    resInfo: true, vehicles: true, ratesBilling: true, charges: true, notes: true, rentalAgreementOptions: true,
  });
  const toggle = (key) => setSect((prev) => ({ ...prev, [key]: !prev[key] }));

  // The agreement is authoritative. localRecord is this page's own fetch of the
  // reservation row, straight from the database and never passed through the
  // load-time merge, so its rentalAgreementStatus is the raw mirror column:
  // complete_pickup writes it and complete_return does not, which left a
  // customer self-return reading Open here for good, on the page the rental
  // agreements list actually opens. Kept as the fallback for a reservation with
  // no agreement yet, and "reservation" when there is neither.
  const rentalAgreementStatus =
    ra?.rentalAgreementStatus || localRecord?.rentalAgreementStatus || "reservation";

  // The vehicle this reservation will actually go out on. Checked before a
  // rental agreement is opened so a PM-due vehicle cannot be rented silently.
  const pmVehicle = React.useMemo(() => {
    const plate = ra?.plate || localRecord?.plate || rentalVehicle.plate;
    if (!plate) return null;
    return fleet.find((v) => normalizePlate(v.plate) === normalizePlate(plate)) || null;
  }, [ra, localRecord, rentalVehicle.plate, fleet]);

  const openRentalAgreement = () => {
    // Warn before the PIN prompt so staff are not asked to authenticate an
    // action they are about to cancel.
    if (!confirmRentalDespitePm(pmVehicle)) {
      console.log("rental open cancelled: vehicle flagged for PM", pmVehicle?.plate);
      // Declining the PM warning never reaches guardAction, so it logs itself.
      logAudit({
        actionType: pmVehicle?.needsPm ? "ra.openDespitePm" : "ra.open",
        tableName: "reservations", recordId: resCode,
        outcome: "refused",
        description: `Declined to open the rental: ${pmVehicle?.plate || "the vehicle"} is flagged for preventative maintenance.`,
      });
      return;
    }
    // The key depends on the vehicle, not on the button. Overriding a PM flag
    // is Admin-only and is logged under its own action, so the log can answer
    // "who put a vehicle that was due for service on the road" without anyone
    // reading descriptions to work out which ra.open entries were overrides.
    guardAction(pmVehicle?.needsPm ? "ra.openDespitePm" : "ra.open", () => {
      setLocalRecord((prev) => prev ? { ...prev, rentalAgreementStatus: "open_rental_agreement" } : prev);
      setReservations((prev) =>
        prev.map((r) => r.resCode === resCode ? { ...r, rentalAgreementStatus: "open_rental_agreement" } : r)
      );
      syncRAStatus(resCode, "open_rental_agreement");
    }, { tableName: "reservations", recordId: resCode, description: `Rental agreement opened${pmVehicle?.plate ? ` on ${pmVehicle.plate}` : ""}.` });
  };

  const updateRentalAgreementStatus = (status) => {
    // The rule, checked here as well as enforced by which buttons exist below.
    // A refusal reaching this point means a button got out of step with the
    // rule, so it says so rather than writing and being wrong quietly.
    const allowed = manualRaTransition(rentalAgreementStatus, status);
    if (!allowed.ok) {
      window.alert(allowed.error);
      logAudit({
        actionType: "ra.advance", tableName: "reservations", recordId: resCode,
        outcome: "refused",
        description: `Refused a manual status change ${rentalAgreementStatus} -> ${status}: not a permitted manual transition.`,
      });
      return;
    }
    // Reopening a rental agreement is the same soft block as opening one.
    if (status === "open_rental_agreement" && !confirmRentalDespitePm(pmVehicle)) {
      console.log("rental reopen cancelled: vehicle flagged for PM", pmVehicle?.plate);
      logAudit({
        actionType: pmVehicle?.needsPm ? "ra.openDespitePm" : "ra.open",
        tableName: "reservations", recordId: resCode,
        outcome: "refused",
        description: `Declined to reopen the rental: ${pmVehicle?.plate || "the vehicle"} is flagged for preventative maintenance.`,
      });
      return;
    }
    guardAction(
      status !== "open_rental_agreement" ? "ra.advance"
        : pmVehicle?.needsPm ? "ra.openDespitePm" : "ra.open", () => {
      setLocalRecord((prev) => prev ? { ...prev, rentalAgreementStatus: status } : prev);
      setReservations((prev) =>
        prev.map((r) => r.resCode === resCode ? { ...r, rentalAgreementStatus: status } : r)
      );
      syncRAStatus(resCode, status);

      // Auto-stamp return date/time at the moment of close
      if (RA_CLOSING_STATUSES.includes(status)) {
        const stamp = raCloseStamp();
        setResInfoForm((p) => ({ ...p, ...stamp }));
        supabase.from("reservations").update(stamp).eq("resCode", resCode)
          .then((res) => console.log("reservations return date/time update:", res))
          .catch((e) => console.warn("reservations return date/time update:", e));
      }
    }, { tableName: "reservations", recordId: resCode, description: `Rental agreement status ${rentalAgreementStatus} -> ${status}.` });
  };

  const handleDeleteReservation = async () => {
    if (!resCode) return;
    const confirmed = window.confirm(
      `Delete reservation ${resCode} for ${name}? This cannot be undone.`
    );
    if (!confirmed) return;
    guardAction("reservation.delete", async () => {
      setReservations((prev) => prev.filter((r) => r.resCode !== resCode));
      try {
        await supabase.from("reservations").delete().eq("resCode", resCode);
      } catch (e) {
        console.warn("Delete reservation error:", e);
      }
      navigate(-1);
    }, { tableName: "reservations", recordId: resCode, description: `Deleted reservation for ${name}.` });
  };

  const deleteBtn = React.createElement("button", {
    type: "button",
    className: "customerRentalAgreementBtn customerRentalAgreementBtn--delete",
    style: { marginLeft: "auto" },
    onClick: handleDeleteReservation,
  }, "Delete");

  const isDamaged = !!localRecord?.hasDamage;
  const flagDamageBtn = React.createElement("button", {
    type: "button",
    className: isDamaged
      ? "customerRentalAgreementBtn customerRentalAgreementBtn--damage customerRentalAgreementBtn--damage-active"
      : "customerRentalAgreementBtn customerRentalAgreementBtn--damage",
    disabled: isDamaged,
    onClick: () => {
      if (!resCode || isDamaged) return;
      const description = window.prompt("Describe the damage:") || "";
      // Opens a claim that a customer can be billed against, so it takes the PIN.
      guardAction("damage.flag", () => {
        setLocalRecord((prev) => prev ? { ...prev, hasDamage: true } : prev);
        setReservations((prev) =>
          prev.map((r) => r.resCode === resCode ? { ...r, hasDamage: true } : r)
        );
        runWrite(supabase.from("reservations").update({ hasDamage: true }).eq("resCode", resCode), "reservations update");

        // Flagging damage here is a manual, standalone report (no return flow,
        // no photos), it still creates a real damage_claims row.
        const claim = {
          id:                crypto.randomUUID(),
          plate:             ra?.plate || null,
          rentalAgreementId: ra?.id || null,
          description:       description || null,
          photos:            [],
          status:            "open",
        };
        setDamageClaims((prev) => [...prev, { ...claim, reportedAt: new Date().toISOString() }]);
        runWrite(supabase.from("damage_claims").insert(claim), "damage_claims insert");
      }, { tableName: "damage_claims", recordId: resCode, description: `Damage flagged${ra?.plate ? ` on ${ra.plate}` : ""}: ${description || "no description given"}.` });
    },
  }, isDamaged ? "Damage Flagged" : "Flag Damage");

  // Hands the agreement across, so Close Rental opens on this rental rather
  // than on its search step with the person retyping what they just clicked.
  const closeRentalBtn = React.createElement("button", {
    type: "button", className: "customerRentalAgreementBtn customerRentalAgreementBtn--pending",
    onClick: () => navigate("/close-rental", { state: { rentalAgreementId: ra?.id || null } }),
  }, "Close Rental");

  const rentalAgreementOptionsBody = () => {
    if (rentalAgreementStatus === "reservation") {
      return React.createElement("div", { className: "customerRentalAgreementBtnRow" },
        deleteBtn
      );
    }
    // Out, or just back from the customer and not yet inspected. Both are
    // Close Rental's to move: the two buttons that used to sit here wrote a
    // status and nothing else.
    if (rentalAgreementStatus === "open_rental_agreement"
        || rentalAgreementStatus === "customer_return") {
      return React.createElement("div", { className: "customerRentalAgreementBtnRow" },
        closeRentalBtn,
        flagDamageBtn,
        deleteBtn
      );
    }
    if (rentalAgreementStatus === "close_pending") {
      return React.createElement("div", { className: "customerRentalAgreementBtnRow" },
        React.createElement("button", {
          type: "button", className: "customerRentalAgreementBtn customerRentalAgreementBtn--close",
          onClick: () => updateRentalAgreementStatus("closed"),
        }, "Close Rental Agreement"),
        flagDamageBtn,
        deleteBtn
      );
    }
    return React.createElement("div", { className: "customerRentalAgreementBtnRow" },
      React.createElement("span", { className: "customerRentalAgreementClosed" }, "Rental Agreement Closed"),
      flagDamageBtn,
      deleteBtn
    );
  };

  const makeSection = (key, label, body) =>
    React.createElement(
      "section",
      { key, className: "dashboardSection" },
      React.createElement(
        "div",
        { className: "dashboardSection__header" },
        React.createElement(
          "div",
          { className: "dashboardSection__headerRow" },
          React.createElement("span", null, label),
          React.createElement("button", {
            type: "button", className: "sectionToggleCircle", onClick: () => toggle(key),
          }, sect[key] ? "+" : "-")
        )
      ),
      !sect[key] && React.createElement("div", { className: "dashboardSection__body" }, body)
    );

  const textField = (label, key, placeholder = "") =>
    React.createElement("label", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("input", {
        className: "resFormInput", type: "text", placeholder,
        value: resInfoForm[key],
        onChange: (e) => updateRI(key, e.target.value),
      })
    );

  const emailField = (label, key) =>
    React.createElement("label", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("input", {
        className: "resFormInput", type: "email", placeholder: "Email address",
        value: resInfoForm[key],
        onChange: (e) => updateRI(key, e.target.value),
      })
    );

  const datePickerField = (label, key) => {
    const val = resInfoForm[key];
    const fmtLabel = val
      ? (() => { const d = new Date(`${val}T00:00:00`); return Number.isNaN(d.getTime()) ? val : d.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" }); })()
      : "Select date";
    const { monthStart, cells } = getCalDays(key);
    return React.createElement("div", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("div", { className: "aiDatePicker" },
        React.createElement("button", {
          type: "button", className: "aiControl aiControl--dateButton",
          onClick: (e) => openCalFor(key, e),
        }, fmtLabel),
        openCal === key && React.createElement(
          "div",
          { className: "calendarPopover", style: { left: `${calAnchor.x}px`, top: `${calAnchor.y}px` } },
          React.createElement("div", { className: "calendarHeader" },
            React.createElement("button", { type: "button", className: "calendarArrow", onClick: () => moveCalMonth(key, -1) }, "<"),
            React.createElement("div", { className: "calendarMonthLabel" }, monthStart.toLocaleDateString("en-CA", { month: "long", year: "numeric" })),
            React.createElement("button", { type: "button", className: "calendarArrow", onClick: () => moveCalMonth(key, 1) }, ">")
          ),
          React.createElement("div", { className: "calendarWeekdays" },
            ["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => React.createElement("div", { key: d, className: "calendarWeekday" }, d))
          ),
          React.createElement("div", { className: "calendarGrid" },
            cells.map((iso, idx) =>
              React.createElement("button", {
                type: "button", key: `${key}-${idx}`,
                className: !iso ? "calendarDay calendarDay--empty"
                  : iso === todayIso
                    ? iso === val ? "calendarDay calendarDay--today calendarDay--selected" : "calendarDay calendarDay--today"
                    : iso === val ? "calendarDay calendarDay--selected" : "calendarDay",
                disabled: !iso,
                onClick: () => { if (!iso) return; updateRI(key, iso); setOpenCal(null); },
              }, iso ? Number(iso.slice(-2)) : "")
            )
          )
        )
      )
    );
  };

  const timePickerField = (label, timeKey, meridiemKey) =>
    React.createElement("div", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
        React.createElement("input", {
          className: "aiControl aiControl--time",
          type: "text", inputMode: "numeric",
          placeholder: "HH:MM",
          maxLength: 5,
          value: toDisplayTime(resInfoForm[timeKey]),
          onChange: (e) => updateRI(timeKey, e.target.value.slice(0, 4)),
        }),
        React.createElement("select", {
          className: "aiControl aiControl--meridiem",
          value: resInfoForm[meridiemKey],
          onChange: (e) => updateRI(meridiemKey, e.target.value),
        },
          React.createElement("option", { value: "AM" }, "AM"),
          React.createElement("option", { value: "PM" }, "PM")
        )
      )
    );

  const twoLevelPicker = (label, valueKey, cats, placeholder) => {
    const catKeys = Object.keys(cats);
    const isOpen  = openRatesPicker === valueKey;
    return React.createElement("div", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("div", { className: "readyFleetPicker" },
        React.createElement("button", {
          type: "button",
          className: "aiControl readyFleetTrigger",
          onClick: (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setRatesPickerAnchor({ x: rect.left, y: rect.bottom + 4 });
            setOpenRatesPicker(isOpen ? null : valueKey);
            setRatesHoverCat(null);
          },
        }, ratesForm[valueKey] || placeholder),
        isOpen && React.createElement("div", {
          className: "readyFleetMenusWrap",
          style: { left: `${ratesPickerAnchor.x}px`, top: `${ratesPickerAnchor.y}px` },
          onMouseLeave: () => { setOpenRatesPicker(null); setRatesHoverCat(null); },
        },
          React.createElement("div", { className: "readyFleetMenu readyFleetMenu--fixed" },
            catKeys.map((cat) =>
              React.createElement("div", {
                key: cat,
                className: "readyFleetBrandItem",
                onMouseEnter: () => setRatesHoverCat(cat),
                onClick: () => {
                  if (cats[cat].length === 0) {
                    updateRates(valueKey, cat);
                    setOpenRatesPicker(null);
                    setRatesHoverCat(null);
                  }
                },
              },
                React.createElement("span", { className: "readyFleetBrandLabel" }, cat)
              )
            )
          ),
          ratesHoverCat && cats[ratesHoverCat] && cats[ratesHoverCat].length > 0 &&
            React.createElement("div", { className: "readyFleetMenu readyFleetMenu--fixed" },
              cats[ratesHoverCat].map((opt) =>
                React.createElement("button", {
                  type: "button",
                  key: opt,
                  className: "readyFleetModelItem",
                  onClick: () => {
                    updateRates(valueKey, `${ratesHoverCat} \u2014 ${opt}`);
                    setOpenRatesPicker(null);
                    setRatesHoverCat(null);
                  },
                }, opt)
              )
            )
        )
      )
    );
  };

  // ── Vehicles section ──────────────────────────────────────────────────────
  const cvField = (label, key, placeholder) =>
    React.createElement("label", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("input", {
        className: "resFormInput", type: "text", placeholder,
        value: customerVehicleForm[key],
        onChange: (e) => updateCustVeh(key, e.target.value),
      })
    );

  const rvField = (label, value, wide = false) =>
    React.createElement("label", { className: wide ? "resFormGroup resFormGroup--full" : "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("input", {
        className: "resFormInput", type: "text", readOnly: true,
        value: value || "—",
        style: { color: "#7b8fa8", background: "#f0f3f7" },
      })
    );

  const rentalVehicleHasData = rentalVehicle.make || rentalVehicle.plate || rentalVehicle.mileage;

  const vehiclesBody = React.createElement("div", { className: "cdetailForm" },
    React.createElement("div", { className: "cdetailSubGroup" }, "Customer Vehicle"),
    React.createElement("div", { className: "resFormRow" },
      cvField("Year",  "year",  "e.g. 2021"),
      cvField("Make",  "make",  "e.g. Honda"),
      cvField("Model", "model", "e.g. Civic")
    ),
    React.createElement("div", { className: "cdetailSubGroup" }, "Rental Vehicle"),
    rentalVehicleHasData
      ? React.createElement("div", null,
          React.createElement("div", { className: "resFormRow" },
            rvField("Year",  rentalVehicle.year),
            rvField("Make",  rentalVehicle.make),
            rvField("Model", rentalVehicle.model)
          ),
          React.createElement("div", { className: "resFormRow" },
            rvField("Plate",            (rentalVehicle.plate || "").replace(/-/g, "")),
            rvField("Vehicle Class",    rentalVehicle.vehicleClass),
            rvField("Province / State", rentalVehicle.province),
            rvField("Starting Fuel",    rentalVehicle.fuelLevel)
          ),
          React.createElement("div", { className: "resFormRow" },
            rvField("Colour",   rentalVehicle.colour),
            rvField("VIN",      rentalVehicle.vin, true)
          ),
          React.createElement("div", { className: "resFormRow" },
            rvField("Starting Mileage",
              rentalVehicle.mileage
                ? fmtDistance(parseInt(rentalVehicle.mileage)) ?? ""
                : "")
          ),
          React.createElement("div", { className: "resFormRow" },
            rvField("Previous Damage", rentalVehicle.damage || "None documented", true)
          )
        )
      : React.createElement("div", { className: "customerPlaceholder" },
          "Populated automatically when the customer completes check-in on the fleetr app."
        ),
    React.createElement("div", { className: "cdetailSubGroup" }, "Vehicles on this rental"),
    React.createElement(AgreementVehicleHistory, { rentalAgreementId: ra?.id || null, resCode }),
    React.createElement("div", { className: "cdetailSubGroup" }, "Protection"),
    React.createElement(ProtectionChoicesList, { rentalAgreementId: ra?.id || null }),
    contractDrivers(ra) && React.createElement("div", { className: "cdetailSubGroup" }, "Drivers"),
    contractDrivers(ra) && React.createElement(ContractDriversList, { rentalAgreementId: ra.id }),
    contractDeductibles(ra) && React.createElement("div", { className: "cdetailSubGroup" }, "Deductibles"),
    contractDeductibles(ra) && React.createElement(ContractDeductiblesList, { rentalAgreementId: ra.id }),
    ra?.acknowledgementId && React.createElement("div", { className: "cdetailSubGroup" }, "Acknowledgements"),
    ra?.acknowledgementId && React.createElement(ContractAcknowledgementRecord, { rentalAgreementId: ra.id }),
    React.createElement("div", { className: "cdetailSubGroup" }, "Photos & Signatures"),
    React.createElement(RentalPhotosAndSignatures, { rentalAgreementId: ra?.id || null })
  );

  // ── Rates & Billing helpers ───────────────────────────────────────────────
  const btText = (label, key, placeholder = "") =>
    React.createElement("label", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("input", {
        className: "resFormInput", type: "text", placeholder,
        value: billToForm[key],
        onChange: (e) => updateBillTo(key, e.target.value),
      })
    );

  const btReadOnly = (label, value) =>
    React.createElement("label", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("input", {
        className: "resFormInput", type: "text", readOnly: true, value,
        style: { color: "#7b8fa8", background: "#f0f3f7" },
      })
    );

  const btDollar = (label, key) =>
    React.createElement("div", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("div", { className: "btDollarWrap" },
        React.createElement("span", { className: "btDollarPrefix" }, "$"),
        React.createElement("input", {
          className: "resFormInput btDollarInput", type: "text", inputMode: "decimal",
          value: billToForm[key],
          onChange: (e) => updateBillTo(key, e.target.value),
        })
      )
    );

  const btSelect = (label, key, options) =>
    React.createElement("label", { className: "resFormGroup" },
      React.createElement("span", { className: "resFormLabel" }, label),
      React.createElement("select", {
        className: "resFormInput",
        value: billToForm[key],
        onChange: (e) => updateBillTo(key, e.target.value),
      },
        options.map((o) => React.createElement("option", { key: o, value: o }, o))
      )
    );

  // Decided by the source's billing type. The four labels are what the rules
  // below have always branched on, whatever the company calls the source.
  const btSrcCat = {
    retail:              "Retail",
    bodyshop_dealership: "Bodyshop/Dealership",
    insurance:           "Insurance",
    corporate:           "Corporate",
  }[sourceBillingType(ratesForm.source)] || null;
  const btSrcName = ratesForm.source.includes(" \u2014 ")
    ? ratesForm.source.split(" \u2014 ")[1] : ratesForm.source;

  const dynamicBillingRows = (() => {
    if (btSrcCat === "Insurance") return [
      React.createElement("div", { className: "resFormRow", key: "b1" },
        btReadOnly("Insurance Company", btSrcName),
        btText("Adjuster Name", "adjusterName", "Adjuster name"),
        btText("Claim Number",  "claimNumber",  "Claim #")
      ),
      React.createElement("div", { className: "resFormRow", key: "b2" },
        btText("File Number",          "fileNumber", "File #"),
        btText("Authorization Number", "authNumber", "Auth #")
      ),
    ];
    if (btSrcCat === "Bodyshop/Dealership") return [
      React.createElement("div", { className: "resFormRow", key: "b1" },
        btReadOnly("Bodyshop",      btSrcName),
        btText("Adjuster Name", "adjusterName", "Adjuster name"),
        btText("File Number",   "fileNumber",   "File #")
      ),
      React.createElement("div", { className: "resFormRow", key: "b2" },
        btText("Claim Number",         "claimNumber", "Claim #"),
        btText("Authorization Number", "authNumber",  "Auth #")
      ),
    ];
    if (btSrcCat === "Corporate") return [
      React.createElement("div", { className: "resFormRow", key: "b1" },
        btReadOnly("Company", btSrcName),
        btText("PO Number",   "poNumber", "PO #")
      ),
    ];
    if (btSrcCat === "Retail") return [
      React.createElement("div", { className: "resFormRow", key: "b1" },
        btSelect("Payment Method", "paymentMethod", ["Credit Card", "Debit", "Cash"])
      ),
    ];
    return [];
  })();

  const ratesBillingBody = React.createElement("div", { className: "cdetailForm" },
    React.createElement("div", { className: "resFormRow" },
      twoLevelPicker("Source",        "source",       sourceCatsFor(ratesForm.source), "Select source"),
      twoLevelPicker("Vehicle Class", "vehicleClass",
        Object.fromEntries(vehicleClassOptions(RES_VEHICLE_CLASSES, ratesForm.vehicleClass).map((c) => [c, []])),
        "Select class"),
      React.createElement("label", { className: "resFormGroup" },
        React.createElement("span", { className: "resFormLabel" }, "Winter Tires"),
        React.createElement("select", {
          className: "resFormInput",
          value: ratesForm.winterTires,
          onChange: (e) => updateRates("winterTires", e.target.value),
        },
          React.createElement("option", { value: "No" },  "No"),
          React.createElement("option", { value: "Yes" }, "Yes")
        )
      )
    ),
    React.createElement("div", { className: "resFormRow" },
      btDollar("Daily Rate", "dailyRate")
    ),
    ...dynamicBillingRows
  );

  // ── Charges & Payments body ───────────────────────────────────────────────
  const totalDays = (() => {
    if (!resInfoForm.pickupDate || !resInfoForm.returnDate) return 0;
    const d1 = new Date(`${resInfoForm.pickupDate}T00:00:00`);
    const d2 = new Date(`${resInfoForm.returnDate}T00:00:00`);
    const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
    return diff > 0 ? diff : 0;
  })();
  const dailyRateNum  = parseFloat(billToForm.dailyRate) || 0;
  const billedToName  = btSrcCat === "Retail" ? name
    : btSrcName || name;

  const lineItemAmt = (item) =>
    (parseFloat(item.qty) || 0) * (parseFloat(item.amount) || 0);
  const totalCharges  = lineItems.reduce((s, it) => s + (it.applies ? lineItemAmt(it) : 0), 0);

  const fmtMoney = (n) => `$${n.toFixed(2)}`;

  const updateLineItem = (key, field, value) =>
    setLineItems((prev) => prev.map((it) => it.key === key ? { ...it, [field]: value } : it));

  // Protection lines, the accepted products and any old fixed lines, are the
  // customer's to pay unless marked covered by the bill-to.
  const showCoverToggle = btSrcCat && btSrcCat !== "Retail";
  const rowBilledTo = (item) =>
    isProtectionLine(item)
      ? (item.coveredByBillTo ? billedToName : name)
      : billedToName;

  const billToItems   = lineItems.filter((it) =>
    it.key === "winter" ? !it.customerPay
    : !isProtectionLine(it) || it.coveredByBillTo
  );
  const customerItems = lineItems.filter((it) =>
    it.key === "winter" ? it.customerPay
    : isProtectionLine(it) && !it.coveredByBillTo
  );
  const billToTotal   = billToItems.reduce((s, it) => s + (it.applies ? lineItemAmt(it) : 0), 0);
  const customerTotal = customerItems.reduce((s, it) => s + (it.applies ? lineItemAmt(it) : 0), 0);
  // Each tax on a subtotal, to the cent. When someone else pays, each side is
  // taxed on its own charges, so the two sides add up to what is shown.
  const taxLinesFor = (subtotal) => salesTaxes.map((t) => ({
    label: `${String(t.name).trim()} ${Number(t.rate)}%`,
    amount: Math.round(subtotal * Number(t.rate)) / 100,
  }));
  const sumTax = (lines) => lines.reduce((s, l) => s + l.amount, 0);
  const subTotal         = billToTotal + customerTotal;
  const allTaxLines      = taxLinesFor(subTotal);
  const billToTaxLines   = taxLinesFor(billToTotal);
  const customerTaxLines = taxLinesFor(customerTotal);
  const billToDue        = billToTotal + sumTax(billToTaxLines);
  const customerDue      = customerTotal + sumTax(customerTaxLines);
  const grandTotal       = btSrcCat === "Retail" ? subTotal + sumTax(allTaxLines) : billToDue + customerDue;
  const billToPaid      = payments.filter((p) => (p.paidBy || "Bill-To") === "Bill-To").reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const customerPaid    = payments.filter((p) => p.paidBy === "Customer").reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const totalPaid       = billToPaid + customerPaid;
  const billToBalance   = billToDue - billToPaid;
  const customerBalance = customerDue - customerPaid;

  const addPayment = () =>
    setPayments((prev) => [...prev, { id: Date.now(), type: "Visa", last4: "", cardholderName: "", amount: "", paidBy: "Bill-To" }]);

  const updatePayment = (id, field, value) =>
    setPayments((prev) => prev.map((p) => p.id === id ? { ...p, [field]: value } : p));

  const removePayment = (id) =>
    setPayments((prev) => prev.filter((p) => p.id !== id));

  const isCardType = (type) => ["Visa", "Mastercard", "Amex"].includes(type);

  const fmtPayment = (p) => {
    const card = isCardType(p.type) && p.last4 ? `${p.type} Ending in ${p.last4}` : p.type;
    const parts = [card, p.cardholderName, p.amount ? fmtMoney(parseFloat(p.amount) || 0) : ""].filter(Boolean);
    return parts.join(" — ");
  };

  const renderChargesRow = (item) =>
    React.createElement("tr", { key: item.key, className: "chargesRow" },
      React.createElement("td", { className: "chargesTd chargesTd--check" },
        React.createElement("input", {
          type: "checkbox", className: "chargesCheck",
          checked: item.applies,
          onChange: (e) => updateLineItem(item.key, "applies", e.target.checked),
        })
      ),
      React.createElement("td", { className: "chargesTd chargesTd--label" },
        item.key === "winter" && showCoverToggle
          ? React.createElement("div", { className: "chargesItemWrap" },
              React.createElement("span", null, item.label),
              React.createElement("label", { className: "chargesCoverLabel" },
                React.createElement("input", {
                  type: "checkbox", className: "chargesCoverCheck",
                  checked: item.customerPay || false,
                  onChange: (e) => updateLineItem(item.key, "customerPay", e.target.checked),
                }),
                "Customer Pay"
              )
            )
          : isProtectionLine(item) && showCoverToggle
            ? React.createElement("div", { className: "chargesItemWrap" },
                React.createElement("span", null, item.label),
                React.createElement("label", { className: "chargesCoverLabel" },
                  React.createElement("input", {
                    type: "checkbox", className: "chargesCoverCheck",
                    checked: item.coveredByBillTo || false,
                    onChange: (e) => updateLineItem(item.key, "coveredByBillTo", e.target.checked),
                  }),
                  "Covered by Bill-To"
                )
              )
            : item.label
      ),
      React.createElement("td", { className: "chargesTd chargesTd--qty" },
        React.createElement("div", { className: "chargesQtyWrap" },
          React.createElement("input", {
            className: "resFormInput chargesQtyInput",
            type: "text", inputMode: "decimal",
            placeholder: chargeQtyPlaceholder(item),
            value: item.qty,
            onChange: (e) => updateLineItem(item.key, "qty", e.target.value),
            disabled: !item.applies,
          }),
          React.createElement("span", { className: "unitSuffix" }, chargeQtyUnit(item))
        )
      ),
      React.createElement("td", { className: "chargesTd chargesTd--amt" },
        React.createElement("div", { className: "btDollarWrap" },
          React.createElement("span", { className: "btDollarPrefix" }, "$"),
          React.createElement("input", {
            className: "resFormInput btDollarInput chargesAmtInput",
            type: "text", inputMode: "decimal",
            value: item.amount,
            onChange: (e) => updateLineItem(item.key, "amount", e.target.value),
            disabled: !item.applies,
          })
        )
      ),
      React.createElement("td", { className: "chargesTd chargesTd--total" },
        React.createElement("span", { className: "chargesAutoAmt" }, fmtMoney(lineItemAmt(item)))
      )
    );

  const renderChargesSection = (title, items, sectionTotal, taxLines = []) =>
    React.createElement("div", { className: "chargesSection" },
      React.createElement("div", { className: "chargesSectionHeader" }, title),
      React.createElement("table", { className: "chargesTable" },
        React.createElement("thead", null,
          React.createElement("tr", null,
            React.createElement("th", { className: "chargesTh chargesTh--check" }, ""),
            React.createElement("th", { className: "chargesTh" }, "Item"),
            React.createElement("th", { className: "chargesTh chargesTh--qty" }, "Qty"),
            React.createElement("th", { className: "chargesTh chargesTh--amt" }, "Rate"),
            React.createElement("th", { className: "chargesTh chargesTh--total" }, "Total Cost")
          )
        ),
        React.createElement("tbody", null, items.map(renderChargesRow))
      ),
      React.createElement("div", { className: "chargesTotalRow chargesTotalRow--section" },
        React.createElement("span", { className: "chargesTotalLabel" }, `${title.split(" ")[0]} Total`),
        React.createElement("span", { className: "chargesTotalValue" }, fmtMoney(sectionTotal))
      ),
      taxLines.map((l) =>
        React.createElement("div", { key: l.label, className: "chargesTotalRow" },
          React.createElement("span", { className: "chargesTotalLabel" }, l.label),
          React.createElement("span", { className: "chargesTotalValue" }, fmtMoney(l.amount))
        ))
    );

  const chargesBody = React.createElement("div", { className: "chargesWrap" },
    // Tab bar
    React.createElement("div", { className: "resvTabBar chargesTabBar" },
      ["Charges", "Payments"].map((tab) =>
        React.createElement("button", {
          key: tab, type: "button",
          className: chargesTab === tab ? "resvPageTab resvPageTab--active" : "resvPageTab",
          onClick: () => setChargesTab(tab),
        }, tab)
      )
    ),

    // ── Charges tab ──
    chargesTab === "Charges" && React.createElement("div", { className: "cdetailForm" },
      // Info row
      React.createElement("div", { className: "chargesInfoRow" },
        React.createElement("div", { className: "chargesInfoItem" },
          React.createElement("span", { className: "chargesInfoLabel" }, "Billed To"),
          React.createElement("span", { className: "chargesInfoValue" }, billedToName || "—")
        ),
        React.createElement("div", { className: "chargesInfoItem" },
          React.createElement("span", { className: "chargesInfoLabel" }, "Daily Rate"),
          React.createElement("span", { className: "chargesInfoValue" }, dailyRateNum ? fmtMoney(dailyRateNum) : "—")
        ),
        React.createElement("div", { className: "chargesInfoItem" },
          React.createElement("span", { className: "chargesInfoLabel" }, "Total Days"),
          React.createElement("span", { className: "chargesInfoValue" }, totalDays || "—")
        )
      ),
      // A retail customer is their own bill-to, so their charges are one list.
      // The split is kept only when someone else pays.
      btSrcCat === "Retail"
        ? renderChargesSection("Charges", lineItems, subTotal, allTaxLines)
        : renderChargesSection("Bill-To Charges", billToItems, billToTotal, billToTaxLines),
      // Additional Charges section, what the customer pays themselves
      btSrcCat !== "Retail" && customerItems.length > 0 && renderChargesSection("Additional Charges", customerItems, customerTotal, customerTaxLines),
      // Grand Total
      React.createElement("div", { className: "chargesTotalRow chargesTotalRow--grand" },
        React.createElement("span", { className: "chargesTotalLabel" }, "Grand Total"),
        React.createElement("span", { className: "chargesTotalValue" }, fmtMoney(grandTotal))
      )
    ),

    // ── Payments tab ──
    chargesTab === "Payments" && React.createElement("div", { className: "cdetailForm" },
      // Owes summary. A retail customer is their own bill-to, so they have one
      // balance: every charge less every payment. The split is kept only when
      // someone else pays.
      btSrcCat === "Retail"
        ? React.createElement("div", { className: "chargesInfoRow" },
            React.createElement("div", { className: "chargesInfoItem" },
              React.createElement("span", { className: "chargesInfoLabel" }, "Balance owing"),
              React.createElement("span", { className: "chargesInfoValue" }, fmtMoney(grandTotal - totalPaid))
            )
          )
        : React.createElement("div", { className: "chargesInfoRow" },
            React.createElement("div", { className: "chargesInfoItem" },
              React.createElement("span", { className: "chargesInfoLabel" }, "Bill-To Owes"),
              React.createElement("span", { className: "chargesInfoValue" }, fmtMoney(billToDue))
            ),
            React.createElement("div", { className: "chargesInfoItem" },
              React.createElement("span", { className: "chargesInfoLabel" }, "Customer Owes"),
              React.createElement("span", { className: "chargesInfoValue" }, fmtMoney(customerDue))
            )
          ),
      // Payments list
      payments.length === 0
        ? React.createElement("div", { className: "customerPlaceholder" }, "No payments recorded yet.")
        : React.createElement("div", { className: "paymentsList" },
            payments.map((p) =>
              React.createElement("div", { key: p.id, className: "paymentRow" },
                React.createElement("div", { className: "paymentDisplay" }, fmtPayment(p)),
                React.createElement("div", { className: "paymentFields" },
                  React.createElement("select", {
                    className: "resFormInput paymentSelect",
                    value: p.type,
                    onChange: (e) => updatePayment(p.id, "type", e.target.value),
                  },
                    ["Visa", "Mastercard", "Amex", "Debit", "Cash"].map((t) =>
                      React.createElement("option", { key: t, value: t }, t)
                    )
                  ),
                  isCardType(p.type) && React.createElement("input", {
                    className: "resFormInput paymentLast4",
                    type: "text", placeholder: "Last 4", maxLength: 4, inputMode: "numeric",
                    value: p.last4,
                    onChange: (e) => updatePayment(p.id, "last4", e.target.value.slice(0, 4)),
                  }),
                  React.createElement("input", {
                    className: "resFormInput paymentName",
                    type: "text", placeholder: "Cardholder name",
                    value: p.cardholderName,
                    onChange: (e) => updatePayment(p.id, "cardholderName", e.target.value),
                  }),
                  React.createElement("div", { className: "btDollarWrap paymentAmtWrap" },
                    React.createElement("span", { className: "btDollarPrefix" }, "$"),
                    React.createElement("input", {
                      className: "resFormInput btDollarInput",
                      type: "text", inputMode: "decimal", placeholder: "0.00",
                      value: p.amount,
                      onChange: (e) => updatePayment(p.id, "amount", e.target.value),
                    })
                  ),
                  // Who paid only matters when someone else is the bill-to.
                  btSrcCat !== "Retail" && React.createElement("select", {
                    className: "resFormInput paymentSelect",
                    value: p.paidBy || "Bill-To",
                    onChange: (e) => updatePayment(p.id, "paidBy", e.target.value),
                  },
                    ["Bill-To", "Customer"].map((party) =>
                      React.createElement("option", { key: party, value: party }, party)
                    )
                  ),
                  React.createElement("button", {
                    type: "button", className: "paymentRemoveBtn",
                    onClick: () => removePayment(p.id),
                  }, "×")
                )
              )
            )
          ),
      React.createElement("button", { type: "button", className: "addPaymentBtn", onClick: addPayment }, "+ Add Payment"),
      // A retail customer has one total paid and one balance, as at the top.
      btSrcCat === "Retail" && React.createElement("div", { className: "paymentsTotals" },
        React.createElement("div", { className: "chargesTotalRow" },
          React.createElement("span", { className: "chargesTotalLabel" }, "Paid"),
          React.createElement("span", { className: "chargesTotalValue" }, fmtMoney(totalPaid))
        ),
        React.createElement("div", { className: "chargesTotalRow chargesTotalRow--balance" },
          React.createElement("span", { className: "chargesTotalLabel" }, "Balance owing"),
          React.createElement("span", {
            className: grandTotal - totalPaid > 0 ? "chargesTotalValue chargesTotalValue--owing"
              : grandTotal - totalPaid < 0 ? "chargesTotalValue chargesTotalValue--credit"
              : "chargesTotalValue",
          }, fmtMoney(Math.abs(grandTotal - totalPaid)) + (grandTotal - totalPaid < 0 ? " CR" : grandTotal - totalPaid > 0 ? " owing" : ""))
        )
      ),
      btSrcCat !== "Retail" && React.createElement("div", { className: "paymentsTotals" },
        React.createElement("div", { className: "chargesTotalRow" },
          React.createElement("span", { className: "chargesTotalLabel" }, "Bill-To Paid"),
          React.createElement("span", { className: "chargesTotalValue" }, fmtMoney(billToPaid))
        ),
        React.createElement("div", { className: "chargesTotalRow chargesTotalRow--balance" },
          React.createElement("span", { className: "chargesTotalLabel" }, "Bill-To Balance"),
          React.createElement("span", {
            className: billToBalance > 0 ? "chargesTotalValue chargesTotalValue--owing"
              : billToBalance < 0 ? "chargesTotalValue chargesTotalValue--credit"
              : "chargesTotalValue",
          }, fmtMoney(Math.abs(billToBalance)) + (billToBalance < 0 ? " CR" : billToBalance > 0 ? " owing" : ""))
        ),
        React.createElement("div", { className: "chargesTotalRow" },
          React.createElement("span", { className: "chargesTotalLabel" }, "Customer Paid"),
          React.createElement("span", { className: "chargesTotalValue" }, fmtMoney(customerPaid))
        ),
        React.createElement("div", { className: "chargesTotalRow chargesTotalRow--balance" },
          React.createElement("span", { className: "chargesTotalLabel" }, "Customer Balance"),
          React.createElement("span", {
            className: customerBalance > 0 ? "chargesTotalValue chargesTotalValue--owing"
              : customerBalance < 0 ? "chargesTotalValue chargesTotalValue--credit"
              : "chargesTotalValue",
          }, fmtMoney(Math.abs(customerBalance)) + (customerBalance < 0 ? " CR" : customerBalance > 0 ? " owing" : ""))
        )
      )
    )
  );

  const resInfoBody = React.createElement(
    "div",
    { className: "cdetailForm" },
    React.createElement("div", { className: "resFormRow" },
      React.createElement("label", { className: "resFormGroup" },
        React.createElement("span", { className: "resFormLabel" }, "Reservation Code"),
        React.createElement("input", {
          className: "resFormInput", type: "text", readOnly: true,
          value: resCode || "—",
          style: { color: "#7b8fa8", background: "#f0f3f7" },
        })
      )
    ),
    React.createElement("div", { className: "cdetailSubGroup" }, "Customer Information"),
    React.createElement("div", { className: "resFormRow" },
      textField("First Name",   "firstName",  "First name"),
      textField("Last Name",    "lastName",   "Last name")
    ),
    React.createElement("div", { className: "resFormRow" },
      textField("Phone Number", "phone",       "Phone number"),
      emailField("Email",       "email")
    ),
    React.createElement("div", { className: "cdetailSubGroup" }, "Pickup & Return"),
    React.createElement("div", { className: "resFormRow" },
      ra?.inspectedAt
        ? React.createElement("label", { className: "resFormGroup" },
            React.createElement("span", { className: "resFormLabel" }, "Pickup Date"),
            React.createElement("input", {
              className: "resFormInput", type: "text", readOnly: true,
              value: new Date(ra.inspectedAt).toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" }),
              style: { color: "#7b8fa8", background: "#f0f3f7" },
            })
          )
        : datePickerField("Pickup Date", "pickupDate"),
      ra?.inspectedAt
        ? React.createElement("label", { className: "resFormGroup" },
            React.createElement("span", { className: "resFormLabel" }, "Pickup Time"),
            React.createElement("input", {
              className: "resFormInput", type: "text", readOnly: true,
              value: new Date(ra.inspectedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
              style: { color: "#7b8fa8", background: "#f0f3f7" },
            })
          )
        : timePickerField("Pickup Time", "pickupTime", "pickupMeridiem")
    ),
    React.createElement("div", { className: "resFormRow" },
      datePickerField("Return Date", "returnDate"),
      timePickerField("Return Time", "returnTime", "returnMeridiem")
    ),
    React.createElement("div", { className: "cdetailSubGroup" }, "Driver's License"),
    React.createElement("div", { className: "resFormRow" },
      textField("License Number",   "licenseNumber",  "License #"),
      textField("Country",          "licenseCountry", "Country"),
      textField("State / Province", "licenseState",   "State or province"),
      datePickerField("Expiry Date", "licenseExpiry")
    )
  );

  if (recordLoading && !localRecord) {
    return React.createElement("div", { className: "page" },
      React.createElement("button", { type: "button", className: "rentalAgreementBackBtn", onClick: () => navigate(-1), style: { marginBottom: "24px" } }, "\u2190 Back"),
      React.createElement("p", { style: { color: "#7b8fa8", fontStyle: "italic" } }, "Loading\u2026")
    );
  }

  return React.createElement(
    "div",
    { className: "page" },
    React.createElement("div", { className: "customerPageTopBar" },
      React.createElement("button", { type: "button", className: "rentalAgreementBackBtn", onClick: () => navigate(-1) }, "\u2190 Back"),
      React.createElement("button", {
        type: "button",
        className: "customerPageSaveBtn",
        disabled: saveStatus === "saving",
        onClick: handleSave,
      },
        saveStatus === "saving" ? "Saving\u2026"
        : saveStatus === "error" ? "Error \u2014 Retry"
        : "Save"
      )
    ),
    React.createElement("h1", { className: "page__title" }, name),
    resCode && React.createElement(
      "div",
      { className: "customerPageMeta" },
      React.createElement("span", { className: "customerPageMetaCode" }, resCode),
      (() => {
        const raStatus = rentalAgreementStatus;
        if (!raStatus || raStatus === "reservation") return null;
        const cls = raBadgeClass(raStatus, { meta: true });
        return React.createElement("span", { className: cls }, statusLabel(raStatus));
      })()
    ),
    React.createElement("div", { className: "page__titleUnderline" }),
    makeSection("resInfo",      "Reservation Information", resInfoBody),
    makeSection("vehicles",     "Vehicles",               vehiclesBody),
    makeSection("ratesBilling", "Rates & Billing",        ratesBillingBody),
    makeSection("charges", "Charges & Payments",   chargesBody),
    makeSection("notes", "Notes",
      React.createElement("div", { style: { padding: "14px" } },
        customerNotesLog.length === 0
          ? React.createElement("p", { style: { color: "#7b8fa8", fontStyle: "italic", margin: "0 0 12px" } }, "No notes yet.")
          : React.createElement("div", { style: { marginBottom: "12px" } },
              customerNotesLog.map((n, i) =>
                React.createElement("div", { key: i, style: { marginBottom: "8px", padding: "8px 10px", background: "#131f1e", borderRadius: "6px" } },
                  React.createElement("div", { style: { fontSize: "0.72rem", color: "#7b8fa8", marginBottom: "3px" } },
                    (n.author || "ADJ") + (n.at
                      ? " — " + new Date(n.at).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
                      : "")
                  ),
                  React.createElement("div", { style: { fontSize: "0.9rem", color: "#e0e8f0" } }, n.text)
                )
              )
            ),
        React.createElement("div", { style: { display: "flex", gap: "8px", marginTop: "4px" } },
          React.createElement("input", {
            className: "resFormInput", type: "text", placeholder: "Add a note…",
            value: customerNoteInput,
            onChange: (e) => setCustomerNoteInput(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); handleAddCustomerNote(); } },
            style: { flex: 1 },
          }),
          React.createElement("button", {
            type: "button", className: "addPaymentBtn",
            style: { whiteSpace: "nowrap", flexShrink: 0 },
            onClick: handleAddCustomerNote,
          }, "Save Note")
        )
      )
    ),
    makeSection("rentalAgreementOptions", "Rental Agreement Options",
      React.createElement("div", { className: "customerRentalAgreementOptions" }, rentalAgreementOptionsBody())
    )
  );
}

// An Exec with no branch selected has current_location() null, so every
// operational screen is legitimately empty: no fleet, no reservations, nothing.
// Empty is indistinguishable from broken, so they get told instead.
//
// The Company and Staff screens are exempt. Company is where a branch is
// chosen, and Staff is operator-scoped for an Exec, so both work with no branch
// selected and blocking them would leave nowhere to go.
const BRANCHLESS_OK = ["/company", "/staff", "/account"];

function ExecNeedsBranch({ children }) {
  const { currentUser } = React.useContext(AppContext);
  const [acting, setActing] = React.useState(undefined);

  React.useEffect(() => {
    if (!roleAtLeast(currentUser?.role, "Exec")) { setActing(null); return; }
    supabase.rpc("my_acting_location").then(({ data }) => {
      setActing(data && data.ok ? data.locationId || null : null);
    });
  }, [currentUser?.role]);

  if (!roleAtLeast(currentUser?.role, "Exec")) return children;
  // undefined means the answer has not come back yet. Rendering the warning
  // during that moment would flash it at an Exec who does have a branch.
  if (acting === undefined) return null;
  if (acting) return children;

  return React.createElement(
    "div", { className: "page" },
    React.createElement("h1", null, "Choose a branch"),
    React.createElement("div", { className: "resvEmpty" },
      "You are not acting in any branch yet, so there is nothing here to show. " +
      "Pick one on the Company screen and this page will fill in."),
    React.createElement("a", {
      href: "#/company", className: "loginBtn",
      style: { display: "inline-block", width: "auto", padding: "8px 14px", marginTop: "12px", textDecoration: "none" },
    }, "Go to Company")
  );
}

function AppRoutes() {
  return React.createElement(
    Routes,
    null,
    React.createElement(Route, {
      path: "/",
      element: React.createElement(Navigate, { to: "/dashboard", replace: true }),
    }),
    React.createElement(Route, {
      path: "/dashboard",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(DashboardPage)),
    }),
    React.createElement(Route, {
      path: "/reservations",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(ReservationsPage)),
    }),
    React.createElement(Route, {
      path: "/arms",
      // Off means unreachable, not only unlisted: a typed or bookmarked URL
      // lands on the Dashboard instead of the page.
      element: isFeatureEnabled("non_drive_intake")
        ? React.createElement(ExecNeedsBranch, null, React.createElement(NonDriveIntakePage))
        : React.createElement(Navigate, { to: "/dashboard", replace: true }),
    }),
    React.createElement(Route, {
      path: "/pre-rental-check",
      // Off means unreachable, not only unlisted, as for /arms.
      element: isFeatureEnabled("pre_rental_check")
        ? React.createElement(ExecNeedsBranch, null, React.createElement(PreRentalCheckPage))
        : React.createElement(Navigate, { to: "/dashboard", replace: true }),
    }),
    React.createElement(Route, {
      path: "/overdue-rentals",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(OverdueRentalsPage)),
    }),
    React.createElement(Route, {
      path: "/vehicle",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(VehicleDetailPage)),
    }),
    React.createElement(Route, {
      path: "/time-of-repair",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(TORPage)),
    }),

    React.createElement(Route, {
      path: "/no-shows",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(NoShowsPage)),
    }),
    React.createElement(Route, {
      path: "/fleet",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(FleetPage)),
    }),
    React.createElement(Route, {
      path: "/fleet/vehicles",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(FleetVehiclesPage)),
    }),
    React.createElement(Route, {
      path: "/fleet/additions",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(FleetAdditionsPage)),
    }),
    React.createElement(Route, {
      path: "/fleet/gas-collections",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(GasCollectionsPage)),
    }),
    React.createElement(Route, {
      path: "/fleet/damage-claims",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(FleetDamageClaimsPage)),
    }),
    React.createElement(Route, {
      path: "/reports",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(ReportsPage)),
    }),
    React.createElement(Route, {
      path: "/settings",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(SettingsPage)),
    }),
    React.createElement(Route, {
      path: "/audit-log",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(AuditLogPage)),
    }),
    React.createElement(Route, {
      key:  "staff",
      path: "/staff",
      element: React.createElement(StaffPage),
    }),
    React.createElement(Route, {
      key:  "company",
      path: "/company",
      element: React.createElement(CompanyPage),
    }),
    // Not wrapped in ExecNeedsBranch. Everything here is about the person
    // rather than the branch, and an Exec with no branch selected still has a
    // password to change.
    React.createElement(Route, {
      key:  "account",
      path: "/account",
      element: React.createElement(AccountPage),
    }),
    React.createElement(Route, {
      path: "/rental-agreements",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(RentalAgreementsPage)),
    }),
    React.createElement(Route, {
      path: "/customer",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(CustomerPage)),
    }),
    // Reached from the Dashboard's Close Rental button, not from the nav.
    React.createElement(Route, {
      path: "/close-rental",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(CloseRentalPage)),
    }),
    // Same, for Switch Out.
    React.createElement(Route, {
      path: "/switch-out",
      element: React.createElement(ExecNeedsBranch, null, React.createElement(SwitchOutPage)),
    }),
    NAV.filter((item) => !["/dashboard", "/reservations", "/arms", "/pre-rental-check", "/overdue-rentals", "/time-of-repair", "/no-shows", "/fleet", "/fleet/vehicles", "/fleet/additions", "/fleet/gas-collections", "/fleet/damage-claims", "/reports", "/settings", "/audit-log", "/rental-agreements", "/customer", "/vehicle"].includes(item.path))
      .map((item) =>
        React.createElement(Route, {
          key: item.path,
          path: item.path,
          element: React.createElement(PlaceholderPage, { title: item.label }),
        })
      ),
    React.createElement(Route, {
      path: "*",
      element: React.createElement(PlaceholderPage, { title: "Not Found" }),

    })
  );
}

// Signup goes through the worker, not straight at Supabase. The worker holds
// the ordering that keeps a failed attempt from leaving an orphaned account
// behind, and the rate limiting that keeps an unauthenticated endpoint bounded.
// Nothing here decides anything: every refusal comes back from the database.
const SIGNUP_URL = `${CLAUDE_API_URL}/signup`;

// A separate Worker, deliberately. It holds the Supabase service role key, and
// keeping it apart is what stops a bug in the reminder cron or the AI proxy
// from reaching admin rights.
const RESET_API_URL = "https://fleetr-reset.connor-0a5.workers.dev";

// One pair of limits for every password field there is. They were previously
// set per input, and drifted: the sign-in field capped at 12 while signup
// allowed 72, so anyone who chose a longer password could create an account and
// then never sign in to it. The sign-in field also truncated in onChange, so a
// pasted password was silently cut and the only feedback was "Invalid
// credentials", which points at the password being wrong rather than at the box
// having eaten half of it.
//
// The maximum is 20, matching worker.js handleSignup, the reset worker and its
// reset page, so a password that can be chosen in one place can be typed in
// every other. It replaces 72, which was bcrypt's own limit and the point past
// which extra bytes are ignored. 20 is well inside that, so the hash never
// silently ignores part of what was typed.
//
// The cost is on this box rather than on the ones that choose a password: an
// account whose password was set while 72 was allowed is longer than this field
// now accepts, and the field stops at 20 with no explanation, so the sign-in
// reads as a wrong password. Such an account recovers through Forgot your
// password, which sets a new one inside the range.
//
// The minimum is 6, matching worker.js handleSignup and the reset worker. It
// was 8 here while signup asked for 6, which let somebody choose a password at
// signup that the change-password form would then refuse as too short.
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 20;

// The username bounds, for every screen that takes one: signup, sign-in and
// forgot-password. Neither is signup-only, so neither is named for signup.
// Signup has no password bounds of its own either; the pair above covers every
// password field in this file.
//
// Mirrors worker.js USERNAME_MIN/MAX and PASSWORD_MIN/MAX, the username pattern
// ^[a-z0-9]{6,20}$ in signup_length_limits.sql, and USERNAME_SHAPE in the reset
// worker. The server is the authority; these only save a round trip.
//
// One number each, because every screen here has to agree with what signup can
// create. The sign-in box once capped at 12 against signup's 20, so an account
// could be made that its owner could not type, and the forgot-password box had
// no bound at all while the route behind it silently ignored anything longer
// than 12. Both were separate literals at the time.
const USERNAME_MIN = 6;
const USERNAME_MAX = 20;

// Reasons from redeem_join_code, which the worker never sees, so these cannot
// come from signupMessage over there.
const SIGNUP_FINISH_MESSAGES = {
  bad_pin:             "Your PIN must be 4 digits.",
  bad_email:           "Enter an email address you can actually receive mail at.",
  bad_code:            "That join code is not valid.",
  no_default_location: "That company is not set up to take new staff yet.",
  username_taken:      "That username is taken, pick another.",
  already_redeemed:    "This account already exists. Sign in instead.",
  not_signed_in:       "Signup did not complete. Try again.",
};

// Always says the same thing. The screen cannot tell you whether the account
// exists, because saying so would turn it into a way to ask which usernames are
// real, one guess at a time. The worker answers identically for the same reason.
function ForgotScreen({ onCancel }) {
  const [username, setUsername] = React.useState("");
  const [sent,     setSent]     = React.useState(false);
  const [busy,     setBusy]     = React.useState(false);
  const [err,      setErr]      = React.useState("");

  const submit = (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    fetch(`${RESET_API_URL}/forgot`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim().toLowerCase() }),
    })
      // The body is deliberately the same whether or not the account exists, so
      // there is nothing to read there. The STATUS is a different question: a
      // 500 means the request never got far enough to send anything, and
      // showing "check your email" for that leaves someone waiting for a
      // message that was never attempted.
      .then((r) => {
        if (!r.ok) { setErr("Something went wrong on our end. Try again shortly."); return; }
        setSent(true);
      })
      .catch(() => setErr("Could not reach the server. Check your connection."))
      .finally(() => setBusy(false));
  };

  return React.createElement(
    "div", { className: "loginWrap" },
    React.createElement(
      "div", { className: "loginCard" },
      React.createElement("div", { style: { fontFamily: "'Inter', sans-serif", color: "#42a4ff", fontSize: "2rem", fontWeight: "700", marginBottom: "4px", textAlign: "center" } }, "fleetr"),
      React.createElement("div", { className: "loginSubtitle" },
        sent ? "Check your email." : "Reset your password."),
      sent
        ? React.createElement(
            "div", { style: { fontSize: "0.9rem", lineHeight: 1.6, textAlign: "center" } },
            React.createElement("p", null,
              "If that username has an account with a recovery address, a link is on its way. The message itself says when the link stops working."),
            React.createElement("p", { style: { opacity: 0.7 } },
              "It can take a few minutes to arrive, and longer the first time. Check spam before asking for another one."),
            React.createElement("p", { style: { opacity: 0.7 } },
              "Nothing has changed yet. Your password stays as it is until you use the link."),
            React.createElement("button", {
              type: "button", onClick: onCancel,
              style: { background: "none", border: "none", color: "#42a4ff", cursor: "pointer", fontSize: "0.85rem" },
            }, "Back to sign in"))
        : React.createElement(
            "form", { className: "loginForm", onSubmit: submit },
            React.createElement("input", {
              className: "loginInput", type: "text", placeholder: "Username",
              minLength: USERNAME_MIN, maxLength: USERNAME_MAX,
              autoComplete: "username", value: username,
              onChange: (e) => setUsername(e.target.value.toLowerCase()),
            }),
            React.createElement("button", { type: "submit", className: "loginBtn", disabled: busy },
              busy ? "Sending\u2026" : "Send a reset link"),
            err && React.createElement("div", { className: "loginError" }, err),
            React.createElement("div", { style: { opacity: 0.65, fontSize: "0.8rem", marginTop: "8px", textAlign: "center" } },
              "The link goes to the personal email on your account, not to your fleetr username."),
            React.createElement("button", {
              type: "button", onClick: onCancel,
              style: { background: "none", border: "none", color: "#42a4ff", cursor: "pointer", marginTop: "8px", fontSize: "0.85rem" },
            }, "Back to sign in"))
    )
  );
}

function SignupScreen({ onDone, onCancel }) {
  const [username, setUsername] = React.useState("");
  const [name,     setName]     = React.useState("");
  const [email,    setEmail]    = React.useState("");
  const [joinCode, setJoinCode] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [pin,      setPin]      = React.useState("");
  const [message,  setMessage]  = React.useState("");
  const [loading,  setLoading]  = React.useState(false);

  const submit = (e) => {
    e.preventDefault();
    // Checked here as well as in the database, because the database's check
    // runs after the account exists. A four-character rule enforced only at the
    // end costs the person their chosen username.
    if (!/^[0-9]{4}$/.test(pin)) { setMessage("Your PIN must be 4 digits."); return; }
    setLoading(true);
    setMessage("");
    fetch(SIGNUP_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        username:      username.trim().toLowerCase(),
        joinCode:      joinCode.trim().toUpperCase(),
        password:      password,
        // Sent so the worker can refuse a malformed address before creating an
        // account. Not a secret, and it is going to be emailed anyway.
        recoveryEmail: email.trim(),
      }),
    })
      .then((r) => r.json())
      .then((out) => {
        if (!out || !out.ok) {
          setMessage((out && out.message) || "Signup could not be completed.");
          return null;
        }
        // Second leg, straight to the database with the session the worker just
        // handed back. The PIN goes here and only here: routing it through the
        // worker would put it within reach of Cloudflare's logs to save one
        // request.
        return fetch(`${SUPABASE_URL}/rest/v1/rpc/redeem_join_code`, {
          method:  "POST",
          headers: {
            apikey:          SUPABASE_ANON,
            Authorization:   `Bearer ${out.accessToken}`,
            "Content-Type":  "application/json",
          },
          body: JSON.stringify({
            code:           joinCode.trim().toUpperCase(),
            full_name:      name.trim(),
            pin:            pin,
            recovery_email: email.trim(),
          }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res && res.ok) {
              // Back to the login screen rather than signed in here. The
              // account is real at this point, so the first thing the person
              // does is the thing they will do every shift after.
              onDone(res.username);
              return;
            }
            setMessage(SIGNUP_FINISH_MESSAGES[res && res.reason] ||
                       "Signup could not be completed.");
          });
      })
      .catch(() => setMessage("Could not reach the server. Check your connection."))
      .finally(() => setLoading(false));
  };

  const field = (props) => React.createElement("input", {
    className: "loginInput", spellCheck: false, ...props,
  });

  return React.createElement(
    "div", { className: "loginWrap" },
    React.createElement(
      "div", { className: "loginCard" },
      React.createElement("div", { style: { fontFamily: "'Inter', sans-serif", color: "#42a4ff", fontSize: "2rem", fontWeight: "700", marginBottom: "4px", textAlign: "center" } }, "fleetr"),
      React.createElement("div", { className: "loginSubtitle" }, "Create your account."),
      React.createElement(
        "form", { className: "loginForm", onSubmit: submit },
        field({ type: "text", placeholder: "Join code", maxLength: 8, autoCapitalize: "characters",
                value: joinCode, onChange: (e) => { setJoinCode(e.target.value.toUpperCase()); setMessage(""); } }),
        field({ type: "text", placeholder: "Full name", maxLength: 60, autoComplete: "name",
                value: name, onChange: (e) => { setName(e.target.value); setMessage(""); } }),
        field({ type: "text", placeholder: "Username", minLength: USERNAME_MIN, maxLength: USERNAME_MAX, autoComplete: "username",
                value: username, onChange: (e) => { setUsername(e.target.value.toLowerCase()); setMessage(""); } }),
        field({ type: "email", placeholder: "Personal email (for account recovery)", maxLength: 120, autoComplete: "email",
                value: email, onChange: (e) => { setEmail(e.target.value); setMessage(""); } }),
        field({ type: "password", placeholder: "Password", minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX, autoComplete: "new-password",
                value: password, onChange: (e) => { setPassword(e.target.value); setMessage(""); } }),
        // Separate from the password on purpose, and the reason is written on
        // the screen: a second secret nobody explains is a second secret people
        // set to the same string as the first.
        field({ type: "password", placeholder: "4-digit PIN", inputMode: "numeric", maxLength: 4,
                autoComplete: "new-password",
                value: pin, onChange: (e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setMessage(""); } }),
        React.createElement("div", { style: { opacity: 0.6, fontSize: "0.78rem", marginTop: "-4px" } },
          "The PIN confirms actions that are hard to undo. Keep it different from your password."),
        React.createElement("button", { type: "submit", className: "loginBtn", disabled: loading },
          loading ? "Creating\u2026" : "Create Account"),
        message && React.createElement("div", { className: "loginError" }, message),
        React.createElement("button", {
          type: "button", className: "loginLink", onClick: onCancel,
          style: { background: "none", border: "none", color: "#42a4ff", cursor: "pointer", marginTop: "8px", fontSize: "0.85rem" },
        }, "I already have an account")
      )
    )
  );
}

function LoginScreen({ onSuccess, onSignup, onForgot, notice }) {
  const [username, setUsername] = React.useState("");
  const [pin,      setPin]      = React.useState("");
  const [error,    setError]    = React.useState("");
  const [loading,  setLoading]  = React.useState(false);
  const pinRef  = React.useRef(null);

  const handleUsernameChange = (e) => {
    const val = e.target.value;
    setUsername(val);
    setError("");
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const u = username.trim().toLowerCase();

    // Supabase Auth is the only way in. The hardcoded connor/1234 fallback that
    // stood here during the transition is gone, along with the account whose
    // password was a constant in this file.
    setLoading(true);
    setError("");
    signInReal(u, pin)
      .then((result) => {
        if (result.ok) {
          onSuccess(result.user);
          return;
        }
        // A wrong password is the only failure that stays vague. Everything
        // else is shown as itself: the generic string used to swallow a
        // deactivated account, a missing profile and a broken profile read
        // alike, so the one real bug among them looked like a typo for months.
        console.warn("Fleetr sign-in failed:", result.reason, result.error);
        setError(result.message || loginMessage(result.reason));
      })
      .finally(() => setLoading(false));
  };

  return React.createElement(
    "div",
    { className: "loginWrap" },
    React.createElement(
      "div",
      { className: "loginCard" },
      React.createElement("div", { style: { fontFamily: "'Inter', sans-serif", color: "#42a4ff", fontSize: "2rem", fontWeight: "700", marginBottom: "4px", textAlign: "center" } }, "fleetr"),
      React.createElement("div", { className: "loginSubtitle" }, "Enter details below."),
      React.createElement(
        "form",
        { className: "loginForm", onSubmit: handleSubmit },
        React.createElement("input", {
          className: "loginInput",
          type: "text",
          placeholder: "Username",
          minLength: USERNAME_MIN,
          maxLength: USERNAME_MAX,
          autoComplete: "username",
          value: username,
          onChange: handleUsernameChange,
          onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); pinRef.current?.focus(); } },
        }),
        React.createElement("input", {
          ref: pinRef,
          className: "loginInput",
          type: "password",
          placeholder: "Password",
          minLength: PASSWORD_MIN,
          maxLength: PASSWORD_MAX,
          inputMode: "text",
          autoComplete: "current-password",
          value: pin,
          onChange: (e) => { setPin(e.target.value); setError(""); },
          onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); handleSubmit(e); } },
        }),
        React.createElement("button", { type: "submit", className: "loginBtn", disabled: loading }, loading ? "Signing in…" : "Sign In"),
        error && React.createElement("div", { className: "loginError" }, error),
        notice && React.createElement("div", { className: "loginNotice", style: { color: "#3fbf7f", fontSize: "0.85rem", marginTop: "8px", textAlign: "center" } }, notice),
        React.createElement("button", {
          type: "button", onClick: onSignup,
          style: { background: "none", border: "none", color: "#42a4ff", cursor: "pointer", marginTop: "8px", fontSize: "0.85rem" },
        }, "I have a join code"),
        React.createElement("button", {
          type: "button", onClick: onForgot,
          style: { background: "none", border: "none", color: "#42a4ff", cursor: "pointer", marginTop: "4px", fontSize: "0.85rem" },
        }, "Forgot your password?")
      )
    )
  );
}

function App() {
  // Session strategy: the JWT is held and refreshed by supabase-js; this only
  // keeps the staff profile and the moment the session began, so the 12 hour
  // cap can be enforced on load.
  //
  // The previous scheme paired localStorage against a per-tab sessionStorage
  // token, which forced a fresh sign-in in every new tab while the stored
  // credential itself never expired. That is now reversed: tabs share the
  // session, and the session actually ends.
  const [currentUser, setCurrentUser] = React.useState(readStoredSession);
  // "none" until a newer deploy is seen, then "ready" until dismissed. A
  // dismissal holds for the life of the tab rather than returning a minute
  // later, which would make the banner a nag.
  const [update, setUpdate] = React.useState("none");

  // Enforces the cap during a long-running session, not only at load. Checked
  // once a minute, which is precise enough for a 12 hour limit and costs
  // nothing. The same tick asks whether a newer version has been deployed.
  React.useEffect(() => {
    if (!currentUser) return;
    const iv = setInterval(() => {
      checkForNewVersion().then((isNew) => {
        if (isNew) setUpdate((u) => (u === "none" ? "ready" : u));
      });
      if (!readStoredSession()) {
        console.log("Fleetr: session expired.");
        clearSession();
        setCurrentUser(null);
        window.location.hash = "";
      }
    }, 60 * 1000);
    return () => clearInterval(iv);
  }, [currentUser]);

  const [signingUp,    setSigningUp]    = React.useState(false);
  const [forgot,       setForgot]       = React.useState(false);
  const [signupNotice, setSignupNotice] = React.useState("");

  const signOut = () => {
    clearSession();
    setCurrentUser(null);
    window.location.hash = "";
  };

  if (!currentUser) {
    if (forgot) {
      return React.createElement(ForgotScreen, { onCancel: () => setForgot(false) });
    }
    if (signingUp) {
      return React.createElement(SignupScreen, {
        onCancel: () => setSigningUp(false),
        onDone:   (username) => {
          setSigningUp(false);
          setSignupNotice(`Account ${username} created. Sign in to continue.`);
        },
      });
    }
    return React.createElement(LoginScreen, {
      notice:   signupNotice,
      onSignup: () => { setSignupNotice(""); setSigningUp(true); },
      onForgot: () => { setSignupNotice(""); setForgot(true); },
      onSuccess: (user) => {
        storeSession(user);
        window.location.hash = "/";
        setCurrentUser(user);
      },
    });
  }

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      AppProvider,
      { currentUser, signOut },
      React.createElement(HashRouter, null, React.createElement(Layout))
    ),
    update === "ready" && React.createElement(UpdateBanner, { onDismiss: () => setUpdate("dismissed") })
  );
}

// Fixed and small, over the page rather than in its flow, so it moves nothing
// and blocks nothing. Refresh is the person's choice; see checkForNewVersion.
function UpdateBanner({ onDismiss }) {
  return React.createElement(
    "div",
    { className: "updateBanner", role: "status" },
    React.createElement("span", null, "A new version of fleetr is available."),
    React.createElement("button", {
      type: "button", className: "updateBanner__refresh", onClick: () => window.location.reload(),
    }, "Refresh"),
    React.createElement("button", {
      type: "button", className: "updateBanner__dismiss", "aria-label": "Dismiss", onClick: onDismiss,
    }, "×")
  );
}

const style = document.createElement("style");
style.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
body, * {
  font-family: 'Inter', sans-serif;
}
.loginWrap{
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #F9F9F7;
}
.loginCard{
  background: #F9F9F7;
  border-radius: 16px;
  padding: 40px;
  width: 340px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.10), 0 1.5px 6px rgba(0,0,0,0.06);
}
.loginLogo{
  display: block;
  width: 100%;
  height: auto;
  margin-bottom: 12px;
}
.loginSubtitle{
  font-size: 14px;
  color: #7b8fa8;
  margin-bottom: 28px;
  text-align: center;
}
.loginForm{
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.loginInput{
  border: 1px solid #d3dbe8;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 14px;
  font-family: inherit;
  color: #1F1E1D;
  background: #fff;
  outline: none;
}
.loginInput:focus{
  border-color: #42a4ff;
  box-shadow: 0 0 0 3px rgba(5,150,105,0.12);
}

/* ── PIN field ──────────────────────────────────────────────────────────────
   Four fixed slots, so a dot's position never depends on how the browser lays
   out centred text. The caret is ours and is placed relative to a slot, which
   is why it can track the typed length exactly. */
.pinField{
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 52px;
  border: 1px solid #d3dbe8;
  border-radius: 8px;
  background: #fff;
  cursor: text;
}
.pinField:focus-within{
  border-color: #42a4ff;
  box-shadow: 0 0 0 3px rgba(66,164,255,0.15);
}
.pinField--error{ border-color: #e53e3e; }
.pinField--error.pinField:focus-within{ box-shadow: 0 0 0 3px rgba(229,62,62,0.15); }

/* Still a real input: keystrokes, paste, IME and maxLength all keep working.
   Invisible rather than removed, with the native caret suppressed so ours is
   the only one on screen. 16px avoids the iOS zoom-on-focus jump. */
.pinField__input{
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  outline: none;
  color: transparent;
  caret-color: transparent;
  font-size: 16px;
  text-align: center;
  letter-spacing: 0;
}
.pinField__slots{
  display: flex;
  align-items: center;
  gap: 18px;
  pointer-events: none;
}
.pinSlot{
  position: relative;
  width: 12px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pinDot{
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #1F1E1D;
}
.pinDot--empty{ background: #d3dbe8; }
.pinCaret{
  position: absolute;
  top: 1px;
  width: 2px;
  height: 22px;
  border-radius: 1px;
  background: #42a4ff;
  animation: pinCaretBlink 1.06s steps(1, end) infinite;
}
.pinCaret--before{ left: -10px; }
.pinCaret--after{ right: -10px; }
@keyframes pinCaretBlink{ 0%, 49%{ opacity: 1 } 50%, 100%{ opacity: 0 } }
@media (prefers-reduced-motion: reduce){
  .pinCaret{ animation: none; }
}
.loginBtn{
  width: 100%;
  padding: 11px;
  background: #42a4ff;
  color: #F9F9F7;
  font-size: 14px;
  font-weight: 700;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  margin-top: 4px;
}
.loginBtn:hover{ background: #0063bf; }
.loginError{
  font-size: 13px;
  color: #c0392b;
  text-align: center;
  font-weight: 500;
}
.app{
  height: 100%;
  display: grid;
  grid-template-columns: 290px 1fr;
}

.sidebar{
  background: #1F1E1D;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  padding: 16px 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* Fixed to the left of the screen for the full height of the window, with
   its own scrollbar, so it stays in view while the page scrolls. It fills the
   first grid column, which is kept for it, and the page sits in the second.
   Desktop only: below 768px the sidebar is not shown and the mobile menu
   takes over. */
@media (min-width: 768px){
  .sidebar{
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 290px;
    overflow-y: auto;
  }
  .main{ grid-column: 2; }
}
@media (min-width: 768px) and (max-width: 900px){
  .sidebar{ width: 76px; }
}
.sidebar__section{
  padding: 0 0 0 14px;
}
.sidebar__sectionHeader{
  margin: 0 14px 10px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: rgba(255, 255, 255, 0.46);
}

.nav{
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.nav__item{
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-radius: 6px 0 0 6px;
  border-left: 3px solid transparent;
  color: rgba(255, 255, 255, 0.84);
  background: transparent;
  transition: background 120ms ease, border-color 120ms ease;
}
.nav__item:hover{
  background: #0063bf;
}
.nav__item--active{
  background: #0063bf;
  border-left-color: #42a4ff;
  color: #F9F9F7;
}
.nav__label{
  font-size: 14px;
  font-weight: 500;
}

.main{
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.topbar{
  height: 68px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: #1F1E1D;
}
.topbar__pills{
  display: flex;
  align-items: center;
  gap: 8px;
}
.pill{
  display: inline-flex;
  align-items: center;
  padding: 5px 14px;
  border-radius: 999px;
  background: rgba(255,255,255,0.1);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  border: 1px solid rgba(255,255,255,0.15);
}
.pill--select{
  appearance: none;
  cursor: pointer;
  font-family: inherit;
  padding-right: 28px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,255,255,0.6)'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}
.pill--select:focus{
  outline: none;
  border-color: #42a4ff;
}
.pill--select option{
  background: #1F1E1D;
  color: #fff;
}

/* ── New-version banner ────────────────────────────────────────────────────── */
/* Bottom centre, clear of the mobile command bar where there is one. The bar's
   height is only defined in the mobile block, so desktop falls back to 0. */
.updateBanner{
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--mobileBottomBarH, 0px) + 16px + env(safe-area-inset-bottom, 0px));
  z-index: 400;
  display: flex;
  align-items: center;
  gap: 12px;
  /* left: 50% alone would cap its natural width at half the screen and wrap
     the message into a column on a phone. */
  width: max-content;
  max-width: calc(100% - 32px);
  box-sizing: border-box;
  padding: 8px 8px 8px 16px;
  border-radius: 999px;
  background: #1F1E1D;
  color: #F9F9F7;
  font-size: 0.85rem;
  font-weight: 500;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
/* The banner is the app's sibling, not its child, so it cannot see the zeroed
   bar height app--noCommandBar sets. With no bar to clear, sit at the edge. */
.app--noCommandBar ~ .updateBanner{
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
}
.updateBanner__refresh{
  font: inherit;
  font-weight: 600;
  color: #fff;
  background: #42a4ff;
  border: 0;
  border-radius: 999px;
  padding: 6px 14px;
  cursor: pointer;
  white-space: nowrap;
}
.updateBanner__dismiss{
  font: inherit;
  font-size: 1.1rem;
  line-height: 1;
  color: rgba(255, 255, 255, 0.6);
  background: none;
  border: 0;
  padding: 4px 8px;
  cursor: pointer;
}

/* ── Fleetr AI Command Bar ─────────────────────────────────────────────────── */
.fleetrCommandBar{
  position: relative;
  display: flex;
  align-items: center;
  gap: 0;
  flex: 1;
  background: #F9F9F7;
  border-radius: 999px;
  padding: 4px 6px 4px 10px;
  border: 1.5px solid rgba(66,164,255,0.35);
}
.fleetrCommandBar__iconBtn{
  background: none;
  border: none;
  cursor: pointer;
  color: #42a4ff;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px 2px 0;
  flex-shrink: 0;
  opacity: 0.75;
  transition: opacity 0.15s;
}
.fleetrCommandBar__iconBtn:hover{
  opacity: 1;
}
.fleetrCommandBar__iconBtn--listening{
  opacity: 1;
  color: #ff4444;
  animation: fleetrMicPulse 1s ease-in-out infinite;
}
@keyframes fleetrMicPulse{
  0%, 100% { filter: drop-shadow(0 0 0px rgba(255,68,68,0));   }
  50%       { filter: drop-shadow(0 0 5px rgba(255,68,68,0.8)); }
}
.fleetrCommandBar__input{
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-family: inherit;
  font-size: 13px;
  color: #1F1E1D;
  min-width: 0;
}
.fleetrCommandBar__input::placeholder{
  color: rgba(6,13,12,0.4);
}
.fleetrCommandBar__sendBtn{
  background: #42a4ff;
  border: none;
  border-radius: 999px;
  cursor: pointer;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  margin-left: 6px;
  transition: background 0.15s;
}
.fleetrCommandBar__sendBtn:hover{
  background: #2b8fe0;
}
.fleetrCommandBar__popover{
  position: absolute;
  top: calc(100% + 10px);
  left: 0;
  right: 0;
  background: #fff;
  border: 1.5px solid rgba(66,164,255,0.3);
  border-radius: 14px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.13);
  z-index: 9999;
  overflow: hidden;
}
.fleetrCommandBar__popoverHeader{
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 8px;
  border-bottom: 1px solid rgba(66,164,255,0.15);
  font-size: 12px;
  font-weight: 600;
  color: #42a4ff;
  letter-spacing: 0.04em;
}
.fleetrCommandBar__popoverClose{
  background: none;
  border: none;
  cursor: pointer;
  color: #7b8fa8;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
}
.fleetrCommandBar__popoverClose:hover{
  color: #1F1E1D;
}
.fleetrCommandBar__popoverBody{
  padding: 14px;
  min-height: 56px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.fleetrCommandBar__editFields{
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  padding: 6px 0 2px;
}
.fleetrCommandBar__editLabel{
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.fleetrCommandBar__editKey{
  font-size: 11px;
  font-weight: 600;
  color: #7b8fa8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  min-width: 110px;
  flex-shrink: 0;
}
.fleetrCommandBar__editInput{
  flex: 1;
  background: #f0f5ff;
  border: 1px solid rgba(66,164,255,0.3);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 13px;
  color: #1F1E1D;
  font-family: inherit;
  outline: none;
  min-width: 0;
}
.fleetrCommandBar__editInput:focus{
  border-color: #42a4ff;
  background: #fff;
}
.fleetrCommandBar__actionRow{
  display: flex;
  gap: 8px;
}
.fleetrCommandBar__confirmBtn{
  background: #42a4ff;
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 6px 18px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}
.fleetrCommandBar__confirmBtn:hover:not(:disabled){
  background: #2b8fe0;
}
.fleetrCommandBar__confirmBtn:disabled{
  opacity: 0.6;
  cursor: default;
}
.fleetrCommandBar__actionDone{
  font-size: 13px;
  font-weight: 600;
  color: #2ecc71;
}
.fleetrCommandBar__responseText{
  margin: 0;
  font-size: 14px;
  color: #1F1E1D;
  line-height: 1.6;
  white-space: pre-wrap;
}
.fleetrCommandBar__thinking{
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 0;
}
.fleetrCommandBar__dot{
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #42a4ff;
  animation: fleetrDotPulse 1.2s ease-in-out infinite;
}
.fleetrCommandBar__dot:nth-child(2){ animation-delay: 0.2s; }
.fleetrCommandBar__dot:nth-child(3){ animation-delay: 0.4s; }
@keyframes fleetrDotPulse{
  0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); }
  40%           { opacity: 1;    transform: scale(1);    }
}

.content{
  padding: 26px;
  background: #F9F9F7;
  min-height: 0;
  overflow: auto;
}
.page{
  max-width: 1100px;
}
.page__title{
  margin: 0;
  font-size: 34px;
  font-weight: 800;
  color: #1F1E1D;
}
.page__titleUnderline{
  width: 100%;
  max-width: 260px;
  height: 4px;
  border-radius: 3px;
  margin: 10px 0 20px;
  background: #42a4ff;
}
.page__body{
  margin: 0;
  color: #1d304b;
  line-height: 1.55;
}

.dashboardGrid{
  display: grid;
  gap: 18px;
}
.dashboardSection{
  border: 1px solid #d9dee8;
  border-radius: 10px;
  overflow: hidden;
  background: #F9F9F7;
}
.dashboardSection__header{
  background: #1F1E1D;
  color: #F9F9F7;
  padding: 10px 14px;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.1px;
}
.dashboardSection__headerRow{
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.sectionToggleCircle{
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: none;
  background: #42a4ff;
  color: #1F1E1D;
  font-size: 13px;
  font-weight: 800;
  line-height: 1;
  display: inline-grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
}
.dashboardSection__body{
  overflow-x: auto;
}
.dashboardTable{
  width: 100%;
  border-collapse: collapse;
  min-width: 760px;
}
.resDayNav{
  display: flex;
  align-items: center;
  gap: 0;
  padding: 8px 12px;
  border-bottom: 1px solid #dfe5ef;
  background: #F9F9F7;
}
.resDayNavArrow{
  border: 1px solid #d3dbe8;
  background: #F9F9F7;
  color: #1F1E1D;
  font-size: 18px;
  font-weight: 700;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
  display: grid;
  place-items: center;
  line-height: 1;
  padding: 0;
}
.resDayNavArrow:hover{
  background: #f0f4fa;
}
.resDayNavPickerWrap{
  position: relative;
  margin: 0 8px;
}
.resDayNavDateBtn{
  min-width: 180px;
  text-align: left;
  font-weight: 600;
}
.dashboardTable th{
  background: #F9F9F7;
  color: #1F1E1D;
  text-align: left;
  font-size: 12px;
  font-weight: 700;
  padding: 10px 12px;
  border-bottom: 1px solid #dfe5ef;
  white-space: nowrap;
}
.dashboardTable td{
  color: #1c2f49;
  font-size: 13px;
  padding: 10px 12px;
  border-bottom: 1px solid #edf1f7;
  white-space: nowrap;
}
.dashboardTable tbody tr:last-child td{
  border-bottom: none;
}
.dashboardTable tbody tr:nth-child(even){
  background: #F9F9F7;
}
.dashboardRow--fromNonDrive td:first-child{
  border-left: 4px solid #d3f0dd;
}
.slaTimer{
  font-size: 13px;
}
.slaTimer--over{
  color: #c0392b;
  font-weight: 700;
}
.slaTimer--warn{
  color: #e6a800;
  font-weight: 700;
}
.slaTimer--under{
  color: #42a4ff;
  font-weight: 500;
}
.aiCallWrap{
  display: inline-flex;
  align-items: center;
  gap: 8px;
  position: relative;
}
.aiControl{
  border: 1px solid #ccd5e3;
  background: #F9F9F7;
  color: #1F1E1D;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  position: relative;
  z-index: 1000;
}
.aiDatePicker{
  position: relative;
}
.aiControl--dateButton{
  min-width: 136px;
  text-align: left;
}
.aiControl--time{
  width: 70px;
}
.aiControl--meridiem{
  width: 58px;
}
.ndiSourceSelect{
  font-size: 12px;
  padding: 3px 5px;
  border: 1px solid #d3dbe8;
  border-radius: 5px;
  background: #F9F9F7;
  color: #1a2233;
  cursor: pointer;
}
.calendarPopover{
  position: fixed;
  z-index: 10000;
  width: 210px;
  border: 1px solid #d3dbe8;
  border-radius: 8px;
  background: #F9F9F7;
  box-shadow: 0 10px 25px rgba(10, 31, 60, 0.16);
  padding: 8px;
}
.calendarHeader{
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.calendarArrow{
  border: 1px solid #d3dbe8;
  background: #F9F9F7;
  color: #1F1E1D;
  width: 26px;
  height: 24px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 700;
}
.calendarMonthLabel{
  font-size: 12px;
  color: #1F1E1D;
  font-weight: 700;
}
.calendarWeekdays,
.calendarGrid{
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 3px;
}
.calendarWeekday{
  text-align: center;
  font-size: 10px;
  color: #55657b;
  padding: 3px 0;
}
.calendarDay{
  border: 1px solid transparent;
  border-radius: 6px;
  background: #F9F9F7;
  color: #1F1E1D;
  font-size: 12px;
  padding: 5px 0;
  cursor: pointer;
}
.calendarDay:hover{
  background: #F9F9F7;
}
.calendarDay--today{
  border-color: #42a4ff;
}
.calendarDay--selected{
  background: #e6f5ed;
  border-color: #42a4ff;
  font-weight: 700;
}
.calendarDay--empty{
  visibility: hidden;
  pointer-events: none;
}
.aiCallButton{
  border: none;
  border-radius: 6px;
  background: #42a4ff;
  color: #F9F9F7;
  font-size: 12px;
  font-weight: 700;
  padding: 7px 10px;
  cursor: pointer;
}
.aiCallButton:hover{
  background: #0063bf;
}
.aiCallAgentWrap{
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.aiCallAgentText{
  color: #c0392b;
  font-weight: 700;
}
.preRentalCheckNot {
  color: #c0392b;
  font-weight: 700;
  font-size: 13px;
}
.preRentalCheckDone {
  color: #42a4ff;
  font-weight: 700;
  font-size: 13px;
}
.preRentalCheckLm {
  color: #e6a800;
  font-weight: 700;
  font-size: 13px;
}
.aiSubTabs {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
}
.aiSubTab {
  border: 1.5px solid var(--border, rgba(6,13,12,0.09));
  border-radius: 8px;
  background: transparent;
  color: #55657b;
  font-size: 13px;
  font-weight: 600;
  padding: 6px 16px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.aiSubTab:hover {
  border-color: #42a4ff;
  color: #42a4ff;
}
.aiSubTab--active {
  border-color: #42a4ff;
  background: rgba(66,164,255,0.08);
  color: #42a4ff;
}
.aiTabDesc {
  font-size: 13px;
  color: #55657b;
  margin: 0 0 18px 0;
  line-height: 1.5;
}
.overdueManual {
  color: #c0392b;
  font-weight: 700;
  font-size: 13px;
}
.notesCellWrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
}
.notesAddBtn {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: none;
  background: #42a4ff;
  color: #F9F9F7;
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  display: inline-grid;
  place-items: center;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
}
.notesAddBtn:hover {
  background: #0063bf;
}
.notesDash {
  color: #7b8fa8;
}
.notesCellBtn {
  font-size: 11px;
  padding: 4px 8px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notesDropdown {
  position: fixed;
  z-index: 10000;
  background: #F9F9F7;
  border: 1px solid #d3dbe8;
  border-radius: 8px;
  box-shadow: 0 10px 25px rgba(10, 31, 60, 0.18);
  width: 380px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.notesSearch {
  border: none;
  border-bottom: 1px solid #dfe5ef;
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  color: #1F1E1D;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
.notesList {
  display: flex;
  flex-direction: column;
  min-height: 40px;
}
.notesRow {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid #f0f3f8;
  font-size: 13px;
}
.notesRow:last-child {
  border-bottom: none;
}
.notesAuthor {
  flex-shrink: 0;
  width: 64px;
  font-weight: 700;
  color: #1F1E1D;
  font-size: 12px;
}
.notesText {
  flex: 1;
  color: #1c2f49;
  line-height: 1.4;
}
.notesEmpty {
  padding: 14px 12px;
  font-size: 13px;
  color: #7b8fa8;
  text-align: center;
}
.notesPager {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  border-top: 1px solid #dfe5ef;
  justify-content: center;
}
.notesPagerBtn {
  border: 1px solid #d3dbe8;
  background: #F9F9F7;
  color: #1F1E1D;
  font-size: 12px;
  font-weight: 600;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.notesPagerBtn--active {
  background: #42a4ff;
  color: #F9F9F7;
  border-color: #42a4ff;
}
.aiCallAgentPhone{
  color: #1c2f49;
  font-size: 12px;
  font-weight: 500;
}
.aiCallAgentTimer{
  color: #c0392b;
  font-weight: 700;
  font-size: 12px;
}
.readyFleetPicker{
  position: relative;
  display: inline-block;
}
.readyFleetTrigger{
  min-width: 170px;
  text-align: left;
}
.readyFleetMenusWrap{
  position: fixed;
  z-index: 9999;
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
}
.readyFleetMenu{
  position: relative;
  min-width: 150px;
  background: #F9F9F7;
  border: 1px solid #d3dbe8;
  border-radius: 8px;
  box-shadow: 0 10px 25px rgba(10, 31, 60, 0.16);
  z-index: 9999;
  padding: 4px;
  display: flex;
  flex-direction: column;
}
.readyFleetBrandItem{
  position: relative;
  display: block;
  width: 100%;
}
.readyFleetBrandLabel{
  display: block;
  padding: 8px 10px;
  font-size: 13px;
  color: #1F1E1D;
  border-radius: 6px;
}
.readyFleetBrandItem:hover .readyFleetBrandLabel{
  background: #F9F9F7;
}
.readyFleetModelItem{
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: #1F1E1D;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.readyFleetModelItem:hover{
  background: #F9F9F7;
}
.readyStatusWrap{
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.readyControl{
  min-width: 130px;
}
.readyControl--status{
  min-width: 150px;
}

/* ── Reservations page ──────────────────────────────────────────────────── */
/* Filter tabs above the panel */
.resvSearchBar{
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.resvDatePickerWrap{
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
}
.resvSearchInput{
  padding: 7px 10px;
  border: 1px solid #dfe5ef;
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
  color: #1F1E1D;
  width: 160px;
}
.resvSearchInput:focus{
  outline: none;
  border-color: #42a4ff;
}
.resvDateBtn{
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  width: 148px;
  color: #7b8fa8;
}
.resvDateBtn--active{
  color: #1F1E1D;
  border-color: #42a4ff;
}
.resvDateClear{
  background: none;
  border: none;
  cursor: pointer;
  color: #7b8fa8;
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
}
.resvDateClear:hover{ color: #1F1E1D; }
.resvPageTabs{
  display: flex;
  gap: 0;
  margin-bottom: 14px;
  border-bottom: 1px solid #dfe5ef;
}
.resvPageTab{
  border: none;
  background: transparent;
  color: #7b8fa8;
  font-size: 13px;
  font-weight: 600;
  padding: 7px 18px 8px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 120ms, border-color 120ms;
  line-height: 1;
}
.resvPageTab:hover{
  color: #1F1E1D;
}
.resvPageTab--active{
  color: #1F1E1D;
  border-bottom-color: #42a4ff;
}
/* New Reservation button inside the panel header */
.autoTextNote{
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: rgba(255,255,255,0.62);
}
.aiCallButton--booked{ margin-left: 6px; }
.resvInlineBtn{
  border: none;
  border-radius: 5px;
  background: #42a4ff;
  color: #F9F9F7;
  font-size: 11px;
  font-weight: 700;
  padding: 4px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.resvInlineBtn:hover{
  background: #0063bf;
}
.resvEmpty{
  padding: 28px;
  text-align: center;
  color: #7b8fa8;
  font-size: 14px;
}
/* Close Rental: the Dashboard's entry button and its search screen */
.dashboardCtaRow{
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 18px;
}
.closeRentalCta{
  display: block;
  border: none;
  border-radius: 10px;
  background: #42a4ff;
  color: #F9F9F7;
  font-family: inherit;
  font-size: 15px;
  font-weight: 800;
  padding: 12px 22px;
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0,0,0,0.07);
}
.closeRentalCta:hover{
  background: #0063bf;
}
.closeRentalRow{
  cursor: pointer;
}
.closeRentalRow:hover td,
.closeRentalRow:focus td{
  background: #eef6ff;
}
.closeRentalRow:focus{
  outline: none;
}
.closeRentalCard{
  width: 100%;
  border: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.closeRentalSummary{
  border: 1px solid #d9dee8;
  border-radius: 10px;
  background: #fff;
  padding: 12px 14px;
  margin-bottom: 18px;
  max-width: 480px;
}
.closeRentalSummary__main{
  font-size: 15px;
  font-weight: 700;
  color: #1F1E1D;
}
.closeRentalSummary__meta{
  font-size: 13px;
  color: #55657b;
  margin-top: 2px;
}
.closeRentalStepTitle{
  margin: 0 0 14px;
  font-size: 18px;
  font-weight: 800;
  color: #1F1E1D;
}
.closeRentalForm{
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 480px;
}
.closeRentalHint{
  font-size: 12px;
  color: #7b8fa8;
}
.closeRentalError{
  margin-top: -8px;
  font-size: 12px;
  font-weight: 600;
  color: #c0392b;
}
.closeRentalWarning{
  border: 1px solid #f3d38a;
  background: #fff8e6;
  color: #7a5a10;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.45;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.closeRentalWarning__confirm{
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  cursor: pointer;
}
.closeRentalFuel__value{
  font-size: 15px;
  font-weight: 700;
  color: #42a4ff;
}
.closeRentalFuel{
  width: 100%;
  accent-color: #42a4ff;
  cursor: pointer;
  margin: 2px 0 0;
  /* A drag on the slider is never a scroll; see the touch handlers on it. */
  touch-action: none;
}
.closeRentalFuel--unset{
  opacity: 0.45;
}
.closeRentalFuel__labels{
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: #7b8fa8;
}
.closeRentalActions{
  display: flex;
  gap: 10px;
  margin-top: 22px;
  max-width: 480px;
}
.closeRentalActions .resModalSubmit{
  margin-left: auto;
}
.closeRentalDamageList{
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 640px;
  margin-bottom: 24px;
}
.closeRentalDamageEmpty{
  font-size: 13px;
  color: #55657b;
  padding: 10px 0;
}
.closeRentalDamageItem{
  border: 1px solid #d9dee8;
  border-radius: 10px;
  background: #fff;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.closeRentalDamageItem__desc{
  font-size: 14px;
  font-weight: 600;
  color: #1F1E1D;
}
.closeRentalDamageItem__meta{
  font-size: 12px;
  color: #7b8fa8;
}
.damagePhotoRow{
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.damagePhotoThumb{
  width: 96px;
  height: 72px;
  border: 1px solid #d9dee8;
  border-radius: 8px;
  padding: 0;
  overflow: hidden;
  background: #f0f4fa;
  cursor: zoom-in;
}
.damagePhotoThumb img{
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.damagePhotoThumb--empty{
  display: grid;
  place-items: center;
  font-size: 11px;
  color: #7b8fa8;
  text-align: center;
  cursor: default;
}
.damagePhotoViewer{
  position: fixed;
  inset: 0;
  z-index: 10000;
  background: rgba(10,31,60,0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 16px 16px;
}
.damagePhotoViewer__img{
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.35);
}
.damagePhotoViewer__close{
  position: absolute;
  top: 10px;
  right: 14px;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 999px;
  background: rgba(255,255,255,0.15);
  color: #fff;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}
.damagePhotoViewer__close:hover{
  background: rgba(255,255,255,0.3);
}
.closeRentalChoiceRow{
  display: flex;
  gap: 10px;
  max-width: 480px;
}
.closeRentalChoice{
  flex: 1;
  border: 1px solid #d3dbe8;
  border-radius: 8px;
  background: #fff;
  color: #1F1E1D;
  font-family: inherit;
  font-size: 14px;
  font-weight: 700;
  padding: 10px 0;
  cursor: pointer;
}
.closeRentalChoice:hover{
  border-color: #42a4ff;
}
.closeRentalChoice--active{
  background: #42a4ff;
  border-color: #42a4ff;
  color: #F9F9F7;
}
.closeRentalActions .resModalSubmit:disabled{
  opacity: 0.45;
  cursor: not-allowed;
}
.closeRentalActions .resModalSubmit:disabled:hover{
  background: #42a4ff;
}
.closeRentalPhotoNote{
  margin: -6px 0 14px;
  max-width: 640px;
  font-size: 13px;
  color: #1c2f49;
  line-height: 1.45;
}
/* Letterboxed rather than cropped, so the preview shows exactly the frame a
   photo will capture. */
.closeRentalCamera{
  position: relative;
  width: 100%;
  max-width: 640px;
  aspect-ratio: 4 / 3;
  background: #1F1E1D;
  border-radius: 12px;
  overflow: hidden;
}
.closeRentalCamera__video,
.closeRentalCamera__still{
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.closeRentalCamera__status{
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
  color: #F9F9F7;
  font-size: 14px;
  line-height: 1.45;
}
.closeRentalCameraControls{
  display: flex;
  gap: 10px;
  max-width: 640px;
  margin: 12px 0 20px;
}
.closeRentalCameraControls button{
  flex: 1;
  padding-block: 12px;
  font-size: 14px;
}
.closeRentalShutter{
  border: none;
  border-radius: 10px;
  background: #42a4ff;
  color: #F9F9F7;
  font-family: inherit;
  font-weight: 800;
  cursor: pointer;
}
.closeRentalShutter:hover{
  background: #0063bf;
}
.closeRentalShutter:disabled{
  opacity: 0.45;
  cursor: not-allowed;
  background: #42a4ff;
}
.closeRentalPhotoListTitle{
  font-size: 13px;
  font-weight: 700;
  color: #1F1E1D;
  margin-bottom: 8px;
}
.closeRentalPhotoItem{
  position: relative;
}
.closeRentalPhotoItem__remove{
  position: absolute;
  top: -6px;
  right: -6px;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 999px;
  background: #1F1E1D;
  color: #F9F9F7;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.closeRentalPhotoItem__remove:hover{
  background: #c0392b;
}
/* Modal */
.resModalBackdrop{
  position: fixed;
  inset: 0;
  background: rgba(10,31,60,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 20px;
}
.resModal{
  background: #F9F9F7;
  border-radius: 14px;
  width: 100%;
  max-width: 740px;
  box-shadow: 0 20px 60px rgba(10,31,60,0.25);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 40px);
}
.resModalHeader{
  background: #1F1E1D;
  color: #F9F9F7;
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.resModalTitle{
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}
.resModalClose{
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.7);
  font-size: 18px;
  cursor: pointer;
  line-height: 1;
  padding: 0;
}
.resModalClose:hover{
  color: #F9F9F7;
}
.resModalForm{
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}
.resModalBody{
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  flex: 1;
}
.resFormRow{
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.resFormGroup{
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 130px;
  flex: 1;
}
.resFormGroup--wide{
  flex: 2;
}
.resFormGroup--full{
  flex: 1 1 100%;
}
.resFormLabel{
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #55657b;
}
.resFormInput{
  border: 1px solid #d3dbe8;
  border-radius: 7px;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  color: #1F1E1D;
  background: #F9F9F7;
}
.resFormInput:focus{
  outline: 2px solid #42a4ff;
  outline-offset: -1px;
}
.resFormTextarea{
  resize: vertical;
}
.resModalActions{
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px 18px;
  border-top: 1px solid #edf1f7;
}
.resModalCancel{
  border: 1px solid #d3dbe8;
  border-radius: 7px;
  background: #F9F9F7;
  color: #55657b;
  font-size: 13px;
  font-weight: 600;
  padding: 9px 18px;
  cursor: pointer;
}
.resModalCancel:hover{
  background: #0063bf;
}
.resModalSubmit{
  border: none;
  border-radius: 7px;
  background: #42a4ff;
  color: #F9F9F7;
  font-size: 13px;
  font-weight: 700;
  padding: 9px 20px;
  cursor: pointer;
}
.resModalSubmit:hover{
  background: #0063bf;
}

@media (max-width: 900px){
  .app{ grid-template-columns: 76px 1fr; }
  .sidebar__sectionHeader{ display:none; }
  .nav__label{ display:none; }
  .nav__item{ justify-content:center; }
}

@media (max-width: 767px){
  .app{
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .app--mobile{
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .sidebar{ display: none; }
  .content{
    padding: 16px;
    padding-bottom: 80px;
    flex: 1;
    overflow-y: auto;
  }

  /* Mobile topbar */
  .mobileTopbar{
    height: 56px;
    background: #1F1E1D;
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 12px;
    flex-shrink: 0;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .mobileHamburger{
    background: none;
    border: none;
    color: rgba(255,255,255,0.84);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    flex-shrink: 0;
  }
  .mobileTopbar__wordmark{
    font-size: 17px;
    font-weight: 800;
    color: #fff;
    letter-spacing: -0.02em;
    flex: 1;
  }
  .mobileTopbar__signOut{
    background: transparent;
    border: 1px solid rgba(255,255,255,0.15);
    color: rgba(255,255,255,0.45);
    font-family: inherit;
    font-size: 0.78rem;
    font-weight: 500;
    padding: 5px 12px;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
  }

  /* How tall the fixed command bar is. On :root because the nav drawer and the
     bar are siblings: custom properties inherit down the tree, so a value
     declared on .mobileBottomBar would be invisible to the drawer, and the
     calc() below it would resolve to nothing and drop the whole declaration.
     Anything that needs to clear the bar reads it from here. */
  :root{ --mobileBottomBarH: 68px; }

  /* Nav drawer */
  .mobileNavOverlay{
    position: fixed;
    inset: 56px 0 0 0;
    z-index: 200;
    background: rgba(0,0,0,0.45);
  }
  .mobileNavDrawer{
    background: #1F1E1D;
    width: 260px;
    height: 100%;
    overflow-y: auto;
    /* The drawer runs to the bottom of the screen, but the command bar is
       fixed on top of it. Without this the drawer scrolled to its true end
       and the last item, Settings, still sat entirely behind the bar: there
       was nothing left to scroll, so it could not be reached at all.
       Padding rather than shortening the overlay, so the drawer's background
       still runs behind the bar instead of ending in a visible seam.
       The safe-area inset covers phones where the bar is lifted by a home
       indicator, which pushes the overlap further up again. */
    padding: 16px 0 calc(var(--mobileBottomBarH) + env(safe-area-inset-bottom, 0px) + 16px);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .mobileNavSection{
    padding: 0 0 0 14px;
  }
  .mobileNavSectionHeader{
    margin: 0 14px 10px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: rgba(255,255,255,0.46);
  }
  .mobileNavItem{
    display: flex;
    align-items: center;
    padding: 10px 14px;
    border-radius: 6px 0 0 6px;
    border-left: 3px solid transparent;
    color: rgba(255,255,255,0.84);
    font-size: 14px;
    font-weight: 500;
    background: transparent;
    text-decoration: none;
  }
  .mobileNavItem:hover{ background: #0063bf; }
  .mobileNavItem--active{
    background: #0063bf;
    border-left-color: #42a4ff;
    color: #F9F9F7;
  }

  /* Fixed bottom command bar */
  .mobileBottomBar{
    min-height: var(--mobileBottomBarH);
    box-sizing: border-box;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: #1F1E1D;
    border-top: 1px solid rgba(255,255,255,0.1);
    padding: 8px 16px;
    z-index: 300;
    display: flex;
    align-items: center;
  }
  /* The bar sits at the bottom of the screen, so its popover opens upward.
     This used to hang off .mobileBottomBar--expanded, which no longer exists
     now that the collapsed pill is gone. */
  .mobileBottomBar .fleetrCommandBar__popover{
    top: auto;
    bottom: calc(100% + 10px);
  }
  /* Anything below 16px makes iOS zoom the whole page when the field takes
     focus, which is jarring on the very tap this bar is built around. */
  .mobileBottomBar .fleetrCommandBar__input{
    font-size: 16px;
  }
  /* Comfortable touch targets for the mic and send buttons. */
  .mobileBottomBar .fleetrCommandBar__iconBtn,
  .mobileBottomBar .fleetrCommandBar__sendBtn{
    min-width: 40px;
    min-height: 40px;
  }
  /* No bar, so nothing to clear. Zeroing the height on the app, an ancestor of
     both the content and the drawer, reaches everything that reads it; the
     content's own 80px is the bar's height plus a margin, so it goes back to
     matching its other sides. */
  .app--noCommandBar{ --mobileBottomBarH: 0px; }
  .app--noCommandBar .content{ padding-bottom: 16px; }

  /* Dashboard cards */
  .dashCard{
    background: #fff;
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 10px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.07);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dashCard__header{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 15px;
    font-weight: 600;
    color: #1F1E1D;
  }
  .dashCard__resCode{
    font-size: 12px;
    color: #7b8fa8;
    font-weight: 500;
    white-space: nowrap;
  }
  .dashCard__meta{
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .dashCard__chip{
    background: #f0f5ff;
    color: #1F1E1D;
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 12px;
    font-weight: 500;
  }
  .dashCard__chip--winter{
    background: #e0f2fe;
    color: #0369a1;
  }
  /* Full width on a phone, where they are the first thing under the title. */
  .dashboardCtaRow{ flex-direction: column; }
  .closeRentalCta{ width: 100%; }
  /* 16px or iOS zooms the page when the field takes focus. */
  .closeRentalMileage, .closeRentalNote{ font-size: 16px; }
  .closeRentalActions button{ flex: 1; padding-block: 12px; }
  .dashCard__chip--loc{
    background: #f0f5ff;
    font-size: 11px;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Make remaining tables scrollable rather than overflowing */
  .dashboardSection .dashboardTable{
    display: block;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  /* Mobile browsers zoom in on any field whose text is under 16px when it is
     tapped. 16px on every field stops that without touching the viewport, so
     pinch zoom still works. !important because many fields set a smaller size
     through their own class or an inline style, which would otherwise win. */
  input, select, textarea{
    font-size: 16px !important;
  }
}

.fleetStatus--available { color: #42a4ff; font-weight: 700; }
.fleetStatus--onRent    { color: #4a6fa5; font-weight: 700; }
.fleetStatus--cleaning  { color: #c0392b; font-weight: 700; }
.fleetStatus--pm      { color: #7b5ea7; font-weight: 700; }
.fleetStatus--damaged   { color: #c0392b; font-weight: 700; }

.fleetGroup {
  border-bottom: 1px solid #dfe5ef;
}
.fleetGroup:last-child {
  border-bottom: none;
}
.fleetGroupHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 14px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #fff;
}
.fleetGroupHeader--available    { background: #22c55e; }
.fleetGroupHeader--cleaning     { background: #e6a800; }
.fleetGroupHeader--readyReturns { background: #ea580c; }
.fleetGroupHeader--pm         { background: #7b5ea7; }
.fleetGroupHeader--damaged      { background: #c0392b; }
.fleetGroupHeader--onRent       { background: #4a6fa5; }
.fleetGroupHeaderRight {
  display: flex;
  align-items: center;
  gap: 8px;
}
.fleetGroupCount {
  background: rgba(255,255,255,0.25);
  border-radius: 10px;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 700;
}
.fleetGroupToggle {
  background: rgba(255,255,255,0.2);
  border: none;
  border-radius: 50%;
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.fleetGroupToggle:hover {
  background: rgba(255,255,255,0.35);
}
.fleetSubLabel {
  padding: 5px 14px 3px;
  font-size: 11px;
  font-weight: 700;
  color: #42a4ff;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  background: #f4fcf7;
  border-bottom: 1px solid #d0ead9;
}
.fleetSubLabel--cleaning {
  color: #e6a800;
  background: #fffbf0;
  border-bottom: 1px solid #f0e0a0;
}
.fleetSubLabel--readyReturns {
  color: #ea580c;
  background: #fff7f0;
  border-bottom: 1px solid #fdd0b0;
}
.fleetMarkCleanBtn {
  border: none;
  border-radius: 5px;
  background: #42a4ff;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 4px 8px;
  cursor: pointer;
}
.fleetMarkCleanBtn:hover { background: #0063bf; }

/* ── Rental Agreements ────────────────────────────────────────────────────────────────── */
.customerLinkWrap {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}
.customerLink {
  background: none;
  border: none;
  padding: 0;
  color: #1F1E1D;
  font-weight: 500;
  font-size: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: #ccc;
}
.customerLink:hover {
  color: #42a4ff;
  text-decoration-color: #42a4ff;
}
.plateLink {
  background: none;
  border: none;
  padding: 0;
  color: #1F1E1D;
  font-weight: 600;
  font-size: inherit;
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-color: #ccc;
  letter-spacing: 0.02em;
}
.plateLink:hover {
  color: #42a4ff;
  text-decoration-color: #42a4ff;
}
.vehicleDetailRow {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid rgba(6,13,12,0.06);
}
.vehicleDetailRow:last-child { border-bottom: none; }
.vehicleDetailLabel {
  min-width: 170px;
  font-size: 13px;
  font-weight: 600;
  color: #55657b;
  flex-shrink: 0;
}
.vehicleDetailValue {
  font-size: 13px;
  color: #1F1E1D;
}
.vehicleDetailSubHeader {
  font-size: 12px;
  font-weight: 700;
  color: #55657b;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin: 18px 0 8px;
}
.vehicleDetailSubHeader:first-child { margin-top: 4px; }
.vehicleStatusSelect {
  border: 1.5px solid rgba(6,13,12,0.12);
  border-radius: 7px;
  background: #F9F9F7;
  color: #1F1E1D;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  padding: 4px 10px;
  cursor: pointer;
}
.vehicleStatusSelect:focus { outline: none; border-color: #42a4ff; }

.tankSizeInput {
  width: 110px;
  border: 1.5px solid rgba(6,13,12,0.12);
  border-radius: 7px;
  background: #F9F9F7;
  color: #1F1E1D;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  padding: 4px 10px;
  text-align: right;
}
.tankSizeInput:focus { outline: none; border-color: #42a4ff; }
.tankSizeInput::-webkit-inner-spin-button,
.tankSizeInput::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }

.tankSizeMissing {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: #fef3c7;
  color: #92400e;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}

.tankSizeBanner {
  margin-bottom: 16px;
  padding: 12px 16px;
  border: 1px solid #fcd34d;
  border-left: 4px solid #f59e0b;
  border-radius: 8px;
  background: #fffbeb;
  color: #78350f;
  font-size: 13px;
  line-height: 1.5;
}
.tankSizeBannerPlates { font-weight: 700; }

.unitToggle {
  display: inline-flex;
  border: 1.5px solid rgba(6,13,12,0.12);
  border-radius: 7px;
  overflow: hidden;
  /* Never shrink. As a flex item this defaulted to flex-shrink:1, so in a
     narrow column the browser squeezed it and overflow:hidden silently clipped
     the label ("Miles" rendered as "M"). Sizing is now driven by the text. */
  flex: 0 0 auto;
}
.unitToggleBtn {
  border: none;
  background: #F9F9F7;
  color: #6b7280;
  font-family: inherit;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  padding: 4px 9px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  white-space: nowrap;
}
.unitToggleBtn + .unitToggleBtn { border-left: 1px solid rgba(6,13,12,0.12); }
.unitToggleBtn:hover { background: #eef1f5; }
.unitToggleBtn--active { background: #42a4ff; color: #fff; }
.unitToggleBtn--active:hover { background: #2f93ef; }

/* Header of a field that carries a unit toggle. Height is pinned to match the
   plain-label fields (see .addVehicleField > .addVehicleLabel) so that every
   input in a grid row starts on the same line. The label is kept on one line
   because wrapping it was what pushed these two inputs out of alignment. */
.addVehicleLabelRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 26px;
}
.addVehicleLabelRow .addVehicleLabel { white-space: nowrap; }

.vehicleDetailControl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.unitSuffix { font-size: 12px; color: #6b7280; font-weight: 600; }

.pmDueBadge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 999px;
  background: #e5e7eb;
  color: #374151;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}
.pmDueBadge--ok  { background: #d1fae5; color: #065f46; }
.pmDueBadge--due { background: #ede9fe; color: #4c1d95; }

.pmCompleteBtn {
  border: 1.5px solid #7b5ea7;
  border-radius: 8px;
  background: #7b5ea7;
  color: #fff;
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  padding: 8px 16px;
  cursor: pointer;
}
.pmCompleteBtn:hover:not(:disabled) { background: #6b4e97; }
.pmCompleteBtn:disabled { background: #d1d5db; border-color: #d1d5db; color: #6b7280; cursor: not-allowed; }

.pmBanner {
  margin-bottom: 16px;
  padding: 12px 16px;
  border: 1px solid #c4b5fd;
  border-left: 4px solid #7b5ea7;
  border-radius: 8px;
  background: #f5f3ff;
  color: #4c1d95;
  font-size: 13px;
  line-height: 1.5;
}
.pmBannerPlates { font-weight: 700; }

/* ─── Audit Log ─────────────────────────────────────────────────────────── */
.auditFilters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.auditFilter {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.auditFilterLabel {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: rgba(6,13,12,0.5);
}
.auditFilterInput {
  font-family: inherit;
  font-size: 13px;
  padding: 6px 10px;
  border: 1px solid #d3dbe8;
  border-radius: 8px;
  background: #fff;
  color: #1F1E1D;
  min-width: 140px;
}
.auditFilterInput:focus {
  outline: none;
  border-color: #42a4ff;
  box-shadow: 0 0 0 3px rgba(66,164,255,0.15);
}
.auditClearBtn {
  font-family: inherit;
  font-size: 13px;
  padding: 7px 14px;
  border: 1px solid #d3dbe8;
  border-radius: 8px;
  background: #fff;
  color: #1F1E1D;
  cursor: pointer;
}
.auditClearBtn:hover { background: #f2f5fa; }
/* The policy key under the human label. Present so an entry traces back to
   ACTION_POLICY without guessing, quiet enough not to compete with the label. */
.auditActionKey {
  font-size: 11px;
  color: rgba(6,13,12,0.45);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.auditDescription {
  max-width: 420px;
  font-size: 12px;
  color: rgba(6,13,12,0.75);
}
.auditOutcome {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  text-transform: capitalize;
}
.auditOutcome--completed { background: #d1fae5; color: #065f46; }
.auditOutcome--cancelled { background: #fef3c7; color: #92400e; }
.auditOutcome--refused   { background: #fee2e2; color: #991b1b; }

.gasSettingRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(6,13,12,0.07);
}
.gasSettingRow:last-child { border-bottom: none; }
.gasSettingLabel {
  font-size: 13px;
  font-weight: 600;
  color: #1F1E1D;
}
.gasSettingControl {
  display: flex;
  align-items: center;
  gap: 6px;
}
.gasSettingInput {
  width: 110px;
  border: 1.5px solid rgba(6,13,12,0.12);
  border-radius: 7px;
  background: #F9F9F7;
  color: #1F1E1D;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  padding: 5px 10px;
  text-align: right;
}
.gasSettingInput:focus { outline: none; border-color: #42a4ff; }
.gasSettingInput::-webkit-inner-spin-button,
.gasSettingInput::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.gasSettingUnit {
  font-size: 13px;
  color: #6b7280;
  font-weight: 500;
}
.gasSettingSubhead {
  margin: 18px 0 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #42a4ff;
}
.customerPlaceholder {
  padding: 16px 18px;
  color: #7b8fa8;
  font-size: 13px;
}
.cdetailForm {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.cdetailSubGroup {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #42a4ff;
  padding-top: 6px;
  border-top: 1px solid #eef1f5;
}
.cdetailSubGroup:first-child {
  border-top: none;
  padding-top: 0;
}
.chargesWrap{
  display: flex;
  flex-direction: column;
}
.chargesTabBar{
  padding: 0 20px;
  border-bottom: 1px solid #dfe5ef;
  margin-bottom: 0;
}
.chargesInfoRow{
  display: flex;
  gap: 32px;
  flex-wrap: wrap;
  padding: 4px 0 8px;
  border-bottom: 1px solid #eef1f5;
  margin-bottom: 4px;
}
.chargesInfoItem{
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.chargesInfoLabel{
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #7b8fa8;
}
.chargesInfoValue{
  font-size: 14px;
  font-weight: 600;
  color: #1F1E1D;
}
.chargesTable{
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.chargesTh{
  text-align: left;
  padding: 6px 8px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #7b8fa8;
  border-bottom: 1px solid #eef1f5;
}
.chargesTh--check{ width: 32px; }
.chargesTh--qty{ width: 120px; }
.chargesTh--amt{ width: 140px; text-align: right; }
.chargesTh--total{ width: 120px; text-align: right; }
.chargesRow:hover{ background: #f7f9fc; }
.chargesTd{
  padding: 7px 8px;
  border-bottom: 1px solid #f0f3f7;
  vertical-align: middle;
}
.chargesTd--check{ text-align: center; }
.chargesTd--label{ color: #1F1E1D; font-weight: 500; }
.chargesItemWrap{ display: flex; flex-direction: column; gap: 3px; }
.chargesItemMeta{ display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.chargesItemBilledTo{ font-size: 11px; color: #7b8fa8; font-weight: 400; }
.chargesCoverLabel{
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; color: #55657b; font-weight: 400;
  cursor: pointer; white-space: nowrap;
}
.chargesCoverCheck{ width: 12px; height: 12px; cursor: pointer; accent-color: #42a4ff; }
.chargesTd--qty{}
.chargesQtyWrap{ display: flex; align-items: center; gap: 6px; }
.chargesTd--amt{ text-align: right; }
.chargesTd--total{ text-align: right; }
.chargesCheck{
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: #42a4ff;
}
.chargesAutoAmt{
  font-weight: 600;
  color: #1F1E1D;
}
.chargesQtyInput{
  width: 70px;
  text-align: left;
}
.chargesAmtInput{
  width: 90px;
  text-align: right;
}
.chargesTotalRow{
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 8px 2px;
  border-top: 2px solid #eef1f5;
  margin-top: 4px;
}
.chargesTotalRow--balance{ border-top: none; padding-top: 4px; }
.chargesTotalRow--section{ border-top-color: #d9e2ee; margin-top: 0; }
.chargesTotalRow--grand{
  border-top: 2px solid #1F1E1D;
  margin-top: 8px;
  padding-top: 10px;
}
.chargesSection{
  margin-bottom: 4px;
}
.chargesSectionHeader{
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #55657b;
  padding: 10px 8px 4px;
  border-bottom: 2px solid #d0dae8;
  margin-bottom: 0;
}
.chargesTotalLabel{
  font-size: 13px;
  font-weight: 700;
  color: #55657b;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.chargesTotalValue{
  font-size: 15px;
  font-weight: 700;
  color: #1F1E1D;
}
.chargesTotalValue--owing{ color: #c0392b; }
.chargesTotalValue--credit{ color: #42a4ff; }
.paymentsList{
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
}
.paymentRow{
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: #f7f9fc;
  border-radius: 8px;
  border: 1px solid #eef1f5;
}
.paymentDisplay{
  font-size: 13px;
  font-weight: 600;
  color: #1F1E1D;
  min-height: 18px;
}
.paymentFields{
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.paymentSelect{ width: 120px; }
.paymentLast4{ width: 72px; }
.paymentName{ flex: 1; min-width: 130px; }
.paymentAmtWrap{ width: 110px; }
.paymentRemoveBtn{
  background: none;
  border: none;
  font-size: 18px;
  color: #c0392b;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.paymentRemoveBtn:hover{ color: #a93226; }
.addPaymentBtn{
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  background: #42a4ff;
  color: #fff;
  border: none;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  margin-bottom: 12px;
}
.addPaymentBtn:hover{ background: #0063bf; }
.paymentsTotals{ margin-top: 4px; }
.btDollarWrap {
  display: flex;
  align-items: center;
  border: 1px solid #d3dbe8;
  border-radius: 7px;
  background: #F9F9F7;
  overflow: hidden;
}
.btDollarPrefix {
  padding: 0 8px;
  font-size: 13px;
  color: #7b8fa8;
  font-weight: 600;
  border-right: 1px solid #d3dbe8;
  background: #f0f3f7;
  line-height: 36px;
  white-space: nowrap;
}
.btDollarInput {
  border: none !important;
  border-radius: 0 !important;
  flex: 1;
  min-width: 0;
}
.btDollarInput:focus {
  outline: 2px solid #42a4ff;
  outline-offset: -2px;
}
.customerRentalAgreementOptions {
  padding: 16px 18px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.customerRentalAgreementBtnRow {
  display: flex;
  gap: 10px;
}
.customerRentalAgreementBtn {
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.customerRentalAgreementBtn--open {
  background: #22c55e;
  color: #fff;
}
.customerRentalAgreementBtn--open:hover { background: #16a34a; }
.customerRentalAgreementBtn--pending {
  background: #e6a800;
  color: #fff;
}
.customerRentalAgreementBtn--pending:hover { background: #cc9600; }
.customerRentalAgreementBtn--close {
  background: #c0392b;
  color: #fff;
}
.customerRentalAgreementBtn--close:hover { background: #a93226; }
.customerRentalAgreementBtn--delete {
  background: #8B0000;
  color: #fff;
}
.customerRentalAgreementBtn--delete:hover { background: #6a0000; }
.customerRentalAgreementBtn--damage {
  background: #c2400c;
  color: #fff;
}
.customerRentalAgreementBtn--damage:hover:not(:disabled) { background: #a33308; }
.customerRentalAgreementBtn--damage-active {
  background: #6b3a2a;
  color: #d9b8ac;
  cursor: default;
  opacity: 0.85;
}
.customerRentalAgreementClosed {
  font-size: 13px;
  color: #7b8fa8;
  font-style: italic;
}
.rentalAgreementLink {
  background: none;
  border: none;
  padding: 0;
  color: #42a4ff;
  font-weight: 600;
  font-size: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.rentalAgreementLink:hover {
  color: #0063bf;
}
.rentalAgreementLink--dark {
  color: #1F1E1D;
}
.rentalAgreementLink--dark:hover {
  color: #42a4ff;
}
.rentalAgreementBadge {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.rentalAgreementBadge--open {
  background: #d1fae5;
  color: #065f46;
}
.rentalAgreementBadge--customerReturn {
  background: #dbeafe;
  color: #1e40af;
}
.rentalAgreementBadge--pending {
  background: #fef3c7;
  color: #92400e;
}
.rentalAgreementBadge--closed {
  background: #fee2e2;
  color: #991b1b;
}
.rentalAgreementBadge--neutral {
  background: #e5e7eb;
  color: #374151;
}
.rentalAgreementBadge--meta {
  font-size: 18px;
  padding: 3px 14px;
  border-radius: 14px;
}
.customerPageMeta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 4px 0 0;
}
.customerPageMetaCode {
  font-size: 18px;
  font-weight: 600;
  color: #374151;
  letter-spacing: 0.04em;
}
.rentalAgreementDetailHeader {
  padding: 4px 0 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rentalAgreementBackBtn {
  background: none;
  border: none;
  color: #42a4ff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  align-self: flex-start;
}
.rentalAgreementBackBtn:hover {
  color: #0063bf;
}
.customerPageTopBar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}
.customerPageSaveBtn {
  background: #42a4ff;
  color: #fff;
  border: none;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 6px 16px;
  transition: background 0.15s;
}
.customerPageSaveBtn:hover:not(:disabled) {
  background: #2287e8;
}
.customerPageSaveBtn:disabled {
  opacity: 0.6;
  cursor: default;
}
.rentalAgreementDetailTitle {
  display: flex;
  align-items: center;
  gap: 12px;
}
.rentalAgreementFields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px 24px;
  padding: 14px 18px;
}
.rentalAgreementField {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rentalAgreementFieldLabel {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #7b8fa8;
}
.rentalAgreementFieldValue {
  font-size: 13px;
  color: #1F1E1D;
  font-weight: 500;
}
/* ── Fleet filter bar ───────────────────────────────────────────────────── */
.fleetFilterBar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 18px;
}
.fleetFilterInput {
  padding: 7px 11px;
  border: 1.5px solid #d3dbe8;
  border-radius: 7px;
  font-size: 13px;
  font-family: inherit;
  color: #1F1E1D;
  background: #fff;
  width: 130px;
  transition: border-color 0.15s;
}
.fleetFilterInput:focus {
  outline: none;
  border-color: #42a4ff;
}
.fleetFilterInput::placeholder { color: #aab4c2; }
.fleetFilterSelect {
  padding: 7px 28px 7px 11px;
  border: 1.5px solid #d3dbe8;
  border-radius: 7px;
  font-size: 13px;
  font-family: inherit;
  color: #1F1E1D;
  background: #fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2355657b'/%3E%3C/svg%3E") no-repeat right 9px center;
  background-size: 10px 6px;
  appearance: none;
  cursor: pointer;
  transition: border-color 0.15s, background-color 0.15s, color 0.15s;
}
.fleetFilterSelect:focus {
  outline: none;
  border-color: #42a4ff;
}

/* ── Claim status badges ────────────────────────────────────────────────── */
.claimStatus {
  display: inline-block;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 9px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
}
.claimStatus--open {
  background: #fee2e2;
  color: #991b1b;
}
.claimStatus--inReview {
  background: #fef3c7;
  color: #92400e;
}
.claimStatus--settled {
  background: #f3f4f6;
  color: #6b7280;
}

/* ── Add / Retire Vehicle form ──────────────────────────────────────────── */
.addVehicleForm {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.addVehicleGrid {
  display: grid;
  /* auto-fill adds columns rather than widening them, so the column width is
     effectively this minimum at every screen size. 200px could not hold
     "Needs PM Every" beside a Kilometers/Miles toggle (227px), which is what
     clipped the toggle. Raised so the widest field fits with room to spare. */
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px 20px;
}
.addVehicleField {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.addVehicleField--full {
  grid-column: 1 / -1;
}
.addVehicleLabel {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: #55657b;
}
/* A plain label is 13px tall but a label sitting beside a unit toggle is 26px,
   which left the inputs in a row starting at three different heights. Giving
   every field header the same height lines all the inputs up. Direct child
   only, so the labels inside .addVehicleLabelRow are not double counted. */
.addVehicleField > .addVehicleLabel {
  display: flex;
  align-items: center;
  min-height: 26px;
}
.addVehicleInput {
  padding: 7px 10px;
  border: 1.5px solid #d3dbe8;
  border-radius: 7px;
  font-size: 13px;
  font-family: inherit;
  color: #1F1E1D;
  background: #F9F9F7;
  transition: border-color 0.15s;
}
.addVehicleInput:focus {
  outline: none;
  border-color: #42a4ff;
}
.addVehicleBtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  background: #42a4ff;
  color: #fff;
  border: none;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  align-self: flex-start;
}
.addVehicleBtn:hover { background: #0063bf; }
.addVehicleBtn--retire {
  background: #c0392b;
}
.addVehicleBtn--retire:hover { background: #a93226; }
.addVehicleError {
  font-size: 13px;
  color: #c0392b;
  font-weight: 500;
}
.addVehicleSuccess {
  font-size: 13px;
  color: #065f46;
  font-weight: 500;
}

.torDateInput {
  padding: 5px 8px;
  border: 1.5px solid #d3dbe8;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  color: #1F1E1D;
  background: #F9F9F7;
  cursor: pointer;
  transition: border-color 0.15s;
}
.torDateInput:focus {
  outline: none;
  border-color: #42a4ff;
}
.torDateInput:hover {
  border-color: #42a4ff;
}

/* ─── Damage Claims ────────────────────────────────────────────────────────── */

.resolveClaimBtn {
  background: none;
  border: 1.5px solid #d3dbe8;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
  color: #1F1E1D;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
  white-space: nowrap;
}
.resolveClaimBtn:hover {
  border-color: #42a4ff;
  color: #42a4ff;
}

/* ─── Gas Collections ──────────────────────────────────────────────────────── */

.gasOwedWrap {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.gasOwedDollar {
  color: #1F1E1D;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
}
.gasOwedInput {
  width: 72px;
  padding: 4px 6px;
  border: 1.5px solid #d3dbe8;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  color: #1F1E1D;
  background: #F9F9F7;
  transition: border-color 0.15s;
  -moz-appearance: textfield;
}
.gasOwedInput::-webkit-inner-spin-button,
.gasOwedInput::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.gasOwedInput:focus {
  outline: none;
  border-color: #42a4ff;
}
.gasOwedInput:hover {
  border-color: #42a4ff;
}
.gasStatusSelect {
  padding: 4px 6px;
  border: 1.5px solid #d3dbe8;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  color: #1F1E1D;
  background: #F9F9F7;
  cursor: pointer;
  transition: border-color 0.15s;
}
.gasStatusSelect:focus {
  outline: none;
  border-color: #42a4ff;
}
.gasStatusSelect:hover {
  border-color: #42a4ff;
}
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(
  React.createElement(React.StrictMode, null, React.createElement(App))
);
