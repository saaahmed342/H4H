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
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return seed(); }
}
function save(db) {
  fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db, null, 2));
  fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
}
function seed() {
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const db = {
    users: {},
    events: [
      { id: "e1", title: "Food Pantry Sorting", description: "Sort and shelve donated goods so families can shop on Saturday.", location: "Community Center, Room 2", date: day(3), start: "16:00", end: "18:00", capacity: 10, signups: [] },
      { id: "e2", title: "Park Cleanup", description: "Bring gloves and water. Bags and grabbers provided.", location: "Main entrance of the park", date: day(9), start: "10:00", end: "13:00", capacity: 15, signups: [] },
      { id: "e3", title: "Elementary Tutoring Night", description: "Help younger students with homework and reading.", location: "School library", date: day(-6), start: "17:00", end: "19:00", capacity: 8, signups: [] }
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

function statusFor(e, user) {
  const i = e.signups.indexOf(user);
  if (i === -1) return null;
  return i < e.capacity ? "joined" : "waitlisted";
}
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
  const mine = db.events.map((e) => publicEvent(e, user)).filter((e) => e.status);
  const joined = mine.filter((e) => e.status === "joined");
  const completed = joined.filter((e) => e.past).sort((a, b) => b.date.localeCompare(a.date));
  const upcoming = joined.filter((e) => !e.past).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const waitlisted = mine.filter((e) => e.status === "waitlisted" && !e.past);
  return {
    hours: completed.reduce((s, e) => s + e.hours, 0),
    joinedCount: joined.length,
    upcoming, completed, waitlisted
  };
}

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

  if (p.startsWith("/api/")) {
    const db = load();
    const user = cleanName(req.headers["x-username"]);
    const known = user && db.users[user] ? user : null;
    const isAdmin = req.headers["x-admin-code"] === ADMIN_CODE;
    const body = req.method === "GET" ? {} : await readBody(req);

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

    let m = p.match(/^\/api\/events\/([\w-]+)\/(join|leave)$/);
    if (m && req.method === "POST") {
      if (!known) return send(res, 401, { error: "Log in first." });
      const e = db.events.find((x) => x.id === m[1]);
      if (!e) return send(res, 404, { error: "Event not found." });
      if (m[2] === "join") {
        if (isPast(e)) return send(res, 400, { error: "That event already happened." });
        if (!e.signups.includes(known)) e.signups.push(known);
      } else {
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
      if (p === "/api/admin/check") return send(res, 200, { ok: true });
      if (p === "/api/admin/events" && req.method === "POST") {
        const { title, description, location, date, start, end } = body;
        const capacity = parseInt(body.capacity, 10);
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(start || "") || !/^\d{2}:\d{2}$/.test(end || "") || !(capacity > 0))
          return send(res, 400, { error: "Title, date, start, end and capacity are required." });
        if (end <= start) return send(res, 400, { error: "End time must be after start time." });
        const e = { id: "e" + Date.now().toString(36), title: String(title).slice(0, 80), description: String(description || "").slice(0, 400), location: String(location || "").slice(0, 80), date, start, end, capacity, signups: [] };
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
        const row = (u, i) => ({ username: u, name: db.users[u] ? db.users[u].displayName : u, status: i < e.capacity ? "joined" : "waitlisted" });
        return send(res, 200, { roster: e.signups.map(row) });
      }
      if (p === "/api/admin/volunteers" && req.method === "GET") {
        const rows = Object.keys(db.users).map((u) => {
          const s = stats(db, u);
          return { username: u, name: db.users[u].displayName, hours: s.hours, events: s.joinedCount };
        }).sort((a, b) => b.hours - a.hours);
        return send(res, 200, { volunteers: rows });
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
