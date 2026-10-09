import http from "node:http";

const [mode, port] = process.argv.slice(2);
http.createServer((req, res) => {
  req.resume();
  console.log(`${new Date().toISOString()} ${mode} ${req.method} ${req.url}`);
  if (mode === "503") { res.writeHead(503); res.end("down"); }
}).listen(Number(port), "127.0.0.1");
