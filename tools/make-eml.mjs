import fs from "node:fs";
import crypto from "node:crypto";

const [out, to = "qa+t-l01@poc.test", targetBytes = "0", messageId = `${crypto.randomUUID()}@poc.test`] = process.argv.slice(2);
const subject = "=?UTF-8?B?" + Buffer.from("ทดสอบใบแจ้งหนี้ INV-0001", "utf8").toString("base64") + "?=";
const pdf = "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n";
const boundary = "BOUNDARY_poc_synthetic";
const wrap = (b64) => b64.match(/.{1,76}/g).join("\r\n");
const textBody = Buffer.from("สวัสดี นี่คือข้อมูลสังเคราะห์\r\n.line that starts with a dot\r\n", "utf8").toString("base64");

const head = [
  "From: qa-sender@example.com", `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${messageId}>`,
  "Date: Thu, 08 Oct 2026 10:00:00 +0000", "MIME-Version: 1.0",
  `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
  `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap(textBody), "",
  `--${boundary}`, 'Content-Type: application/pdf; name="inv0001.pdf"', 'Content-Disposition: attachment; filename="inv0001.pdf"',
  "Content-Transfer-Encoding: base64", "", wrap(Buffer.from(pdf).toString("base64")), "",
].join("\r\n") + "\r\n";
let tail = `--${boundary}--\r\n`;
let middle = "";
const target = Number(targetBytes);
if (target > 0) {
  const mHead = `--${boundary}\r\nContent-Type: application/octet-stream; name="pad.bin"\r\nContent-Disposition: attachment; filename="pad.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
  const room = target - head.length - tail.length - mHead.length - 2;
  const lines = Math.floor(room / 78);
  const rem = room - lines * 78;
  const rnd = crypto.randomBytes(Math.ceil((lines * 76) / 4) * 3).toString("base64");
  const chunks = [];
  for (let i = 0; i < lines; i++) chunks.push(rnd.slice(i * 76, i * 76 + 76));
  middle = mHead + chunks.join("\r\n") + "\r\n" + "A".repeat(Math.max(0, rem - 2)) + (rem >= 2 ? "\r\n" : "") + "\r\n";
}
const buf = Buffer.from(head + middle + tail, "latin1");
fs.writeFileSync(out, buf);
console.log(`${out} ${buf.length} sha256=${crypto.createHash("sha256").update(buf).digest("hex")}`);
