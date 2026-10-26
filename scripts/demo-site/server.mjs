/**
 * Built-in demo target site: a tiny Node static server with SPA fallback.
 *
 * Routes: / -> index.html, /orders/create -> create.html,
 * /orders/list -> list.html, anything else -> index.html.
 *
 * This is the system under test (default TARGET_URL http://127.0.0.1:8200).
 * Its visible copy intentionally matches the anchors the case generator
 * produces (e.g. "Order created successfully", "Payment successful",
 * "<Label> cannot be empty", "Total of N items").
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(__dirname, "static");
const PORT = Number(process.env.DEMO_PORT ?? 8200);
const HOST = process.env.DEMO_HOST ?? "127.0.0.1";

const ROUTES = {
  "/": "index.html",
  "/orders/create": "create.html",
  "/orders/list": "list.html",
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type ?? "text/plain; charset=utf-8",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const key = url.pathname.replace(/\/+$/, "") || "/";

  // 1. Explicit SPA routes.
  const routed = ROUTES[key];
  // 2. Otherwise, serve a real static asset (e.g. /favicon.ico) if it exists.
  const asset = path.normalize(path.join(STATIC, key));
  const isAsset =
    !routed &&
    asset.startsWith(STATIC) &&
    fs.existsSync(asset) &&
    fs.statSync(asset).isFile();

  const file = routed
    ? path.join(STATIC, routed)
    : isAsset
      ? asset
      : path.join(STATIC, ROUTES["/"]);
  if (!fs.existsSync(file)) {
    send(res, 404, "Not Found");
    return;
  }
  const ext = path.extname(file).toLowerCase();
  send(
    res,
    200,
    fs.readFileSync(file),
    CONTENT_TYPES[ext] ?? "application/octet-stream",
  );
});

server.listen(PORT, HOST, () => {
  console.log(`Demo target site running at http://${HOST}:${PORT}`);
});
