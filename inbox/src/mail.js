const BASE = `${process.env.MAILPIT_URL ?? "http://mailpit:8025/admin"}/api/v1`;
const DOMAIN = process.env.INBOX_DOMAIN ?? "booth.pp.ua";
const AUTH = "Basic " + Buffer.from(`${process.env.MAILPIT_UI_USER}:${process.env.MAILPIT_UI_PASSWORD}`).toString("base64");
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const address = (username) => `${username}@${DOMAIN}`;
export const mailpit = (path) => fetch(BASE + path, { headers: { Authorization: AUTH }, signal: AbortSignal.timeout(10_000) });

export function owns(username, recipient) {
  const mail = String(recipient).toLowerCase();
  const at = mail.lastIndexOf("@");
  const local = mail.slice(0, at);
  return at > 0 && mail.slice(at + 1) === DOMAIN && (local === username || local.startsWith(`${username}+`));
}

const isRecipient = (message, username) =>
  [message.To, message.Cc, message.Bcc].some((list) => (list ?? []).some((p) => owns(username, p.Address)));

async function candidates(term) {
  const res = await mailpit(`/search?query=${encodeURIComponent(`addressed:"${term}"`)}&limit=200`);
  if (!res.ok) throw new Error(`mailpit search ${res.status}`);
  return (await res.json()).messages ?? [];
}

export async function listFor(username, hidden) {
  const found = await Promise.all([candidates(address(username)), candidates(`${username}+`)]);
  const byId = new Map(found.flat().map((m) => [m.ID, m]));
  return [...byId.values()]
    .filter((m) => isRecipient(m, username) && !hidden.has(m.ID))
    .sort((a, b) => b.Created.localeCompare(a.Created))
    .map((m) => ({ id: m.ID, from: m.From, to: m.To, cc: m.Cc, subject: m.Subject, created: m.Created, snippet: m.Snippet, attachments: m.Attachments, size: m.Size, read: m.Read }));
}

export async function ownMessage(username, id, hidden) {
  if (!ID_RE.test(id) || hidden.has(id)) return null;
  const res = await mailpit(`/message/${id}`);
  if (!res.ok) return null;
  const message = await res.json();
  return message.ID === id && isRecipient(message, username) ? message : null;
}

const hideForeignRecipient = (username) => (match, recipient) => (owns(username, recipient) ? match : "");

export function scrubRaw(raw, username) {
  const end = raw.search(/\r?\n\r?\n/);
  const head = end < 0 ? raw : raw.slice(0, end);
  return head.replace(/^Bcc:.*(?:\r?\n[ \t].*)*\r?\n?/gim, "").replace(/\bfor <([^>]*)>/g, hideForeignRecipient(username)) + (end < 0 ? "" : raw.slice(end));
}

export function scrubHeaders(headers, username) {
  const kept = Object.entries(headers).filter(([name]) => name.toLowerCase() !== "bcc");
  return Object.fromEntries(kept.map(([name, values]) => [name, values.map((v) => v.replace(/\bfor <([^>]*)>/g, hideForeignRecipient(username)))]));
}
