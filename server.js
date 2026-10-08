// Hands for Humankind Volunteer Hub: zero-dependency Node server (Node 18+).
// Run: node server.js   (set ADMIN_CODE to your own secret first)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || "h4h-admin";
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC = path.join(__dirname, "public");

// ---------- storage (one JSON file) ----------
function load() {
  let db;
  try { db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { db = seed(); }
  db.users ||= {}; db.events ||= []; db.adjustments ||= [];
  return db;
}
function save(db) {
  fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db, null, 2));
  fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
}
function seed() {
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const db = {
    users: {}, adjustments: [],
    events: [
      { id: "e1", title: "Food Pantry Sorting", description: "Sort and shelve donated goods so families can shop on Saturday.", location: "Community Center, Room 2", date: day(3), start: "16:00", end: "18:00", capacity: 10, signups: [], attendance: {} },
      { id: "e2", title: "Park Cleanup", description: "Bring gloves and water. Bags and grabbers provided.", location: "Main entrance of the park", date: day(9), start: "10:00", end: "13:00", capacity: 15, signups: [], attendance: {} }
    ]
  };
  save(db);
  return db;
}

// ---------- helpers ----------
const ts = (d, t) => new Date(`${d}T${t}:00`).getTime();
const hoursOf = (e) => Math.max(0, (ts(e.date, e.end) - ts(e.date, e.start)) / 36e5);
const isPast = (e) => ts(e.date, e.end) < Date.now();
const cleanName = (s) => String(s || "").trim().toLowerCase();
const validName = (s) => /^[a-z0-9_.-]{3,20}$/.test(s);
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
    past: isPast(e), status: user ? statusFor(e, user) : null,
    waitlistPosition: user && e.signups.indexOf(user) >= e.capacity ? e.signups.indexOf(user) - e.capacity + 1 : null
  };
}
function stats(db, user) {
  const mine = db.events.filter((e) => statusFor(e, user));
  const joined = mine.filter((e) => statusFor(e, user) === "joined");
  const completed = joined.filter(isPast).sort((a, b) => b.date.localeCompare(a.date))
    .map((e) => ({ ...publicEvent(e, user), approval: approvalOf(e, user), credited: creditOf(e, user) }));
  const upcoming = joined.filter((e) => !isPast(e)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map((e) => publicEvent(e, user));
  const waitlisted = mine.filter((e) => statusFor(e, user) === "waitlisted" && !isPast(e)).map((e) => publicEvent(e, user));
  const adjustments = db.adjustments.filter((a) => a.username === user);
  const adjTotal = adjustments.reduce((s, a) => s + a.hours, 0);
  return {
    hours: round2(completed.reduce((s, e) => s + e.credited, 0) + adjTotal),
    pendingHours: round2(completed.filter((e) => e.approval === "pending").reduce((s, e) => s + e.hours, 0)),
    joinedCount: joined.length, upcoming, completed, waitlisted, adjustments
  };
}
const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// ---------- http ----------
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); });
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
    const known = user && db.users[user] ? user : null;
    const isAdmin = req.headers["x-admin-code"] === ADMIN_CODE;
    const body = req.method === "GET" ? {} : await readBody(req);
    let m;

    // login or create account (username only)
    if (p === "/api/login" && req.method === "POST") {
      const name = cleanName(body.username);
      if (!validName(name)) return send(res, 400, { error: "Usernames are 3 to 20 characters: letters, numbers, . _ -" });
      let created = false;
      if (!db.users[name]) { db.users[name] = { displayName: String(body.displayName || "").trim().slice(0, 40) || name, createdAt: Date.now() }; created = true; save(db); }
      return send(res, 200, { username: name, displayName: db.users[name].displayName, created });
    }

    if (p === "/api/events" && req.method === "GET") {
      const list = db.events.map((e) => publicEvent(e, known)).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
      return send(res, 200, { events: list });
    }

    m = p.match(/^\/api\/events\/([\w-]+)\/(join|leave)$/);
    if (m && req.method === "POST") {
      if (!known) return send(res, 401, { error: "Log in first." });
      const e = db.events.find((x) => x.id === m[1]);
      if (!e) return send(res, 404, { error: "Event not found." });
      if (m[2] === "join") {
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
      return send(res, 200, { username: known, displayName: db.users[known].displayName, createdAt: db.users[known].createdAt, ...stats(db, known) });
    }

    // ----- admin -----
    if (p.startsWith("/api/admin/")) {
      if (!isAdmin) return send(res, 403, { error: "Wrong admin code." });
      const nameOf = (u) => (db.users[u] ? db.users[u].displayName : u);

      if (p === "/api/admin/check") return send(res, 200, { ok: true });

      // create / delete events
      if (p === "/api/admin/events" && req.method === "POST") {
        const { title, description, location, date, start, end } = body;
        const capacity = parseInt(body.capacity, 10);
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(start || "") || !/^\d{2}:\d{2}$/.test(end || "") || !(capacity > 0))
          return send(res, 400, { error: "Title, date, start, end and capacity are required." });
        if (end <= start) return send(res, 400, { error: "End time must be after start time." });
        const e = { id: "e" + Date.now().toString(36), title: String(title).slice(0, 80), description: String(description || "").slice(0, 400), location: String(location || "").slice(0, 80), date, start, end, capacity, signups: [], attendance: {} };
        db.events.push(e); save(db);
        return send(res, 200, { event: publicEvent(e, null) });
      }
      m = p.match(/^\/api\/admin\/events\/([\w-]+)$/);
      if (m && req.method === "DELETE") {
        db.events = db.events.filter((e) => e.id !== m[1]); save(db);
        return send(res, 200, { ok: true });
      }
      m = p.match(/^\/api\/admin\/events\/([\w-]+)\/roster$/);
      if (m && req.method === "GET") {
        const e = db.events.find((x) => x.id === m[1]);
        if (!e) return send(res, 404, { error: "Event not found." });
        return send(res, 200, { roster: e.signups.map((u, i) => ({ username: u, name: nameOf(u), status: i < e.capacity ? "joined" : "waitlisted" })) });
      }

      // hours review: finished events, one row per joined volunteer
      if (p === "/api/admin/review" && req.method === "GET") {
        const events = db.events.filter(isPast).sort((a, b) => (b.date + b.end).localeCompare(a.date + a.end)).map((e) => ({
          id: e.id, title: e.title, date: e.date, start: e.start, end: e.end, hours: hoursOf(e),
          people: e.signups.slice(0, e.capacity).map((u) => ({ username: u, name: nameOf(u), approval: approvalOf(e, u), credited: creditOf(e, u) }))
        })).filter((e) => e.people.length);
        const pending = events.reduce((s, e) => s + e.people.filter((x) => x.approval === "pending").length, 0);
        return send(res, 200, { events, pending });
      }
      m = p.match(/^\/api\/admin\/events\/([\w-]+)\/attendance$/);
      if (m && req.method === "POST") {
        const e = db.events.find((x) => x.id === m[1]);
        if (!e) return send(res, 404, { error: "Event not found." });
        const u = cleanName(body.username);
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
          return { username: u, name: nameOf(u), createdAt: db.users[u].createdAt, hours: s.hours, pendingHours: s.pendingHours, events: s.joinedCount };
        }).sort((a, b) => b.hours - a.hours);
        return send(res, 200, { volunteers: rows });
      }
      m = p.match(/^\/api\/admin\/volunteers\/([\w.-]+)$/);
      if (m && req.method === "GET") {
        const u = cleanName(m[1]);
        if (!db.users[u]) return send(res, 404, { error: "Volunteer not found." });
        return send(res, 200, { username: u, name: nameOf(u), ...stats(db, u) });
      }
      if (m && req.method === "DELETE") {
        const u = cleanName(m[1]);
        delete db.users[u];
        db.events.forEach((e) => { e.signups = e.signups.filter((x) => x !== u); if (e.attendance) delete e.attendance[u]; });
        db.adjustments = db.adjustments.filter((a) => a.username !== u);
        save(db);
        return send(res, 200, { ok: true });
      }

      // manual hour entries (+ or -), e.g. work done outside a listed event
      if (p === "/api/admin/adjustments" && req.method === "POST") {
        const u = cleanName(body.username), h = Number(body.hours), note = String(body.note || "").trim().slice(0, 120);
        if (!db.users[u]) return send(res, 404, { error: "Volunteer not found." });
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

      // CSV export
      if (p === "/api/admin/export" && req.method === "GET") {
        const lines = [["username", "name", "events_joined", "approved_hours", "pending_hours"].join(",")];
        Object.keys(db.users).forEach((u) => { const s = stats(db, u); lines.push([u, nameOf(u), s.joinedCount, s.hours, s.pendingHours].map(csvCell).join(",")); });
        return send(res, 200, lines.join("\n"), "text/csv");
      }
    }
    return send(res, 404, { error: "Not found." });
  }

  // static files
  const file = p === "/" ? "/index.html" : p;
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, "Not found", "text/plain");
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };
  send(res, 200, fs.readFileSync(full), types[path.extname(full)] || "application/octet-stream");
});

server.listen(PORT, () => {
  console.log(`Hands for Humankind Volunteer Hub running at http://localhost:${PORT}`);
  if (!process.env.ADMIN_CODE) console.log('Admin code is the default "h4h-admin". Set ADMIN_CODE before going live.');
});
