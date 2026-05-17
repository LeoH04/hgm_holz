const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
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
const MAIL_CONFIG = createMailConfig();

if (!ADMIN_PASSWORD) {
  throw new Error("ADMIN_PASSWORD muss in Produktion gesetzt sein.");
}

if (!process.env.ADMIN_PASSWORD) {
  console.warn("Admin nutzt das lokale Standardpasswort 'admin'. Vor Deployment in .env ändern.");
}

if (MAIL_CONFIG.enabled) {
  console.log("Bestätigungs-E-Mails per SMTP aktiviert.");
} else {
  console.warn("SMTP nicht konfiguriert; Bestätigungs-E-Mails werden nicht versendet.");
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
const deleteOrder = db.prepare("DELETE FROM orders WHERE id = ?");

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
  const orderId = Number(result.lastInsertRowid);

  queueOrderConfirmation(order, orderId);
  sendJson(res, 201, { ok: true, id: orderId });
}

function queueOrderConfirmation(order, orderId) {
  if (!MAIL_CONFIG.enabled) {
    console.error(`Bestätigungs-E-Mail für Anfrage #${orderId} wurde nicht versendet: SMTP ist nicht konfiguriert.`);
    return;
  }

  sendOrderConfirmation(order, orderId).catch((error) => {
    console.error(`Bestätigungs-E-Mail für Anfrage #${orderId} konnte nicht gesendet werden: ${error.message}`);
  });
}

async function sendOrderConfirmation(order, orderId) {
  const subject = "Eingangsbestätigung deiner Brennholz-Anfrage";
  const text = buildOrderConfirmationText(order, orderId);

  await sendSmtpMail({
    to: {
      email: order.email,
      name: order.name
    },
    subject,
    text
  });

  console.log(`Bestätigungs-E-Mail für Anfrage #${orderId} gesendet.`);
}

function buildOrderConfirmationText(order, orderId) {
  const details = [
    `Anfragenummer: #${orderId}`,
    `Name: ${order.name}`,
    `Telefon: ${order.telefon}`,
    order.email ? `E-Mail: ${order.email}` : "",
    order.adresse ? `Ort / Lieferadresse: ${order.adresse}` : "",
    `Gewünschte Menge: ${order.menge}`,
    `Übergabe: ${order.uebergabe}`,
    order.nachricht ? `Nachricht: ${order.nachricht}` : ""
  ].filter(Boolean);

  return [
    `Hallo ${order.name},`,
    "",
    "vielen Dank für deine Brennholz-Anfrage. Wir haben sie erhalten und melden uns persönlich zur Abstimmung.",
    "",
    "Deine Angaben:",
    ...details.map((detail) => `- ${detail}`),
    "",
    "Hinweis: Diese E-Mail bestätigt nur den Eingang deiner Anfrage. Eine verbindliche Bestellung entsteht erst nach unserer Rückmeldung und Bestätigung.",
    "",
    "Viele Grüße",
    "HGM Holz"
  ].join("\n");
}

async function sendSmtpMail({ to, subject, text }) {
  const client = await connectSmtp(MAIL_CONFIG);
  const fromAddress = extractEmailAddress(MAIL_CONFIG.from);
  const recipientAddress = extractEmailAddress(to.email);

  try {
    let capabilities = await sayHello(client);

    if (!MAIL_CONFIG.secure && capabilities.has("STARTTLS")) {
      await client.command("STARTTLS", [220], "STARTTLS");
      await client.upgradeToTls();
      capabilities = await sayHello(client);
    }

    if (MAIL_CONFIG.user || MAIL_CONFIG.password) {
      await authenticateSmtp(client, capabilities);
    }

    await client.command(`MAIL FROM:<${fromAddress}>`, [250], "MAIL FROM");
    await client.command(`RCPT TO:<${recipientAddress}>`, [250, 251], "RCPT TO");
    await client.command("DATA", [354], "DATA");
    await client.sendData(buildEmailMessage({ to, subject, text }));
    await client.command("QUIT", [221], "QUIT").catch(() => {});
  } finally {
    client.close();
  }
}

async function sayHello(client) {
  const response = await client.command(`EHLO ${MAIL_CONFIG.heloName}`, [250], "EHLO");
  return parseSmtpCapabilities(response);
}

async function authenticateSmtp(client, capabilities) {
  const authMethods = capabilities.get("AUTH") || "";

  if (authMethods.includes("PLAIN") || authMethods === "") {
    const token = Buffer.from(`\0${MAIL_CONFIG.user}\0${MAIL_CONFIG.password}`, "utf8").toString("base64");
    await client.command(`AUTH PLAIN ${token}`, [235], "AUTH PLAIN");
    return;
  }

  if (authMethods.includes("LOGIN")) {
    await client.command("AUTH LOGIN", [334], "AUTH LOGIN");
    await client.command(Buffer.from(MAIL_CONFIG.user, "utf8").toString("base64"), [334], "AUTH USER");
    await client.command(Buffer.from(MAIL_CONFIG.password, "utf8").toString("base64"), [235], "AUTH PASSWORD");
    return;
  }

  throw new Error("SMTP-Server unterstützt keine passende Authentifizierung.");
}

function buildEmailMessage({ to, subject, text }) {
  const headers = [
    ["From", formatAddressHeader(MAIL_CONFIG.from, MAIL_CONFIG.fromName)],
    ["To", formatAddressHeader(to.email, to.name)],
    ["Subject", encodeHeader(subject)],
    ["Date", new Date().toUTCString()],
    ["Message-ID", `<${crypto.randomUUID()}@${MAIL_CONFIG.heloName}>`],
    ["MIME-Version", "1.0"],
    ["Content-Type", "text/plain; charset=UTF-8"],
    ["Content-Transfer-Encoding", "8bit"]
  ];

  if (MAIL_CONFIG.replyTo) {
    headers.splice(2, 0, ["Reply-To", formatAddressHeader(MAIL_CONFIG.replyTo)]);
  }

  return `${headers.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${text}`;
}

async function connectSmtp(config) {
  let socket = config.secure
    ? tls.connect({ host: config.host, port: config.port, servername: config.host })
    : net.connect({ host: config.host, port: config.port });
  let reader = createSmtpReader(socket, config.timeoutMs);

  await waitForConnection(socket, config.secure);
  const greeting = await reader.read();

  if (greeting.code !== 220) {
    throw new Error(`SMTP-Verbindung abgelehnt (${greeting.code}).`);
  }

  return {
    async command(line, expectedCodes, label) {
      socket.write(`${line}\r\n`);
      const response = await reader.read();

      if (!expectedCodes.includes(response.code)) {
        throw new Error(`${label} fehlgeschlagen (${response.code}).`);
      }

      return response;
    },
    async sendData(rawMessage) {
      socket.write(`${normalizeSmtpData(rawMessage)}\r\n.\r\n`);
      const response = await reader.read();

      if (response.code !== 250) {
        throw new Error(`DATA fehlgeschlagen (${response.code}).`);
      }
    },
    async upgradeToTls() {
      reader.detach();
      socket = tls.connect({ socket, servername: config.host });
      reader = createSmtpReader(socket, config.timeoutMs);
      await waitForConnection(socket, true);
    },
    close() {
      reader.detach();
      socket.end();
    }
  };
}

function createSmtpReader(socket, timeoutMs) {
  let buffer = "";
  let pending = null;

  function onData(chunk) {
    buffer += chunk.toString("utf8");
    resolvePending();
  }

  function onError(error) {
    rejectPending(error);
  }

  function onClose() {
    rejectPending(new Error("SMTP-Verbindung wurde geschlossen."));
  }

  function resolvePending() {
    if (!pending) return;

    const parsed = parseSmtpResponse(buffer);
    if (!parsed) return;

    buffer = parsed.rest;
    clearTimeout(pending.timer);
    const resolve = pending.resolve;
    pending = null;
    resolve(parsed.response);
  }

  function rejectPending(error) {
    if (!pending) return;

    clearTimeout(pending.timer);
    const reject = pending.reject;
    pending = null;
    reject(error);
  }

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  return {
    read() {
      if (pending) {
        return Promise.reject(new Error("SMTP-Antwort wird bereits gelesen."));
      }

      return new Promise((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(() => rejectPending(new Error("SMTP-Antwort hat zu lange gedauert.")), timeoutMs)
        };
        resolvePending();
      });
    },
    detach() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      rejectPending(new Error("SMTP-Reader wurde beendet."));
    }
  };
}

function parseSmtpResponse(buffer) {
  const lines = buffer.split("\r\n");
  if (!buffer.endsWith("\r\n")) lines.pop();

  let consumedLength = 0;
  const responseLines = [];

  for (const line of lines) {
    consumedLength += line.length + 2;
    responseLines.push(line);

    const match = line.match(/^(\d{3})\s/);
    if (!match) continue;

    return {
      response: {
        code: Number(match[1]),
        lines: responseLines,
        message: responseLines.map((responseLine) => responseLine.slice(4)).join("\n")
      },
      rest: buffer.slice(consumedLength)
    };
  }

  return null;
}

function parseSmtpCapabilities(response) {
  const capabilities = new Map();

  for (const line of response.lines) {
    const content = line.slice(4).trim();
    if (!content) continue;

    const [key, ...values] = content.split(/\s+/);
    capabilities.set(key.toUpperCase(), values.join(" ").toUpperCase());
  }

  return capabilities;
}

function normalizeSmtpData(rawMessage) {
  return rawMessage
    .replace(/\r?\n/g, "\r\n")
    .replace(/^\./gm, "..");
}

function waitForConnection(socket, isTls) {
  return new Promise((resolve, reject) => {
    const event = isTls ? "secureConnect" : "connect";

    socket.once(event, resolve);
    socket.once("error", reject);
  });
}

function formatAddressHeader(email, displayName = "") {
  const address = extractEmailAddress(email);
  const name = cleanHeaderValue(displayName || extractDisplayName(email));

  if (!name) return `<${address}>`;

  return `${encodePhrase(name)} <${address}>`;
}

function extractEmailAddress(value) {
  const text = String(value || "");
  const wrapped = text.match(/<([^>]+)>/);
  const email = wrapped ? wrapped[1] : text.match(/[^\s<>"]+@[^\s<>"]+/)?.[0];

  if (!email) {
    throw new Error("E-Mail-Adresse fehlt.");
  }

  return email.trim();
}

function extractDisplayName(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/["']/g, "")
    .trim();
}

function encodeHeader(value) {
  const cleanValue = cleanHeaderValue(value);

  if (/^[\x20-\x7E]*$/.test(cleanValue)) {
    return cleanValue;
  }

  return `=?UTF-8?B?${Buffer.from(cleanValue, "utf8").toString("base64")}?=`;
}

function encodePhrase(value) {
  const cleanValue = cleanHeaderValue(value);

  if (!/^[\x20-\x7E]*$/.test(cleanValue)) {
    return encodeHeader(cleanValue);
  }

  return `"${cleanValue.replace(/["\\]/g, "\\$&")}"`;
}

function cleanHeaderValue(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
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

  const orderMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (req.method === "DELETE" && orderMatch) {
    const result = deleteOrder.run(Number(orderMatch[1]));

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

function createMailConfig() {
  const host = cleanEnv(process.env.SMTP_HOST);
  const from = cleanEnv(process.env.SMTP_FROM);
  const secure = parseBoolean(process.env.SMTP_SECURE, Number(process.env.SMTP_PORT) === 465);
  const port = Number(process.env.SMTP_PORT || (secure ? 465 : 587));

  return {
    enabled: Boolean(host && from),
    host,
    port,
    secure,
    user: cleanEnv(process.env.SMTP_USER),
    password: process.env.SMTP_PASSWORD || "",
    from,
    fromName: cleanEnv(process.env.SMTP_FROM_NAME) || "HGM Holz",
    replyTo: cleanEnv(process.env.SMTP_REPLY_TO),
    heloName: cleanEnv(process.env.SMTP_HELO_NAME) || "hgm-holz.local",
    timeoutMs: Number(process.env.SMTP_TIMEOUT_MS || 10000)
  };
}

function cleanEnv(value) {
  return String(value || "").trim();
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "ja"].includes(String(value).trim().toLowerCase());
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

  if (!order.name || !order.telefon || !order.email || !order.menge || !order.uebergabe || body.datenschutz !== true) {
    return { ok: false, error: "Bitte alle Pflichtfelder ausfüllen." };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email)) {
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
