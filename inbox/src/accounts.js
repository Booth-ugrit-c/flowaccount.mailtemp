import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const SESSION_SECONDS = 365 * 86400;
const TOUCH_SECONDS = 86400;
const PRUNE_SECONDS = 3600;
const LEGACY_RE = /^(.+)\.(\d+)\.([0-9a-f]{64})$/;
const SESSION_RE = /^([A-Za-z0-9_-]+)\.(\d+)\.([0-9a-f]{64})$/;
const SID_RE = /^v3\.([A-Za-z0-9_-]{43})\.(\d+)\.([0-9a-f]{64})$/;
const USERNAME_RE = /^([a-z0-9][a-z0-9._-]{2,29})(?:\+[a-z0-9._-]{1,30})?$/;
const RESERVED = new Set(["root", "admin", "postmaster", "abuse", "hostmaster", "webmaster", "noreply", "no-reply", "security", "support", "mailer-daemon"]);
const cookieValue = (header, name) => new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header ?? "")?.[1] ?? "";

export const usernameError = (name) => {
  const base = USERNAME_RE.exec(name)?.[1];
  if (!base) return "username must be 3-30 chars: a-z 0-9 . _ - (optionally +tag, 1-30 chars)";
  return base.startsWith("qa") || base.startsWith("h13") || RESERVED.has(base) ? "username not available" : null;
};

export function limiter(max, windowMs) {
  const hits = new Map();
  const recent = (ip, now) => {
    const times = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (times.length) hits.set(ip, times);
    else hits.delete(ip);
    return times;
  };
  setInterval(() => { for (const ip of [...hits.keys()]) recent(ip, Date.now()); }, 60_000).unref();
  return {
    full: (ip) => recent(ip, Date.now()).length >= max,
    hit: (ip) => { const now = Date.now(); hits.set(ip, [...recent(ip, now), now]); },
  };
}

export function openAccounts(dbPath, key) {
  const db = new DatabaseSync(dbPath);
  if (db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "hash")) db.exec("DROP TABLE users");
  db.exec(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hidden (username TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (username, id));
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, active TEXT, created INTEGER NOT NULL, seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS session_accounts (session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, username TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (session, username));
    CREATE INDEX IF NOT EXISTS session_accounts_order ON session_accounts (session, position)`);
  db.exec("PRAGMA foreign_keys = ON");
  const insert = db.prepare("INSERT OR IGNORE INTO users (username, created) VALUES (?, ?)");
  const find = db.prepare("SELECT 1 FROM users WHERE username = ?");
  const hide = db.prepare("INSERT OR IGNORE INTO hidden (username, id) VALUES (?, ?)");
  const hiddenOf = db.prepare("SELECT id FROM hidden WHERE username = ?");
  const sign = (text) => crypto.createHmac("sha256", key).update(text).digest("hex");
  const matches = (text, sig) => {
    const a = Buffer.from(sign(text));
    const b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const exists = (username) => find.get(username) !== undefined;
  const fresh = (issued) => Date.now() / 1000 - Number(issued) < SESSION_SECONDS;

  const now = () => Math.floor(Date.now() / 1000);
  const hashOf = (sid) => crypto.createHash("sha256").update(sid).digest("hex");
  const insertSession = db.prepare("INSERT OR IGNORE INTO sessions (id, active, created, seen) VALUES (?, ?, ?, ?)");
  const rowOf = db.prepare("SELECT active, seen FROM sessions WHERE id = ?");
  const namesOf = db.prepare("SELECT sa.username FROM session_accounts sa JOIN users u ON u.username = sa.username WHERE sa.session = ? ORDER BY sa.position");
  const addName = db.prepare("INSERT OR IGNORE INTO session_accounts (session, username, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM session_accounts WHERE session = ?))");
  const dropName = db.prepare("DELETE FROM session_accounts WHERE session = ? AND username = ?");
  const setActive = db.prepare("UPDATE sessions SET active = ? WHERE id = ?");
  const touch = db.prepare("UPDATE sessions SET seen = ? WHERE id = ?");
  const dropSession = db.prepare("DELETE FROM sessions WHERE id = ?");
  const pruneOld = db.prepare("DELETE FROM sessions WHERE seen < ?");
  let lastPrune = 0;
  const prune = () => {
    if (now() - lastPrune < PRUNE_SECONDS) return;
    lastPrune = now();
    pruneOld.run(now() - SESSION_SECONDS);
  };
  const atomically = (work) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  const view = (sid) => {
    const id = hashOf(sid);
    const row = rowOf.get(id);
    const names = row ? namesOf.all(id).map((r) => r.username) : [];
    return names.length ? { sid, accounts: names, active: names.includes(row.active) ? row.active : names[0] } : null;
  };
  prune();

  const readSid = (value) => {
    const m = SID_RE.exec(value);
    if (!m || !fresh(m[2]) || !matches(`v3:${m[1]}.${m[2]}`, m[3])) return null;
    const session = view(m[1]);
    if (session && now() - rowOf.get(hashOf(m[1])).seen > TOUCH_SECONDS) touch.run(now(), hashOf(m[1]));
    return session;
  };

  const migrate = (kind, value, { accounts, active }) => {
    const names = accounts.filter(exists);
    if (!names.length) return null;
    const sid = crypto.createHmac("sha256", key).update(`migrate:${kind}:${value}`).digest("base64url");
    const id = hashOf(sid);
    if (!rowOf.get(id)) {
      atomically(() => {
        insertSession.run(id, names.includes(active) ? active : names[0], now(), now());
        for (const name of names) addName.run(id, name, id);
      });
    }
    const session = view(sid);
    return session && { ...session, migrated: true };
  };

  const importFrom = (kind, value, read) => {
    const parsed = read(value);
    return parsed && migrate(kind, value, parsed);
  };

  const readV2 = (value) => {
    const m = SESSION_RE.exec(value);
    if (!m || !fresh(m[2]) || !matches(`v2:${m[1]}.${m[2]}`, m[3])) return null;
    try {
      const { accounts, active } = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
      const valid = Array.isArray(accounts) && accounts.length > 0 && accounts.every((n) => typeof n === "string" && USERNAME_RE.test(n));
      return valid && accounts.includes(active) ? { accounts, active } : null;
    } catch {
      return null;
    }
  };

  const readLegacy = (value) => {
    const m = LEGACY_RE.exec(value);
    if (!m || !fresh(m[2]) || !matches(`session:${m[1]}.${m[2]}`, m[3]) || !exists(m[1])) return null;
    return { accounts: [m[1]], active: m[1] };
  };

  return {
    open: (username) => ({ created: Number(insert.run(username, Date.now()).changes) === 1 }),
    exists,
    // Keeps db referenced: statements are finalized when a collected db goes away (seen on Node 22.13).
    close: () => db.close(),
    start() {
      prune();
      const sid = crypto.randomBytes(32).toString("base64url");
      insertSession.run(hashOf(sid), null, now(), now());
      return sid;
    },
    issue(sid, secure) {
      const iat = now();
      const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
      return [`inboxes=v3.${sid}.${iat}.${sign(`v3:${sid}.${iat}`)}; ${flags}`, "inbox=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"];
    },
    clear: () => ["inboxes=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0", "inbox=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"],
    sessionFrom(cookieHeader) {
      const current = cookieValue(cookieHeader, "inboxes");
      const legacy = cookieValue(cookieHeader, "inbox");
      return readSid(current) ?? importFrom("v2", current, readV2) ?? importFrom("legacy", legacy, readLegacy);
    },
    add: (sid, username) => atomically(() => {
      addName.run(hashOf(sid), username, hashOf(sid));
      setActive.run(username, hashOf(sid));
      return view(sid);
    }),
    activate: (sid, username) => {
      setActive.run(username, hashOf(sid));
      return view(sid);
    },
    forget: (sid, username) => atomically(() => {
      const before = view(sid);
      dropName.run(hashOf(sid), username);
      const rest = namesOf.all(hashOf(sid)).map((r) => r.username);
      if (!rest.length) {
        dropSession.run(hashOf(sid));
        return null;
      }
      if (before?.active === username) setActive.run(rest.at(-1), hashOf(sid));
      return view(sid);
    }),
    hide: (username, id) => { hide.run(username, id); },
    hiddenIds: (username) => new Set(hiddenOf.all(username).map((r) => r.id)),
  };
}
