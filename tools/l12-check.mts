import fs from "node:fs";
import crypto from "node:crypto";
import { waitForMessage } from "../e2e-helper/mailbox.ts";

const [emlPath, testId, afterIso] = process.argv.slice(2);
const eml = fs.readFileSync(emlPath, "latin1");
const encodedSubject = eml.match(/^Subject: =\?UTF-8\?B\?(.+)\?=/m)![1];
const sourceSubject = Buffer.from(encodedSubject, "base64").toString("utf8");
const pdfB64 = eml.split('filename="inv0001.pdf"')[1].split("\r\n\r\n")[1].split("\r\n\r\n")[0].replace(/\r\n/g, "");
const sourceSha = crypto.createHash("sha256").update(Buffer.from(pdfB64, "base64")).digest("hex");

const message = await waitForMessage(testId, { receivedAfter: new Date(afterIso), timeoutMs: 10000 });
console.log("source subject :", sourceSubject);
console.log("stored subject :", message.subject);
console.log("subject equal  :", message.subject === sourceSubject);
console.log("source pdf sha :", sourceSha);
console.log("stored pdf sha :", message.attachments[0].sha256, message.attachments[0].name, message.attachments[0].size);
console.log("attachment equal:", message.attachments[0].sha256 === sourceSha);
