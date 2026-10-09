import net from "node:net";

const CRLF = Buffer.from("\r\n");

function dotStuff(raw) {
  const text = raw.toString("latin1");
  let out = text.startsWith(".") ? "." + text : text;
  out = out.replaceAll("\r\n.", "\r\n..");
  let buf = Buffer.from(out, "latin1");
  if (!buf.subarray(buf.length - 2).equals(CRLF)) buf = Buffer.concat([buf, CRLF]);
  return buf;
}

export function relay({ host, port, from, recipients, raw, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => fail(new Error("smtp timeout")));
    let pending = "";
    let waiter = null;
    let done = false;

    const fail = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(err);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("smtp connection closed")));
    socket.on("data", (chunk) => {
      pending += chunk.toString("latin1");
      flush();
    });

    function flush() {
      if (!waiter) return;
      const lines = pending.split("\r\n");
      const last = lines.findIndex((l, i) => i < lines.length - 1 && /^\d{3} /.test(l));
      if (last === -1) return;
      const reply = lines.slice(0, last + 1);
      pending = lines.slice(last + 1).join("\r\n");
      const w = waiter;
      waiter = null;
      w({ code: Number(reply[last].slice(0, 3)), text: reply.join("\n") });
    }

    const reply = () => new Promise((r) => { waiter = r; flush(); });
    const expect = async (codes, label) => {
      const r = await reply();
      if (!codes.includes(r.code)) throw new Error(`smtp ${label} rejected: ${r.text}`);
      return r;
    };
    const send = (line) => socket.write(line + "\r\n");

    (async () => {
      await expect([220], "greeting");
      send("EHLO capture-bridge");
      await expect([250], "EHLO");
      send(`MAIL FROM:<${from}>`);
      await expect([250], "MAIL FROM");
      for (const rcpt of recipients) {
        send(`RCPT TO:<${rcpt}>`);
        await expect([250, 251], "RCPT TO");
      }
      send("DATA");
      await expect([354], "DATA");
      socket.write(dotStuff(raw));
      socket.write(".\r\n");
      const ack = await expect([250], "DATA end");
      send("QUIT");
      done = true;
      socket.end();
      resolve(ack.text);
    })().catch(fail);
  });
}
