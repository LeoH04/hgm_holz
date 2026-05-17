const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "hgm-holz.sqlite");

loadEnv();

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_SIZE = 32 * 1024;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (process.env.NODE_ENV === "production" ? "" : "admin");
const SESSION_COOKIE = "hgm_admin_session";
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_PASSWORD;
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

if (!ADMIN_PASSWORD) {
  throw new Error("ADMIN_PASSWORD muss in Produktion gesetzt sein.");
}

if (!process.env.ADMIN_PASSWORD) {
  console.warn("Admin nutzt das lokale Standardpasswort 'admin'. Vor Deployment in .env ändern.");
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL,
    telefon TEXT NOT NULL,
    email TEXT,
    adresse TEXT,
    menge TEXT NOT NULL,
    uebergabe TEXT NOT NULL,
    nachricht TEXT,
    status TEXT NOT NULL DEFAULT 'neu'
  );
`);

const insertOrder = db.prepare(`
  INSERT INTO orders (
    created_at, name, telefon, email, adresse, menge, uebergabe, nachricht, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'neu')
`);

const listOrders = db.prepare(`
  SELECT id, created_at, name, telefon, email, adresse, menge, uebergabe, nachricht, status
  FROM orders
  ORDER BY created_at DESC
`);

const updateOrderStatus = db.prepare("UPDATE orders SET status = ? WHERE id = ?");

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

const insertAdminSession = db.prepare("INSERT INTO admin_sessions (id, expires_at) VALUES (?, ?)");
const getAdminSession = db.prepare("SELECT expires_at FROM admin_sessions WHERE id = ?");
const deleteAdminSession = db.prepare("DELETE FROM admin_sessions WHERE id = ?");
const deleteExpiredAdminSessions = db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?");

deleteExpiredAdminSessions.run(Date.now());

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === "POST" && pathname === "/api/orders") {
      return handleCreateOrder(req, res);
    }

    if (req.method === "POST" && pathname === "/api/admin/login") {
      return handleAdminLogin(req, res);
    }

    if (req.method === "POST" && pathname === "/api/admin/logout") {
      return handleAdminLogout(req, res);
    }

    if (pathname === "/admin/login") {
      if (isAdmin(req)) return redirect(res, "/admin");
      return serveLoginPage(res, url.searchParams.get("error") === "1");
    }

    if (pathname.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return sendJson(res, 401, { error: "Nicht angemeldet." });
      return handleAdminApi(req, res, pathname);
    }

    if (pathname === "/admin.css") {
      return serveFile(res, "admin.css");
    }

    if (pathname === "/admin" || pathname === "/admin/" || pathname === "/admin.js") {
      if (!isAdmin(req)) return redirect(res, "/admin/login");
      const file = pathname === "/admin" || pathname === "/admin/" ? "admin.html" : pathname.slice(1);
      return serveFile(res, file, req.method, { "Cache-Control": "no-store" });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (pathname === "/" || pathname === "/index.html") return serveFile(res, "index.html", req.method);
      if (pathname === "/style.css") return serveFile(res, "style.css", req.method);
      if (pathname === "/script.js") return serveFile(res, "script.js", req.method);
      if (pathname.startsWith("/assets/")) return serveFile(res, pathname.slice(1), req.method);
    }

    sendJson(res, 404, { error: "Nicht gefunden." });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Interner Serverfehler." });
  }
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : PORT;
  console.log(`HGM Holz läuft unter http://${HOST}:${activePort}`);
  console.log(`Adminpanel: http://${HOST}:${activePort}/admin`);
});

process.on("SIGINT", () => {
  db.close();
  server.close(() => process.exit(0));
});

async function handleCreateOrder(req, res) {
  const body = await readJsonBody(req);
  const validation = validateOrder(body);

  if (validation.honeypot) {
    return sendJson(res, 200, { ok: true });
  }

  if (!validation.ok) {
    return sendJson(res, 400, { error: validation.error });
  }

  const order = validation.order;
  const result = insertOrder.run(
    new Date().toISOString(),
    order.name,
    order.telefon,
    order.email,
    order.adresse,
    order.menge,
    order.uebergabe,
    order.nachricht
  );

  sendJson(res, 201, { ok: true, id: Number(result.lastInsertRowid) });
}

async function handleAdminApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/admin/orders") {
    return sendJson(res, 200, { orders: listOrders.all() });
  }

  const statusMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
  if (req.method === "PATCH" && statusMatch) {
    const body = await readJsonBody(req);
    const status = clean(body.status, 24);
    const allowed = new Set(["neu", "kontaktiert", "erledigt"]);

    if (!allowed.has(status)) {
      return sendJson(res, 400, { error: "Ungültiger Status." });
    }

    const result = updateOrderStatus.run(status, Number(statusMatch[1]));

    if (result.changes === 0) {
      return sendJson(res, 404, { error: "Bestellung nicht gefunden." });
    }

    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: "Nicht gefunden." });
}

async function handleAdminLogin(req, res) {
  const body = await readFormBody(req);
  const user = clean(body.username, 120);
  const password = clean(body.password, 240);

  if (!safeEqual(user, ADMIN_USER) || !safeEqual(password, ADMIN_PASSWORD)) {
    return redirect(res, "/admin/login?error=1");
  }

  const sessionId = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  insertAdminSession.run(sessionId, expiresAt);

  const cookie = serializeCookie(SESSION_COOKIE, `${sessionId}.${signSessionPayload(sessionId)}`, {
    httpOnly: true,
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
    path: "/",
    sameSite: "Lax",
    secure: COOKIE_SECURE
  });

  res.writeHead(303, {
    "Location": "/admin",
    "Cache-Control": "no-store",
    "Set-Cookie": cookie
  });
  res.end();
}

function handleAdminLogout(req, res) {
  const sessionId = getSessionId(req);
  if (sessionId) {
    deleteAdminSession.run(sessionId);
  }

  res.writeHead(303, {
    "Location": "/admin/login",
    "Cache-Control": "no-store",
    "Set-Cookie": serializeCookie(SESSION_COOKIE, "", {
      httpOnly: true,
      maxAge: 0,
      path: "/",
      sameSite: "Lax",
      secure: COOKIE_SECURE
    })
  });
  res.end();
}

function validateOrder(body) {
  if (clean(body.website, 200)) {
    return { ok: true, honeypot: true };
  }

  const order = {
    name: clean(body.name, 120),
    telefon: clean(body.telefon, 80),
    email: clean(body.email, 160),
    adresse: clean(body.adresse, 220),
    menge: clean(body.menge, 80),
    uebergabe: clean(body.uebergabe, 80),
    nachricht: clean(body.nachricht, 1200)
  };

  if (!order.name || !order.telefon || !order.menge || !order.uebergabe || body.datenschutz !== true) {
    return { ok: false, error: "Bitte alle Pflichtfelder ausfüllen." };
  }

  if (order.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email)) {
    return { ok: false, error: "Bitte eine gültige E-Mail-Adresse eintragen." };
  }

  return { ok: true, order };
}

function clean(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function isAdmin(req) {
  const sessionId = getSessionId(req);
  if (!sessionId) return false;

  const session = getAdminSession.get(sessionId);
  if (!session) return false;

  if (Number(session.expires_at) <= Date.now()) {
    deleteAdminSession.run(sessionId);
    return false;
  }

  return true;
}

function getSessionId(req) {
  const cookie = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (!cookie) return "";

  const [sessionId, signature] = cookie.split(".");
  if (!sessionId || !signature || !safeEqual(signature, signSessionPayload(sessionId))) return "";

  return sessionId;
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function signSessionPayload(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator === -1) return [part, ""];
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      })
  );
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push("Secure");

  return parts.join("; ");
}

function redirect(res, location) {
  res.writeHead(303, {
    "Location": location,
    "Cache-Control": "no-store"
  });
  res.end();
}

function serveFile(res, relativePath, method = "GET", headers = {}) {
  const safePath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT) || safePath.startsWith(".") || safePath.startsWith("data")) {
    return sendJson(res, 404, { error: "Nicht gefunden." });
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      return sendJson(res, 404, { error: "Nicht gefunden." });
    }

    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      ...headers
    });

    if (method === "HEAD") {
      return res.end();
    }

    res.end(content);
  });
}

function serveLoginPage(res, hasError) {
  fs.readFile(path.join(ROOT, "admin-login.html"), "utf8", (error, html) => {
    if (error) {
      return sendJson(res, 404, { error: "Nicht gefunden." });
    }

    const content = html.replace("{{ERROR_HIDDEN}}", hasError ? "" : " hidden");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return readRawBody(req).then((body) => {
    if (!body) return {};
    return JSON.parse(body);
  });
}

function readFormBody(req) {
  return readRawBody(req).then((body) => Object.fromEntries(new URLSearchParams(body)));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => resolve(body));

    req.on("error", reject);
  });
}

function loadEnv() {
  const envPath = path.join(ROOT, ".env");

  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
