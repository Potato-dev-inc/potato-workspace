// A fake PC for the tests: plain HTTP on loopback, with the routes the Worker has to forward.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One unmasked server frame. */
function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  return Buffer.concat([head, payload]);
}

/** Decode the client frames in `buffer` (always masked); returns [frames, rest]. */
function decode(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    let len = buffer[offset + 1] & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (buffer.length - pos < 2) break;
      len = buffer.readUInt16BE(pos);
      pos += 2;
    }
    if (buffer.length - pos < 4 + len) break;
    const mask = buffer.subarray(pos, pos + 4);
    const data = Buffer.from(buffer.subarray(pos + 4, pos + 4 + len));
    for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];
    frames.push({ opcode, data });
    offset = pos + 4 + len;
  }
  return [frames, buffer.subarray(offset)];
}

/** `label` names the origin in the JS a generic `/assets/*.js` file answers with, so two fake PCs can be told apart. */
export function startFakeOrigin(label = "A") {
  const seen = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    seen.push({ method: req.method, path: url.pathname + url.search, headers: req.headers });
    if (url.pathname === "/hello") {
      res.writeHead(200, { "content-type": "text/plain", "x-from": "fake-pc" });
      res.end(`hello ${url.search}`);
    } else if (url.pathname === "/echo") {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of req) {
        hash.update(chunk);
        size += chunk.length;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ size, sha256: hash.digest("hex"), method: req.method, type: req.headers["content-type"] ?? null }));
    } else if (url.pathname === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let n = 0;
      const timer = setInterval(() => {
        res.write(`data: tick ${n}\n\n`);
        n += 1;
        if (n === 4) {
          clearInterval(timer);
          res.end();
        }
      }, 300);
      res.on("close", () => clearInterval(timer));
    } else if (url.pathname === "/redirect") {
      res.writeHead(302, { location: `http://${req.headers.host}/hello` });
      res.end();
    } else if (url.pathname === "/assets/app-abc123.js" || url.pathname === "/sw.js" || url.pathname === "/index.html" || url.pathname === "/deep/link") {
      // like the phone server: every file says no-store
      const html = url.pathname === "/index.html" || url.pathname === "/deep/link";
      res.writeHead(200, { "content-type": html ? "text/html" : "text/javascript", "cache-control": "no-store" });
      res.end(html ? "<html></html>" : "console.log(1)");
    } else if (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".js")) {
      // any other page file: served like the phone server does (no-store), body names this origin
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      res.end(`console.log("${label}")`);
    } else if (url.pathname === "/down") {
      res.writeHead(502);
      res.end("bad gateway");
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ method: "UPGRADE", path: req.url, headers: req.headers });
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const [frames, rest] = decode(pending);
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 1) socket.write(frame(1, Buffer.from(`echo:${f.data.toString()}`)));
        else if (f.opcode === 8) socket.end(frame(8, Buffer.alloc(0)));
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) });
    });
  });
}
