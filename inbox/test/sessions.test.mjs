import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openAccounts } from "../src/accounts.js";

const KEY = "unit-test-key";
const hmac = (text) => crypto.createHmac("sha256", KEY).update(text).digest("hex");
const v2Cookie = (accounts, active, iat = Math.floor(Date.now() / 1000)) => {
  const payload = Buffer.from(JSON.stringify({ accounts, active })).toString("base64url");
  return `${payload}.${iat}.${hmac(`v2:${payload}.${iat}`)}`;
};
const legacyCookie = (name) => {
  const iat = Math.floor(Date.now() / 1000);
  return `${name}.${iat}.${hmac(`session:${name}.${iat}`)}`;
};
const valueOf = (setCookie) => /^inboxes=([^;]*)/.exec(setCookie)[1];
const rows = (dbPath, sql) => {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
};
const flip = (value) => value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");

function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessions-"));
  const dbPath = path.join(dir, "users.sqlite");
  const stores = [];
  const open = () => {
    const store = openAccounts(dbPath, KEY);
    stores.push(store);
    return store;
  };
  try {
    return run(open, dbPath);
  } finally {
    for (const store of stores) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("150 addresses are saved in one session and survive a reopened database", () => {
  withStore((open) => {
    const store = open();
    const names = Array.from({ length: 150 }, (_, i) => `address-${String(i).padStart(3, "0")}+tag${i}`);
    const sid = store.start();
    for (const name of names) {
      store.open(name);
      store.add(sid, name);
    }
    const [set] = store.issue(sid, true);
    const session = open().sessionFrom(`inboxes=${valueOf(set)}`);
    assert.deepEqual(session.accounts, names);
    assert.equal(session.active, names.at(-1));
  });
});

test("the cookie length stays constant as the list grows", () => {
  withStore((open) => {
    const store = open();
    const sid = store.start();
    const lengths = new Set();
    for (let i = 0; i < 160; i += 1) {
      const name = `grow-${i}-${"x".repeat(40)}`;
      store.open(name);
      store.add(sid, name);
      if ([1, 10, 150, 160].includes(i + 1)) lengths.add(valueOf(store.issue(sid, true)[0]).length);
    }
    assert.equal(lengths.size, 1);
    assert.ok([...lengths][0] < 200);
  });
});

test("a forged, unsigned or unknown session id is no session", () => {
  withStore((open) => {
    const store = open();
    store.open("alice");
    const sid = store.start();
    store.add(sid, "alice");
    const good = valueOf(store.issue(sid, true)[0]);
    const other = crypto.randomBytes(32).toString("base64url");
    const iat = Math.floor(Date.now() / 1000);
    const bad = [
      flip(good),
      `v3.${other}.${iat}.${hmac(`v3:${other}.${iat}`)}`,
      `v3.${other}.${good.split(".").slice(2).join(".")}`,
      `v3.${sid}.1.${hmac(`v3:${sid}.1`)}`,
      `v3.${sid}.${iat}.${"0".repeat(64)}`,
      "v3.short.1.00",
      "",
    ];
    for (const value of bad) assert.equal(store.sessionFrom(`inboxes=${value}`), null, value);
    assert.notEqual(store.sessionFrom(`inboxes=${good}`), null);
  });
});

test("the session id is stored only as a sha256 hash", () => {
  withStore((open, dbPath) => {
    const store = open();
    store.open("hashed");
    const sid = store.start();
    store.add(sid, "hashed");
    assert.deepEqual(rows(dbPath, "SELECT id FROM sessions").map((r) => r.id), [crypto.createHash("sha256").update(sid).digest("hex")]);
  });
});

test("switch and forget keep the active address as before", () => {
  withStore((open) => {
    const store = open();
    const sid = store.start();
    for (const name of ["one-name", "two-name", "three-name"]) {
      store.open(name);
      store.add(sid, name);
    }
    assert.equal(store.activate(sid, "one-name").active, "one-name");
    assert.equal(store.forget(sid, "two-name").active, "one-name");
    assert.deepEqual(store.sessionFrom(`inboxes=${valueOf(store.issue(sid, true)[0])}`).accounts, ["one-name", "three-name"]);
    assert.equal(store.forget(sid, "one-name").active, "three-name");
    assert.equal(store.forget(sid, "three-name"), null);
    assert.equal(store.sessionFrom(`inboxes=${valueOf(store.issue(sid, true)[0])}`), null);
  });
});

test("a current v2 cookie with 10 names migrates with order and active address", () => {
  withStore((open) => {
    const store = open();
    const names = Array.from({ length: 10 }, (_, i) => `legacy-name-${i}`);
    for (const name of names) store.open(name);
    const session = store.sessionFrom(`inboxes=${v2Cookie(names, names[3])}`);
    assert.equal(session.migrated, true);
    assert.deepEqual(session.accounts, names);
    assert.equal(session.active, names[3]);
    const [set] = store.issue(session.sid, true);
    assert.match(valueOf(set), /^v3\./);
    const next = store.sessionFrom(`inboxes=${valueOf(set)}`);
    assert.equal(next.migrated, undefined);
    assert.deepEqual(next.accounts, names);
    assert.equal(next.active, names[3]);
  });
});

test("replaying the same old cookie reuses one session and does not resurrect forgotten names", () => {
  withStore((open, dbPath) => {
    const store = open();
    store.open("keep-me");
    store.open("drop-me");
    const cookie = v2Cookie(["keep-me", "drop-me"], "drop-me");
    const first = store.sessionFrom(`inboxes=${cookie}`);
    store.forget(first.sid, "drop-me");
    const second = store.sessionFrom(`inboxes=${cookie}`);
    assert.equal(second.sid, first.sid);
    assert.deepEqual(second.accounts, ["keep-me"]);
    assert.equal(rows(dbPath, "SELECT COUNT(*) AS n FROM sessions")[0].n, 1);
  });
});

test("the legacy single-name cookie migrates to a one-item list", () => {
  withStore((open) => {
    const store = open();
    store.open("solo");
    const session = store.sessionFrom(`inbox=${legacyCookie("solo")}`);
    assert.deepEqual([session.accounts, session.active, session.migrated], [["solo"], "solo", true]);
    assert.equal(store.sessionFrom(`inbox=${legacyCookie("ghost")}`), null);
  });
});

test("v2 cookies with unknown names, bad names or a bad signature do not migrate", () => {
  withStore((open) => {
    const store = open();
    store.open("real-name");
    assert.equal(store.sessionFrom(`inboxes=${v2Cookie(["ghost-name"], "ghost-name")}`), null);
    assert.equal(store.sessionFrom(`inboxes=${v2Cookie(["Bad Name"], "Bad Name")}`), null);
    assert.equal(store.sessionFrom(`inboxes=${flip(v2Cookie(["real-name"], "real-name"))}`), null);
    assert.equal(store.sessionFrom(`inboxes=${v2Cookie(["real-name"], "real-name", 1)}`), null);
  });
});

test("a v2 cookie above the old ten-name cap migrates whole", () => {
  withStore((open) => {
    const store = open();
    const names = Array.from({ length: 12 }, (_, i) => `over-cap-${i}`);
    for (const name of names) store.open(name);
    assert.deepEqual(store.sessionFrom(`inboxes=${v2Cookie(names, names[0])}`).accounts, names);
  });
});

test("existing users and hidden rows survive the schema upgrade", () => {
  withStore((open, dbPath) => {
    const first = open();
    first.open("kept-user");
    first.hide("kept-user", "msg-1");
    const second = open();
    assert.equal(second.exists("kept-user"), true);
    assert.deepEqual([...second.hiddenIds("kept-user")], ["msg-1"]);
  });
});
