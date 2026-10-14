import { probeMailpit } from "./mail.js";

const BRIDGE_URL = process.env.BRIDGE_HEALTH_URL ?? "http://bridge:8080/healthz";
const TIMEOUT_MS = 1000;
const CACHE_MS = 5000;
let cached = null;
let pending = null;

async function healthy(probe) {
  try {
    const res = await probe();
    await res.body?.cancel();
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

export function currentStatus() {
  if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.value);
  pending ??= Promise.all([
    healthy(() => probeMailpit(TIMEOUT_MS)),
    healthy(() => fetch(BRIDGE_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })),
  ]).then(([mailpit, bridge]) => {
    cached = { at: Date.now(), value: { mailpit, bridge, checkedAt: new Date().toISOString() } };
    return cached.value;
  }).finally(() => { pending = null; });
  return pending;
}
