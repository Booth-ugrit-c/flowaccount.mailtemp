export const SORT_KEYS = ["from", "subject", "size", "received"];
export const RANGES = ["1h", "today", "7d"];
export const DEFAULT_SORT = Object.freeze({ key: "received", dir: "desc" });
export const MAX_QUERY_LENGTH = 200;
export const MAX_TAG_CHIPS = 12;

const FIRST_DIRECTION = { from: "asc", subject: "asc", size: "desc", received: "desc" };
const TAG_RE = /^[a-z0-9._-]{1,30}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
const TOKEN_RE = /([A-Za-z]+):(?:"([^"]*)(?:"|$)|(\S*))|"([^"]*)(?:"|$)|(\S+)/g;
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export const person = (p) => (p && p.Name ? p.Name : p?.Address ?? "");
export const people = (list) => (list ?? []).map((p) => (p.Name ? `${p.Name} <${p.Address}>` : p.Address)).join(", ");
const hasAttachment = (m) => (Array.isArray(m.attachments) ? m.attachments.length : Number(m.attachments)) > 0;

export function parseQuery(text) {
  const terms = { from: [], to: [], subject: [], attachment: false, unread: false, text: [] };
  for (const match of String(text ?? "").matchAll(TOKEN_RE)) {
    const [, field, quoted, bare, freeQuoted, freeBare] = match;
    if (field === undefined) {
      const word = (freeQuoted ?? freeBare).trim().toLowerCase();
      if (word) terms.text.push(word);
      continue;
    }
    const value = (quoted ?? bare).trim().toLowerCase();
    const name = field.toLowerCase();
    if (!value) continue;
    if (name === "from" || name === "to" || name === "subject") terms[name].push(value);
    else if (name === "has" && value === "attachment") terms.attachment = true;
    else if (name === "is" && value === "unread") terms.unread = true;
    else terms.text.push(`${field.toLowerCase()}:${value}`);
  }
  return terms;
}

function matchesQuery(m, terms) {
  if (terms.attachment && !hasAttachment(m)) return false;
  if (terms.unread && m.read) return false;
  const from = people([m.from]).toLowerCase();
  const to = people([...(m.to ?? []), ...(m.cc ?? [])]).toLowerCase();
  const subject = String(m.subject ?? "").toLowerCase();
  if (!terms.from.every((v) => from.includes(v)) || !terms.to.every((v) => to.includes(v)) || !terms.subject.every((v) => subject.includes(v))) return false;
  if (!terms.text.length) return true;
  const all = `${m.subject ?? ""} ${people([m.from])} ${people(m.to)} ${m.snippet ?? ""}`.toLowerCase();
  return terms.text.every((word) => all.includes(word));
}

export function parseSort(text) {
  const match = /^(from|subject|size|received)\.(asc|desc)$/.exec(String(text ?? ""));
  return match ? { key: match[1], dir: match[2] } : null;
}
export const formatSort = (sort) => `${sort.key}.${sort.dir}`;
export const nextSort = (current, key) => (current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_DIRECTION[key] });

export const defaultState = (sort = DEFAULT_SORT) => ({ q: "", sort: { key: sort.key, dir: sort.dir }, unread: false, att: false, range: "", tag: "", from: "" });
export const hasFilters = (state) => Boolean(state.q.trim() || state.unread || state.att || state.range || state.tag || state.from);
export const clearFilters = (state) => defaultState(state.sort);

export function parseHash(hash, fallbackSort = DEFAULT_SORT) {
  const state = defaultState(fallbackSort);
  const match = /^#\/\?([^]*)$/.exec(String(hash ?? ""));
  if (!match) return state;
  const params = new URLSearchParams(match[1]);
  state.q = (params.get("q") ?? "").replace(CONTROL_RE, " ").slice(0, MAX_QUERY_LENGTH);
  state.sort = parseSort(params.get("sort")) ?? state.sort;
  if (RANGES.includes(params.get("range"))) state.range = params.get("range");
  const tag = (params.get("tag") ?? "").toLowerCase();
  if (TAG_RE.test(tag)) state.tag = tag;
  state.unread = params.get("unread") === "1";
  state.att = params.get("att") === "1";
  state.from = (params.get("from") ?? "").replace(CONTROL_RE, "").trim().toLowerCase().slice(0, 254);
  return state;
}

export function formatHash(state) {
  const q = state.q.trim();
  const rest = [["tag", state.tag], ["range", state.range], ["unread", state.unread ? "1" : ""], ["att", state.att ? "1" : ""], ["from", state.from]].filter(([, value]) => value);
  const sorted = formatSort(state.sort) !== formatSort(DEFAULT_SORT);
  if (!q && !rest.length && !sorted) return "#/";
  return `#/?${new URLSearchParams([...(q ? [["q", q]] : []), ["sort", formatSort(state.sort)], ...rest])}`;
}

const splitAddress = (address) => {
  const text = String(address ?? "").toLowerCase();
  const at = text.lastIndexOf("@");
  return { local: text.slice(0, at), domain: text.slice(at + 1) };
};

export function recipientTags(m, base) {
  const own = splitAddress(base);
  const tags = new Set();
  for (const p of [...(m.to ?? []), ...(m.cc ?? [])]) {
    const { local, domain } = splitAddress(p.Address);
    if (domain !== own.domain || !local.startsWith(`${own.local}+`)) continue;
    const tag = local.slice(own.local.length + 1).split("+")[0];
    if (TAG_RE.test(tag)) tags.add(tag);
  }
  return tags;
}

export function tagCounts(messages, base) {
  const counts = new Map();
  for (const m of messages) for (const tag of recipientTags(m, base)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return counts;
}

export function topTags(counts, selected = "", max = MAX_TAG_CHIPS) {
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, max);
  if (selected && !ranked.some(([tag]) => tag === selected)) ranked.push([selected, counts.get(selected) ?? 0]);
  return ranked;
}

export function senderOptions(messages) {
  const byAddress = new Map();
  for (const m of messages) {
    const address = m.from?.Address?.toLowerCase();
    if (!address) continue;
    const seen = byAddress.get(address) ?? { value: address, label: m.from.Name ? `${m.from.Name} <${m.from.Address}>` : m.from.Address, count: 0 };
    seen.count += 1;
    byAddress.set(address, seen);
  }
  return [...byAddress.values()].sort((a, b) => collator.compare(a.label, b.label));
}

export function rangeStart(range, now) {
  if (range === "1h") return now - 3600_000;
  if (range === "7d") return now - 7 * 86400_000;
  if (range === "today") {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return midnight.getTime();
  }
  return null;
}

export function filterMessages(messages, state, { base, now }) {
  const terms = parseQuery(state.q);
  const since = rangeStart(state.range, now);
  return messages.filter((m) =>
    (!state.unread || !m.read)
    && (!state.att || hasAttachment(m))
    && (since === null || Date.parse(m.created) >= since)
    && (!state.tag || recipientTags(m, base).has(state.tag))
    && (!state.from || m.from?.Address?.toLowerCase() === state.from)
    && matchesQuery(m, terms));
}

const SORT_VALUE = {
  from: (m) => person(m.from),
  subject: (m) => String(m.subject ?? ""),
  size: (m) => Number(m.size) || 0,
  received: (m) => Date.parse(m.created) || 0,
};

export function sortMessages(messages, sort) {
  const value = SORT_VALUE[sort.key] ?? SORT_VALUE.received;
  const sign = sort.dir === "asc" ? 1 : -1;
  const compare = typeof value(messages[0] ?? {}) === "number" ? (a, b) => a - b : (a, b) => collator.compare(a, b);
  return [...messages].sort((a, b) => sign * compare(value(a), value(b)));
}
