import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SORT, clearFilters, defaultState, filterMessages, formatHash, formatSort, hasFilters, nextSort,
  orderAccounts, parseHash, parseQuery, parseSort, senderOptions, sortMessages,
} from "../src/public/listview.js";

const NOW = new Date(2026, 9, 16, 15, 30).getTime();
const ago = (ms) => new Date(NOW - ms).toISOString();
const HOUR = 3600_000;
const BASE = "test@booth.pp.ua";
const who = (name, address) => ({ Name: name, Address: address });
const mail = (id, over = {}) => ({ id, from: who("Alice", "alice@example.com"), to: [who("", BASE)], cc: [], subject: `subject ${id}`, snippet: `snippet ${id}`, created: ago(HOUR), attachments: 0, size: 1000, read: true, ...over });
const ids = (list) => list.map((m) => m.id);
const run = (messages, patch = {}) => filterMessages(messages, { ...defaultState(), ...patch }, { now: NOW });

test("parseQuery reads each operator and keeps free text", () => {
  const terms = parseQuery("from:bob to:ploy subject:invoice has:attachment is:unread hello");
  assert.deepEqual(terms, { from: ["bob"], to: ["ploy"], subject: ["invoice"], attachment: true, unread: true, text: ["hello"] });
});

test("parseQuery handles quoted values, quoted phrases and an unclosed quote", () => {
  assert.deepEqual(parseQuery('from:"john smith" "exact phrase" tail').from, ["john smith"]);
  assert.deepEqual(parseQuery('from:"john smith" "exact phrase" tail').text, ["exact phrase", "tail"]);
  assert.deepEqual(parseQuery('subject:"half open').subject, ["half open"]);
  assert.deepEqual(parseQuery('"half open').text, ["half open"]);
});

test("parseQuery treats unknown operators and urls as free text", () => {
  assert.deepEqual(parseQuery("x:foo has:other is:read http://a.b 12:30").text, ["x:foo", "has:other", "is:read", "http://a.b", "12:30"]);
});

test("parseQuery ignores an operator with no value and is case-insensitive", () => {
  const terms = parseQuery("from: To:Bob SUBJECT:Hi HAS:Attachment is:");
  assert.deepEqual(terms, { from: [], to: ["bob"], subject: ["hi"], attachment: true, unread: false, text: [] });
  assert.deepEqual(parseQuery(""), { from: [], to: [], subject: [], attachment: false, unread: false, text: [] });
  assert.deepEqual(parseQuery("   "), parseQuery(""));
});

test("search operators combine with AND and with free text", () => {
  const list = [
    mail("a", { from: who("Bob Lee", "bob@x.com"), subject: "Invoice May", attachments: 1, read: false }),
    mail("b", { from: who("Bob Lee", "bob@x.com"), subject: "Invoice June", read: true }),
    mail("c", { from: who("Eve", "eve@x.com"), subject: "Invoice May", attachments: 2, read: false }),
  ];
  assert.deepEqual(ids(run(list, { q: "from:bob" })), ["a", "b"]);
  assert.deepEqual(ids(run(list, { q: "from:bob subject:may" })), ["a"]);
  assert.deepEqual(ids(run(list, { q: "invoice has:attachment" })), ["a", "c"]);
  assert.deepEqual(ids(run(list, { q: "is:unread from:eve" })), ["c"]);
  assert.deepEqual(ids(run(list, { q: "from:bob is:unread has:attachment invoice may" })), ["a"]);
  assert.deepEqual(ids(run(list, { q: "from:nobody" })), []);
});

test("free text matches subject, sender, recipient and snippet, every word required", () => {
  const list = [mail("a", { subject: "Hello", snippet: "see the report" }), mail("b", { from: who("Zed", "zed@y.org"), snippet: "other" })];
  assert.deepEqual(ids(run(list, { q: "hello report" })), ["a"]);
  assert.deepEqual(ids(run(list, { q: "ZED" })), ["b"]);
  assert.deepEqual(ids(run(list, { q: "test@booth" })), ["a", "b"]);
  assert.deepEqual(ids(run(list, { q: "report hello nope" })), []);
});

test("to: also matches Cc recipients", () => {
  const list = [mail("a", { cc: [who("", "boss@x.com")] }), mail("b")];
  assert.deepEqual(ids(run(list, { q: "to:boss" })), ["a"]);
});

test("unread chip keeps only unread mail", () => {
  assert.deepEqual(ids(run([mail("a", { read: false }), mail("b")], { unread: true })), ["a"]);
});

test("attachment chip keeps only mail with attachments", () => {
  assert.deepEqual(ids(run([mail("a", { attachments: 2 }), mail("b"), mail("c", { attachments: [{}] })], { att: true })), ["a", "c"]);
});

test("1h and 7d ranges cut at the right age", () => {
  const list = [mail("new", { created: ago(HOUR - 1000) }), mail("old", { created: ago(HOUR + 1000) }), mail("week", { created: ago(7 * 24 * HOUR - 1000) }), mail("older", { created: ago(7 * 24 * HOUR + 1000) })];
  assert.deepEqual(ids(run(list, { range: "1h" })), ["new"]);
  assert.deepEqual(ids(run(list, { range: "7d" })), ["new", "old", "week"]);
});

test("Today starts at local midnight", () => {
  const list = [mail("after", { created: new Date(2026, 9, 16, 0, 1).toISOString() }), mail("before", { created: new Date(2026, 9, 15, 23, 59).toISOString() })];
  assert.deepEqual(ids(run(list, { range: "today" })), ["after"]);
});

test("to: can still narrow to one tag address", () => {
  const to = (...locals) => locals.map((l) => who("", `${l}@booth.pp.ua`));
  const list = [mail("a", { to: to("test+01") }), mail("b", { to: to("test+01", "test+02") }), mail("c", { to: to("test") })];
  assert.deepEqual(ids(run(list, { q: "to:test+01" })), ["a", "b"]);
  assert.deepEqual(ids(run(list, { q: "to:test+02" })), ["b"]);
});

test("sender dropdown lists each sender once with a count, and filters by address", () => {
  const list = [mail("a", { from: who("Zed", "Zed@x.com") }), mail("b", { from: who("Alice", "alice@example.com") }), mail("c", { from: who("Zed", "zed@x.com") }), mail("d", { from: undefined })];
  assert.deepEqual(senderOptions(list).map((s) => [s.value, s.count]), [["alice@example.com", 1], ["zed@x.com", 2]]);
  assert.deepEqual(ids(run(list, { from: "zed@x.com" })), ["a", "c"]);
});

test("filters combine with AND", () => {
  const list = [mail("a", { read: false, attachments: 1 }), mail("b", { read: false }), mail("c", { attachments: 1 })];
  assert.deepEqual(ids(run(list, { unread: true, att: true })), ["a"]);
});

test("sort orders each column both ways", () => {
  const list = [
    mail("1", { from: who("bob", "b@x.com"), subject: "beta", size: 300, created: ago(3 * HOUR) }),
    mail("2", { from: who("Alice", "a@x.com"), subject: "Alpha", size: 100, created: ago(HOUR) }),
    mail("3", { from: who("carol", "c@x.com"), subject: "gamma", size: 200, created: ago(2 * HOUR) }),
  ];
  const order = (key, dir) => ids(sortMessages(list, { key, dir }));
  assert.deepEqual(order("from", "asc"), ["2", "1", "3"]);
  assert.deepEqual(order("from", "desc"), ["3", "1", "2"]);
  assert.deepEqual(order("subject", "asc"), ["2", "1", "3"]);
  assert.deepEqual(order("size", "asc"), ["2", "3", "1"]);
  assert.deepEqual(order("size", "desc"), ["1", "3", "2"]);
  assert.deepEqual(order("received", "desc"), ["2", "3", "1"]);
  assert.deepEqual(order("received", "asc"), ["1", "3", "2"]);
});

test("sort is stable and never mutates its input", () => {
  const list = [mail("a", { size: 5 }), mail("b", { size: 5 }), mail("c", { size: 1 }), mail("d", { size: 5 })];
  const copy = [...list];
  assert.deepEqual(ids(sortMessages(list, { key: "size", dir: "desc" })), ["a", "b", "d", "c"]);
  assert.deepEqual(ids(sortMessages(list, { key: "size", dir: "asc" })), ["c", "a", "b", "d"]);
  assert.deepEqual(list, copy);
  assert.deepEqual(sortMessages([], DEFAULT_SORT), []);
});

test("sort tolerates missing fields", () => {
  const list = [mail("a", { subject: undefined }), mail("b", { size: undefined, from: undefined }), mail("c", { created: "bad" })];
  for (const key of ["from", "subject", "size", "received"]) assert.equal(sortMessages(list, { key, dir: "asc" }).length, 3);
});

test("nextSort toggles the active column and starts others in their natural direction", () => {
  assert.deepEqual(nextSort({ key: "received", dir: "desc" }, "received"), { key: "received", dir: "asc" });
  assert.deepEqual(nextSort({ key: "received", dir: "asc" }, "received"), { key: "received", dir: "desc" });
  assert.deepEqual(nextSort(DEFAULT_SORT, "from"), { key: "from", dir: "asc" });
  assert.deepEqual(nextSort(DEFAULT_SORT, "size"), { key: "size", dir: "desc" });
});

test("parseSort accepts only known keys and directions", () => {
  assert.deepEqual(parseSort("size.desc"), { key: "size", dir: "desc" });
  for (const bad of [null, undefined, "", "size", "size.up", "date.asc", "size.desc.x", "SIZE.DESC"]) assert.equal(parseSort(bad), null, String(bad));
  assert.equal(formatSort(DEFAULT_SORT), "received.desc");
});

test("the default state is the bare list hash", () => {
  assert.equal(formatHash(defaultState()), "#/");
  assert.deepEqual(parseHash("#/"), defaultState());
  assert.deepEqual(parseHash(""), defaultState());
  assert.deepEqual(parseHash("#/view/abc"), defaultState());
});

test("hash round-trips every field", () => {
  const state = { q: 'from:"john smith" invoice & more=1', sort: { key: "size", dir: "desc" }, unread: true, att: true, range: "today", from: "a@x.com" };
  const hash = formatHash(state);
  assert.match(hash, /^#\/\?q=.+&sort=size\.desc&range=today&unread=1&att=1&from=a%40x\.com$/);
  assert.deepEqual(parseHash(hash), state);
  assert.equal(formatHash(parseHash(hash)), hash);
});

test("a non-default sort alone and a filter alone both serialize with the sort", () => {
  assert.equal(formatHash({ ...defaultState(), sort: { key: "from", dir: "asc" } }), "#/?sort=from.asc");
  assert.equal(formatHash({ ...defaultState(), unread: true }), "#/?sort=received.desc&unread=1");
  assert.deepEqual(parseHash("#/?sort=from.asc").sort, { key: "from", dir: "asc" });
});

test("a hash without sort uses the stored fallback sort", () => {
  assert.deepEqual(parseHash("#/", { key: "size", dir: "asc" }).sort, { key: "size", dir: "asc" });
  assert.deepEqual(parseHash("#/?unread=1", { key: "size", dir: "asc" }).sort, { key: "size", dir: "asc" });
});

test("parseHash survives hostile and malformed input", () => {
  const hostile = [
    "#/?q=%E0%A4%A", "#/?sort=__proto__&range=%00&tag=<script>alert(1)</script>&from=%0d%0a",
    `#/?q=${"a".repeat(5000)}`, "#/?unread=yes&att=2", "#/?%%%", "#/?range=7d&range=1h",
  ];
  for (const hash of hostile) {
    const state = parseHash(hash);
    assert.ok(state.q.length <= 200, hash);
    assert.ok(["", "1h", "today", "7d"].includes(state.range), hash);
    assert.deepEqual(Object.keys(state).sort(), ["att", "from", "q", "range", "sort", "unread"]);
    assert.equal(typeof state.unread, "boolean");
    assert.doesNotMatch(state.from, /[\u0000-\u001f]/);
  }
  assert.equal(parseHash("#/?range=7d&range=1h").range, "7d");
  assert.deepEqual(parseHash("#/?sort=__proto__").sort, DEFAULT_SORT);
  assert.deepEqual(parseHash("#/?tag=01&unread=1"), { ...defaultState(), unread: true });
  assert.equal(formatHash(parseHash("#/?tag=01")), "#/");
  assert.equal(parseHash("#/?unread=yes&att=2").unread, false);
});

test("hasFilters and clearFilters leave the sort alone", () => {
  const sort = { key: "size", dir: "asc" };
  assert.equal(hasFilters({ ...defaultState(sort), q: "  " }), false);
  const busy = { ...defaultState(sort), from: "a@x.com", q: "x" };
  assert.equal(hasFilters(busy), true);
  assert.deepEqual(clearFilters(busy), defaultState(sort));
});

test("addresses list each base followed by its tags, in natural order", () => {
  const input = ["test2+01", "test+10", "test", "test2", "test+2", "test+01", "alpha", "test+1", "test10", "test9"];
  assert.deepEqual(orderAccounts(input), ["alpha", "test", "test+01", "test+1", "test+2", "test+10", "test2", "test2+01", "test9", "test10"]);
  assert.deepEqual(orderAccounts(["test+01", "test"]), ["test", "test+01"]);
  assert.deepEqual(orderAccounts(["b+1", "a+2", "a"]), ["a", "a+2", "b+1"]);
});

test("orderAccounts does not mutate its input and handles an empty list", () => {
  const input = ["b", "a"];
  assert.deepEqual(orderAccounts(input), ["a", "b"]);
  assert.deepEqual(input, ["b", "a"]);
  assert.deepEqual(orderAccounts([]), []);
});
