import http from "node:http";
import crypto from "node:crypto";
import { relay } from "./smtp.js";
import { openSeen } from "./seen.js";

const MAX_BODY = 26 * 1024 * 1024;
const DRAIN_LIMIT = 64 * 1024 * 1024;
const SKEW_SECONDS = 300;
const HMAC_KEY = process.env.HMAC_KEY;
if (!HMAC_KEY) throw new Error("HMAC_KEY is required");

const config = {
  port: Number(process.env.PORT ?? 8080),
  mailpitHost: process.env.MAILPIT_HOST ?? "mailpit",
  mailpitPort: Number(process.env.MAILPIT_PORT ?? 1025),
};
const seen = openSeen(process.env.SEEN_DB ?? "/data/seen.sqlite");
const inFlight = new Set();

const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const reply = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "text/plain", Connection: "close" });
  res.end(body);
};

function validSignature(captureId, timestamp, signature, body) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const expected = crypto.createHmac("sha256", HMAC_KEY).update(`${captureId}.${timestamp}.${bodyHash}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > DRAIN_LIMIT) return req.destroy(new Error("body exceeds drain limit"));
      if (total > MAX_BODY) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function ingest(req, res) {
  const captureId = req.headers["x-capture-id"];
  const timestamp = req.headers["x-capture-timestamp"];
  const signature = req.headers["x-capture-signature"];
  const from = req.headers["x-envelope-from"] ?? "";
  const to = String(req.headers["x-envelope-to"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!captureId || !signature || !Number.isFinite(skew) || skew > SKEW_SECONDS) {
    req.resume();
    return reply(res, 401, "unauthorized");
  }
  const body = await readBody(req);
  if (body === null) return reply(res, 413, "body too large");
  if (!validSignature(captureId, timestamp, String(signature), body)) return reply(res, 401, "unauthorized");
  if (to.length === 0) return reply(res, 400, "missing X-Envelope-To");
  if (seen.has(captureId)) {
    log({ event: "already_seen", captureId });
    return reply(res, 200, "already-seen");
  }
  if (inFlight.has(captureId)) return reply(res, 503, "in flight");

  inFlight.add(captureId);
  try {
    await relay({ host: config.mailpitHost, port: config.mailpitPort, from, recipients: to, raw: body });
    seen.add(captureId);
    log({ event: "delivered", captureId, bytes: body.length, recipients: to.length });
    reply(res, 200, "delivered");
  } catch (err) {
    log({ event: "relay_failed", captureId, error: err.message });
    reply(res, 503, "relay failed");
  } finally {
    inFlight.delete(captureId);
  }
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "GET" && path === "/healthz") return reply(res, 200, "ok");
  if (req.method === "POST" && path === "/ingest") {
    return ingest(req, res).catch((err) => {
      log({ event: "error", error: err.message });
      if (!res.headersSent) reply(res, 500, "error");
    });
  }
  req.resume();
  reply(res, 404, "not found");
});
server.requestTimeout = 120000;
server.listen(config.port, () => log({ event: "listening", port: config.port }));
