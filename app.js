import { existsSync, readFileSync } from "fs";
import { createServer } from "http";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import {
  initDB, runWithDB, kPrisma,
  validateAuthToken, createAuthToken, registerWebUser, loginWebUser,
  getAccounts, createAccount, updateAccount, deleteAccount, getAccount,
  createSpeaker, updateSpeaker, deleteSpeaker, getSpeakers,
  manager,
} from "./dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const editorPath = join(__dirname, "speakers-editor.html");
const PORT = parseInt(process.env.CONFIG_PORT || "8408", 10);

// ---- Password hashing ----
function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256")
    .update(salt + password)
    .digest("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const testHash = createHash("sha256")
    .update(salt + password)
    .digest("hex");
  return hash === testHash;
}

// ---- Auth middleware ----
async function authenticate(req) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  return validateAuthToken(token);
}

// ---- Router helpers ----
function sendJSON(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function matchRoute(method, url, pattern) {
  const spaceIdx = pattern.indexOf(" ");
  const httpMethod = pattern.slice(0, spaceIdx);
  const pathPattern = pattern.slice(spaceIdx + 1);
  const parts = url.split("/").filter(Boolean);
  const pParts = pathPattern.split("/").filter(Boolean);
  if (method !== httpMethod || parts.length !== pParts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (pParts[i].startsWith(":")) {
      params[pParts[i].slice(1)] = parts[i];
    } else if (pParts[i] !== parts[i]) {
      return null;
    }
  }
  return params;
}

async function main() {
  await initDB();

  // === HTTP 服务 ===
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url.split("?")[0];

    // 公开: ping
    if (req.method === "GET" && url === "/ping") {
      sendJSON(res, 200, { ok: true });
      return;
    }

    // 公开: 页面
    if (req.method === "GET" && (url === "/" || url === "/editor" || url === "/login")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(readFileSync(editorPath, "utf-8"));
      return;
    }

    // ---- Auth endpoints ----
    if (req.method === "POST" && url === "/api/auth/register") {
      const body = await parseBody(req);
      if (!body.username || !body.password) {
        sendJSON(res, 400, { error: "用户名和密码不能为空" });
        return;
      }
      const user = await registerWebUser(body.username, hashPassword(body.password));
      if (!user) {
        sendJSON(res, 409, { error: "用户名已存在" });
        return;
      }
      const token = await createAuthToken(user.id);
      sendJSON(res, 200, { token: token.token, username: user.username });
      return;
    }

    if (req.method === "POST" && url === "/api/auth/login") {
      const body = await parseBody(req);
      if (!body.username || !body.password) {
        sendJSON(res, 400, { error: "用户名和密码不能为空" });
        return;
      }
      const user = await loginWebUser(body.username);
      if (!user || !verifyPassword(body.password, user.passwordHash)) {
        sendJSON(res, 401, { error: "用户名或密码错误" });
        return;
      }
      const token = await createAuthToken(user.id);
      sendJSON(res, 200, { token: token.token, username: user.username });
      return;
    }

    // ---- Protected endpoints ----
    const webUserId = await authenticate(req);
    if (!webUserId) {
      sendJSON(res, 401, { error: "未登录" });
      return;
    }

    // GET /api/me
    if (req.method === "GET" && url === "/api/me") {
      const user = await kPrisma.webUser.findUnique({ where: { id: webUserId } });
      sendJSON(res, 200, { username: user?.username });
      return;
    }

    // GET /api/accounts
    if (req.method === "GET" && url === "/api/accounts") {
      const accounts = await getAccounts(webUserId);
      const result = accounts.map((a) => ({
        ...a,
        _count: a.speakers?.length || 0,
        status: manager.getStatus(a.id),
      }));
      sendJSON(res, 200, result);
      return;
    }

    // POST /api/accounts
    if (req.method === "POST" && url === "/api/accounts") {
      const body = await parseBody(req);
      if (!body.userId) {
        sendJSON(res, 400, { error: "userId 不能为空" });
        return;
      }
      const account = await createAccount({
        webUserId,
        userId: body.userId,
        password: body.password || "",
        passToken: body.passToken || "",
        speakerDefaults: body.speakerDefaults || {},
      });
      sendJSON(res, 200, account);
      return;
    }

    // PUT /api/accounts/:id
    let match = matchRoute(req.method, url, "PUT /api/accounts/:id");
    if (match) {
      const body = await parseBody(req);
      const account = await updateAccount(match.id, webUserId, body);
      if (!account) {
        sendJSON(res, 404, { error: "账号不存在" });
        return;
      }
      sendJSON(res, 200, account);
      return;
    }

    // DELETE /api/accounts/:id
    match = matchRoute(req.method, url, "DELETE /api/accounts/:id");
    if (match) {
      await manager.stopAccount(match.id);
      const ok = await deleteAccount(match.id, webUserId);
      sendJSON(res, ok ? 200 : 404, { ok });
      return;
    }

    // POST /api/accounts/:id/restart
    match = matchRoute(req.method, url, "POST /api/accounts/:id/restart");
    if (match) {
      await manager.restartAccount(match.id);
      sendJSON(res, 200, { ok: true });
      return;
    }

    // GET /api/accounts/:id/speakers
    match = matchRoute(req.method, url, "GET /api/accounts/:id/speakers");
    if (match) {
      const account = await getAccount(match.id, webUserId);
      const speakers = account ? await getSpeakers(match.id) : [];
      sendJSON(res, 200, { speakers, userId: account?.userId || "" });
      return;
    }

    // POST /api/accounts/:id/speakers
    match = matchRoute(req.method, url, "POST /api/accounts/:id/speakers");
    if (match) {
      const account = await getAccount(match.id, webUserId);
      if (!account) {
        sendJSON(res, 404, { error: "账号不存在" });
        return;
      }
      const body = await parseBody(req);
      const speaker = await createSpeaker(match.id, account.userId, body);
      sendJSON(res, 200, speaker);
      return;
    }

    // PUT /api/accounts/:id/speakers/:sid
    match = matchRoute(req.method, url, "PUT /api/accounts/:id/speakers/:sid");
    if (match) {
      const body = await parseBody(req);
      const speaker = await updateSpeaker(match.sid, body);
      if (!speaker) {
        sendJSON(res, 404, { error: "音箱不存在" });
        return;
      }
      sendJSON(res, 200, speaker);
      return;
    }

    // DELETE /api/accounts/:id/speakers/:sid
    match = matchRoute(req.method, url, "DELETE /api/accounts/:id/speakers/:sid");
    if (match) {
      const ok = await deleteSpeaker(match.sid);
      sendJSON(res, ok ? 200 : 404, { ok });
      return;
    }

    // GET /api/accounts/:id/passToken
    match = matchRoute(req.method, url, "GET /api/accounts/:id/passToken");
    if (match) {
      const account = await getAccount(match.id, webUserId);
      sendJSON(res, 200, { passToken: account?.passToken || "" });
      return;
    }

    // POST /api/accounts/:id/passToken
    match = matchRoute(req.method, url, "POST /api/accounts/:id/passToken");
    if (match) {
      const body = await parseBody(req);
      await updateAccount(match.id, webUserId, { passToken: body.passToken });
      sendJSON(res, 200, { ok: true });
      return;
    }

    sendJSON(res, 404, { error: "Not found" });
  });

  server.listen(PORT, () => {
    console.log(`🔌 配置服务: http://localhost:${PORT}`);
    console.log(`🔑 登录页面: http://localhost:${PORT}/login`);
  });

  // 启动所有已配置的账号（fire-and-forget）
  manager.startAll().catch((e) => console.error("startAll error", e));
}

runWithDB(main);
