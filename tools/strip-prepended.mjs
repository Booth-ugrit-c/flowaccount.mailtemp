import fs from "node:fs";
import crypto from "node:crypto";

const [storedPath, sourcePath] = process.argv.slice(2);
const stored = fs.readFileSync(storedPath);
const source = fs.readFileSync(sourcePath);
const text = stored.toString("latin1");
const lines = text.split("\r\n");
let i = 0;
const removed = [];
for (const name of ["Return-Path", "Received"]) {
  if (lines[i]?.toLowerCase().startsWith(name.toLowerCase() + ":")) {
    removed.push(lines[i].split(":")[0]);
    i++;
    while (/^[ \t]/.test(lines[i] ?? "")) i++;
  }
}
const rest = Buffer.from(lines.slice(i).join("\r\n"), "latin1");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
console.log(`prepended blocks removed: ${removed.join(", ")}`);
console.log(`stored-minus-prepended sha256=${sha(rest)} bytes=${rest.length}`);
console.log(`source                 sha256=${sha(source)} bytes=${source.length}`);
console.log(sha(rest) === sha(source) ? "MATCH" : "MISMATCH");
