import React from "https://esm.sh/react@18.3.1";
import ReactDOM from "https://esm.sh/react-dom@18.3.1/client";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  HashRouter,
  useNavigate,
} from "https://esm.sh/react-router-dom@6.26.2?deps=react@18.3.1,react-dom@18.3.1";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@1/+esm";

// ─── Supabase client ──────────────────────────────────────────────────────────
// Paste your Project URL and anon key from Supabase → Settings → API
const SUPABASE_URL  = "https://hzcatlecvwpqxedrzfog.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6Y2F0bGVjdndwcXhlZHJ6Zm9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNzQzMTMsImV4cCI6MjA5MzY1MDMxM30.mfqwWQh54hPsRunAVB6RDf_IrvwKmhSYWWJ4sMy0rcw";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ─── Claude API ───────────────────────────────────────────────────────────────
const CLAUDE_MODEL     = "claude-sonnet-4-5";
const CLAUDE_API_URL   = "https://fleetr-ai-proxy.connor-0a5.workers.dev";
const CLAUDE_SYSTEM    = `You are fleetr ai, an assistant built into a vehicle fleet rental management system. You have access to the current reservations, rental agreements, fleet, non-drive intake, no-shows, and damage claims data passed in the user message.

Always respond with a valid JSON object — no markdown, no code fences, no text outside the JSON. Use this exact structure:
{
  "message": "Plain English description of what you found or what action you are about to take.",
  "action": {
    "table": "reservations | rental_agreements | fleet | ndi_rows | no_shows | damage_claims",
    "operation": "update | insert | delete | confirmPickup | addNote",
    "match": { "fieldName": "value" },
    "data": { "fieldName": "newValue" }
  }
}

Rules:
- "message" is always required. Write in plain conversational English.
- "action" is optional. Only include it when the user is requesting a write operation (create, update, delete, confirmPickup, addNote). For read/lookup requests omit "action" entirely.
- For "match", use the record's primary identifier: resCode for reservations, id for rental_agreements, id for fleet, id for ndi_rows, id for no_shows, id for damage_claims.
- For "data", include only the fields that need to change.
- For "delete" and "confirmPickup" operations, "data" can be omitted.
- Do not include any text, explanation, or formatting outside the JSON object.

Fleet table fields:
- id (primary key, do not modify), plate (e.g. "ABC-123"), make, model, year (number), colour, vin (17 chars), province (e.g. "NL")
- vehicleClass: one of "Compact Car", "Regular Car", "Large Car", "Compact SUV", "Regular SUV", "Large SUV", "Minivan", "Truck"
- status: one of "Available", "Needs Cleaning", "Ready for Pickup", "PM", "Damaged", "On Rent", "Ready Returns"
- "PM" means Preventative Maintenance (the vehicle is due for scheduled service).
- winterTires: "Yes" or "No"
- currentRenter (customer name or null), dueBack (ISO date or null), fileType (string or null)

Fleet operation rules:
- To update a vehicle's status, use operation "update" with match on "id" and data containing the new "status".
- When marking a "Ready Returns" vehicle as collected (changing its status to any other status), also include currentRenter: null, dueBack: null, fileType: null in data.
- To add a vehicle to the fleet, use operation "insert". ALL of these are required and the action is rejected without them: plate, province, year, make, model, colour, tankSizeLiters, pmIntervalKm, vehicleClass, vin. Do not include status or winterTires in data -- those defaults are applied automatically.
- tankSizeLiters is the fuel tank size in LITRES and pmIntervalKm is the service interval in KILOMETRES. If the user gives gallons or miles, convert before sending: 1 gallon = 3.785411784 litres, 1 mile = 1.609344 km. Both must be positive numbers.
- If the user has not given every required field, do NOT emit an insert action. Ask for the missing ones in "message" instead.
- To retire a vehicle from the fleet, use operation "delete" with match on "id", and data containing disposalDate (ISO date) and reason. Both are required: the archive keeps them and the action is rejected without them. Look up the vehicle id from the fleet data using the plate.
- Vehicles flagged needsPm are due for service. Changing such a vehicle to Available, Needs Cleaning or Ready for Pickup is automatically converted to PM, so say so rather than promising the requested status.
- Use the fleet data passed in the user message to find vehicle ids.

Notes:
- Every notes field in this system (notesLog on reservations and on rental_agreements) is an append-only log, not a text field.
- To add a note use operation "addNote" with the table, match on the record's identifier (resCode for reservations, id for rental_agreements), and data containing "text". Example: {"table":"reservations","operation":"addNote","match":{"resCode":"ABC 123 456"},"data":{"text":"Customer called to confirm"}}
- NEVER write notesLog through an "update" operation. That replaces the whole log and erases every earlier note. Use addNote.

Reservations operation rules:
- To create a reservation, use operation "insert". Required: customer, date, time, location, vehicleClass. The resCode is generated automatically, never supply one.
- If any required field is missing, ask for it in "message" rather than emitting the action.

Non-drive intake (ndi_rows) table fields:
- id (primary key, do not modify), rescode, customer, phone, type, rate (read-only, not editable)
- source: one of "Insurance", "AF", "FA", "CCS", "CSTAR", "CCTOP", "CA", "Janes", "Brian's"
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

// ─── Twilio SMS ──────────────────────────────────────────────────────────────
// The client-side sendSMS helper was removed along with the automated texting
// loop. Automated customer texts are now sent server-side by the Cloudflare Cron
// Trigger in worker.js. The Worker's /sms proxy endpoint is still live, so this
// helper can be reinstated if a staff-initiated "send text now" button is ever
// added, but nothing in the app should text customers on a timer any more.

// ─── One-time customer data cleanup ──────────────────────────────────────────
// Runs once per device (gated by localStorage). Wipes all customer records from
// Supabase so the system starts completely empty. Does not touch fleet vehicles.
(async function runOneTimeCleanup() {
  const FLAG = "fleetr_cleanup_v1";
  if (localStorage.getItem(FLAG)) return;
  try {
    // Secondary safety check: if any customer data already exists in Supabase,
    // the app has been used in production. Set the flag and bail out so a
    // localStorage.clear() can never trigger a wipe of real data.
    const [{ count: resCount }, { count: ndiCount }, { count: raCount }] = await Promise.all([
      supabase.from("reservations").select("*", { count: "exact", head: true }),
      supabase.from("ndi_rows").select("*", { count: "exact", head: true }),
      supabase.from("rental_agreements").select("*", { count: "exact", head: true }),
    ]);
    if ((resCount || 0) > 0 || (ndiCount || 0) > 0 || (raCount || 0) > 0) {
      localStorage.setItem(FLAG, "1");
      console.log("Fleetr: cleanup skipped — data already exists in Supabase.");
      return;
    }
    await Promise.all([
      supabase.from("reservations").delete().not("resCode", "is", null),
      supabase.from("rental_agreements").delete().not("id", "is", null),
      supabase.from("ndi_rows").delete().not("id", "is", null),
      supabase.from("tor_rows").delete().not("id", "is", null),
      supabase.from("no_shows").delete().not("id", "is", null),
    ]);
    localStorage.setItem(FLAG, "1");
    console.log("Fleetr: one-time cleanup complete — all customer data removed.");
  } catch (e) {
    console.warn("Fleetr: one-time cleanup error:", e);
  }
})();
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
  // Deletes, and composites that contain one.
  "reservation.delete":   { tier: "pin", label: "Delete reservation" },
  "reservation.noShow":   { tier: "pin", label: "Mark reservation as a no-show" },
  "noShow.confirmPickup": { tier: "pin", label: "Confirm the customer showed up" },
  "vehicle.retire":       { tier: "pin", label: "Retire vehicle" },

  // Money.
  "gas.amount":       { tier: "pin", label: "Change the amount owed" },
  "gas.collected":    { tier: "pin", label: "Change gas payment status" },
  "gas.markup":       { tier: "pin", label: "Change the gas markup" },
  "gas.regionPrice":  { tier: "pin", label: "Change a regional fuel price" },
  "damage.flag":      { tier: "pin", label: "Flag damage" },
  "damage.resolve":   { tier: "pin", label: "Resolve a damage claim" },
  // Tank size is a money input: it is the divisor in every gas charge.
  "vehicle.tankSize": { tier: "pin", label: "Set tank size" },

  // Vehicle status and PM.
  "vehicle.status":     { tier: "pin", label: "Change vehicle status" },
  "vehicle.collected":  { tier: "pin", label: "Mark vehicle collected" },
  "vehicle.pmComplete": { tier: "pin", label: "Record preventative maintenance as complete" },
  "vehicle.pmInterval": { tier: "pin", label: "Set the PM interval" },
  "vehicle.add":        { tier: "pin", label: "Add a vehicle to the fleet" },

  // Rental agreement lifecycle.
  "ra.open":    { tier: "pin", label: "Open a rental agreement" },
  "ra.advance": { tier: "pin", label: "Change rental agreement status" },

  // Reversible, no money or safety weight.
  "reservation.add":  { tier: "confirm", label: "Add reservation" },
  "reservation.edit": { tier: "confirm", label: "Save reservation changes" },
  "note.add":         { tier: "confirm", label: "Add a note" },
  "ndi.edit":         { tier: "confirm", label: "Edit an intake row" },
  "tor.confirmDate":  { tier: "confirm", label: "Confirm the repair date" },
};

const actionTier = (key) => ACTION_POLICY[key]?.tier || "pin"; // unknown defaults to the safer tier
const actionLabel = (key) => ACTION_POLICY[key]?.label || "this action";

// Maps a command bar action onto the same registry, so the AI is gated by
// consequence rather than uniformly. Reads the payload because the tier of a
// reservations update depends on which fields it touches.
const MONEY_FIELDS   = ["gasOwed", "gasCollected", "dailyRate"];
const PIN_RA_FIELDS  = ["rentalAgreementStatus"];
function commandBarActionKey({ table, operation, data }) {
  const fields = Object.keys(data || {});
  const touches = (list) => fields.some((f) => list.includes(f));

  if (operation === "delete") {
    return table === "fleet" ? "vehicle.retire" : "reservation.delete";
  }
  if (operation === "confirmPickup") return "noShow.confirmPickup";
  if (table === "fleet") {
    if (operation === "insert") return "vehicle.add";
    if (fields.includes("tankSizeLiters")) return "vehicle.tankSize";
    if (fields.includes("pmIntervalKm"))   return "vehicle.pmInterval";
    if (fields.includes("needsPm") || fields.includes("lastPmOdometer")) return "vehicle.pmComplete";
    return "vehicle.status";
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
      { label: "Non-Drive's", path: "/arms" },
      { label: "Pre-Rental Check", path: "/pre-rental-check" },
      { label: "Overdue Rentals", path: "/overdue-rentals" },
      { label: "Unknown Repair Date", path: "/time-of-repair" },

      { label: "No Shows", path: "/no-shows" },
    ],
  },
  {
    header: "Branch",
    items: [
      { label: "Reports", path: "/reports" },
      { label: "Settings", path: "/settings" },
    ],
  },
];
const NAV = NAV_SECTIONS.flatMap((section) => section.items);
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
    rentalAgreementId: claim.rentalAgreementId || null,
    _status:           claim.status || "open",
  };
}

// ─── Archived vehicles seed ────────────────────────────────────────────────────

const ARCHIVED_VEHICLES_SEED = [
  { id: "AV-1", plate: "XKR-401", make: "Ford",   model: "Focus", year: 2018, colour: "Silver", province: "NL", vin: "1FADP3F24JL123456", disposalDate: "2025-10-15", reason: "High mileage — decommissioned" },
  { id: "AV-2", plate: "PTN-889", make: "Toyota", model: "Yaris", year: 2017, colour: "White",  province: "NL", vin: "JTDBT923X71234567", disposalDate: "2025-12-01", reason: "Collision write-off" },
];

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

// ─── PIN Confirmation Modal ───────────────────────────────────────────────────
// Reusable modal that gates any write operation behind the signed-in user's PIN.
// Rendered by AppProvider; shown via requirePin(fn) from anywhere in the tree.
function PinConfirmModal({ onConfirm, onCancel }) {
  const [pin,     setPin]     = React.useState("");
  const [error,   setError]   = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [focused, setFocused] = React.useState(true);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!pin) return;
    setLoading(true);
    const ok = await onConfirm(pin);
    setLoading(false);
    if (!ok) { setError(true); setPin(""); }
  };

  return React.createElement(
    "div",
    { className: "resModalBackdrop", onClick: onCancel },
    React.createElement(
      "div",
      { className: "resModal", style: { maxWidth: "340px" }, onClick: (e) => e.stopPropagation() },
      React.createElement(
        "div", { className: "resModalHeader" },
        React.createElement("h2", { className: "resModalTitle" }, "Confirm PIN"),
        React.createElement("button", { type: "button", className: "resModalClose", onClick: onCancel }, "✕")
      ),
      React.createElement(
        "form", { className: "resModalForm", onSubmit: handleSubmit },
        React.createElement(
          "div", { className: "resModalBody" },
          React.createElement("p", { style: { color: "#666", fontSize: "14px", marginBottom: "16px" } },
            "Enter your PIN to confirm this action."
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
              onChange: (e) => { setPin(e.target.value.slice(0, 4)); setError(false); },
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
            "Incorrect PIN. Please try again."
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

  // Call requirePin(fn) to show the PIN gate; fn runs only if PIN matches.
  const requirePin = (fn) => {
    pendingFnRef.current = fn;
    setPinModalOpen(true);
  };

  // The single entry point every write should go through. Looks the action up in
  // ACTION_POLICY and either raises the PIN gate or runs it straight away,
  // because for the "confirm" tier the click that got here IS the confirmation.
  // Callers pass an action key rather than a boolean so the policy stays in one
  // place and cannot drift per call site.
  const guardAction = (actionKey, fn) => {
    if (actionTier(actionKey) === "pin") { requirePin(fn); return; }
    fn();
  };

  // Called by PinConfirmModal on submit — verifies against the PIN stored in session state at login.
  const confirmPin = async (enteredPin) => {
    if (!currentUser) return false;
    if (enteredPin === currentUser.pin) {
      const fn = pendingFnRef.current;
      pendingFnRef.current = null;
      setPinModalOpen(false);
      if (fn) await fn();
      return true;
    }
    return false;
  };

  const dismissPinModal = () => {
    pendingFnRef.current = null;
    setPinModalOpen(false);
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
  async function syncRAStatus(resCode, status) {
    try {
      const existing = raRef.current.find((ra) => ra.resCode === resCode);
      if (existing) {
        if (existing.rentalAgreementStatus === status) return;
        await supabase.from("rental_agreements").update({ rentalAgreementStatus: status }).eq("id", existing.id);
        const updated = raRef.current.map((ra) =>
          ra.resCode === resCode ? { ...ra, rentalAgreementStatus: status } : ra
        );
        raRef.current = updated;
        setRentalAgreementsState(updated);

        // Enforce vehicle status rules driven by RA status
        const plate = existing.plate;
        if (plate) {
          const newFleetStatus =
            status === "open_rental_agreement" ? "On Rent" :
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
        if (plate) {
          const newFleetStatus =
            status === "open_rental_agreement" ? "On Rent" :
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
  const saveSetting = React.useCallback(async (key, value) => {
    setAppSettingsState((prev) => ({ ...prev, [key]: value }));
    const { error } = await supabase
      .from("app_settings")
      .upsert({ key, value, updatedAt: new Date().toISOString() }, { onConflict: "key" });
    if (error) console.warn("app_settings upsert failed:", key, error);
    return !error;
  }, []);

  // ── Initial load from Supabase ───────────────────────────────────────────
  React.useEffect(() => {
    async function load() {
      const [res, ndi, tor, fl, ns, ra, dc, st] = await Promise.all([
        supabase.from("reservations").select("*"),
        supabase.from("ndi_rows").select("*"),
        supabase.from("tor_rows").select("*"),
        supabase.from("fleet").select("*"),
        supabase.from("no_shows").select("*"),
        supabase.from("rental_agreements").select("*"),
        supabase.from("damage_claims").select("*"),
        supabase.from("app_settings").select("*"),
      ]);

      // If a table is empty, seed it with the default data
      async function maybeSeED(table, seed, data) {
        if (!data?.length && seed.length > 0) {
          // Use raw fetch to avoid Supabase JS v1 SDK automatically appending
          // a `columns` query parameter on array inserts, which causes 400 errors
          // when any seed key doesn't exist as a column in the table schema.
          const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
            method: "POST",
            headers: {
              "apikey": SUPABASE_ANON,
              "Authorization": `Bearer ${SUPABASE_ANON}`,
              "Content-Type": "application/json",
              "Prefer": "return=representation",
            },
            body: JSON.stringify(seed),
          });
          const inserted = resp.ok ? await resp.json() : null;
          return inserted || seed;
        }
        return data || [];
      }

      let [resData, ndiData, torData, flData, nsData, raData] = await Promise.all([
        // Pass an empty seed so maybeSeED never inserts fake data — reservations
        // must come from Supabase only. If the table is empty, start with [].
        maybeSeED("reservations",      [],             res.data),
        Promise.resolve(ndi.data || []),
        Promise.resolve(tor.data || []),
        Promise.resolve(fl.data || []),
        Promise.resolve(ns.data || []),
        maybeSeED("rental_agreements", [],             ra.data),
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
            headers: {
              "apikey": SUPABASE_ANON,
              "Authorization": `Bearer ${SUPABASE_ANON}`,
              "Content-Type": "application/json",
              "Prefer": "return=minimal",
            },
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
      setAppSettingsState({});
      setDbReady(true);
    });
  }, []);

  // ── Real-time subscriptions ───────────────────────────────────────────────
  // Subscribe once after the initial load; each handler re-fetches only the
  // affected table and updates the relevant slice of state.
  React.useEffect(() => {
    if (!dbReady) return;

    const refetchReservations = async () => {
      const { data } = await supabase.from("reservations").select("*");
      if (!data) return;
      const raByResCode = Object.fromEntries(raRef.current.map((a) => [a.resCode, a]));
      setReservationsState(
        data.map((r) => {
          const ra = raByResCode[r.resCode];
          return ra ? { ...r, rentalAgreementStatus: ra.rentalAgreementStatus } : r;
        })
      );
    };

    const refetchRentalAgreements = async () => {
      const { data } = await supabase.from("rental_agreements").select("*");
      if (!data) return;
      raRef.current = data;
      setRentalAgreementsState(data);
      // Re-merge rentalAgreementStatus into the current reservations slice.
      setReservationsState((prev) => {
        const raByResCode = Object.fromEntries(data.map((a) => [a.resCode, a]));
        return prev.map((r) => {
          const ra = raByResCode[r.resCode];
          return ra ? { ...r, rentalAgreementStatus: ra.rentalAgreementStatus } : r;
        });
      });
    };

    const refetchFleet = async () => {
      const { data } = await supabase.from("fleet").select("*");
      if (data) setFleetState(data);
    };

    const refetchNdiRows = async () => {
      const { data } = await supabase.from("ndi_rows").select("*");
      if (data) setNdiRowsState(data);
    };

    const refetchTorRows = async () => {
      const { data } = await supabase.from("tor_rows").select("*");
      if (data) setTorRowsState(data);
    };

    const refetchNoShows = async () => {
      const { data } = await supabase.from("no_shows").select("*");
      if (data) setNoShowsState(data);
    };

    const refetchDamageClaims = async () => {
      const { data } = await supabase.from("damage_claims").select("*");
      if (data) setDamageClaimsState(data);
    };

    const refetchAppSettings = async () => {
      const { data } = await supabase.from("app_settings").select("*");
      if (data) setAppSettingsState(Object.fromEntries(data.map((r) => [r.key, r.value])));
    };

    const subs = [
      supabase.from("reservations").on("*", refetchReservations).subscribe(),
      supabase.from("rental_agreements").on("*", refetchRentalAgreements).subscribe(),
      supabase.from("fleet").on("*", refetchFleet).subscribe(),
      supabase.from("ndi_rows").on("*", refetchNdiRows).subscribe(),
      supabase.from("tor_rows").on("*", refetchTorRows).subscribe(),
      supabase.from("no_shows").on("*", refetchNoShows).subscribe(),
      supabase.from("damage_claims").on("*", refetchDamageClaims).subscribe(),
      supabase.from("app_settings").on("*", refetchAppSettings).subscribe(),
    ];

    return () => subs.forEach((s) => s.unsubscribe());
  }, [dbReady]); // eslint-disable-line react-hooks/exhaustive-deps

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
    { value: { reservations, setReservations, rentalAgreements, setRentalAgreements, syncRAStatus, ndiRows, setNdiRows, torRows, setTorRows, openNotesId, setOpenNotesId, fleet, setFleet, noShows, setNoShows, openRentalAgreementId, setOpenRentalAgreementId, openCustomer, setOpenCustomer, openVehiclePlate, setOpenVehiclePlate, damageClaims, setDamageClaims, readyReturns, setReadyReturns, appSettings, saveSetting, requirePin, guardAction, currentUser, signOut } },
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
    React.createElement("span", { className: statusClass }, preRentalCheck),

    // ── dash + notes preview button ───────────────────────────────────────
    hasNotes && React.createElement("span", { className: "notesDash" }, " \u2014 "),
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
  ratesVehicleClass: "", ratesVehicleSize: "",
  dailyRate: "", adjusterName: "", claimNumber: "",
  fileNumber: "", authNumber: "", poNumber: "",
  paymentMethod: "Credit Card",
};

// ─── Status label helper ──────────────────────────────────────────────────────

function statusLabel(s) {
  if (s === "open_rental_agreement") return "Open";
  if (s === "close_pending")         return "Close Pending";
  if (s === "closed")                return "Closed";
  if (s === "reservation")           return "Reservation";
  return s || "";
}

// ─── CustomerLink ─────────────────────────────────────────────────────────────

function CustomerLink({ name, resCode, label, hideBadge }) {
  const { setOpenCustomer, reservations } = React.useContext(AppContext);
  const navigate = useNavigate();
  const res = reservations.find((r) => r.resCode === resCode);
  const raStatus = res?.rentalAgreementStatus;
  const showBadge = !hideBadge && label === undefined && raStatus && raStatus !== "reservation";
  const badgeClass =
    raStatus === "open_rental_agreement" ? "rentalAgreementBadge rentalAgreementBadge--open"
    : raStatus === "close_pending"       ? "rentalAgreementBadge rentalAgreementBadge--pending"
    : raStatus === "closed"              ? "rentalAgreementBadge rentalAgreementBadge--closed"
    : null;
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
    showBadge && badgeClass &&
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

async function generateUniqueResCode() {
  const L    = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const rand3L = () => Array.from({ length: 3 }, () => L[Math.floor(Math.random() * 26)]).join("");
  const rand3D = () => String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  for (let i = 0; i < 30; i++) {
    const code = `${rand3L()} ${rand3D()} ${rand3D()}`;
    try {
      const [r1, r2, r3] = await Promise.all([
        supabase.from("reservations").select("*").eq("resCode", code).limit(1),
        supabase.from("ndi_rows").select("rescode").eq("rescode", code),
        supabase.from("no_shows").select("resCode").eq("resCode", code),
      ]);
      const exists = [r1, r2, r3].some((r) => r.data && r.data.length > 0);
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
  const [form, setForm] = React.useState(EMPTY_RES_FORM);
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
      ratesVehicleClass: form.ratesVehicleClass && form.ratesVehicleSize
        ? `${form.ratesVehicleClass} — ${form.ratesVehicleSize}`
        : form.ratesVehicleClass || "",
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
    try {
      const insertRes = await supabase.from("reservations").insert(newRow);
      console.log("reservations insert response:", insertRes);
    } catch (err) {
      console.warn("Reservation Supabase write error:", err);
    }
    setReservations((prev) => {
      const next = [...prev, newRow];
      next.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time);
      });
      return next;
    });
    setForm(EMPTY_RES_FORM);
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
                          supabase.from("reservations").update({ notesLog: newLog }).eq("resCode", row.resCode).catch((e) => console.warn("notes sync:", e));
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
                  LOCATION_OPTIONS.map((l) => React.createElement("option", { key: l, value: l }, l))
                )
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Vehicle Class"),
                React.createElement("select", { className: "resFormInput", value: form.vehicleClass, onChange: (e) => updateForm("vehicleClass", e.target.value) },
                  RES_VEHICLE_CLASSES.map((c) => React.createElement("option", { key: c, value: c }, c))
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
                React.createElement("select", { className: "resFormInput", value: form.source, onChange: (e) => setForm((p) => ({ ...p, source: e.target.value, sourceDetail: "" })) },
                  React.createElement("option", { value: "" }, "Select source"),
                  Object.keys(RATES_SOURCE_CATS).map((cat) => React.createElement("option", { key: cat, value: cat }, cat))
                )
              ),
              form.source && RATES_SOURCE_CATS[form.source] && React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Specific Source"),
                React.createElement("select", { className: "resFormInput", value: form.sourceDetail, onChange: (e) => updateForm("sourceDetail", e.target.value) },
                  React.createElement("option", { value: "" }, "Select…"),
                  RATES_SOURCE_CATS[form.source].map((s) => React.createElement("option", { key: s, value: s }, s))
                )
              )
            ),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Rates Vehicle Class"),
                React.createElement("select", { className: "resFormInput", value: form.ratesVehicleClass, onChange: (e) => setForm((p) => ({ ...p, ratesVehicleClass: e.target.value, ratesVehicleSize: "" })) },
                  React.createElement("option", { value: "" }, "Select class"),
                  Object.keys(RATES_VCLASS_CATS).map((cat) => React.createElement("option", { key: cat, value: cat }, cat))
                )
              ),
              form.ratesVehicleClass && RATES_VCLASS_CATS[form.ratesVehicleClass] && React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Size"),
                React.createElement("select", { className: "resFormInput", value: form.ratesVehicleSize, onChange: (e) => updateForm("ratesVehicleSize", e.target.value) },
                  React.createElement("option", { value: "" }, "Select…"),
                  RATES_VCLASS_CATS[form.ratesVehicleClass].map((s) => React.createElement("option", { key: s, value: s }, s))
                )
              ),
              tf("Daily Rate ($)", "dailyRate", "0.00")
            ),
            ...(() => {
              if (form.source === "Insurance") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("Adjuster Name", "adjusterName", "Adjuster name"), tf("Claim Number", "claimNumber", "Claim #")),
                React.createElement("div", { className: "resFormRow", key: "rb2" }, tf("File Number", "fileNumber", "File #"), tf("Authorization Number", "authNumber", "Auth #")),
              ];
              if (form.source === "Bodyshop") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("Claim Number", "claimNumber", "Claim #"), tf("Authorization Number", "authNumber", "Auth #")),
              ];
              if (form.source === "Corporate") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("PO Number", "poNumber", "PO #")),
              ];
              if (form.source === "Retail") return [
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
      supabase.from("ndi_rows").update({ [field]: value }).eq("id", id).catch((e) => console.warn("ndi_rows update:", e));
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
      location: "CCS",
      resCode: target.rescode,
      customer: target.customer,
      vehicleClass: "Regular SUV",
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
      supabase.from("reservations").insert(newRes).then((res) => console.log("reservations insert response:", res)).catch((e) => console.warn("reservations insert:", e));
      setNdiRows((prev) => prev.filter((row) => row.id !== id));
      supabase.from("ndi_rows").delete().eq("id", id).catch((e) => console.warn("ndi_rows delete:", e));
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
                    NDI_SOURCE_OPTIONS.map((opt) =>
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
  const readyReturns = fleet.filter((v) => v.status === "Ready Returns");
  const navigate = useNavigate();
  const [collectedOpenId, setCollectedOpenId] = React.useState(null);
  const handleCollected = (entry, status) => {
    // Advancing a vehicle out of Ready Returns is the point where a pending PM
    // takes over: the requested status is replaced with PM so it cannot be
    // handed out unserviced.
    const vehicle = fleet.find((fv) => fv.plate === entry.plate) || entry;
    const { status: finalStatus, forced, message } = resolvePmStatus(vehicle, status);
    guardAction("vehicle.collected", () => {
      setFleet((prev) => prev.map((fv) =>
        fv.plate === entry.plate ? { ...fv, status: finalStatus, currentRenter: null, dueBack: null, fileType: null } : fv
      ));
      supabase.from("fleet").update({ status: finalStatus, currentRenter: null, dueBack: null, fileType: null }).eq("id", entry.id).catch((e) => console.warn("fleet update:", e));
      setCollectedOpenId(null);
      if (forced) window.alert(message);
    });
  };
  const [now, setNow] = React.useState(Date.now());
  const [openReadyFleetMenuId, setOpenReadyFleetMenuId] = React.useState(null);
  const [readyFleetAnchor, setReadyFleetAnchor] = React.useState({ x: 0, y: 0 });
  const [readyFleetHoverBrand, setReadyFleetHoverBrand] = React.useState(null);
  const [collapsedSections, setCollapsedSections] = React.useState({
    reservations: true,
    readyForRental: true,
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
  const [form, setForm] = React.useState(EMPTY_RES_FORM);
  const updateForm = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));
  const [readyForRentalRows, setReadyForRentalRows] = React.useState([
    {
      id: "RFR-1",
      customerName: "Olivia Bennett",
      reservedClass: "Compact SUV",
      pickupLocation: "Memorial University Residence",
      pickupAddress: "230 Elizabeth Ave, St. John's, NL",
      fleetBrand: "",
      fleetModel: "",
      driveMinutes: null,
      status: "Waiting",
      addedAtMs: Date.now() - 12 * 60000,
      frozenWaitMins: null,
      pickupStartedAtMs: null,
      addedOrder: 1,
    },
    {
      id: "RFR-2",
      customerName: "Liam Walsh",
      reservedClass: "Compact Car",
      pickupLocation: "St. Clare's Mercy Hospital",
      pickupAddress: "154 LeMarchant Rd, St. John's, NL",
      fleetBrand: "",
      fleetModel: "",
      driveMinutes: null,
      status: "Waiting",
      addedAtMs: Date.now() - 4 * 60000,
      frozenWaitMins: null,
      pickupStartedAtMs: null,
      addedOrder: 2,
    },
  ]);

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    setReadyForRentalRows((prev) =>
      prev.filter((row) => {
        if (row.status !== "Pickup in progress") return true;
        if (typeof row.pickupStartedAtMs !== "number") return true;
        if (typeof row.driveMinutes !== "number") return true;
        return now - row.pickupStartedAtMs < row.driveMinutes * 60000;
      })
    );
  }, [now]);

  React.useEffect(() => {
    const estimateFallback = {
      "230 Elizabeth Ave, St. John's, NL": 18,
      "154 LeMarchant Rd, St. John's, NL": 22,
    };

    const fetchGoogleDriveTime = async (destinationAddress) => {
      const apiKey = window.GOOGLE_MAPS_API_KEY || "";
      if (!apiKey) return null;
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent("Mount Pearl, NL")}&destinations=${encodeURIComponent(destinationAddress)}&mode=driving&key=${encodeURIComponent(apiKey)}`;
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const payload = await response.json();
        const seconds = payload?.rows?.[0]?.elements?.[0]?.duration?.value;
        if (typeof seconds !== "number") return null;
        return Math.max(1, Math.round(seconds / 60));
      } catch (error) {
        return null;
      }
    };

    readyForRentalRows.forEach(async (row) => {
      if (typeof row.driveMinutes === "number") return;
      const googleMins = await fetchGoogleDriveTime(row.pickupAddress);
      const fallbackMins = estimateFallback[row.pickupAddress] || 20;
      const minutes = googleMins || fallbackMins;
      setReadyForRentalRows((prev) =>
        prev.map((candidate) =>
          candidate.id === row.id ? { ...candidate, driveMinutes: minutes } : candidate
        )
      );
    });
  }, [readyForRentalRows]);

  const getReadyWaitMins = (row) => {
    if (row.status === "Pickup in progress" && typeof row.frozenWaitMins === "number") {
      return row.frozenWaitMins;
    }
    return Math.max(0, Math.floor((now - row.addedAtMs) / 60000));
  };

  const handleReadyFleetModelSelect = (id, brand, model) => {
    setReadyForRentalRows((prev) =>
      prev.map((row) =>
        row.id === id ? { ...row, fleetBrand: brand, fleetModel: model } : row
      )
    );
    setOpenReadyFleetMenuId(null);
    setReadyFleetHoverBrand(null);
  };

  const toggleSection = (sectionKey) => {
    setCollapsedSections((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }));
  };

  const openReadyFleetMenuForRow = (rowId, event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setReadyFleetAnchor({ x: rect.left, y: rect.bottom + 4 });
    setOpenReadyFleetMenuId((prev) => (prev === rowId ? null : rowId));
    setReadyFleetHoverBrand(null);
  };

  const handleReadyStatusChange = (id, status) => {
    setReadyForRentalRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        if (status === "Pickup in progress") {
          return {
            ...row,
            status,
            frozenWaitMins:
              typeof row.frozenWaitMins === "number"
                ? row.frozenWaitMins
                : Math.max(0, Math.floor((Date.now() - row.addedAtMs) / 60000)),
            pickupStartedAtMs: row.pickupStartedAtMs || Date.now(),
          };
        }
        return { ...row, status, frozenWaitMins: null, pickupStartedAtMs: null };
      })
    );
  };

  const triggerReadyText = (row) => {
    const vehicleLabel =
      row.fleetBrand && row.fleetModel
        ? `${row.fleetBrand} ${row.fleetModel}`
        : row.reservedClass;
    const minsLabel =
      typeof row.driveMinutes === "number" ? `${row.driveMinutes} mins` : "approximately 20 mins";
    const message = `Hi ${row.customerName}, Enterprise is on the way to ${row.pickupLocation} in a ${vehicleLabel} and should be approximately ${minsLabel}.`;
    window.open(`sms:?&body=${encodeURIComponent(message)}`);
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
      ratesVehicleClass: form.ratesVehicleClass && form.ratesVehicleSize
        ? `${form.ratesVehicleClass} — ${form.ratesVehicleSize}`
        : form.ratesVehicleClass || "",
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
    try {
      const insertRes = await supabase.from("reservations").insert(newRow);
      console.log("reservations insert response:", insertRes);
    } catch (err) {
      console.warn("Reservation Supabase write error:", err);
    }
    setReservations((prev) => {
      const next = [...prev, newRow];
      next.sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time);
      });
      return next;
    });
    setForm(EMPTY_RES_FORM);
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
                              supabase.from("reservations").update({ notesLog: newLog }).eq("resCode", row.resCode).catch((e) => console.warn("notes sync:", e));
                            },
                          })
                        )
                      )
                    )
                  )
                )
          )
      ),
      // ── Section 2: Ready for Pickup ───────────────────────────────────────
      React.createElement(
        "section",
        { key: "readyForRental", className: "dashboardSection" },
        React.createElement(
          "div",
          { className: "dashboardSection__header" },
          React.createElement(
            "div",
            { className: "dashboardSection__headerRow" },
            React.createElement("span", null, "Ready for Pickup"),
            React.createElement(
              "button",
              {
                type: "button",
                className: "sectionToggleCircle",
                onClick: () => toggleSection("readyForRental"),
              },
              collapsedSections.readyForRental ? "+" : "-"
            )
          )
        ),
        !collapsedSections.readyForRental &&
          React.createElement(
            "div",
            { className: "dashboardSection__body" },
            isMobile
              ? readyForRentalRows
                  .slice()
                  .sort((a, b) => a.addedOrder - b.addedOrder)
                  .map((row) =>
                    React.createElement("div", { key: row.id, className: "dashCard" },
                      React.createElement("div", { className: "dashCard__header" },
                        React.createElement(CustomerLink, { name: row.customerName, resCode: row.id, label: row.customerName })
                      ),
                      React.createElement("div", { className: "dashCard__meta" },
                        React.createElement("span", { className: "dashCard__chip" }, row.reservedClass),
                        React.createElement("span", { className: "dashCard__chip dashCard__chip--loc" }, row.pickupLocation)
                      ),
                      React.createElement("div", { className: "dashCard__meta" },
                        React.createElement(
                          "select",
                          {
                            className: "aiControl readyControl readyControl--status",
                            value: row.status,
                            onChange: (e) => handleReadyStatusChange(row.id, e.target.value),
                            style: { fontSize: "12px" },
                          },
                          React.createElement("option", { value: "Waiting" }, "Waiting"),
                          React.createElement("option", { value: "Pickup in progress" }, "Pickup in progress")
                        ),
                        React.createElement("span", { className: "dashCard__chip" }, `${getReadyWaitMins(row)} mins`)
                      )
                    )
                  )
              : React.createElement(
                  "table",
                  { className: "dashboardTable" },
              React.createElement(
                "thead",
                null,
                React.createElement("tr", null, [
                  "Customer name",
                  "Vehicle they're getting",
                  "Pickup location / where to serve them",
                  "Fleet Vehicle",
                  "Time to Location",
                  "Status",
                  "Waiting timer",
                ].map((col) => React.createElement("th", { key: col }, col)))
              ),
              React.createElement(
                "tbody",
                null,
                readyForRentalRows
                  .slice()
                  .sort((a, b) => a.addedOrder - b.addedOrder)
                  .map((row) =>
                    React.createElement("tr", { key: row.id }, [
                      React.createElement("td", { key: `${row.id}-name` }, React.createElement(CustomerLink, { name: row.customerName, resCode: row.id, label: row.customerName })),
                      React.createElement("td", { key: `${row.id}-class` }, row.reservedClass),
                      React.createElement("td", { key: `${row.id}-loc` }, row.pickupLocation),
                      React.createElement(
                        "td",
                        { key: `${row.id}-fleet` },
                        React.createElement(
                          "div",
                          { className: "readyFleetPicker" },
                          React.createElement(
                            "button",
                            {
                              type: "button",
                              className: "aiControl readyFleetTrigger",
                              onClick: (event) => openReadyFleetMenuForRow(row.id, event),
                            },
                            row.fleetBrand && row.fleetModel
                              ? `${row.fleetBrand} ${row.fleetModel}`
                              : "Select vehicle"
                          ),
                          openReadyFleetMenuId === row.id &&
                            React.createElement(
                              "div",
                              {
                                className: "readyFleetMenusWrap",
                                style: {
                                  left: `${readyFleetAnchor.x}px`,
                                  top: `${readyFleetAnchor.y}px`,
                                },
                                onMouseLeave: () => {
                                  setOpenReadyFleetMenuId(null);
                                  setReadyFleetHoverBrand(null);
                                },
                              },
                              React.createElement(
                                "div",
                                { className: "readyFleetMenu readyFleetMenu--fixed" },
                                FLEET_BRANDS.map((brand) =>
                                  React.createElement(
                                    "div",
                                    {
                                      key: `${row.id}-${brand}`,
                                      className: "readyFleetBrandItem",
                                      onMouseEnter: () => setReadyFleetHoverBrand(brand),
                                    },
                                    React.createElement(
                                      "span",
                                      { className: "readyFleetBrandLabel" },
                                      brand
                                    )
                                  )
                                )
                              ),
                              readyFleetHoverBrand &&
                                React.createElement(
                                  "div",
                                  { className: "readyFleetMenu readyFleetMenu--fixed" },
                                  FLEET_MODELS_BY_BRAND[readyFleetHoverBrand].map((model) =>
                                    React.createElement(
                                      "button",
                                      {
                                        type: "button",
                                        key: `${row.id}-${readyFleetHoverBrand}-${model}`,
                                        className: "readyFleetModelItem",
                                        onClick: () =>
                                          handleReadyFleetModelSelect(
                                            row.id,
                                            readyFleetHoverBrand,
                                            model
                                          ),
                                      },
                                      model
                                    )
                                  )
                                )
                            )
                        )
                      ),
                      React.createElement(
                        "td",
                        { key: `${row.id}-mins` },
                        typeof row.driveMinutes === "number"
                          ? `${row.driveMinutes} mins`
                          : "Calculating..."
                      ),
                      React.createElement(
                        "td",
                        { key: `${row.id}-status` },
                        React.createElement(
                          "div",
                          { className: "readyStatusWrap" },
                          React.createElement(
                            "select",
                            {
                              className: "aiControl readyControl readyControl--status",
                              value: row.status,
                              onChange: (event) =>
                                handleReadyStatusChange(row.id, event.target.value),
                            },
                            [
                              React.createElement(
                                "option",
                                { key: `${row.id}-waiting`, value: "Waiting" },
                                "Waiting"
                              ),
                              React.createElement(
                                "option",
                                { key: `${row.id}-progress`, value: "Pickup in progress" },
                                "Pickup in progress"
                              ),
                            ]
                          ),
                          row.status === "Pickup in progress" &&
                            React.createElement(
                              "button",
                              {
                                type: "button",
                                className: "aiCallButton",
                                onClick: () => triggerReadyText(row),
                              },
                              "Text"
                            )
                        )
                      ),
                      React.createElement(
                        "td",
                        { key: `${row.id}-wait` },
                        `${getReadyWaitMins(row)} mins`
                      ),
                    ])
                  )
              )
            )
          )
      ),
      // ── Section 3: Non-Drive Intake ──────────────────────────────────
      React.createElement(NonDriveIntakeSection, { key: "nonDriveIntake", standalone: false }),
      // ── Section 4: Vehicle Status ────────────────────────────────
      React.createElement(
        "section",
        { key: "fleetAvailability", className: "dashboardSection" },
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
                onClick: () => toggleSection("fleetAvailability"),
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
                // Ready Returns — two sub-sections: returned & ready + projected
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
                          ["Plate", "Vehicle", "Type", "Location", ""].map((col) =>
                            React.createElement("th", { key: col }, col)
                          )
                        )
                      ),
                      React.createElement("tbody", null,
                        readyReturns.length === 0
                          ? React.createElement("tr", null, React.createElement("td", { colSpan: 5, style: { color: "#aaa", fontStyle: "italic" } }, "None"))
                          : readyReturns.map((r) => {
                              const matchRA = (rentalAgreements || []).find((a) => a.plate === r.plate && a.rentalAgreementStatus === "close_pending");
                              const loc = matchRA?.returnVehicleLocation || "";
                              return React.createElement("tr", { key: r.id },
                                React.createElement("td", null, React.createElement(PlateLink, { plate: r.plate })),
                                React.createElement("td", null, `${r.make} ${r.model}`),
                                React.createElement("td", null, r.fileType || ""),
                                React.createElement("td", null, loc),
                                React.createElement("td", null,
                                  collectedOpenId === r.id
                                    ? React.createElement("select", {
                                        className: "gasStatusSelect",
                                        autoFocus: true,
                                        defaultValue: "",
                                        onChange: (e) => { if (e.target.value) handleCollected(r, e.target.value); },
                                        onBlur: () => setCollectedOpenId(null),
                                      },
                                        React.createElement("option", { value: "", disabled: true }, "Select status…"),
                                        FLEET_STATUS_OPTS.filter((s) => s.value !== "All").map((s) =>
                                          React.createElement("option", { key: s.value, value: s.value }, s.label)
                                        )
                                      )
                                    : React.createElement("button", {
                                        type: "button",
                                        className: "collectedBtn",
                                        onClick: () => setCollectedOpenId(r.id),
                                      }, "Collected")
                                )
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
                  LOCATION_OPTIONS.map((l) => React.createElement("option", { key: l, value: l }, l))
                )
              ),
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Vehicle Class"),
                React.createElement("select", { className: "resFormInput", value: form.vehicleClass, onChange: (e) => updateForm("vehicleClass", e.target.value) },
                  RES_VEHICLE_CLASSES.map((c) => React.createElement("option", { key: c, value: c }, c))
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
                React.createElement("select", { className: "resFormInput", value: form.source, onChange: (e) => setForm((p) => ({ ...p, source: e.target.value, sourceDetail: "" })) },
                  React.createElement("option", { value: "" }, "Select source"),
                  Object.keys(RATES_SOURCE_CATS).map((cat) => React.createElement("option", { key: cat, value: cat }, cat))
                )
              ),
              form.source && RATES_SOURCE_CATS[form.source] && React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Specific Source"),
                React.createElement("select", { className: "resFormInput", value: form.sourceDetail, onChange: (e) => updateForm("sourceDetail", e.target.value) },
                  React.createElement("option", { value: "" }, "Select…"),
                  RATES_SOURCE_CATS[form.source].map((s) => React.createElement("option", { key: s, value: s }, s))
                )
              )
            ),
            React.createElement("div", { className: "resFormRow" },
              React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Rates Vehicle Class"),
                React.createElement("select", { className: "resFormInput", value: form.ratesVehicleClass, onChange: (e) => setForm((p) => ({ ...p, ratesVehicleClass: e.target.value, ratesVehicleSize: "" })) },
                  React.createElement("option", { value: "" }, "Select class"),
                  Object.keys(RATES_VCLASS_CATS).map((cat) => React.createElement("option", { key: cat, value: cat }, cat))
                )
              ),
              form.ratesVehicleClass && RATES_VCLASS_CATS[form.ratesVehicleClass] && React.createElement("label", { className: "resFormGroup" },
                React.createElement("span", { className: "resFormLabel" }, "Size"),
                React.createElement("select", { className: "resFormInput", value: form.ratesVehicleSize, onChange: (e) => updateForm("ratesVehicleSize", e.target.value) },
                  React.createElement("option", { value: "" }, "Select…"),
                  RATES_VCLASS_CATS[form.ratesVehicleClass].map((s) => React.createElement("option", { key: s, value: s }, s))
                )
              ),
              tf("Daily Rate ($)", "dailyRate", "0.00")
            ),
            ...(() => {
              if (form.source === "Insurance") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("Adjuster Name", "adjusterName", "Adjuster name"), tf("Claim Number", "claimNumber", "Claim #")),
                React.createElement("div", { className: "resFormRow", key: "rb2" }, tf("File Number", "fileNumber", "File #"), tf("Authorization Number", "authNumber", "Auth #")),
              ];
              if (form.source === "Bodyshop") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("Claim Number", "claimNumber", "Claim #"), tf("Authorization Number", "authNumber", "Auth #")),
              ];
              if (form.source === "Corporate") return [
                React.createElement("div", { className: "resFormRow", key: "rb1" }, tf("PO Number", "poNumber", "PO #")),
              ];
              if (form.source === "Retail") return [
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
      supabase.from("reservations").insert(newRes).then((res) => console.log("reservations insert response:", res)).catch((e) => console.warn("reservations insert:", e));
      setNoShows((prev) => prev.filter((r) => r.id !== row.id));
      supabase.from("no_shows").delete().eq("id", row.id).catch((e) => console.warn("no_shows delete:", e));
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
  const { openVehiclePlate, fleet, setFleet, reservations, rentalAgreements, setOpenRentalAgreementId, damageClaims, requirePin } = React.useContext(AppContext);
  const navigate = useNavigate();

  const plate   = openVehiclePlate || "";
  const vehicle = fleet.find((v) => v.plate === plate) || {};
  const extra   = VEHICLE_EXTRA_DATA[plate] || {};

  // Active RA for this plate (open rental) \u2014 used for currentRenter, resCode, returnDate
  const activeRa = plate
    ? rentalAgreements.find((ra) => ra.plate === plate && ra.rentalAgreementStatus === "open_rental_agreement") || null
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
  const [tankUnit, setTankUnit] = React.useState("L");
  const [pmUnit,   setPmUnit]   = React.useState("km");
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
    if (trimmed !== "" && (parsed == null || parsed <= 0)) {
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
    const odo = vehicle.currentOdometer;
    if (odo == null) {
      window.alert("No odometer reading on file for this vehicle yet, so PM cannot be recorded. The odometer is captured when a rental is returned.");
      return;
    }
    requirePin(() => {
      // Clearing the flag is what actually releases the vehicle. Status is only
      // reset when PM had already taken it over; if it is still sitting in
      // Ready Returns, that state is left for staff to finish normally.
      const patch = { lastPmOdometer: odo, needsPm: false };
      if (vehicle.status === "PM") patch.status = "Available";
      setFleet((prev) => prev.map((v) => v.plate === plate ? { ...v, ...patch } : v));
      supabase.from("fleet").update(patch).eq("id", vehicle.id)
        .then(({ error }) => { if (error) console.warn("fleet PM complete failed:", error); })
        .catch((err) => console.warn("fleet PM complete:", err));
    });
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
          ? `${Number(latestRa.mileage).toLocaleString()} km`
          : extra.odometer != null ? `${extra.odometer.toLocaleString()} km` : "\u2014"),
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
                    supabase.from("fleet").update({ status: newStatus }).eq("id", vehicle.id).catch((err) => console.warn("fleet update:", err));
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
            ["Customer", "Res Code", "Damage Description", "Status", "Rental Agreement"].map((col) =>
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
              React.createElement("td", null, c.rentalAgreementId || "\u2014")
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
  const [collectedOpenId, setCollectedOpenId] = React.useState(null);
  const handleCollected = (entry, status) => {
    // Advancing a vehicle out of Ready Returns is the point where a pending PM
    // takes over: the requested status is replaced with PM so it cannot be
    // handed out unserviced.
    const vehicle = fleet.find((fv) => fv.plate === entry.plate) || entry;
    const { status: finalStatus, forced, message } = resolvePmStatus(vehicle, status);
    guardAction("vehicle.collected", () => {
      setFleet((prev) => prev.map((fv) =>
        fv.plate === entry.plate ? { ...fv, status: finalStatus, currentRenter: null, dueBack: null, fileType: null } : fv
      ));
      supabase.from("fleet").update({ status: finalStatus, currentRenter: null, dueBack: null, fileType: null }).eq("id", entry.id).catch((e) => console.warn("fleet update:", e));
      setCollectedOpenId(null);
      if (forced) window.alert(message);
    });
  };
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
                        ["Plate", "Vehicle", "Type", "Location", ""].map((col) =>
                          React.createElement("th", { key: col }, col)
                        )
                      )
                    ),
                    React.createElement("tbody", null,
                      readyReturns.length === 0
                        ? React.createElement("tr", null, React.createElement("td", { colSpan: 5, style: { color: "#aaa", fontStyle: "italic" } }, "None"))
                        : readyReturns.map((r) => {
                            const matchRA = (rentalAgreements || []).find((a) => a.plate === r.plate && a.rentalAgreementStatus === "close_pending");
                            const loc = matchRA?.returnVehicleLocation || "";
                            return React.createElement("tr", { key: r.id },
                              React.createElement("td", null, React.createElement(PlateLink, { plate: r.plate })),
                              React.createElement("td", null, `${r.make} ${r.model}`),
                              React.createElement("td", null, r.fileType || ""),
                              React.createElement("td", null, loc),
                              React.createElement("td", null,
                                collectedOpenId === r.id
                                  ? React.createElement("select", {
                                      className: "gasStatusSelect",
                                      autoFocus: true,
                                      defaultValue: "",
                                      onChange: (e) => { if (e.target.value) handleCollected(r, e.target.value); },
                                      onBlur: () => setCollectedOpenId(null),
                                    },
                                      React.createElement("option", { value: "", disabled: true }, "Select status…"),
                                      FLEET_STATUS_OPTS.filter((s) => s.value !== "All").map((s) =>
                                        React.createElement("option", { key: s.value, value: s.value }, s.label)
                                      )
                                    )
                                  : React.createElement("button", {
                                      type: "button",
                                      className: "collectedBtn",
                                      onClick: () => setCollectedOpenId(r.id),
                                    }, "Collected")
                              )
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
      (r.source === "Bodyshop/Dealership" || r.source === "Insurance") &&
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
    supabase.from("reservations").update({ returnDate: date, repairDateConfirmed: true }).eq("resCode", resCode).catch((e) => console.warn("reservations update:", e));
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
  { value: "NL", label: "NL — Newfoundland and Labrador" },
  { value: "NS", label: "NS — Nova Scotia" },
  { value: "NB", label: "NB — New Brunswick" },
  { value: "PE", label: "PE — Prince Edward Island" },
  { value: "QC", label: "QC — Quebec" },
  { value: "ON", label: "ON — Ontario" },
  { value: "MB", label: "MB — Manitoba" },
  { value: "SK", label: "SK — Saskatchewan" },
  { value: "AB", label: "AB — Alberta" },
  { value: "BC", label: "BC — British Columbia" },
  { value: "YT", label: "YT — Yukon" },
  { value: "NT", label: "NT — Northwest Territories" },
  { value: "NU", label: "NU — Nunavut" },
  // US states
  { value: "AK", label: "AK — Alaska" },
  { value: "AL", label: "AL — Alabama" },
  { value: "AR", label: "AR — Arkansas" },
  { value: "AZ", label: "AZ — Arizona" },
  { value: "CA", label: "CA — California" },
  { value: "CO", label: "CO — Colorado" },
  { value: "CT", label: "CT — Connecticut" },
  { value: "DC", label: "DC — Washington D.C." },
  { value: "DE", label: "DE — Delaware" },
  { value: "FL", label: "FL — Florida" },
  { value: "GA", label: "GA — Georgia" },
  { value: "HI", label: "HI — Hawaii" },
  { value: "IA", label: "IA — Iowa" },
  { value: "ID", label: "ID — Idaho" },
  { value: "IL", label: "IL — Illinois" },
  { value: "IN", label: "IN — Indiana" },
  { value: "KS", label: "KS — Kansas" },
  { value: "KY", label: "KY — Kentucky" },
  { value: "LA", label: "LA — Louisiana" },
  { value: "MA", label: "MA — Massachusetts" },
  { value: "MD", label: "MD — Maryland" },
  { value: "ME", label: "ME — Maine" },
  { value: "MI", label: "MI — Michigan" },
  { value: "MN", label: "MN — Minnesota" },
  { value: "MO", label: "MO — Missouri" },
  { value: "MS", label: "MS — Mississippi" },
  { value: "MT", label: "MT — Montana" },
  { value: "NC", label: "NC — North Carolina" },
  { value: "ND", label: "ND — North Dakota" },
  { value: "NE", label: "NE — Nebraska" },
  { value: "NH", label: "NH — New Hampshire" },
  { value: "NJ", label: "NJ — New Jersey" },
  { value: "NM", label: "NM — New Mexico" },
  { value: "NV", label: "NV — Nevada" },
  { value: "NY", label: "NY — New York" },
  { value: "OH", label: "OH — Ohio" },
  { value: "OK", label: "OK — Oklahoma" },
  { value: "OR", label: "OR — Oregon" },
  { value: "PA", label: "PA — Pennsylvania" },
  { value: "RI", label: "RI — Rhode Island" },
  { value: "SC", label: "SC — South Carolina" },
  { value: "SD", label: "SD — South Dakota" },
  { value: "TN", label: "TN — Tennessee" },
  { value: "TX", label: "TX — Texas" },
  { value: "UT", label: "UT — Utah" },
  { value: "VA", label: "VA — Virginia" },
  { value: "VT", label: "VT — Vermont" },
  { value: "WA", label: "WA — Washington" },
  { value: "WI", label: "WI — Wisconsin" },
  { value: "WV", label: "WV — West Virginia" },
  { value: "WY", label: "WY — Wyoming" },
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
  const [collectedOpenId, setCollectedOpenId] = React.useState(null);
  const handleCollected = (entry, status) => {
    // Advancing a vehicle out of Ready Returns is the point where a pending PM
    // takes over: the requested status is replaced with PM so it cannot be
    // handed out unserviced.
    const vehicle = fleet.find((fv) => fv.plate === entry.plate) || entry;
    const { status: finalStatus, forced, message } = resolvePmStatus(vehicle, status);
    guardAction("vehicle.collected", () => {
      setFleet((prev) => prev.map((fv) =>
        fv.plate === entry.plate ? { ...fv, status: finalStatus, currentRenter: null, dueBack: null, fileType: null } : fv
      ));
      supabase.from("fleet").update({ status: finalStatus, currentRenter: null, dueBack: null, fileType: null }).eq("id", entry.id).catch((e) => console.warn("fleet update:", e));
      setCollectedOpenId(null);
      if (forced) window.alert(message);
    });
  };

  // Status dropdown change: update fleet state immediately then persist
  const handleStatusChange = (vehicle, newStatus) => {
    const { status: finalStatus, forced, message } = resolvePmStatus(vehicle, newStatus);
    guardAction("vehicle.status", () => {
      setFleet((prev) => prev.map((fv) => fv.id === vehicle.id ? { ...fv, status: finalStatus } : fv));
      supabase.from("fleet").update({ status: finalStatus }).eq("id", vehicle.id).catch((e) => console.warn("fleet status update:", e));
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
                        ["Plate", "Vehicle", "Type", "Location", ""].map((col) =>
                          React.createElement("th", { key: col }, col)
                        )
                      )
                    ),
                    React.createElement("tbody", null,
                      filteredRR.length === 0
                        ? React.createElement("tr", null, React.createElement("td", { colSpan: 5, style: { color: "#aaa", fontStyle: "italic" } }, "None"))
                        : filteredRR.map((r) => {
                            const matchRA = (rentalAgreements || []).find((a) => a.plate === r.plate && a.rentalAgreementStatus === "close_pending");
                            const loc = matchRA?.returnVehicleLocation || "";
                            return React.createElement("tr", { key: r.id },
                              React.createElement("td", null, React.createElement(PlateLink, { plate: r.plate })),
                              React.createElement("td", null, `${r.make} ${r.model}`),
                              React.createElement("td", null, r.fileType || ""),
                              React.createElement("td", null, loc),
                              React.createElement("td", null,
                                collectedOpenId === r.id
                                  ? React.createElement("select", {
                                      className: "gasStatusSelect",
                                      autoFocus: true,
                                      defaultValue: "",
                                      onChange: (e) => { if (e.target.value) handleCollected(r, e.target.value); },
                                      onBlur: () => setCollectedOpenId(null),
                                    },
                                      React.createElement("option", { value: "", disabled: true }, "Select status…"),
                                      FLEET_STATUS_OPTS.filter((s) => s.value !== "All").map((s) =>
                                        React.createElement("option", { key: s.value, value: s.value }, s.label)
                                      )
                                    )
                                  : React.createElement("button", {
                                      type: "button",
                                      className: "collectedBtn",
                                      onClick: (e) => { e.stopPropagation(); setCollectedOpenId(r.id); },
                                    }, "Collected")
                              )
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
  const { fleet, setFleet, requirePin } = React.useContext(AppContext);
  const { filtered, filterState } = useFleetFilter(fleet);
  const [activeTab,  setActiveTab]  = React.useState("add");
  const [archived,   setArchived]   = React.useState(ARCHIVED_VEHICLES_SEED);

  // tankSize / pmInterval are held in the CURRENTLY SELECTED display unit while
  // typing, and converted to canonical litres/km only at submit.
  const BLANK_ADD    = { plate: "", province: "NL", year: "", make: "", model: "", colour: "", vin: "", vehicleClass: "Compact Car", tankSize: "", pmInterval: "" };
  const [tankUnit, setTankUnit] = React.useState("L");
  const [pmUnit,   setPmUnit]   = React.useState("km");
  // Canonical litres / kilometres, kept alongside the displayed string so that
  // toggling units re-renders the number without ever rewriting the value.
  const [tankCanonical, setTankCanonical] = React.useState(null);
  const [pmCanonical,   setPmCanonical]   = React.useState(null);
  const BLANK_RETIRE = { plateId: "", disposalDate: "", reason: "" };
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
      vin:            addForm.vin,
    };
    const check = validateVehicle(candidate);
    if (!check.ok) { setAddError(check.error); return; }
    if (fleet.some((v) => normalizePlate(v.plate) === plate)) { setAddError("A vehicle with this plate already exists."); return; }

    requirePin(() => {
      const newVehicle = {
        plate, make: addForm.make, model: addForm.model,
        vehicleClass: addForm.vehicleClass || "Compact Car",
        year: addForm.year || null,
        colour: addForm.colour || null,
        vin: addForm.vin || null,
        province: addForm.province || null,
        tankSizeLiters: tankLiters,
        pmIntervalKm: pmKm,
        lastPmOdometer: null,
        currentOdometer: null,
        winterTires: "No", status: "Needs Cleaning",
        currentRenter: null, dueBack: null, fileType: null,
      };
      setFleet((prev) => [...prev, newVehicle]);
      supabase.from("fleet").insert(newVehicle).then((res) => { console.log("fleet insert response:", res); if (res.error) console.warn("fleet insert error:", res.error); }).catch((e) => console.warn("fleet insert:", e));
      setAddForm(BLANK_ADD);
      setTankCanonical(null);
      setPmCanonical(null);
      setAddSuccess(true);
    });
  };

  const handleRetireSubmit = (e) => {
    e.preventDefault();
    if (!retireForm.plateId || !retireForm.disposalDate || !retireForm.reason.trim()) { setRetireError("All fields are required."); return; }
    const v = fleet.find((x) => x.id === retireForm.plateId);
    if (!v) { setRetireError("Vehicle not found."); return; }
    const extra = VEHICLE_EXTRA_DATA[v.plate] || {};
    requirePin(() => {
      setArchived((prev) => [...prev, {
        id: `AV-${Date.now()}`, plate: v.plate, make: v.make, model: v.model,
        year: extra.year || "", colour: extra.colour || "", province: extra.province || "",
        vin: extra.vin || "", disposalDate: retireForm.disposalDate, reason: retireForm.reason,
      }]);
      setFleet((prev) => prev.filter((x) => x.id !== retireForm.plateId));
      supabase.from("fleet").delete().eq("id", retireForm.plateId).then((res) => { console.log("fleet delete response:", res); if (res.error) console.warn("fleet delete error:", res.error); }).catch((e) => console.warn("fleet delete:", e));
      setRetireForm(BLANK_RETIRE);
    });
  };

  const fmtDate = (iso) => {
    if (!iso) return "—";
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
            React.createElement("div", { className: "addVehicleField" },
              React.createElement("label", { className: "addVehicleLabel" }, "Vehicle Class"),
              React.createElement("select", { className: "addVehicleInput", value: addForm.vehicleClass, onChange: (e) => onAdd("vehicleClass", e.target.value) },
                ["Compact Car", "Regular Car", "Large Car", "Compact SUV", "Regular SUV", "Large SUV", "Minivan", "Truck"].map((vc) =>
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
                  React.createElement("option", { value: "" }, filtered.length === fleet.length ? "— Select vehicle —" : `— ${filtered.length} of ${fleet.length} shown —`),
                  filtered.map((v) => React.createElement("option", { key: v.id, value: v.id }, `${v.plate} — ${v.make} ${v.model}`))
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
                React.createElement("label", { className: "addVehicleLabel" }, "Reason for Retirement"),
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
      archived.length > 0 && React.createElement(
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
              archived.map((v) =>
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
    });
  };

  const renderTable = (claims, showResolve) =>
    React.createElement("table", { className: "dashboardTable" },
      React.createElement("thead", null,
        React.createElement("tr", null,
          [...["Plate", "Vehicle", "Customer", "Res Code", "Damage Description", "Status", "Rental Agreement"],
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
            React.createElement("td", null, c.rentalAgreementId || "N/A"),
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

function SettingsPage() {
  const { appSettings, saveSetting, fleet, guardAction } = React.useContext(AppContext);

  const SECTS = [
    { key: "branch",  title: "Branch Information",    body: "Branch name, address, phone number, operating hours, and SIPP codes." },
    // Roles are described here but nothing enforces them: there is no users
    // table and the PIN is checked against the single signed-in user. Said
    // plainly so the panel does not read as a working feature.
    { key: "users",   title: "User Accounts",         body: "Manage staff logins, roles (Agent, Manager, Admin), and PIN resets. Roles are not active yet: every signed-in user currently has the same access, and confirmation is by PIN alone." },
    { key: "notifs",  title: "Notification Settings", body: "Configure which events trigger notifications and to which staff members." },
    { key: "twilio",  title: "Twilio SMS Setup",      body: "Twilio Account SID, Auth Token, and sending phone number for AI call and text automation." },
    { key: "billing", title: "Billing Configuration", body: "Billing address, HST registration number, and invoice export settings." },
  ];
  const [sect, setSect] = React.useState({ gas: false, ...Object.fromEntries(SECTS.map((s) => [s.key, true])) });
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
    setPriceDrafts(Object.fromEntries(fleetRegions.map((r) => [r, gasPrices[r] != null ? String(gasPrices[r]) : ""])));
  }, [fleetRegions.join(","), JSON.stringify(gasPrices)]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (msg) => { setSavedFlash(msg); setTimeout(() => setSavedFlash(""), 2000); };

  const commitMarkup = async () => {
    const raw = markupDraft.trim();
    const n   = raw === "" ? null : parseFloat(raw);
    if (n === null || !Number.isFinite(n) || n < 0) {
      setMarkupDraft(appSettings.gasMarkupPercent != null ? String(appSettings.gasMarkupPercent) : "");
      return;
    }
    if (n === appSettings.gasMarkupPercent) return;
    guardAction("gas.markup", async () => {
      if (await saveSetting("gasMarkupPercent", n)) flash("Markup saved.");
    });
  };

  const commitPrice = async (region) => {
    const raw = (priceDrafts[region] || "").trim();
    const n   = raw === "" ? null : parseFloat(raw);
    if (raw !== "" && (!Number.isFinite(n) || n <= 0)) {
      setPriceDrafts((p) => ({ ...p, [region]: gasPrices[region] != null ? String(gasPrices[region]) : "" }));
      return;
    }
    if (n === (gasPrices[region] ?? null)) return;
    const next = { ...gasPrices };
    if (n === null) delete next[region]; else next[region] = n;
    guardAction("gas.regionPrice", async () => {
      if (await saveSetting("gasPrices", next)) flash(`${region} price saved.`);
    });
  };

  const missingTank = fleet.filter((v) => v.tankSizeLiters == null).length;

  const gasBody = React.createElement(React.Fragment, null,
    React.createElement("p", { className: "aiTabDesc" },
      "On return, if the vehicle comes back with less fuel than it left with, the charge is calculated as ",
      React.createElement("em", null, "litres short × price per litre × (1 + markup)"),
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

    React.createElement("div", { className: "gasSettingSubhead" }, "Price per litre by region"),
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
              React.createElement("span", { className: "gasSettingUnit" }, "/ L"),
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
        NAV_SECTIONS.map((section) =>
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

function MobileCommandBar() {
  const [expanded, setExpanded] = React.useState(false);
  return React.createElement(
    "div",
    { className: "mobileBottomBar" + (expanded ? " mobileBottomBar--expanded" : "") },
    expanded
      ? React.createElement(
          React.Fragment,
          null,
          React.createElement(
            "button",
            {
              type: "button",
              className: "mobileBottomBar__collapse",
              "aria-label": "Collapse command bar",
              onClick: () => setExpanded(false),
            },
            React.createElement(
              "svg",
              { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" },
              React.createElement("polyline", { points: "18 15 12 9 6 15" })
            )
          ),
          React.createElement(FleetrCommandBar)
        )
      : React.createElement(
          "button",
          {
            type: "button",
            className: "mobileBottomBar__pill",
            onClick: () => setExpanded(true),
          },
          React.createElement(
            "svg",
            { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" },
            React.createElement("rect", { x: "9", y: "2", width: "6", height: "12", rx: "3" }),
            React.createElement("path", { d: "M5 10a7 7 0 0 0 14 0" }),
            React.createElement("line", { x1: "12", y1: "19", x2: "12", y2: "22" }),
            React.createElement("line", { x1: "8",  y1: "22", x2: "16", y2: "22" })
          ),
          React.createElement("span", null, "Ask fleetr ai…")
        )
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
    React.createElement(FleetrCommandBar),
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
    NAV_SECTIONS.map((section) =>
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

function FleetrCommandBar() {
  const { requirePin, guardAction, currentUser, reservations, setReservations, rentalAgreements, setRentalAgreements, fleet, setFleet, ndiRows, setNdiRows, noShows, setNoShows, damageClaims, setDamageClaims } = React.useContext(AppContext);
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
        `Reservations data: ${JSON.stringify(reservations)}\n\n` +
        `Rental agreements data: ${JSON.stringify(rentalAgreements)}\n\n` +
        `Fleet data: ${JSON.stringify(fleet)}\n\n` +
        `Non-drive intake data: ${JSON.stringify(ndiRows)}\n\n` +
        `No-shows data: ${JSON.stringify(noShows)}\n\n` +
        `Damage claims data: ${JSON.stringify(damageClaims)}\n\n` +
        `User command: ${trimmed}`;
      const res = await fetch(CLAUDE_API_URL, {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type":      "application/json",
        },
        body: JSON.stringify({
          model:      CLAUDE_MODEL,
          max_tokens: 1024,
          system:     CLAUDE_SYSTEM,
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
        setAiMessage(parsed.message || "Done.");
        if (parsed.action && parsed.action.table && parsed.action.operation) {
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
  const confirmAction = () => {
    const key = commandBarActionKey({
      table: pendingAction?.table,
      operation: pendingAction?.operation,
      data: editableData,
    });
    console.log("Fleetr command bar action tier:", key, actionTier(key));
    guardAction(key, executeAction);
  };

  const executeAction = async () => {
    if (!pendingAction) return;
    setActionLoading(true);
    const { table, operation, match } = pendingAction;
    let data = editableData; // use user-edited values

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
    // return time. Failing here aborts before any Supabase call.
    // Reuses the same channel a failed Supabase write reports through, and drops
    // the pending action so the Confirm button cannot be pressed again.
    const abort = (msg) => {
      console.warn("Fleetr AI action blocked by a write rule:", msg, { table, operation, data });
      setAiMessage(msg);
      setPendingAction(null);
      setActionLoading(false);
    };

    if (table === "fleet" && operation === "insert") {
      const check = validateVehicle(data);
      if (!check.ok) return void abort(check.error);
    }

    if (table === "fleet" && operation === "delete") {
      const check = validateRetirement(data);
      if (!check.ok) return void abort(`${check.error} Retire it from Additions and Deletions so the archive keeps a record.`);
    }

    if (table === "reservations" && operation === "insert") {
      const check = validateReservation(data);
      if (!check.ok) return void abort(check.error);
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

    // Opening or reopening a rental on a PM-flagged vehicle raises the same soft
    // block, and cancelling it aborts rather than writing.
    if (table === "reservations" && data.rentalAgreementStatus === "open_rental_agreement") {
      const res   = reservations.find((r) => Object.entries(match || {}).every(([k, val]) => String(r[k]) === String(val)));
      const ra    = rentalAgreements.find((x) => x.resCode === res?.resCode);
      const plate = ra?.plate || res?.plate;
      const veh   = plate ? fleet.find((v) => normalizePlate(v.plate) === normalizePlate(plate)) : null;
      if (!confirmRentalDespitePm(veh)) return void abort("Cancelled. The vehicle is still flagged for preventative maintenance.");
    }

    // Closing stamps the return time, so a closed agreement always records when
    // the vehicle came back.
    if (table === "reservations" && RA_CLOSING_STATUSES.includes(data.rentalAgreementStatus)) {
      data = { ...raCloseStamp(), ...data };
    }

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
      if (operation === "update") {
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
            const newLog   = [...existing, { author: currentUser?.name || "fleetr ai", text: noteText }];
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
    return React.createElement(
      "div",
      { className: "app app--mobile" },
      React.createElement(MobileNav),
      React.createElement("main", { className: "content" }, React.createElement(AppRoutes)),
      React.createElement(MobileCommandBar)
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

function PreRentalCheckPage() {
  const { reservations } = React.useContext(AppContext);
  const tomorrowIso = isoOffset(1);
  const tomorrowLabel = (() => {
    const d = new Date(`${tomorrowIso}T00:00:00`);
    return d.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  })();

  const tomorrowRows = reservations.filter((r) => r.date === tomorrowIso);

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
                    React.createElement("td", { key: `${row.resCode}-6` },
                      React.createElement("span", { className: "preRentalCheckDone" }, "Queued")
                    )
                  )
                )
              )
            )
      )
    )
  );
}


// ─── RentalAgreementDetail ────────────────────────────────────────────────────────────

function RentalAgreementDetail({ rentalAgreement, onBack, setRentalAgreements }) {
  const [sect, setSect] = React.useState({
    resInfo: true, datesRates: true, billTo: true, charges: true, notes: true,
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

  const statusClass =
    rentalAgreement.status === "open_rental_agreement" ? "rentalAgreementBadge rentalAgreementBadge--open"
    : rentalAgreement.status === "close_pending"       ? "rentalAgreementBadge rentalAgreementBadge--pending"
    : "rentalAgreementBadge rentalAgreementBadge--closed";

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
      ),
      React.createElement("p", { className: "rentalAgreementDetailMeta" }, `${rentalAgreement.id} · Res Code ${rentalAgreement.resCode}`)
    ),
    React.createElement("div", { className: "page__titleUnderline" }),
    section("resInfo", "Reservation Information",
      React.createElement("div", { className: "rentalAgreementFields" },
        field("Rental Agreement #", rentalAgreement.id),
        field("Res Code", rentalAgreement.resCode),
        field("Customer", rentalAgreement.customer),
        field("Status", statusLabel(rentalAgreement.status)),
        field("Vehicle", rentalAgreement.vehicle),
        field("Vehicle Class", rentalAgreement.vehicleClass),
        field("Pickup Date", pickupDateDisplay),
        pickupTimeDisplay ? field("Pickup Time", pickupTimeDisplay) : null
      )
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

  const statusBadgeClass = (s) =>
    s === "open_rental_agreement" ? "rentalAgreementBadge rentalAgreementBadge--open"
    : s === "close_pending"       ? "rentalAgreementBadge rentalAgreementBadge--pending"
    : "rentalAgreementBadge rentalAgreementBadge--closed";

  const selectedRes = selectedId ? reservations.find((r) => r.resCode === selectedId) : null;
  if (selectedRes) {
    const matchingRa = rentalAgreements.find((ra) => ra.resCode === selectedRes.resCode);
    const selectedRentalAgreement = {
      id:          selectedRes.resCode,
      raId:        matchingRa?.id || null,
      resCode:     selectedRes.resCode,
      customer:    selectedRes.customer,
      status:      selectedRes.rentalAgreementStatus,
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

// ─── CustomerPage data ────────────────────────────────────────────────────────

const DEFAULT_LINE_ITEMS = [
  { key: "vehicle", label: "Vehicle Cost",     applies: true,  amount: "", qty: "", qtyPlaceholder: "Days"   },
  { key: "winter",  label: "Winter Tires",     applies: false, amount: "", qty: "", qtyPlaceholder: "Days", customerPay: false },
  { key: "gas",     label: "Gas",              applies: false, amount: "", qty: "", qtyPlaceholder: "Litres" },
  { key: "mileage", label: "Mileage",          applies: false, amount: "", qty: "", qtyPlaceholder: "Miles"  },
  { key: "waiver",  label: "Damage Waiver",    applies: false, amount: "", qty: "", qtyPlaceholder: "Days", coveredByBillTo: false },
  { key: "roadside",label: "Roadside",         applies: false, amount: "", qty: "", qtyPlaceholder: "Days", coveredByBillTo: false },
  { key: "injury",  label: "Injury Insurance", applies: false, amount: "", qty: "", qtyPlaceholder: "Days", coveredByBillTo: false },
];

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
const RATES_VCLASS_CATS = {
  "Car":     ["Compact", "Regular", "Large"],
  "SUV":     ["Compact", "Regular", "Large"],
  "Minivan": [],
  "Truck":   [],
};

// ─── CustomerPage ─────────────────────────────────────────────────────────────

function CustomerPage() {
  const { openCustomer, reservations, setReservations, rentalAgreements, setRentalAgreements, fleet, syncRAStatus, requirePin, guardAction, setDamageClaims } = React.useContext(AppContext);
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
  const updateRates = (f, v) => setRatesForm((p) => ({ ...p, [f]: v }));
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
  const raVehicleClass = ra?.vehicleClass || null;

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
    const vcStr = localRecord.vehicleSize
      ? `${localRecord.vehicleClass || ""} — ${localRecord.vehicleSize}`
      : (localRecord.ratesVehicleClass || "");
    setRatesForm({ source: srcStr, vehicleClass: vcStr, winterTires: localRecord.winterTires || "No" });
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
    if (Array.isArray(ra.lineItems) && ra.lineItems.length > 0) {
      setLineItems(ra.lineItems);
    }
    if (Array.isArray(ra.payments)) {
      setPayments(ra.payments);
    }
  }, [ra]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-populate Rates & Billing vehicle class from the RA's fleet vehicleClass
  // (fires only when the RA's vehicleClass first appears or changes).
  React.useEffect(() => {
    if (!raVehicleClass) return;
    const parts = raVehicleClass.split(" ");
    // "Regular Car" → "Car — Regular", "Compact SUV" → "SUV — Compact", etc.
    const mapped = parts.length === 2 ? `${parts[1]} — ${parts[0]}` : raVehicleClass;
    updateRates("vehicleClass", mapped);
  }, [raVehicleClass]);

  React.useEffect(() => {
    const src = ratesForm.source;
    const vc  = ratesForm.vehicleClass;
    const srcCat = src === "Retail" ? "Retail"
      : src.startsWith("Bodyshop/Dealership") ? "Bodyshop/Dealership"
      : src.startsWith("Insurance")           ? "Insurance"
      : src.startsWith("Corporate")           ? "Corporate" : null;
    const vcCat = vc === "Minivan" ? "Minivan"
      : vc === "Truck"             ? "Truck"
      : vc.startsWith("Car")       ? "Car"
      : vc.startsWith("SUV")       ? "SUV" : null;
    if (srcCat && vcCat && DAILY_RATES[srcCat]?.[vcCat] !== undefined) {
      setBillToForm((p) => ({ ...p, dailyRate: String(DAILY_RATES[srcCat][vcCat]) }));
    }
  }, [ratesForm.source, ratesForm.vehicleClass]);

  React.useEffect(() => {
    const d1 = resInfoForm.pickupDate ? new Date(`${resInfoForm.pickupDate}T00:00:00`) : null;
    const d2 = resInfoForm.returnDate ? new Date(`${resInfoForm.returnDate}T00:00:00`) : null;
    if (!d1 || !d2) return;
    const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
    const days = diff > 0 ? diff : 0;
    setLineItems((prev) => prev.map((item) =>
      ["vehicle", "winter", "waiver", "roadside", "injury"].includes(item.key)
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
      const vcParts  = ratesForm.vehicleClass.includes(" — ")
        ? ratesForm.vehicleClass.split(" — ") : [ratesForm.vehicleClass, ""];
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
        vehicleSize:     vcParts[1]  || "",
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

  const rentalAgreementStatus = localRecord?.rentalAgreementStatus || "reservation";

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
      return;
    }
    requirePin(() => {
      setLocalRecord((prev) => prev ? { ...prev, rentalAgreementStatus: "open_rental_agreement" } : prev);
      setReservations((prev) =>
        prev.map((r) => r.resCode === resCode ? { ...r, rentalAgreementStatus: "open_rental_agreement" } : r)
      );
      syncRAStatus(resCode, "open_rental_agreement");
    });
  };

  const updateRentalAgreementStatus = (status) => {
    // Reopening a rental agreement is the same soft block as opening one.
    if (status === "open_rental_agreement" && !confirmRentalDespitePm(pmVehicle)) {
      console.log("rental reopen cancelled: vehicle flagged for PM", pmVehicle?.plate);
      return;
    }
    requirePin(() => {
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
    });
  };

  const handleDeleteReservation = async () => {
    if (!resCode) return;
    const confirmed = window.confirm(
      `Delete reservation ${resCode} for ${name}? This cannot be undone.`
    );
    if (!confirmed) return;
    requirePin(async () => {
      setReservations((prev) => prev.filter((r) => r.resCode !== resCode));
      try {
        await supabase.from("reservations").delete().eq("resCode", resCode);
      } catch (e) {
        console.warn("Delete reservation error:", e);
      }
      navigate(-1);
    });
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
        supabase.from("reservations").update({ hasDamage: true }).eq("resCode", resCode).catch((e) => console.warn("reservations update:", e));

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
        supabase.from("damage_claims").insert(claim).catch((e) => console.warn("damage_claims insert:", e));
      });
    },
  }, isDamaged ? "Damage Flagged" : "Flag Damage");

  const rentalAgreementOptionsBody = () => {
    if (rentalAgreementStatus === "reservation") {
      return React.createElement("div", { className: "customerRentalAgreementBtnRow" },
        deleteBtn
      );
    }
    if (rentalAgreementStatus === "open_rental_agreement") {
      return React.createElement("div", { className: "customerRentalAgreementBtnRow" },
        React.createElement("button", {
          type: "button", className: "customerRentalAgreementBtn customerRentalAgreementBtn--pending",
          onClick: () => updateRentalAgreementStatus("close_pending"),
        }, "Close Pending"),
        React.createElement("button", {
          type: "button", className: "customerRentalAgreementBtn customerRentalAgreementBtn--close",
          onClick: () => updateRentalAgreementStatus("closed"),
        }, "Close Rental Agreement"),
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
                ? `${parseInt(rentalVehicle.mileage).toLocaleString("en-CA")} km`
                : "")
          ),
          React.createElement("div", { className: "resFormRow" },
            rvField("Previous Damage", rentalVehicle.damage || "None documented", true)
          )
        )
      : React.createElement("div", { className: "customerPlaceholder" },
          "Populated automatically when the customer completes check-in on the fleetr app."
        )
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

  const btSrcCat = ratesForm.source === "Retail" ? "Retail"
    : ratesForm.source.startsWith("Bodyshop/Dealership") ? "Bodyshop/Dealership"
    : ratesForm.source.startsWith("Insurance")           ? "Insurance"
    : ratesForm.source.startsWith("Corporate")           ? "Corporate" : null;
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
      twoLevelPicker("Source",        "source",       RATES_SOURCE_CATS, "Select source"),
      twoLevelPicker("Vehicle Class", "vehicleClass", RATES_VCLASS_CATS, "Select class"),
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

  const PERSONAL_KEYS = ["waiver", "roadside", "injury"];
  const showCoverToggle = btSrcCat && btSrcCat !== "Retail";
  const rowBilledTo = (item) =>
    PERSONAL_KEYS.includes(item.key)
      ? (item.coveredByBillTo ? billedToName : name)
      : billedToName;

  const billToItems   = lineItems.filter((it) =>
    it.key === "winter" ? !it.customerPay
    : !PERSONAL_KEYS.includes(it.key) || it.coveredByBillTo
  );
  const customerItems = lineItems.filter((it) =>
    it.key === "winter" ? it.customerPay
    : PERSONAL_KEYS.includes(it.key) && !it.coveredByBillTo
  );
  const billToTotal   = billToItems.reduce((s, it) => s + (it.applies ? lineItemAmt(it) : 0), 0);
  const customerTotal = customerItems.reduce((s, it) => s + (it.applies ? lineItemAmt(it) : 0), 0);
  const grandTotal    = billToTotal + customerTotal;
  const billToPaid      = payments.filter((p) => (p.paidBy || "Bill-To") === "Bill-To").reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const customerPaid    = payments.filter((p) => p.paidBy === "Customer").reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const totalPaid       = billToPaid + customerPaid;
  const billToBalance   = billToTotal - billToPaid;
  const customerBalance = customerTotal - customerPaid;

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
          : PERSONAL_KEYS.includes(item.key) && showCoverToggle
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
        React.createElement("input", {
          className: "resFormInput chargesQtyInput",
          type: "text", inputMode: "decimal",
          placeholder: item.qtyPlaceholder,
          value: item.qty,
          onChange: (e) => updateLineItem(item.key, "qty", e.target.value),
          disabled: !item.applies,
        })
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

  const renderChargesSection = (title, items, sectionTotal) =>
    React.createElement("div", { className: "chargesSection" },
      React.createElement("div", { className: "chargesSectionHeader" }, title),
      React.createElement("table", { className: "chargesTable" },
        React.createElement("thead", null,
          React.createElement("tr", null,
            React.createElement("th", { className: "chargesTh chargesTh--check" }, ""),
            React.createElement("th", { className: "chargesTh" }, "Item"),
            React.createElement("th", { className: "chargesTh chargesTh--qty" }, "Quantity"),
            React.createElement("th", { className: "chargesTh chargesTh--amt" }, "Cost Per Day"),
            React.createElement("th", { className: "chargesTh chargesTh--total" }, "Total Cost")
          )
        ),
        React.createElement("tbody", null, items.map(renderChargesRow))
      ),
      React.createElement("div", { className: "chargesTotalRow chargesTotalRow--section" },
        React.createElement("span", { className: "chargesTotalLabel" }, `${title.split(" ")[0]} Total`),
        React.createElement("span", { className: "chargesTotalValue" }, fmtMoney(sectionTotal))
      )
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
      // Bill-To Charges section
      renderChargesSection("Bill-To Charges", billToItems, billToTotal),
      // Customer Charges section
      customerItems.length > 0 && renderChargesSection("Customer Charges", customerItems, customerTotal),
      // Grand Total
      React.createElement("div", { className: "chargesTotalRow chargesTotalRow--grand" },
        React.createElement("span", { className: "chargesTotalLabel" }, "Grand Total"),
        React.createElement("span", { className: "chargesTotalValue" }, fmtMoney(grandTotal))
      )
    ),

    // ── Payments tab ──
    chargesTab === "Payments" && React.createElement("div", { className: "cdetailForm" },
      // Owes summary
      React.createElement("div", { className: "chargesInfoRow" },
        React.createElement("div", { className: "chargesInfoItem" },
          React.createElement("span", { className: "chargesInfoLabel" }, "Bill-To Owes"),
          React.createElement("span", { className: "chargesInfoValue" }, fmtMoney(billToTotal))
        ),
        React.createElement("div", { className: "chargesInfoItem" },
          React.createElement("span", { className: "chargesInfoLabel" }, "Customer Owes"),
          React.createElement("span", { className: "chargesInfoValue" }, fmtMoney(customerTotal))
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
                  React.createElement("select", {
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
      React.createElement("div", { className: "paymentsTotals" },
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
        const raStatus = localRecord?.rentalAgreementStatus;
        if (!raStatus || raStatus === "reservation") return null;
        const cls = raStatus === "open_rental_agreement"
          ? "rentalAgreementBadge rentalAgreementBadge--open rentalAgreementBadge--meta"
          : raStatus === "close_pending"
          ? "rentalAgreementBadge rentalAgreementBadge--pending rentalAgreementBadge--meta"
          : "rentalAgreementBadge rentalAgreementBadge--closed rentalAgreementBadge--meta";
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
      element: React.createElement(DashboardPage),
    }),
    React.createElement(Route, {
      path: "/reservations",
      element: React.createElement(ReservationsPage),
    }),
    React.createElement(Route, {
      path: "/arms",
      element: React.createElement(NonDriveIntakePage),
    }),
    React.createElement(Route, {
      path: "/pre-rental-check",
      element: React.createElement(PreRentalCheckPage),
    }),
    React.createElement(Route, {
      path: "/overdue-rentals",
      element: React.createElement(OverdueRentalsPage),
    }),
    React.createElement(Route, {
      path: "/vehicle",
      element: React.createElement(VehicleDetailPage),
    }),
    React.createElement(Route, {
      path: "/time-of-repair",
      element: React.createElement(TORPage),
    }),

    React.createElement(Route, {
      path: "/no-shows",
      element: React.createElement(NoShowsPage),
    }),
    React.createElement(Route, {
      path: "/fleet",
      element: React.createElement(FleetPage),
    }),
    React.createElement(Route, {
      path: "/fleet/vehicles",
      element: React.createElement(FleetVehiclesPage),
    }),
    React.createElement(Route, {
      path: "/fleet/additions",
      element: React.createElement(FleetAdditionsPage),
    }),
    React.createElement(Route, {
      path: "/fleet/gas-collections",
      element: React.createElement(GasCollectionsPage),
    }),
    React.createElement(Route, {
      path: "/fleet/damage-claims",
      element: React.createElement(FleetDamageClaimsPage),
    }),
    React.createElement(Route, {
      path: "/reports",
      element: React.createElement(ReportsPage),
    }),
    React.createElement(Route, {
      path: "/settings",
      element: React.createElement(SettingsPage),
    }),
    React.createElement(Route, {
      path: "/rental-agreements",
      element: React.createElement(RentalAgreementsPage),
    }),
    React.createElement(Route, {
      path: "/customer",
      element: React.createElement(CustomerPage),
    }),
    NAV.filter((item) => !["/dashboard", "/reservations", "/arms", "/pre-rental-check", "/overdue-rentals", "/time-of-repair", "/no-shows", "/fleet", "/fleet/vehicles", "/fleet/additions", "/fleet/gas-collections", "/fleet/damage-claims", "/reports", "/settings", "/rental-agreements", "/customer", "/vehicle"].includes(item.path))
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

function LoginScreen({ onSuccess }) {
  const [username, setUsername] = React.useState("");
  const [pin,      setPin]      = React.useState("");
  const [error,    setError]    = React.useState(false);
  const [loading,  setLoading]  = React.useState(false);
  const pinRef = React.useRef(null);

  const handleUsernameChange = (e) => {
    const val = e.target.value;
    setUsername(val);
    setError(false);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const u = username.trim().toLowerCase();
    if (u !== "connor" || pin !== "1234") {
      setError(true);
      return;
    }
    onSuccess({ id: null, username: u, pin });
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
          minLength: 6,
          maxLength: 12,
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
          maxLength: 12,
          inputMode: "text",
          autoComplete: "current-password",
          value: pin,
          onChange: (e) => { setPin(e.target.value.slice(0, 12)); setError(false); },
          onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); handleSubmit(e); } },
        }),
        React.createElement("button", { type: "submit", className: "loginBtn", disabled: loading }, loading ? "Signing in…" : "Sign In"),
        error && React.createElement("div", { className: "loginError" }, "Invalid credentials")
      )
    )
  );
}

function App() {
  // Session strategy: localStorage holds the user data (survives browser quirks
  // and page refreshes reliably). sessionStorage holds a per-tab token written
  // at login. On init, both must match — a missing or mismatched sessionStorage
  // token means the tab was closed/relaunched and sign-in is required again.
  // This is more robust than pure sessionStorage, which Safari and PWA contexts
  // can clear on page reload in certain configurations.
  const [currentUser, setCurrentUser] = React.useState(() => {
    try {
      const saved = localStorage.getItem("fleetr_session");
      if (!saved) return null;
      const data = JSON.parse(saved);
      const tabToken = sessionStorage.getItem("fleetr_tab_token");
      if (!tabToken || tabToken !== data._tabToken) {
        localStorage.removeItem("fleetr_session");
        return null;
      }
      const { _tabToken: _t, ...user } = data;
      return user;
    } catch (e) { return null; }
  });

  const signOut = () => {
    localStorage.removeItem("fleetr_session");
    sessionStorage.removeItem("fleetr_tab_token");
    setCurrentUser(null);
    window.location.hash = "";
  };

  if (!currentUser) {
    return React.createElement(LoginScreen, {
      onSuccess: (user) => {
        const tabToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        sessionStorage.setItem("fleetr_tab_token", tabToken);
        localStorage.setItem("fleetr_session", JSON.stringify({ ...user, _tabToken: tabToken }));
        window.location.hash = "/";
        setCurrentUser(user);
      },
    });
  }

  return React.createElement(
    AppProvider,
    { currentUser, signOut },
    React.createElement(HashRouter, null, React.createElement(Layout))
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
    padding: 16px 0;
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
  .mobileBottomBar--expanded{
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 10px 16px 16px;
  }
  .mobileBottomBar__pill{
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    background: #F9F9F7;
    border: 1.5px solid rgba(66,164,255,0.35);
    border-radius: 999px;
    padding: 8px 14px;
    font-family: inherit;
    font-size: 13px;
    color: rgba(6,13,12,0.4);
    cursor: pointer;
    text-align: left;
  }
  .mobileBottomBar__pill svg{ color: #42a4ff; flex-shrink: 0; }
  .mobileBottomBar__collapse{
    background: none;
    border: none;
    color: rgba(255,255,255,0.5);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    align-self: flex-end;
    padding: 2px 6px;
  }
  .mobileBottomBar--expanded .fleetrCommandBar{
    background: #F9F9F7;
    border-radius: 999px;
  }
  .mobileBottomBar--expanded .fleetrCommandBar__popover{
    top: auto;
    bottom: calc(100% + 10px);
  }

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
.chargesTh--qty{ width: 90px; }
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
.rentalAgreementBadge--pending {
  background: #fef3c7;
  color: #92400e;
}
.rentalAgreementBadge--closed {
  background: #fee2e2;
  color: #991b1b;
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
.rentalAgreementDetailMeta {
  margin: 0;
  font-size: 12px;
  color: #7b8fa8;
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
.collectedBtn {
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
.collectedBtn:hover {
  border-color: #42a4ff;
  color: #42a4ff;
}
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(
  React.createElement(React.StrictMode, null, React.createElement(App))
);
