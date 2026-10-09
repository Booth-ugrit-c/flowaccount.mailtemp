import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { openAccounts, limiter, usernameError, MAX_ACCOUNTS } from "./accounts.js";
import { address, mailpit, listFor, ownMessage, scrubRaw, scrubHeaders } from "./mail.js";

const INBOX_KEY = process.env.INBOX_KEY;
if (!INBOX_KEY) throw new Error("INBOX_KEY is required");
const PORT = Number(process.env.PORT ?? 8090);
const accounts = openAccounts(process.env.USERS_DB ?? "/data/users.sqlite", INBOX_KEY);
const creations = limiter(30, 3600_000);
const randomRequests = limiter(30, 60_000);
const page = fs.readFileSync(new URL("./public/index.html", import.meta.url));
const VENDOR = {
  "app.css": "text/css; charset=utf-8",
  "bootstrap-icons-CVBWLLHT.woff2": "font/woff2",
  "bootstrap-icons-VQNJTM6Q.woff": "font/woff",
  "mailpit.svg": "image/svg+xml",
  LICENSE: "text/plain; charset=utf-8",
};
const vendorFiles = new Map(Object.entries(VENDOR).map(([name, type]) => [name, { type, body: fs.readFileSync(new URL(`./public/vendor/${name}`, import.meta.url)) }]));

const send = (res, status, body, type = "application/json", extra = {}) => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
};
const fail = (res, status, error) => send(res, status, { error });
const clientIp = (req) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "unknown");
const isSecure = (req) => req.headers["x-forwarded-proto"] === "https" || /"https"/.test(String(req.headers["cf-visitor"] ?? ""));

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2048) throw new Error("body too large");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (body === null || typeof body !== "object") throw new Error("body must be an object");
  return body;
}

const RANDOM_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomUsername() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = "rand-" + Array.from({ length: 6 }, () => RANDOM_CHARS[crypto.randomInt(RANDOM_CHARS.length)]).join("");
    if (!accounts.exists(name)) return name;
  }
  return null;
}

function randomInbox(req, res) {
  const ip = clientIp(req);
  if (randomRequests.full(ip)) return fail(res, 429, "Too many requests, try again in a moment");
  randomRequests.hit(ip);
  const username = randomUsername();
  return username ? send(res, 200, { username }) : fail(res, 503, "no free random name, try again");
}

const meBody = ({ accounts: list, active }) => ({ active, address: active ? address(active) : null, accounts: list });

function sessionReply(req, res, session, extra = {}) {
  const cookies = session.accounts.length ? accounts.issue(session, isSecure(req)) : accounts.clear();
  send(res, 200, { ...meBody(session), ...extra }, "application/json", { "Set-Cookie": cookies });
}

async function readUsername(req, res) {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return void fail(res, 415, "expected application/json");
  try {
    return String((await readJson(req)).username ?? "").trim().toLowerCase();
  } catch {
    return void fail(res, 400, "invalid body");
  }
}

async function openInbox(req, res) {
  const username = await readUsername(req, res);
  if (username === undefined) return;
  const problem = usernameError(username);
  if (problem) return fail(res, 400, problem);
  const current = accounts.sessionFrom(req.headers.cookie) ?? { accounts: [], active: null };
  const known = current.accounts.includes(username);
  if (!known && current.accounts.length >= MAX_ACCOUNTS) return fail(res, 400, `too many addresses in this browser (max ${MAX_ACCOUNTS})`);
  const ip = clientIp(req);
  if (creations.full(ip) && !accounts.exists(username)) return fail(res, 429, "too many new addresses, try later");
  const { created } = accounts.open(username);
  if (created) creations.hit(ip);
  sessionReply(req, res, { accounts: known ? current.accounts : [...current.accounts, username], active: username }, { created });
}

async function switchInbox(req, res, session) {
  const username = await readUsername(req, res);
  if (username === undefined) return;
  if (!session.accounts.includes(username)) return fail(res, 403, "address is not opened in this browser");
  sessionReply(req, res, { accounts: session.accounts, active: username });
}

async function forgetInbox(req, res, session) {
  const username = await readUsername(req, res);
  if (username === undefined) return;
  if (!session.accounts.includes(username)) return fail(res, 403, "address is not opened in this browser");
  const rest = session.accounts.filter((name) => name !== username);
  sessionReply(req, res, { accounts: rest, active: session.active === username ? rest.at(-1) ?? null : session.active });
}

const summary = (m) => ({
  id: m.ID, from: m.From, to: m.To, cc: m.Cc, subject: m.Subject, created: m.Date, text: m.Text, html: m.HTML, size: m.Size,
  attachments: (m.Attachments ?? []).map((a) => ({ partId: a.PartID, fileName: a.FileName, contentType: a.ContentType, size: a.Size })),
});

async function relay(res, path, type, extra = {}) {
  const upstream = await mailpit(path);
  if (!upstream.ok) return fail(res, 404, "not found");
  send(res, 200, Buffer.from(await upstream.arrayBuffer()), type ?? upstream.headers.get("content-type") ?? "application/octet-stream", extra);
}

async function scrubbed(res, path, kind, transform) {
  const upstream = await mailpit(path);
  if (!upstream.ok) return fail(res, 404, "not found");
  send(res, 200, transform(await upstream[kind]()), kind === "json" ? "application/json" : "text/plain; charset=utf-8");
}

async function messageRoute(req, res, username, segments) {
  if (segments.length === 2) {
    if (req.method !== "GET") return fail(res, 404, "not found");
    return send(res, 200, { messages: await listFor(username, accounts.hiddenIds(username)) });
  }
  const id = segments[2];
  const message = await ownMessage(username, id, accounts.hiddenIds(username));
  if (!message) return fail(res, 404, "not found");
  const sub = segments[3];
  if (segments.length === 3 && req.method === "GET") return send(res, 200, summary(message));
  if (segments.length === 3 && req.method === "DELETE") {
    accounts.hide(username, id);
    return send(res, 200, { deleted: true });
  }
  if (req.method !== "GET") return fail(res, 404, "not found");
  if (segments.length === 4 && sub === "headers") return scrubbed(res, `/message/${id}/headers`, "json", (h) => scrubHeaders(h, username));
  if (segments.length === 4 && sub === "raw") return scrubbed(res, `/message/${id}/raw`, "text", (raw) => scrubRaw(raw, username));
  if (segments.length === 5 && sub === "part") {
    const part = [...(message.Attachments ?? []), ...(message.Inline ?? [])].find((p) => p.PartID === segments[4]);
    if (!part) return fail(res, 404, "not found");
    const name = encodeURIComponent(part.FileName || `part-${part.PartID}`);
    return relay(res, `/message/${id}/part/${encodeURIComponent(part.PartID)}`, null, {
      "Content-Disposition": `attachment; filename*=UTF-8''${name}`,
      "Content-Security-Policy": "sandbox",
    });
  }
  fail(res, 404, "not found");
}

async function route(req, res) {
  const { pathname } = new URL(req.url, "http://x");
  if (req.method === "GET" && pathname === "/healthz") return send(res, 200, "ok", "text/plain");
  if (req.method === "GET" && pathname === "/favicon.ico") return send(res, 204, "", "text/plain");
  if (req.method === "GET" && pathname === "/") {
    return send(res, 200, page, "text/html; charset=utf-8", { "Content-Security-Policy": "frame-ancestors 'none'", "Referrer-Policy": "no-referrer" });
  }
  if (req.method === "GET" && pathname.startsWith("/vendor/")) {
    const file = vendorFiles.get(pathname.slice("/vendor/".length));
    return file ? send(res, 200, file.body, file.type, { "Cache-Control": "public, max-age=86400" }) : fail(res, 404, "not found");
  }
  if (req.method === "POST" && pathname === "/api/open") return openInbox(req, res);
  if (req.method === "GET" && pathname === "/api/random") return randomInbox(req, res);

  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api") return fail(res, 404, "not found");
  const session = accounts.sessionFrom(req.headers.cookie);
  if (!session) return fail(res, 401, "sign in required");
  if (req.method === "GET" && pathname === "/api/me") return send(res, 200, meBody(session));
  if (req.method === "POST" && pathname === "/api/switch") return switchInbox(req, res, session);
  if (req.method === "POST" && pathname === "/api/forget") return forgetInbox(req, res, session);
  if (segments[1] === "messages") return messageRoute(req, res, session.active, segments);
  fail(res, 404, "not found");
}

http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "error", error: err.message }));
    if (!res.headersSent) fail(res, 502, "mail store unavailable");
  });
}).listen(PORT, () => console.log(JSON.stringify({ at: new Date().toISOString(), event: "listening", port: PORT })));
