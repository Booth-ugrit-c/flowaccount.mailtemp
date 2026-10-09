import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const MAX_ACCOUNTS = 10;
const SESSION_SECONDS = 365 * 86400;
const LEGACY_RE = /^(.+)\.(\d+)\.([0-9a-f]{64})$/;
const SESSION_RE = /^([A-Za-z0-9_-]+)\.(\d+)\.([0-9a-f]{64})$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const RESERVED = new Set(["root", "admin", "postmaster", "abuse", "hostmaster", "webmaster", "noreply", "no-reply", "security", "support", "mailer-daemon"]);
const cookieValue = (header, name) => new RegExp(`(?:^|;\s*)${name}=([^;]*)`).exec(header ?? "")?.[1] ?? "";

export const usernameError = (name) => {
  if (!USERNAME_RE.test(name)) return "username must be 3-30 chars: a-z 0-9 . _ -";
  return name.startsWith("qa") || name.startsWith("h13") || RESERVED.has(name) ? "username not available" : null;
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
    CREATE TABLE IF NOT EXISTS hidden (username TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (username, id))`);
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

  const readSession = (value) => {
    const m = SESSION_RE.exec(value);
    if (!m || !fresh(m[2]) || !matches(`v2:${m[1]}.${m[2]}`, m[3])) return null;
    try {
      const { accounts, active } = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
      const valid = Array.isArray(accounts) && accounts.length > 0 && accounts.length <= MAX_ACCOUNTS && accounts.every((n) => typeof n === "string" && USERNAME_RE.test(n));
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
    issue({ accounts, active }, secure) {
      const payload = Buffer.from(JSON.stringify({ accounts, active })).toString("base64url");
      const iat = Math.floor(Date.now() / 1000);
      const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
      return [`inboxes=${payload}.${iat}.${sign(`v2:${payload}.${iat}`)}; ${flags}`, "inbox=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"];
    },
    clear: () => ["inboxes=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0", "inbox=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"],
    sessionFrom(cookieHeader) {
      const session = readSession(cookieValue(cookieHeader, "inboxes")) ?? readLegacy(cookieValue(cookieHeader, "inbox"));
      if (!session) return null;
      const accounts = session.accounts.filter(exists);
      return accounts.length ? { accounts, active: accounts.includes(session.active) ? session.active : accounts[0] } : null;
    },
    hide: (username, id) => { hide.run(username, id); },
    hiddenIds: (username) => new Set(hiddenOf.all(username).map((r) => r.id)),
  };
}
