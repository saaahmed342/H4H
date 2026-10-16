// Hands for Humankind Volunteer Hub: zero-dependency Node server (Node 18+).
// Run: node server.js   (set ADMIN_CODE to your own secret first)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || "h4h-admin";
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC = path.join(__dirname, "public");
const UPLOADS = path.join(__dirname, "uploads"); // local-testing fallback for gallery photos
const BUCKET = "gallery";                       // Supabase Storage bucket for gallery photos

// ---------- storage ----------
// With SUPABASE_URL + SUPABASE_SECRET_KEY set, all data is saved in a Supabase table (survives restarts).
// Without them (local testing), data is saved to data.json instead.
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SECRET_KEY || "";
const useSupabase = Boolean(SB_URL && SB_KEY);
const sbHeaders = () => {
  const h = { apikey: SB_KEY, "Content-Type": "application/json" };
  if (SB_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + SB_KEY; // legacy JWT-style keys
  return h;
};

let CACHE = null;   // the whole database lives in memory; every change is written out right after
function load() { return CACHE; }

async function writeOut(db) {
  if (useSupabase) {
    const r = await fetch(`${SB_URL}/rest/v1/h4h_store?on_conflict=key`, {
      method: "POST",
      headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ key: "main", value: db, updated_at: new Date().toISOString() }])
    });
    if (!r.ok) throw new Error(`Supabase write failed (${r.status}): ${await r.text()}`);
  } else {
    fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db, null, 2));
    fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
  }
}
let saving = false, again = false;
async function flush() {
  if (saving) { again = true; return; }
  saving = true;
  try { do { again = false; await writeOut(CACHE); } while (again); }
  catch (e) { console.error("SAVE FAILED, retrying in 5s:", e.message); setTimeout(flush, 5000); }
  finally { saving = false; }
}
function save(db) { CACHE = db; flush(); }

// ---------- gallery photo files ----------
// Photos are JPEG files (the browser shrinks them first). With Supabase they live in the public "gallery"
// bucket; without it they go in ./uploads. Only captions and file names are kept in the main database.
const storageHeaders = (type) => {
  const h = { apikey: SB_KEY, "Content-Type": type };
  if (SB_KEY.startsWith("eyJ")) h.Authorization = "Bearer " + SB_KEY;
  return h;
};
const imageUrl = (name) => (useSupabase ? `${SB_URL}/storage/v1/object/public/${BUCKET}/${name}` : `/uploads/${name}`);
async function ensureBucket() {
  try {
    const r = await fetch(`${SB_URL}/storage/v1/bucket`, { method: "POST", headers: storageHeaders("application/json"), body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }) });
    if (!r.ok) {
      const t = await r.text();
      if (!/already exists|duplicate/i.test(t)) console.warn(`Gallery: could not create the "${BUCKET}" storage bucket (${r.status}): ${t}. Create it by hand in Supabase: Storage > New bucket > "${BUCKET}" > Public.`);
    }
  } catch (e) { console.warn("Gallery: storage check failed:", e.message); }
}
async function putImage(name, buf) {
  if (useSupabase) {
    const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${name}`, { method: "POST", headers: { ...storageHeaders("image/jpeg"), "Cache-Control": "max-age=31536000" }, body: buf });
    if (!r.ok) throw new Error(`Storage upload failed (${r.status}): ${await r.text()}`);
  } else {
    fs.mkdirSync(UPLOADS, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, name), buf);
  }
}
async function removeImage(name) { // best effort: a leftover file is harmless, a failed delete shouldn't block the officer
  try {
    if (useSupabase) await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${name}`, { method: "DELETE", headers: storageHeaders("application/json") });
    else fs.rmSync(path.join(UPLOADS, name), { force: true });
  } catch (e) { console.warn("Gallery: could not delete", name, e.message); }
}
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const decodeJpeg = (b64, max) => {
  if (typeof b64 !== "string" || !b64) return null;
  const buf = Buffer.from(b64, "base64");
  return isJpeg(buf) && buf.length <= max ? buf : null;
};

function seedData() {
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  return {
    users: {}, adjustments: [], photos: [],
    events: [
      { id: "e1", title: "Food Pantry Sorting", description: "Sort and shelve donated goods so families can shop on Saturday.", location: "Community Center, Room 2", date: day(3), start: "16:00", end: "18:00", capacity: 10, signups: [], attendance: {} },
      { id: "e2", title: "Park Cleanup", description: "Bring gloves and water. Bags and grabbers provided.", location: "Main entrance of the park", date: day(9), start: "10:00", end: "13:00", capacity: 15, signups: [], attendance: {} }
    ]
  };
}
async function init() {
  let db = null;
  if (useSupabase) {
    const r = await fetch(`${SB_URL}/rest/v1/h4h_store?key=eq.main&select=value`, { headers: sbHeaders() });
    if (!r.ok) throw new Error(`Could not read from Supabase (${r.status}): ${await r.text()}`);
    const rows = await r.json();
    db = rows.length ? rows[0].value : null;
  } else {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
  }
  const fresh = !db;
  db = db || seedData();
  db.users ||= {}; db.events ||= []; db.adjustments ||= []; db.photos ||= [];
  CACHE = db;
  if (fresh) await writeOut(db);
  if (useSupabase) await ensureBucket();
  console.log(`Storage: ${useSupabase ? "Supabase" : "local data.json"} (${Object.keys(db.users).length} volunteers, ${db.events.length} events)`);
}

// ---------- helpers ----------
const ts = (d, t) => new Date(`${d}T${t}:00`).getTime();
const hoursOf = (e) => Math.max(0, (ts(e.date, e.end) - ts(e.date, e.start)) / 36e5);
const isPast = (e) => ts(e.date, e.end) < Date.now();
const cleanName = (s) => String(s || "").trim().toLowerCase();
const validEmail = (s) => s.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(s);
const hasUser = (db, k) => Object.prototype.hasOwnProperty.call(db.users, k);
const dec = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
const round2 = (n) => Math.round(n * 100) / 100;

const statusFor = (e, u) => { const i = e.signups.indexOf(u); return i === -1 ? null : i < e.capacity ? "joined" : "waitlisted"; };
// attendance review: pending (default) | approved | absent
const approvalOf = (e, u) => ((e.attendance || {})[u] || {}).status || "pending";
const creditOf = (e, u) => {
  const a = (e.attendance || {})[u];
  return a && a.status === "approved" ? (typeof a.hours === "number" ? a.hours : hoursOf(e)) : 0;
};

function publicEvent(e, user) {
  return {
    id: e.id, title: e.title, description: e.description, location: e.location,
    date: e.date, start: e.start, end: e.end, hours: hoursOf(e), capacity: e.capacity,
    taken: Math.min(e.signups.length, e.capacity),
    waitlist: Math.max(0, e.signups.length - e.capacity),
    past: isPast(e), canceled: !!e.canceled, status: user ? statusFor(e, user) : null,
    waitlistPosition: user && e.signups.indexOf(user) >= e.capacity ? e.signups.indexOf(user) - e.capacity + 1 : null
  };
}
function publicPhoto(db, ph) {
  const ev = ph.eventId ? db.events.find((e) => e.id === ph.eventId) : null;
  return { id: ph.id, url: imageUrl(ph.file), thumb: imageUrl(ph.thumb), caption: ph.caption || "", eventId: ev ? ev.id : null,
    eventTitle: ev ? ev.title : ph.eventTitle || "", date: ev ? ev.date : "", createdAt: ph.createdAt };
}
function stats(db, user) {
  const mine = db.events.filter((e) => statusFor(e, user));
  const joined = mine.filter((e) => statusFor(e, user) === "joined" && !e.canceled); // canceled events never count
  const canceled = mine.filter((e) => e.canceled && !isPast(e)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map((e) => publicEvent(e, user));
  const completed = joined.filter(isPast).sort((a, b) => b.date.localeCompare(a.date))
    .map((e) => ({ ...publicEvent(e, user), approval: approvalOf(e, user), credited: creditOf(e, user) }));
  const upcoming = joined.filter((e) => !isPast(e)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map((e) => publicEvent(e, user));
  const waitlisted = mine.filter((e) => statusFor(e, user) === "waitlisted" && !isPast(e) && !e.canceled).map((e) => publicEvent(e, user));
  const adjustments = db.adjustments.filter((a) => a.username === user);
  const adjTotal = adjustments.reduce((s, a) => s + a.hours, 0);
  return {
    hours: round2(completed.reduce((s, e) => s + e.credited, 0) + adjTotal),
    pendingHours: round2(completed.filter((e) => e.approval === "pending").reduce((s, e) => s + e.hours, 0)),
    joinedCount: joined.length, upcoming, completed, waitlisted, canceled, adjustments
  };
}
const csvCell = (v) => {
  let s = String(v ?? "");
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running names/emails as formulas
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ---------- http ----------
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function readBody(req, limit = 1e5) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > limit) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/healthz") return send(res, 200, "ok", "text/plain");

  if (p.startsWith("/api/")) {
    const db = load();
    const user = cleanName(req.headers["x-username"]);
    const known = user && hasUser(db, user) ? user : null;
    const isAdmin = req.headers["x-admin-code"] === ADMIN_CODE;
    const bigUpload = isAdmin && p === "/api/admin/photos" && req.method === "POST"; // two shrunken JPEGs as base64
    const body = req.method === "GET" ? {} : await readBody(req, bigUpload ? 8e6 : 1e5);
    let m;

    // log in, or create an account (email + name, no password)
    if (p === "/api/login" && req.method === "POST") {
      const key = cleanName(body.email || body.username);
      if (hasUser(db, key)) { // existing account, including older username accounts
        return send(res, 200, { email: key, displayName: db.users[key].displayName, created: false });
      }
      const displayName = String(body.displayName || "").trim().slice(0, 40);
      if (!validEmail(key)) return send(res, 400, { error: "Enter a valid email address, like name@example.com." });
      if (!displayName) return send(res, 400, { error: "Enter your name to create your account." });
      db.users[key] = { displayName, createdAt: Date.now() };
      save(db);
      return send(res, 200, { email: key, displayName, created: true });
    }

    if (p === "/api/events" && req.method === "GET") {
      const list = db.events.map((e) => publicEvent(e, known)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
      return send(res, 200, { events: list });
    }

    if (p === "/api/photos" && req.method === "GET") {
      const list = db.photos.slice().sort((a, b) => b.createdAt - a.createdAt).map((ph) => publicPhoto(db, ph));
      return send(res, 200, { photos: list });
    }

    m = p.match(/^\/api\/events\/([\w-]+)\/(join|leave)$/);
    if (m && req.method === "POST") {
      if (!known) return send(res, 401, { error: "Log in first." });
      const e = db.events.find((x) => x.id === m[1]);
      if (!e) return send(res, 404, { error: "Event not found." });
      if (m[2] === "join") {
        if (e.canceled) return send(res, 400, { error: "That event was canceled." });
        if (isPast(e)) return send(res, 400, { error: "That event already happened." });
        if (!e.signups.includes(known)) e.signups.push(known);
      } else {
        if (isPast(e)) return send(res, 400, { error: "That event already happened. Ask an officer if something is wrong." });
        e.signups = e.signups.filter((u) => u !== known); // waitlist moves up automatically
      }
      save(db);
      return send(res, 200, { event: publicEvent(e, known) });
    }

    if (p === "/api/me") {
      if (!known) return send(res, 401, { error: "Log in first." });
      if (req.method === "PUT") {
        db.users[known].displayName = String(body.displayName || "").trim().slice(0, 40) || known;
        save(db);
      }
      return send(res, 200, { email: known, displayName: db.users[known].displayName, createdAt: db.users[known].createdAt, ...stats(db, known) });
    }

    // ----- admin -----
    if (p.startsWith("/api/admin/")) {
      if (!isAdmin) return send(res, 403, { error: "Wrong admin code." });
      const nameOf = (u) => (db.users[u] ? db.users[u].displayName : u);

      if (p === "/api/admin/check") return send(res, 200, { ok: true });

      // create / delete events
      const parseEvent = (b) => {
        const { title, description, location, date, start, end } = b;
        const capacity = parseInt(b.capacity, 10);
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(start || "") || !/^\d{2}:\d{2}$/.test(end || "") || !(capacity > 0))
          return { error: "Title, date, start, end and capacity are required." };
        if (end <= start) return { error: "End time must be after start time." };
        return { fields: { title: String(title).slice(0, 80), description: String(description || "").slice(0, 400), location: String(location || "").slice(0, 80), date, start, end, capacity } };
      };
      if (p === "/api/admin/events" && req.method === "POST") {
        const r = parseEvent(body);
        if (r.error) return send(res, 400, { error: r.error });
        const e = { id: "e" + Date.now().toString(36), ...r.fields, signups: [], attendance: {} };
        db.events.push(e); save(db);
        return send(res, 200, { event: publicEvent(e, null) });
      }
      m = p.match(/^\/api\/admin\/events\/([\w-]+)$/);
      if (m && req.method === "DELETE") {
        db.events = db.events.filter((e) => e.id !== m[1]); save(db);
        return send(res, 200, { ok: true });
      }
      if (m && req.method === "PUT") { // edit an event in place; sign-ups and approvals are kept
        const e = db.events.find((x) => x.id === m[1]);
        if (!e) return send(res, 404, { error: "Event not found." });
        const r = parseEvent(body);
        if (r.error) return send(res, 400, { error: r.error });
        Object.assign(e, r.fields); save(db);
        return send(res, 200, { event: publicEvent(e, null) });
      }
      m = p.match(/^\/api\/admin\/events\/([\w-]+)\/cancel$/);
      if (m && req.method === "POST") { // cancel (or restore) without deleting sign-ups
        const e = db.events.find((x) => x.id === m[1]);
        if (!e) return send(res, 404, { error: "Event not found." });
        if (body.canceled === false) delete e.canceled; else e.canceled = true;
        save(db);
        return send(res, 200, { event: publicEvent(e, null) });
      }
      m = p.match(/^\/api\/admin\/events\/([\w-]+)\/roster$/);
      if (m && req.method === "GET") {
        const e = db.events.find((x) => x.id === m[1]);
        if (!e) return send(res, 404, { error: "Event not found." });
        return send(res, 200, { roster: e.signups.map((u, i) => ({ email: u, name: nameOf(u), status: i < e.capacity ? "joined" : "waitlisted" })) });
      }

      // hours review: finished events, one row per joined volunteer
      if (p === "/api/admin/review" && req.method === "GET") {
        const events = db.events.filter((e) => isPast(e) && !e.canceled).sort((a, b) => (b.date + b.end).localeCompare(a.date + a.end)).map((e) => ({
          id: e.id, title: e.title, date: e.date, start: e.start, end: e.end, hours: hoursOf(e),
          people: e.signups.slice(0, e.capacity).map((u) => ({ email: u, name: nameOf(u), approval: approvalOf(e, u), credited: creditOf(e, u) }))
        })).filter((e) => e.people.length);
        const pending = events.reduce((s, e) => s + e.people.filter((x) => x.approval === "pending").length, 0);
        return send(res, 200, { events, pending });
      }
      m = p.match(/^\/api\/admin\/events\/([\w-]+)\/attendance$/);
      if (m && req.method === "POST") {
        const e = db.events.find((x) => x.id === m[1]);
        if (!e) return send(res, 404, { error: "Event not found." });
        if (e.canceled) return send(res, 400, { error: "That event was canceled." });
        const u = cleanName(body.email || body.username);
        if (!e.signups.slice(0, e.capacity).includes(u)) return send(res, 400, { error: "That person isn't on this event's roster." });
        e.attendance ||= {};
        if (body.status === "pending") delete e.attendance[u];
        else if (body.status === "absent") e.attendance[u] = { status: "absent", hours: 0 };
        else if (body.status === "approved") {
          let h = body.hours === undefined || body.hours === "" ? hoursOf(e) : Number(body.hours);
          if (!isFinite(h) || h < 0 || h > 24) return send(res, 400, { error: "Hours must be between 0 and 24." });
          e.attendance[u] = { status: "approved", hours: round2(h) };
        } else return send(res, 400, { error: "Unknown status." });
        save(db);
        return send(res, 200, { ok: true });
      }
      m = p.match(/^\/api\/admin\/events\/([\w-]+)\/approve-all$/);
      if (m && req.method === "POST") {
        const e = db.events.find((x) => x.id === m[1]);
        if (!e) return send(res, 404, { error: "Event not found." });
        if (e.canceled) return send(res, 400, { error: "That event was canceled." });
        e.attendance ||= {};
        let n = 0;
        e.signups.slice(0, e.capacity).forEach((u) => { if (!e.attendance[u]) { e.attendance[u] = { status: "approved", hours: round2(hoursOf(e)) }; n++; } });
        save(db);
        return send(res, 200, { approved: n });
      }

      // volunteers
      if (p === "/api/admin/volunteers" && req.method === "GET") {
        const rows = Object.keys(db.users).map((u) => {
          const s = stats(db, u);
          return { email: u, name: nameOf(u), createdAt: db.users[u].createdAt, hours: s.hours, pendingHours: s.pendingHours, events: s.joinedCount };
        }).sort((a, b) => b.hours - a.hours);
        return send(res, 200, { volunteers: rows });
      }
      m = p.match(/^\/api\/admin\/volunteers\/([^/]+)$/);
      if (m && req.method === "GET") {
        const u = cleanName(dec(m[1]));
        if (!hasUser(db, u)) return send(res, 404, { error: "Volunteer not found." });
        return send(res, 200, { email: u, name: nameOf(u), ...stats(db, u) });
      }
      if (m && req.method === "DELETE") {
        const u = cleanName(dec(m[1]));
        delete db.users[u];
        db.events.forEach((e) => { e.signups = e.signups.filter((x) => x !== u); if (e.attendance) delete e.attendance[u]; });
        db.adjustments = db.adjustments.filter((a) => a.username !== u);
        save(db);
        return send(res, 200, { ok: true });
      }

      // manual hour entries (+ or -), e.g. work done outside a listed event
      if (p === "/api/admin/adjustments" && req.method === "POST") {
        const u = cleanName(body.email || body.username), h = Number(body.hours), note = String(body.note || "").trim().slice(0, 120);
        if (!hasUser(db, u)) return send(res, 404, { error: "Volunteer not found." });
        if (!isFinite(h) || h === 0 || Math.abs(h) > 100) return send(res, 400, { error: "Enter hours between -100 and 100 (not 0)." });
        if (!note) return send(res, 400, { error: "Add a short note, like what the hours were for." });
        db.adjustments.push({ id: "a" + Date.now().toString(36), username: u, hours: round2(h), note, date: new Date().toISOString().slice(0, 10) });
        save(db);
        return send(res, 200, { ok: true });
      }
      m = p.match(/^\/api\/admin\/adjustments\/([\w-]+)$/);
      if (m && req.method === "DELETE") {
        db.adjustments = db.adjustments.filter((a) => a.id !== m[1]); save(db);
        return send(res, 200, { ok: true });
      }

      // gallery photos
      if (p === "/api/admin/photos" && req.method === "POST") {
        const full = decodeJpeg(body.full, 3.5e6), thumb = decodeJpeg(body.thumb, 6e5);
        if (!full || !thumb) return send(res, 400, { error: "That file isn't a usable photo. Try a different one." });
        const ev = body.eventId ? db.events.find((e) => e.id === body.eventId) : null;
        if (body.eventId && !ev) return send(res, 400, { error: "That event no longer exists." });
        const id = crypto.randomBytes(8).toString("hex");
        try {
          await putImage(id + ".jpg", full);
          try { await putImage(id + "-t.jpg", thumb); } catch (e) { await removeImage(id + ".jpg"); throw e; }
        } catch (e) { console.error("Photo upload failed:", e.message); return send(res, 502, { error: "Couldn't save the photo. " + (useSupabase ? "Check that the Supabase \"gallery\" storage bucket exists and is public." : "") }); }
        const ph = { id, file: id + ".jpg", thumb: id + "-t.jpg", caption: String(body.caption || "").trim().slice(0, 140), eventId: ev ? ev.id : null, eventTitle: ev ? ev.title : "", createdAt: Date.now() };
        db.photos.push(ph); save(db);
        return send(res, 200, { photo: publicPhoto(db, ph) });
      }
      m = p.match(/^\/api\/admin\/photos\/([\w-]+)$/);
      if (m && req.method === "PUT") {
        const ph = db.photos.find((x) => x.id === m[1]);
        if (!ph) return send(res, 404, { error: "Photo not found." });
        const ev = body.eventId ? db.events.find((e) => e.id === body.eventId) : null;
        if (body.eventId && !ev) return send(res, 400, { error: "That event no longer exists." });
        ph.caption = String(body.caption || "").trim().slice(0, 140);
        ph.eventId = ev ? ev.id : null; ph.eventTitle = ev ? ev.title : "";
        save(db);
        return send(res, 200, { photo: publicPhoto(db, ph) });
      }
      if (m && req.method === "DELETE") {
        const ph = db.photos.find((x) => x.id === m[1]);
        if (ph) { db.photos = db.photos.filter((x) => x.id !== ph.id); save(db); await removeImage(ph.file); await removeImage(ph.thumb); }
        return send(res, 200, { ok: true });
      }

      // CSV export
      if (p === "/api/admin/export" && req.method === "GET") {
        const lines = [["name", "email", "events_joined", "approved_hours", "pending_hours"].join(",")];
        Object.keys(db.users).forEach((u) => { const s = stats(db, u); lines.push([nameOf(u), u, s.joinedCount, s.hours, s.pendingHours].map(csvCell).join(",")); });
        return send(res, 200, lines.join("\n"), "text/csv");
      }
    }
    return send(res, 404, { error: "Not found." });
  }

  // gallery photos kept on disk (local testing only; with Supabase they are served from its storage)
  let um = p.match(/^\/uploads\/([a-f0-9]{16}(?:-t)?\.jpg)$/);
  if (um && !useSupabase) {
    const f = path.join(UPLOADS, um[1]);
    if (!fs.existsSync(f)) return send(res, 404, "Not found", "text/plain");
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" });
    return res.end(fs.readFileSync(f));
  }

  // static files
  const file = p === "/" ? "/index.html" : p;
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, "Not found", "text/plain");
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };
  send(res, 200, fs.readFileSync(full), types[path.extname(full)] || "application/octet-stream");
});

init().then(() => {
  server.listen(PORT, () => {
    console.log(`Hands for Humankind Volunteer Hub running at http://localhost:${PORT}`);
    if (!process.env.ADMIN_CODE) console.log('Admin code is the default "h4h-admin". Set ADMIN_CODE before going live.');
  });
}).catch((e) => { console.error("STARTUP FAILED:", e.message); process.exit(1); }); // never start empty and overwrite real data
