import { test, expect } from "@playwright/test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { MailboxTimeoutError, waitForMessage } from "./mailbox.ts";

const bridgeUrl = process.env.BRIDGE_URL ?? "http://127.0.0.1:8080/ingest";
const hmacKey = process.env.HMAC_KEY ?? "";
const sourceSubject = "ทดสอบใบแจ้งหนี้ INV-0001";

// Stands in for the FA send step: pushes a signed message through the bridge
async function sendThroughBridge(testId: string): Promise<void> {
  const messageId = randomUUID();
  const eml = readFileSync(process.env.SAMPLE_EML ?? "sample.eml", "latin1")
    .replaceAll("qa+t-l01@poc.test", `qa+${testId}@poc.test`)
    .replaceAll("l01@poc.test", `${messageId}@poc.test`);
  const body = Buffer.from(eml, "latin1");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", hmacKey).update(`${messageId}.${timestamp}.${bodyHash}`).digest("hex");
  const res = await fetch(bridgeUrl, {
    method: "POST",
    headers: {
      "X-Capture-Id": messageId,
      "X-Capture-Timestamp": timestamp,
      "X-Capture-Signature": signature,
      "X-Envelope-From": "qa-sender@example.com",
      "X-Envelope-To": `qa+${testId}@poc.test`,
    },
    body,
  });
  expect(res.status).toBe(200);
}

test("captured mail is found by test id with subject and attachment", async () => {
  const testId = `t-${randomUUID().slice(0, 8)}`;
  const receivedAfter = new Date();
  await sendThroughBridge(testId);

  const message = await waitForMessage(testId, { receivedAfter, timeoutMs: 10_000 });

  expect(message.subject).toBe(sourceSubject);
  expect(message.attachments.map((a) => a.name)).toEqual(["inv0001.pdf"]);
  expect(message.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(message.raw.length).toBeGreaterThan(message.attachments[0].size);
});

test("a send that never happens ends in an explicit timeout error", async () => {
  const testId = `t-${randomUUID().slice(0, 8)}`;
  await expect(waitForMessage(testId, { receivedAfter: new Date(), timeoutMs: 1500 })).rejects.toBeInstanceOf(MailboxTimeoutError);
});

test("a stale message from before the send is not accepted", async () => {
  const testId = `t-${randomUUID().slice(0, 8)}`;
  await sendThroughBridge(testId);
  await expect(waitForMessage(testId, { receivedAfter: new Date(Date.now() + 5000), timeoutMs: 1500 })).rejects.toBeInstanceOf(MailboxTimeoutError);
});
