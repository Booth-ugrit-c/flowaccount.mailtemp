import fs from "node:fs";
import crypto from "node:crypto";

const [file, captureId, envTo, envFrom = "qa-sender@example.com"] = process.argv.slice(2);
const mode = process.env.MODE ?? "valid";
const url = process.env.BRIDGE_URL ?? "http://127.0.0.1:8080/ingest";
const key = fs.readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^HMAC_KEY=(.+)$/m)[1];
const body = fs.readFileSync(file);
const timestamp = String(Math.floor(Date.now() / 1000) + (mode === "skew" ? 400 : 0));
const hash = crypto.createHash("sha256").update(body).digest("hex");
const signature = crypto.createHmac("sha256", key).update(`${captureId}.${timestamp}.${hash}`).digest("hex");

const headers = { "X-Capture-Id": captureId, "X-Capture-Timestamp": timestamp, "X-Envelope-From": envFrom, "X-Envelope-To": envTo };
if (mode !== "nosig") headers["X-Capture-Signature"] = signature;
const sent = mode === "tamper" ? Buffer.concat([body, Buffer.from("x")]) : body;
try {
  const res = await fetch(url, { method: "POST", headers, body: sent });
  console.log(`mode=${mode} status=${res.status} body=${(await res.text()).trim()}`);
} catch (e) {
  console.log(`mode=${mode} fetch-error=${e.cause?.code ?? e.message}`);
}
