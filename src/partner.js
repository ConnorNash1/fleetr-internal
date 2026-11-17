// fleetr for partners: the portal a rental company's body shops, insurers
// and dealerships use (overnight-nov17, Part 3). Its own page on the staff
// site, so a partner never loads the staff app. Everything it reads and
// writes goes through the partner_* functions (partner_portal.sql in
// fleetr-infra), each scoped to the signed-in partner at its company.
import React from "https://esm.sh/react@18.3.1";
import ReactDOM from "https://esm.sh/react-dom@18.3.1/client";
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@1/+esm";
import { matchClass } from "./partner_match.js";

const SUPABASE_URL  = "https://hzcatlecvwpqxedrzfog.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6Y2F0bGVjdndwcXhlZHJ6Zm9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNzQzMTMsImV4cCI6MjA5MzY1MDMxM30.mfqwWQh54hPsRunAVB6RDf_IrvwKmhSYWWJ4sMy0rcw";
// Joining makes an account, which only the reset Worker can do (admin API).
const RESET_URL = "https://fleetr-reset.connor-0a5.workers.dev";
// Its own place for the session, apart from the staff app's on the same
// site: signing in here never signs a staff member out there, or the
// reverse (found on staging, where one replaced the other).
const partnerStorage = {
  getItem: (k) => { try { return window.localStorage.getItem(`fleetr.partner.${k}`); } catch (e) { return null; } },
  setItem: (k, v) => { try { window.localStorage.setItem(`fleetr.partner.${k}`, v); } catch (e) { /* private window */ } },
  removeItem: (k) => { try { window.localStorage.removeItem(`fleetr.partner.${k}`); } catch (e) { /* private window */ } },
};
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, { localStorage: partnerStorage });
const h = React.createElement;

const REASONS = {
  not_partner: "This account isn't set up for the partner portal. Ask the rental company to invite you.",
  not_available: "That class is booked for those dates. Pick another class or other dates.",
  bad_dates: "Check the dates: the return has to be after the pickup, and the pickup can't be in the past.",
  bad_name: "Add the renter's first and last name.", bad_phone: "Add the renter's mobile number, with the area code.",
  bad_email: "Check the renter's email address.", bad_reference: "Add the claim or repair order number.",
  bad_class: "Pick the class of car to book.", bad_branch: "Pick the branch the renter picks up from.", branch_not_ready: "This branch isn't taking partner bookings yet. Call the branch.",
  no_source: "The rental company hasn't finished setting up your account. Call the branch.",
  already_asked: "You've already asked to extend this rental. The branch will answer soon.",
  bad_date: "Pick a new return date after the current one.", already_sent: "You've already told the branch about this transfer.",
  not_found: "That's no longer here. Reload to see the latest.", try_again: "Try again in a moment.",
  bad_limit: "Check the daily limit.", over_limit: "That class costs more than the daily limit. Pick one within it.",
};
const reasonText = (r) => REASONS[r] || "That didn't work. Try again, or call the branch.";
const rpc = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args || {});
  if (error) return { ok: false, reason: "network" };
  return data || { ok: false, reason: "empty" };
};
const money = (n) => `$${Number(n || 0).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDay = (iso) => { if (!iso) return ""; const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`); return d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }); };
const isoDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const logo = (cls) => h("img", { className: cls, src: "/fleetr-logo-terracotta-on-white.svg", alt: "fleetr" });
const Btn = ({ variant = "primary", block, lg, loading, className, children, ...rest }) => h("button", {
  type: "button", ...rest, className: ["btn", `btn--${variant}`, block && "btn--block", lg && "btn--lg", className].filter(Boolean).join(" "), disabled: rest.disabled || loading,
}, loading ? h("span", { className: "spin", "aria-hidden": "true" }) : null, children);
// A label tied to its input by id, with any hint read out with it.
let fieldSeq = 0;
function Field({ label, hint, children }) {
  const [id] = React.useState(() => `pf${++fieldSeq}`);
  const child = React.isValidElement(children) ? React.cloneElement(children, { id, "aria-describedby": hint ? `${id}-hint` : undefined }) : children;
  return h("div", { className: "field" }, h("label", { htmlFor: id }, label), child, hint ? h("small", { id: `${id}-hint` }, hint) : null);
}
const Input = (props) => h("input", { className: "input", ...props });

// ── Joining from an invite ──
function Join({ token, onDone }) {
  const [info, setInfo] = React.useState(null);
  const [pw, setPw] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  React.useEffect(() => { rpc("partner_invite_info", { p_token: token }).then(setInfo); }, [token]);
  if (!info) return h("div", { className: "auth" }, h("div", { className: "auth__card" }, h("span", { className: "skel", style: { height: 120 } })));
  if (!info.ok) return h("div", { className: "auth" }, h("div", { className: "auth__card" }, logo("auth__logo"),
    h("h1", { className: "auth__title" }, "This invite has expired"),
    h("p", { className: "note" }, "Invite links work once and for 14 days. Ask the rental company to send you a new one, or sign in if you've already set your password."),
    h(Btn, { variant: "secondary", onClick: () => { window.location.hash = ""; onDone(); } }, "Sign in")));
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const res = await fetch(`${RESET_URL}/partner/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: pw }) });
      const out = await res.json().catch(() => null);
      if (!out || !out.ok) { setError((out && out.message) || "Your account could not be set up. Try again in a minute."); setBusy(false); return; }
      const { error: e2 } = await supabase.auth.signIn({ email: out.email, password: pw });
      if (e2) { setError("Your password is set. Sign in to continue."); setBusy(false); return; }
      const acc = await rpc("accept_partner_invite", { p_token: token });
      if (!acc.ok) { setError(reasonText(acc.reason)); setBusy(false); return; }
      window.location.hash = "";
      onDone();
    } catch (err) { setError("Could not reach fleetr. Check the connection and try again."); setBusy(false); }
  };
  return h("div", { className: "auth" }, h("form", { className: "auth__card", onSubmit: submit }, logo("auth__logo"),
    h("h1", { className: "auth__title" }, `Book rentals with ${info.company}`),
    h("p", { className: "note" }, `Hi ${String(info.name || "").split(" ")[0]}. Set a password for your ${info.partner} account. You'll sign in with ${info.email}.`),
    h(Field, { label: "Password", hint: "At least 8 characters, with letters and a number." },
      Input({ type: "password", autoComplete: "new-password", value: pw, onChange: (e) => setPw(e.target.value), minLength: 8, required: true })),
    error && h("p", { className: "error", role: "alert" }, error),
    h(Btn, { lg: true, block: true, type: "submit", loading: busy, disabled: pw.length < 8 }, "Set password and continue")));
}

function SignIn({ onDone, onForgot }) {
  const [email, setEmail] = React.useState("");
  const [pw, setPw] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setError("");
    const { error: err } = await supabase.auth.signIn({ email: email.trim().toLowerCase(), password: pw });
    setBusy(false);
    if (err) { setError("That email and password don't match. Check them and try again."); return; }
    onDone();
  };
  return h("div", { className: "auth" }, h("form", { className: "auth__card", onSubmit: submit }, logo("auth__logo"),
    h("h1", { className: "auth__title" }, "Partner sign in"),
    h("p", { className: "note" }, "For body shops, insurers and dealerships booking replacement rentals."),
    h(Field, { label: "Email" }, Input({ type: "email", autoComplete: "email", inputMode: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })),
    h(Field, { label: "Password" }, Input({ type: "password", autoComplete: "current-password", value: pw, onChange: (e) => setPw(e.target.value), required: true })),
    error && h("p", { className: "error", role: "alert" }, error),
    h(Btn, { lg: true, block: true, type: "submit", loading: busy, disabled: !email || !pw }, "Sign in"),
    h(Btn, { variant: "quiet", onClick: onForgot }, "Forgot your password?")));
}

// The same as staff: a link by email, to the address the invite went to.
function Forgot({ onBack }) {
  const [email, setEmail] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    await fetch(`${RESET_URL}/partner/forgot`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim().toLowerCase() }) }).catch(() => null);
    setBusy(false); setSent(true);
  };
  return h("div", { className: "auth" }, h("form", { className: "auth__card", onSubmit: submit }, logo("auth__logo"),
    h("h1", { className: "auth__title" }, "Reset your password"),
    sent ? h("p", { className: "ok", role: "status" }, `If ${email.trim()} has a partner account, a link to choose a new password is on its way. It works for an hour.`)
      : h("p", { className: "note" }, "Enter the email you sign in with. We'll send a link to choose a new password."),
    !sent && h(Field, { label: "Email" }, Input({ type: "email", autoComplete: "email", inputMode: "email", value: email, onChange: (e) => setEmail(e.target.value), required: true })),
    !sent && h(Btn, { lg: true, block: true, type: "submit", loading: busy, disabled: !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim()) }, "Send link"),
    h(Btn, { variant: "quiet", onClick: onBack }, "Back to sign in")));
}

// ── Availability ──
function Availability({ home, branchId, setBranchId, onBook }) {
  const [av, setAv] = React.useState(null);
  React.useEffect(() => { if (branchId) { setAv(null); rpc("partner_availability", { p_location_id: branchId }).then(setAv); } }, [branchId]);
  return h("div", null,
    h("h1", { className: "pp__h1" }, "Availability"),
    h("p", { className: "pp__lead" }, `What ${home.company} has free over the next two weeks, by class. Book straight from here.`),
    home.branches.length > 1 && h("div", { style: { marginBottom: 16 } }, h(Field, { label: "Branch" },
      h("select", { className: "input", value: branchId || "", onChange: (e) => setBranchId(e.target.value) }, home.branches.map((b) => h("option", { key: b.id, value: b.id }, b.name))))),
    !av ? h("div", { className: "card card__pad stack" }, [0, 1, 2].map((i) => h("span", { key: i, className: "skel", style: { height: 44 } })))
    : !av.ok ? h("p", { className: "error" }, reasonText(av.reason))
    : !av.classes.length ? h("div", { className: "card empty" }, h("h3", null, "No classes yet"), h("p", null, "The rental company hasn't added its cars yet."))
    : h("div", { className: "card" }, h("div", { className: "avail" }, av.classes.map((c) => h("div", { key: c.vehicleClass, className: "avail__row" },
        h("span", { className: "avail__name" }, c.vehicleClass),
        h("span", { className: `avail__when${c.freeToday > 0 ? " avail__when--now" : ""}` },
          c.freeToday > 0 ? `${c.freeToday} free today` : c.nextOpen ? `Next free ${fmtDay(c.nextOpen)}` : "None free in 60 days"),
        h("span", { className: "avail__strip", "aria-label": `${c.vehicleClass}, next 14 days` }, (c.days || []).map((d, i) =>
          h("span", { key: d.day, title: `${fmtDay(d.day)}: ${d.free} free`, className: `avail__day${d.free > 1 ? " avail__day--free" : d.free === 1 ? " avail__day--low" : ""}${i === 0 ? " avail__day--today" : ""}` })))))),
        h("div", { className: "avail__legend" }, h("span", null, h("i", { style: { background: "rgba(23,104,63,0.22)" } }), "Free"),
          h("span", null, h("i", { style: { background: "rgba(244,132,95,0.14)" } }), "Last one"), h("span", null, h("i", { style: { background: "#F1F0EC" } }), "Booked"))),
    h("div", { className: "foot" }, h(Btn, { lg: true, onClick: onBook }, "Book a replacement rental")));
}

// ── Booking (Nov 17): what an insurer or shop has to hand comes first: the
// claim or repair order number, the renter, the approved class or a daily
// limit, and the estimated repair days. The car being repaired, its VIN, an
// email and a note are optional, after. One form, one button.
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const classRate = (c) => (c && c.dailyRate != null && c.dailyRate !== "" ? Number(c.dailyRate) : null);
// Within a daily limit: classes priced for this partner at or under it, the
// dearest first, so the default is the best car the limit pays for.
function classesWithin(classes, limit) {
  return (classes || []).filter((c) => classRate(c) != null && classRate(c) <= limit).sort((x, y) => classRate(y) - classRate(x));
}
function Book({ home, branchId, onBooked, onCancel }) {
  const insurer = home.partner.kind === "insurer";
  const [f, setF] = React.useState({ reference: "", firstName: "", lastName: "", phone: "", approve: "class", classId: "", limit: "",
    days: "", pickDate: isoDay(1), pickTime: "09:00", locationId: branchId || (home.branches[0] && home.branches[0].id) || "", email: "", note: "" });
  const [v, setV] = React.useState({ vin: "", year: "", make: "", model: "" });
  const [more, setMore] = React.useState(false);
  const [decoding, setDecoding] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const set = (k, val) => setF((x) => ({ ...x, [k]: val }));
  // A VIN fills in the rest, from the US government's free decoder.
  React.useEffect(() => {
    const vin = v.vin.trim().toUpperCase();
    if (vin.length !== 17) return undefined;
    let live = true;
    setDecoding(true);
    fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`).then((r) => r.json()).then((d) => {
      const x = d && d.Results && d.Results[0];
      if (!live || !x) return;
      setV((p) => ({ ...p, year: x.ModelYear || p.year, make: x.Make ? x.Make.charAt(0) + x.Make.slice(1).toLowerCase() : p.make, model: x.Model || p.model }));
    }).catch(() => null).finally(() => { if (live) setDecoding(false); });
    return () => { live = false; };
  }, [v.vin]);
  // A daily limit can only be checked against this partner's own rates; with
  // none set up (found on staging: Louie's Collision Repair), it books by class.
  const priced = home.classes.some((c) => classRate(c) != null);
  const approve = priced ? f.approve : "class";
  const limit = Number(f.limit) > 0 ? Number(f.limit) : null;
  const within = limit != null ? classesWithin(home.classes, limit) : [];
  // With a class approved, the one picked, else the like-for-like match once
  // the repair vehicle is filled in. With a limit, the one picked if it fits,
  // else the best the limit pays for.
  const matched = v.make.trim() && v.model.trim() ? matchClass(v, home.classes) : null;
  const cid = approve === "class" ? (f.classId || (matched ? matched.id : ""))
    : (within.some((c) => c.id === f.classId) ? f.classId : (within[0] ? within[0].id : ""));
  const chosen = home.classes.find((c) => c.id === cid) || null;
  const days = /^\d{1,3}$/.test(f.days) ? Number(f.days) : 0;
  const retDate = days ? addDays(f.pickDate, days) : "";
  const problems = {
    reference: !f.reference.trim() ? (insurer ? "Add the claim number." : "Add the repair order number.") : "",
    name: !f.firstName.trim() || !f.lastName.trim() ? "Add the renter's first and last name." : "",
    phone: f.phone.replace(/\D/g, "").length < 10 ? "Add the renter's mobile number, with the area code." : "",
    cls: approve === "limit" ? (!limit ? "Add the daily limit." : !within.length ? `No class is priced at ${money(limit)} a day or less. Call the branch.` : "")
      : !cid ? "Pick the approved class." : "",
    days: !days || days > 120 ? "Add the estimated repair days, 1 to 120." : "",
    pick: !f.pickDate || !f.locationId ? "Pick the pickup day." : "",
  };
  const ok = !Object.values(problems).some(Boolean);
  const show = (k) => (tried && problems[k] ? h("small", { className: "error", role: "alert" }, problems[k]) : null);
  const book = async () => {
    setTried(true);
    if (!ok) return;
    setBusy(true); setError("");
    const out = await rpc("partner_book", { p: { locationId: f.locationId, classId: cid, pickup: `${f.pickDate} ${f.pickTime}`, return: `${retDate} ${f.pickTime}`,
      firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email, reference: f.reference, note: f.note,
      dailyLimit: approve === "limit" ? String(limit) : "", repairDays: String(days),
      repairVehicle: { year: v.year, make: v.make, model: v.model, vin: v.vin.trim().toUpperCase() } } });
    setBusy(false);
    if (!out.ok) { setError(reasonText(out.reason)); return; }
    onBooked(out);
  };
  const ff = (k, label, props = {}) => h(Field, { label, hint: props.hint }, Input({ value: f[k], onChange: (e) => set(k, e.target.value), ...props, hint: undefined }));
  const vf = (k, label, props = {}) => h(Field, { label }, Input({ value: v[k], onChange: (e) => { const val = e.target.value; setV((x) => ({ ...x, [k]: val })); }, ...props }));
  const classLabel = (c) => (classRate(c) != null ? `${c.name}, ${money(classRate(c))}/day` : c.name);
  return h("div", { className: "book" },
    h("h1", { className: "pp__h1" }, "Book a replacement rental"),
    h("p", { className: "pp__lead" }, "The essentials first. The car being repaired and the rest are optional."),
    h("section", { className: "book__sec", "aria-labelledby": "bk-ref" },
      h("h2", { className: "book__h", id: "bk-ref" }, insurer ? "The claim" : "The repair"),
      ff("reference", insurer ? "Claim number" : "Repair order number", { autoCapitalize: "characters", maxLength: 40, autoComplete: "off" }), show("reference")),
    h("section", { className: "book__sec", "aria-labelledby": "bk-who" },
      h("h2", { className: "book__h", id: "bk-who" }, "Renter"),
      h("div", { className: "grid2" }, ff("firstName", "First name", { autoComplete: "off" }), ff("lastName", "Last name", { autoComplete: "off" })), show("name"),
      ff("phone", "Mobile number", { type: "tel", inputMode: "tel", autoComplete: "off", hint: "They get a text with a link to check in, so pickup takes a minute." }), show("phone")),
    h("section", { className: "book__sec", "aria-labelledby": "bk-ok" },
      h("h2", { className: "book__h", id: "bk-ok" }, "Approved"),
      priced
        ? h("div", { className: "segs", role: "radiogroup", "aria-label": "What was approved" },
            [["class", "A class"], ["limit", "A daily limit"]].map(([k, label]) => h("button", { key: k, type: "button", role: "radio", "aria-checked": approve === k,
              className: approve === k ? "on" : "", onClick: () => set("approve", k) }, label)))
        : h("p", { className: "note" }, `Your rates aren't set up with ${home.company} yet, so pick the approved class. The branch prices it.`),
      approve === "class"
        ? h(Field, { label: "Class" }, h("select", { className: "input", value: cid, onChange: (e) => set("classId", e.target.value) },
            h("option", { value: "" }, "Pick a class"), home.classes.map((c) => h("option", { key: c.id, value: c.id }, classLabel(c)))))
        : h("div", { className: "grid2" },
            h(Field, { label: "Daily limit ($)" }, Input({ value: f.limit, inputMode: "decimal", maxLength: 7, placeholder: "50", onChange: (e) => set("limit", e.target.value.replace(/[^0-9.]/g, "")) })),
            h(Field, { label: "Class within it" }, h("select", { className: "input", value: cid, disabled: !within.length, onChange: (e) => set("classId", e.target.value) },
              !within.length && h("option", { value: "" }, limit ? "None within the limit" : "Add the limit first"),
              within.map((c) => h("option", { key: c.id, value: c.id }, classLabel(c)))))),
      show("cls"),
      // Only when it adds something: the price, or the match it came from.
      chosen && (classRate(chosen) != null || (approve === "class" && matched && chosen.id === matched.id && !f.classId)) && h("p", { className: "note" }, `${chosen.name}${classRate(chosen) != null ? ` at ${money(classRate(chosen))} a day` : ""}${approve === "class" && matched && chosen.id === matched.id && !f.classId ? `, matched to the ${[v.year, v.make, v.model].filter(Boolean).join(" ")}` : ""}.`)),
    h("section", { className: "book__sec", "aria-labelledby": "bk-when" },
      h("h2", { className: "book__h", id: "bk-when" }, "Repair and pickup"),
      h("div", { className: "grid2" },
        ff("days", "Estimated repair days", { inputMode: "numeric", maxLength: 3, placeholder: "7" }),
        home.branches.length > 1 && h(Field, { label: "Branch" }, h("select", { className: "input", value: f.locationId, onChange: (e) => set("locationId", e.target.value) },
          home.branches.map((b) => h("option", { key: b.id, value: b.id }, b.name))))),
      show("days"),
      h("div", { className: "grid2" }, ff("pickDate", "Pickup date", { type: "date", min: isoDay(0) }), ff("pickTime", "Time", { type: "time", step: 900 })), show("pick"),
      retDate && h("p", { className: "note" }, `Back about ${fmtDay(retDate)}. You can ask to extend later.`)),
    h("button", { type: "button", className: "book__more", "aria-expanded": more, onClick: () => setMore((m) => !m) },
      h("span", null, more ? "Hide the optional details" : "Add the car being repaired, an email or a note"), h("span", { "aria-hidden": "true" }, more ? "−" : "+")),
    more && h("section", { className: "book__sec book__sec--more", "aria-label": "Optional details" },
      vf("vin", "VIN of the car being repaired", { maxLength: 17, autoCapitalize: "characters", spellCheck: false, placeholder: "17 characters" }),
      decoding && h("p", { className: "note" }, "Reading the VIN…"),
      h("div", { className: "grid2" }, vf("year", "Year", { inputMode: "numeric", maxLength: 4 }), vf("make", "Make", { autoComplete: "off" })),
      vf("model", "Model", { autoComplete: "off" }),
      ff("email", "Renter's email", { type: "email", inputMode: "email", autoComplete: "off" }),
      h(Field, { label: "Note for the branch" }, h("textarea", { className: "input", value: f.note, maxLength: 300, onChange: (e) => set("note", e.target.value) }))),
    h("p", { className: "note" }, home.bookingMode === "auto" ? "It's booked as soon as you send it." : `${home.company} confirms each booking. You'll be notified here.`),
    error && h("p", { className: "error", role: "alert" }, error),
    tried && !ok && h("p", { className: "error", role: "alert" }, "Fill in the fields marked above."),
    h("div", { className: "foot" },
      h(Btn, { variant: "secondary", lg: true, onClick: onCancel, disabled: busy }, "Cancel"),
      h(Btn, { lg: true, onClick: book, loading: busy }, home.bookingMode === "auto" ? "Book" : "Send booking")));
}

// ── Rentals ──
const STAGE = { requested: "Waiting for the branch", booked: "Booked", out: "Out", returned: "Returned", declined: "Not booked" };
const OPEN_STAGES = ["requested", "booked", "out"];
function Rentals({ home, reload, flash }) {
  const [ext, setExt] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  if (!home.rentals.length) return h("div", null, h("h1", { className: "pp__h1" }, "Your rentals"),
    h("div", { className: "card empty" }, h("h3", null, "No rentals yet"), h("p", null, "Replacement rentals you book show here, with where each one stands.")));
  const ask = async () => {
    setBusy(true); setError("");
    const out = await rpc("partner_request_extension", { p_res_code: ext.resCode, p_return_date: ext.date, p_reason: ext.reason });
    setBusy(false);
    if (!out.ok) { setError(reasonText(out.reason)); return; }
    setExt(null); flash("Extension requested. The branch will answer here."); reload();
  };
  // Rentals, rebuilt (overnight-nov17): the open ones first, each with
  // when it comes back; the finished ones below, out of the way.
  const open = home.rentals.filter((r) => OPEN_STAGES.includes(r.stage));
  const done = home.rentals.filter((r) => !OPEN_STAGES.includes(r.stage));
  const row = (r) => h("div", { key: r.resCode, className: "item" },
      h("div", { className: "item__top" }, h("span", { className: "item__title" }, r.customer), h("span", { className: `chip chip--${r.stage}` }, STAGE[r.stage] || r.stage)),
      h("div", { className: "item__meta" }, `${r.vehicleClass}${r.plate ? `, ${r.plate}` : ""}. ${fmtDay(r.date)} to ${fmtDay(r.returnDate)}.`),
      h("div", { className: "item__meta" }, h("span", { className: "code" }, r.resCode), r.claimNumber ? ` · ${/^claim/i.test(r.claimNumber) ? "" : "Claim "}${r.claimNumber}` : r.repairOrder ? ` · ${/^ro\b/i.test(r.repairOrder) ? "" : "RO "}${r.repairOrder}` : "",
        r.repairVehicle && r.repairVehicle.make ? ` · ${[r.repairVehicle.year, r.repairVehicle.make, r.repairVehicle.model].filter(Boolean).join(" ")}` : ""),
      r.extension === "requested" && h("div", { className: "item__meta" }, "Extension asked for, waiting for the branch."),
      ["booked", "out"].includes(r.stage) && r.extension !== "requested" && (ext && ext.resCode === r.resCode
        ? h("div", { className: "stack", style: { marginTop: 8 } },
            h(Field, { label: "New return date" }, Input({ type: "date", min: r.returnDate, value: ext.date, onChange: (e) => setExt({ ...ext, date: e.target.value }) })),
            h(Field, { label: "Why (optional)" }, Input({ value: ext.reason, maxLength: 300, placeholder: "Parts delayed", onChange: (e) => setExt({ ...ext, reason: e.target.value }) })),
            error && h("p", { className: "error", role: "alert" }, error),
            h("div", { className: "item__actions" }, h(Btn, { onClick: ask, loading: busy, disabled: !ext.date }, "Ask to extend"), h(Btn, { variant: "quiet", onClick: () => setExt(null) }, "Cancel")))
        : h("div", { className: "item__actions" }, h(Btn, { variant: "secondary", onClick: () => { setError(""); setExt({ resCode: r.resCode, date: "", reason: "" }); } }, "Extend"))));
  return h("div", null, h("h1", { className: "pp__h1" }, "Your rentals"),
    h("p", { className: "pp__lead" }, open.length ? `${open.length} open with ${home.company}.` : `Nothing open with ${home.company} right now.`),
    open.length > 0 && h("section", { "aria-label": "Open rentals" }, h("h2", { className: "pp__h2" }, "Open"), h("div", { className: "card list" }, open.map(row))),
    done.length > 0 && h("section", { className: open.length ? "pp__section" : "", "aria-label": "Finished rentals" }, h("h2", { className: "pp__h2" }, "Finished"), h("div", { className: "card list" }, done.map(row))));
}

// ── Invoices ──
function Invoices({ home, reload, flash }) {
  const [open, setOpen] = React.useState(null);
  const [ref, setRef] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  if (!home.invoices.length) return h("div", null, h("h1", { className: "pp__h1" }, "Invoices"),
    h("div", { className: "card empty" }, h("h3", null, "No invoices"), h("p", null, `${home.company} sends an invoice when a rental closes. It shows here, to pay by card or bank transfer.`)));
  const owing = home.invoices.filter((i) => i.status !== "paid").reduce((a, i) => a + Number(i.amount || 0), 0);
  const sent = async (inv) => {
    setBusy(true); setError("");
    const out = await rpc("partner_report_transfer", { p_invoice_id: inv.id, p_reference: ref });
    setBusy(false);
    if (!out.ok) { setError(reasonText(out.reason)); return; }
    setOpen(null); setRef(""); flash("Thanks. The branch will mark it paid when it arrives."); reload();
  };
  // Invoices, rebuilt (overnight-nov17): what is owed, in one number,
  // then the ones to pay, then the paid ones.
  const unpaid = home.invoices.filter((i) => i.status !== "paid");
  const paid = home.invoices.filter((i) => i.status === "paid");
  const row = (i) => h("div", { key: i.id, className: "item" },
      h("div", { className: "item__top" }, h("span", { className: "item__title" }, `Invoice ${i.number}`), h("span", { className: "money" }, money(i.amount))),
      h("div", { className: "item__meta" }, `Rental ${i.resCode}. Sent ${fmtDay(i.issuedAt)}${i.status !== "paid" ? `, due ${fmtDay(i.dueAt)}` : ""}.`),
      i.status === "paid" ? h("span", { className: "chip chip--paid" }, "Paid")
      : i.transferSent ? h("div", { className: "item__meta" }, "Bank transfer sent. The branch marks it paid when it arrives.")
      : open === i.id ? h("div", { className: "stack", style: { marginTop: 8 } },
          home.bankTransferDetails ? h("div", { className: "bank" }, home.bankTransferDetails) : h("p", { className: "note" }, "Ask the branch for its bank details."),
          h(Field, { label: "Your transfer reference (optional)" }, Input({ value: ref, maxLength: 80, onChange: (e) => setRef(e.target.value) })),
          error && h("p", { className: "error", role: "alert" }, error),
          h("div", { className: "item__actions" }, h(Btn, { onClick: () => sent(i), loading: busy }, "I've sent it"), h(Btn, { variant: "quiet", onClick: () => setOpen(null) }, "Cancel")))
      : h("div", { className: "item__actions" },
          i.payUrl && h("a", { className: "btn btn--primary", href: i.payUrl, target: "_blank", rel: "noopener" }, "Pay by card"),
          h(Btn, { variant: "secondary", onClick: () => { setError(""); setOpen(i.id); } }, "Pay by bank transfer")));
  return h("div", null, h("h1", { className: "pp__h1" }, "Invoices"),
    h("div", { className: `card card__pad owing${owing > 0 ? "" : " owing--clear"}` },
      h("span", { className: "owing__label" }, owing > 0 ? `Owing to ${home.company}` : "All paid"),
      h("span", { className: "owing__n" }, money(owing)),
      h("span", { className: "owing__sub" }, owing > 0 ? `${unpaid.length} invoice${unpaid.length === 1 ? "" : "s"} to pay` : "Thank you.")),
    unpaid.length > 0 && h("section", { className: "pp__section", "aria-label": "To pay" }, h("h2", { className: "pp__h2" }, "To pay"), h("div", { className: "card list" }, unpaid.map(row))),
    paid.length > 0 && h("section", { className: "pp__section", "aria-label": "Paid" }, h("h2", { className: "pp__h2" }, "Paid"), h("div", { className: "card list" }, paid.map(row))));
}

function Notifications({ items, onClose }) {
  React.useEffect(() => { rpc("partner_mark_read"); }, []);
  React.useEffect(() => { const k = (e) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  return h("div", { className: "sheetBg", onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
    h("div", { className: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Notifications" },
      h("div", { className: "sheet__head" }, h("h2", null, "Notifications"), h(Btn, { variant: "quiet", onClick: onClose }, "Close")),
      !items.length ? h("div", { className: "empty" }, h("h3", null, "Nothing new"), h("p", null, "Bookings, extensions and payments show here as they happen."))
      : items.map((n) => h("div", { key: n.id, className: `notif${n.read ? "" : " notif--new"}` }, h("strong", null, n.title), n.body && h("p", null, n.body),
          h("small", null, new Date(n.createdAt).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))))));
}

function Portal({ onSignOut }) {
  const [home, setHome] = React.useState(null);
  // null until the first load picks: Rentals when some are open, else
  // Availability (overnight-nov17).
  const [tab, setTab] = React.useState(null);
  const [booking, setBooking] = React.useState(false);
  const [branchId, setBranchId] = React.useState("");
  const [notif, setNotif] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const load = React.useCallback(() => rpc("partner_home").then((d) => {
    setHome(d);
    if (d.ok && !branchId && d.branches[0]) setBranchId(d.branches[0].id);
    if (d.ok) setTab((t) => t || ((d.rentals || []).some((r) => OPEN_STAGES.includes(r.stage)) ? "rentals" : "availability"));
  }), [branchId]);
  React.useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(""), 5000); };
  if (!home) return h("div", { className: "pp__main stack" }, [0, 1, 2].map((i) => h("span", { key: i, className: "skel", style: { height: i ? 64 : 32 } })));
  if (!home.ok) return h("div", { className: "auth" }, h("div", { className: "auth__card" }, logo("auth__logo"), h("h1", { className: "auth__title" }, "No partner account"),
    h("p", { className: "note" }, reasonText(home.reason)), h(Btn, { variant: "secondary", onClick: onSignOut }, "Sign out")));
  const unread = home.notifications.filter((n) => !n.read).length;
  const openCount = home.rentals.filter((r) => OPEN_STAGES.includes(r.stage)).length;
  const owingCount = home.invoices.filter((i) => i.status !== "paid" && !i.transferSent).length;
  const tabs = [["availability", "Availability", 0], ["rentals", "Rentals", openCount], ["invoices", "Invoices", owingCount]];
  const shown = tab || "availability";
  return h("div", { className: "pp" },
    h("header", { className: "pp__top" }, logo("pp__logo"),
      h("span", { className: "pp__who" }, h("strong", null, home.partner.name), h("small", null, `with ${home.company}`)),
      h("button", { type: "button", className: "pp__bell", "aria-label": unread ? `Notifications, ${unread} new` : "Notifications", onClick: () => setNotif(true) },
        h("svg", { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
          h("path", { d: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" }), h("path", { d: "M10.3 21a1.9 1.9 0 0 0 3.4 0" })),
        unread > 0 && h("span", { className: "pp__dot" }, unread)),
      !booking && h(Btn, { className: "pp__book", onClick: () => setBooking(true) }, "Book a rental")),
    h("nav", { className: "pp__tabs", role: "tablist", "aria-label": "Portal" }, tabs.map(([k, label, n]) => h("button", { key: k, type: "button", role: "tab", className: "pp__tab", "aria-selected": shown === k && !booking,
      onClick: () => { setBooking(false); setTab(k); } }, label, n > 0 && h("span", { className: "pp__count", "aria-label": `, ${n}` }, n)))),
    h("main", { className: "pp__main" },
      msg && h("p", { className: "ok", role: "status", style: { marginBottom: 16 } }, msg),
      booking ? h(Book, { home, branchId, onCancel: () => setBooking(false),
          onBooked: (out) => { setBooking(false); setTab("rentals"); flash(out.status === "accepted" ? `Booked: ${out.vehicleClass}, reservation ${out.resCode}.` : `Sent to ${home.company}. You'll be notified when it's confirmed.`); load(); } })
      : shown === "availability" ? h(Availability, { home, branchId, setBranchId, onBook: () => setBooking(true) })
      : shown === "rentals" ? h(Rentals, { home, reload: load, flash })
      : h(Invoices, { home, reload: load, flash }),
      h("footer", { className: "pp__foot" }, h("span", null, `Signed in for ${home.partner.name}`), h(Btn, { variant: "quiet", onClick: onSignOut }, "Sign out"))),
    notif && h(Notifications, { items: home.notifications, onClose: () => { setNotif(false); load(); } }));
}

function App() {
  const [session, setSession] = React.useState(() => supabase.auth.session());
  // The invite is state, not read from the address each render: once joined,
  // it is cleared here so the portal shows straight away (found on staging:
  // the join screen stayed up until a reload).
  const [invite, setInvite] = React.useState(() => (window.location.hash.match(/invite=([0-9a-f]{48})/) || [])[1] || "");
  React.useEffect(() => { const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s)); return () => data && data.unsubscribe(); }, []);
  const refresh = () => setSession(supabase.auth.session());
  const [forgot, setForgot] = React.useState(false);
  if (invite) return h(Join, { token: invite, onDone: () => { setInvite(""); refresh(); } });
  if (!session) return forgot ? h(Forgot, { onBack: () => setForgot(false) }) : h(SignIn, { onDone: refresh, onForgot: () => setForgot(true) });
  return h(Portal, { onSignOut: async () => { await supabase.auth.signOut(); refresh(); } });
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App));
