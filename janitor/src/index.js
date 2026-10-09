import fs from "node:fs";

const env = process.env;
const number = (name, fallback) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

const BASE = `${env.MAILPIT_URL ?? "http://mailpit:8025/admin"}/api/v1`;
const AUTH = "Basic " + Buffer.from(`${env.MAILPIT_UI_USER}:${env.MAILPIT_UI_PASSWORD}`).toString("base64");
const QUOTA = number("MAIL_QUOTA_BYTES", 21474836480);
const HIGH = number("HIGH_WATERMARK_PCT", 90);
const LOW = number("LOW_WATERMARK_PCT", 70);
const INTERVAL_MS = number("INTERVAL_SECONDS", 60) * 1000;
const RESCAN_MS = number("RESCAN_HOURS", 6) * 3600_000;
const PAGE = number("PAGE_SIZE", 500);
const DRY_RUN = env.DRY_RUN === "1";
const RUN_ONCE = env.RUN_ONCE === "1";
const DB_FILE = env.MAILPIT_DB_FILE ?? "/mailpit-data/mailpit.db";

if (QUOTA <= 0 || PAGE < 1 || !(LOW > 0 && LOW < HIGH && HIGH <= 100)) throw new Error("need MAIL_QUOTA_BYTES > 0, PAGE_SIZE >= 1 and 0 < LOW_WATERMARK_PCT < HIGH_WATERMARK_PCT <= 100");

const log = (fields) => console.log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { Authorization: AUTH, "Content-Type": "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`mailpit ${init.method ?? "GET"} ${path} -> ${res.status}`);
  return res.json().catch(() => null);
}

const listPage = (start) => api(`/messages?start=${start}&limit=${PAGE}`);

function fileBytes() {
  const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
  const total = sizeOf(DB_FILE) + sizeOf(`${DB_FILE}-wal`);
  return total || null;
}

let known = null;
let usage = 0;
let lastFullScan = 0;

const remember = (m) => {
  if (known.has(m.ID)) return;
  known.set(m.ID, { size: m.Size, created: Date.parse(m.Created) });
  usage += m.Size;
};

async function fullScan() {
  known = new Map();
  usage = 0;
  for (let start = 0; ; ) {
    const { total, messages } = await listPage(start);
    messages.forEach(remember);
    start += messages.length;
    if (messages.length === 0 || start >= total) break;
  }
  lastFullScan = Date.now();
}

async function scanNewest() {
  let total = 0;
  for (let start = 0; ; ) {
    const page = await listPage(start);
    total = page.total;
    const fresh = page.messages.findIndex((m) => known.has(m.ID));
    (fresh === -1 ? page.messages : page.messages.slice(0, fresh)).forEach(remember);
    start += page.messages.length;
    if (fresh !== -1 || page.messages.length === 0 || start >= total) return total;
  }
}

function oldestFirstUntil(bytesToFree) {
  const picked = [];
  let freed = 0;
  for (const [id, m] of [...known].sort((a, b) => a[1].created - b[1].created)) {
    if (freed >= bytesToFree) break;
    picked.push(id);
    freed += m.size;
  }
  return { picked, freed };
}

async function purge(ids) {
  for (let i = 0; i < ids.length; i += PAGE) {
    const batch = ids.slice(i, i + PAGE);
    await api("/messages", { method: "DELETE", body: JSON.stringify({ IDs: batch }) });
    for (const id of batch) {
      usage -= known.get(id).size;
      known.delete(id);
    }
  }
}

async function cycle() {
  const started = Date.now();
  let rescan = "none";
  if (known === null) {
    await fullScan();
    rescan = "start";
  } else if (Date.now() - lastFullScan >= RESCAN_MS) {
    await fullScan();
    rescan = "periodic";
  } else {
    const total = await scanNewest();
    if (known.size !== total) {
      await fullScan();
      rescan = "mismatch";
    }
  }

  const line = { event: "cycle", usage, quota: QUOTA, pct: Number(((usage * 100) / QUOTA).toFixed(2)), count: known.size, rescan, deleted: 0, freedEstimate: 0 };
  if (usage >= (QUOTA * HIGH) / 100) {
    const { picked, freed } = oldestFirstUntil(usage - Math.floor((QUOTA * LOW) / 100));
    if (DRY_RUN) {
      line.wouldDelete = picked.length;
      line.freedEstimate = freed;
    } else {
      try {
        await purge(picked);
      } catch (err) {
        known = null;
        throw err;
      }
      line.deleted = picked.length;
      line.freedEstimate = freed;
      line.usageAfter = usage;
      line.pctAfter = Number(((usage * 100) / QUOTA).toFixed(2));
    }
  }
  log({ ...line, dryRun: DRY_RUN, fileBytes: fileBytes(), ms: Date.now() - started });
}

log({ event: "start", quota: QUOTA, highPct: HIGH, lowPct: LOW, intervalSeconds: INTERVAL_MS / 1000, dryRun: DRY_RUN, runOnce: RUN_ONCE, mailpit: BASE });
for (;;) {
  try {
    await cycle();
  } catch (err) {
    log({ event: "error", error: err.message });
    if (RUN_ONCE) process.exit(1);
  }
  if (RUN_ONCE) process.exit(0);
  await sleep(INTERVAL_MS);
}
