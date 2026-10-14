import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { findMessageMetadata } from "./mailbox.ts";

const baseUrl = process.env.MAILPIT_URL ?? "";
const user = process.env.MAILPIT_USER ?? "";
const password = process.env.MAILPIT_PASSWORD ?? "";
const credentials = { baseUrl, user, password };

// sha256 of the 15 MiB attachment of the live T-03 mail, recorded when the file was generated
const expected = Object.fromEntries(
  readFileSync(new URL("../tools/live/mails/sizes.txt", import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, bytes, sha] = line.split(" ");
      return [name, { bytes: Number(bytes.split("=")[1]), sha256: sha.split("=")[1] }];
    }),
);

test.beforeAll(() => {
  if (!baseUrl || !user || !password) throw new Error("set MAILPIT_URL, MAILPIT_USER and MAILPIT_PASSWORD");
});

test("the Mailpit API answers with the CI credential", async () => {
  const res = await fetch(`${baseUrl}/api/v1/info`, { headers: { Authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64") } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ Version: expect.any(String), Messages: expect.any(Number) });
});

test("the captured T-03 mail is found by tag and its attachment metadata is readable", async () => {
  const messages = await findMessageMetadata("t03a", credentials);
  expect(messages.length).toBeGreaterThanOrEqual(1);
  const attachment = messages[0].attachments.find((a) => a.name === "t03-under-cap.pdf");
  expect(attachment).toBeDefined();
  expect(attachment!.size).toBe(expected["t03-under-cap.pdf"].bytes);
  expect(attachment!.sha256).toBe(expected["t03-under-cap.pdf"].sha256);
});

test("a wrong password is rejected", async () => {
  await expect(findMessageMetadata("t03a", { ...credentials, password: `${password}-wrong` })).rejects.toThrow(/401/);
});

test("no credential at all is rejected", async () => {
  await expect(findMessageMetadata("t03a", { baseUrl, user: "", password: "" })).rejects.toThrow(/401/);
});
