import net from "node:net";

const [count, bytes, prefix, firstIndex = "1", gapMs = "5", host = "mailpit"] = process.argv.slice(2);
const total = Number(count);
const padding = "x".repeat(Math.max(0, Number(bytes) - 300));

const socket = net.connect(1025, host);
let buffer = "";
let waiting = null;
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\r\n");
  buffer = lines.pop();
  for (const line of lines) if (/^\d{3} /.test(line) && waiting) { const done = waiting; waiting = null; done(line); }
});

const reply = () => new Promise((resolve) => { waiting = resolve; });
const send = async (text) => { socket.write(`${text}\r\n`); return reply(); };
const expect = (line, code) => { if (!line.startsWith(code)) throw new Error(`SMTP: expected ${code}, got ${line}`); };

expect(await reply(), "220");
expect(await send("EHLO janitor-seed"), "250");
for (let i = 0; i < total; i += 1) {
  const n = Number(firstIndex) + i;
  expect(await send("MAIL FROM:<seed@example.com>"), "250");
  expect(await send("RCPT TO:<janitor@booth.pp.ua>"), "250");
  expect(await send("DATA"), "354");
  socket.write(`From: seed@example.com\r\nTo: janitor@booth.pp.ua\r\nSubject: janitor-${prefix}-${n}\r\nMessage-ID: <${prefix}-${n}-${Date.now()}@janitor.test>\r\nContent-Type: text/plain\r\n\r\n${padding}\r\n.\r\n`);
  expect(await reply(), "250");
  if (Number(gapMs) > 0) await new Promise((r) => setTimeout(r, Number(gapMs)));
}
await send("QUIT");
socket.end();
console.log(`seeded ${total} messages (${prefix}-${firstIndex}..${prefix}-${Number(firstIndex) + total - 1}, about ${bytes} bytes each)`);
