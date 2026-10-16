import test from "node:test";
import assert from "node:assert/strict";

process.env.MAILPIT_URL = "http://mailpit.test/admin";
process.env.MAILPIT_UI_USER = "u";
process.env.MAILPIT_UI_PASSWORD = "p";
const { listFor } = await import("../src/mail.js");

const message = (n, to) => ({ ID: `id${n}`, From: { Address: "s@example.com" }, To: [{ Address: to }], Cc: [], Bcc: [], Subject: `s${n}`, Created: new Date(2026, 9, 1, 0, n).toISOString(), Snippet: "", Attachments: 0, Size: 1, Read: false });

function stubSearch(direct, tagged) {
  globalThis.fetch = async (url) => {
    const query = decodeURIComponent(String(url));
    const messages = query.includes('addressed:"qa-user@') ? direct : tagged;
    return { ok: true, json: async () => ({ messages }) };
  };
}

test("a small inbox is not reported as truncated", async () => {
  stubSearch([message(1, "qa-user@booth.pp.ua")], []);
  const result = await listFor("qa-user", new Set());
  assert.equal(result.truncated, false);
  assert.deepEqual(result.messages.map((m) => m.id), ["id1"]);
});

test("a candidate list that reached 200 is reported as truncated", async () => {
  const direct = Array.from({ length: 200 }, (_, i) => message(i, "qa-user@booth.pp.ua"));
  stubSearch(direct, []);
  assert.equal((await listFor("qa-user", new Set())).truncated, true);
  stubSearch([], Array.from({ length: 200 }, (_, i) => message(i, "qa-user+x@booth.pp.ua")));
  assert.equal((await listFor("qa-user", new Set())).truncated, true);
});

test("199 candidates in a list are not truncated and foreign mail is still dropped", async () => {
  const direct = Array.from({ length: 198 }, (_, i) => message(i, "qa-user@booth.pp.ua"));
  stubSearch([...direct, message(900, "someone@booth.pp.ua")], []);
  const result = await listFor("qa-user", new Set(["id0"]));
  assert.equal(result.truncated, false);
  assert.equal(result.messages.length, 197);
});
