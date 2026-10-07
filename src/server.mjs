import { createServer } from "node:http";
import { Readable } from "node:stream";
import api from "./api.ts";

function requestUrl(req, port) {
  const protocol = String(req.headers["x-forwarded-proto"] || "http").split(",", 1)[0].trim();
  const host = req.headers.host || `127.0.0.1:${port}`;
  return `${protocol}://${host}${req.url || "/"}`;
}

export function createHttpServer() {
  return createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }

      const method = incoming.method || "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const request = new Request(requestUrl(incoming, outgoing.localPort || process.env.PORT || 3000), {
        method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(incoming), duplex: "half" } : {}),
      });
      const response = await api.fetch(request);

      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      if (!response.body || method === "HEAD") {
        outgoing.end();
        return;
      }
      Readable.fromWeb(response.body).pipe(outgoing);
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      }
      outgoing.end('{"error":"internal_error"}');
    }
  });
}

export function startServer() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");
  const server = createHttpServer();
  server.listen(port, "0.0.0.0");
  return server;
}

startServer();
