import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openAccounts, usernameError } from "../src/accounts.js";
import { owns } from "../src/mail.js";

test("plain names and +tag names are accepted", () => {
  for (const name of ["abc", "test", "test+1", "alice.b-c_d+x.y_z-9", `${"a".repeat(30)}+${"b".repeat(30)}`, "alice+qa"]) {
    assert.equal(usernameError(name), null, name);
  }
});

test("malformed +tag names are refused", () => {
  const bad = ["test+", "+1", "test++1", "test+a+b", "test+a b", "test+A", "test+é", "test+1\n", `test+${"b".repeat(31)}`, "ab+1", "test+@x", "test+1@booth.pp.ua"];
  for (const name of bad) assert.match(usernameError(name) ?? "", /username must be/, name);
});

test("reserved names stay reserved on their base part", () => {
  for (const name of ["qa-team", "qa-team+1", "qa1+x", "h13+x", "root+1", "admin+x", "no-reply+a", "support+1"]) {
    assert.equal(usernameError(name), "username not available", name);
  }
});

test("a name owns exactly its own address and its own +sub-tags", () => {
  const to = (local, domain = "booth.pp.ua") => `${local}@${domain}`;
  assert.equal(owns("test+1", to("test+1")), true);
  assert.equal(owns("test+1", to("test+1+x")), true);
  assert.equal(owns("test+1", to("TEST+1", "BOOTH.PP.UA")), true);
  for (const other of ["test", "test+2", "test+10", "test+", "atest+1", "test_1", "test 1"]) {
    assert.equal(owns("test+1", to(other)), false, other);
  }
  assert.equal(owns("test+1", to("test+1", "example.com")), false);
});

test("the base name owns every +tag of itself and nothing else", () => {
  const to = (local) => `${local}@booth.pp.ua`;
  for (const local of ["test", "test+1", "test+2", "test+10", "test+1+x"]) assert.equal(owns("test", to(local)), true, local);
  for (const local of ["tests", "xtest", "tes", "test-1", "test.1"]) assert.equal(owns("test", to(local)), false, local);
});

test("a +tag name round-trips through the session cookie", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "names-"));
  const store = openAccounts(path.join(dir, "users.sqlite"), "unit-test-key");
  try {
    for (const name of ["test", "test+1"]) store.open(name);
    const sid = store.start();
    store.add(sid, "test");
    store.add(sid, "test+1");
    const [set] = store.issue(sid, true);
    const value = /^inboxes=([^;]*)/.exec(set)[1];
    assert.match(value, /^v3\.[A-Za-z0-9_-]{43}\.\d+\.[0-9a-f]{64}$/);
    assert.equal(decodeURIComponent(value), value);
    for (const header of [`inboxes=${value}`, `theme=dark; inboxes=${value}`, `inboxes=${value}; theme=dark`, `a=1;  inboxes=${value}; b=2`]) {
      const { accounts, active } = store.sessionFrom(header);
      assert.deepEqual({ accounts, active }, { accounts: ["test", "test+1"], active: "test+1" }, header);
    }
    const flipped = value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
    assert.equal(store.sessionFrom(`inboxes=${flipped}`), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
