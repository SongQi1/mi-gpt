import { existsSync, readFileSync } from "fs";
import { createServer } from "http";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import {
  initDB, runWithDB, kPrisma,
  validateAuthToken, createAuthToken, registerWebUser, loginWebUser, deleteWebUser,
  getAccounts, createAccount, updateAccount, deleteAccount, getAccount,
  createSpeaker, updateSpeaker, deleteSpeaker, getSpeakers,
  manager, LoggerManager,
} from "./dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const editorPath = join(__dirname, "speakers-editor.html");
const logsPath = join(__dirname, "logs.html");
const PORT = parseInt(process.env.CONFIG_PORT || "8408", 10);

// ---- Global error handlers ----
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  if (err instanceof Error && (err.message.includes("EADDRINUSE") || err.message.includes("EACCES"))) {
    process.exit(1);
  }
});

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

function parseBody(req, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("Request body timeout"));
    }, timeoutMs);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        clearTimeout(timer);
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
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
    try {
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
    if (req.method === "GET" && url === "/logs") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(readFileSync(logsPath, "utf-8"));
      return;
    }

    // 公开: 默认角色配置（从 .migpt.js 读取）
    if (req.method === "GET" && url === "/api/defaults") {
      const configPath = join(__dirname, ".migpt.js");
      if (!existsSync(configPath)) {
        sendJSON(res, 200, {});
        return;
      }
      try {
        const config = (await import(`${configPath}?t=${Date.now()}`)).default;
        const speaker = config.speaker || {};
        sendJSON(res, 200, {
          botName: config.bot?.name || "",
          botProfile: config.bot?.profile || "",
          masterName: config.master?.name || "",
          masterProfile: config.master?.profile || "",
          roomName: config.room?.name || "",
          roomDescription: config.room?.description || "",
          systemTemplate: config.systemTemplate || "",
          callAIKeywords: speaker.callAIKeywords || [],
          wakeUpKeywords: speaker.wakeUpKeywords || [],
          exitKeywords: speaker.exitKeywords || [],
          switchSpeakerKeywords: speaker.switchSpeakerKeywords || [],
          onEnterAI: speaker.onEnterAI || [],
          onExitAI: speaker.onExitAI || [],
          onAIAsking: speaker.onAIAsking || [],
          onAIReplied: speaker.onAIReplied || [],
          onAIError: speaker.onAIError || [],
        });
      } catch {
        sendJSON(res, 200, {});
      }
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

    // DELETE /api/auth/me — 注销登录账号，级联删除所有关联数据
    if (req.method === "DELETE" && url === "/api/auth/me") {
      // 先停掉该用户所有正在运行的小米账号实例
      const accounts = await getAccounts(webUserId);
      for (const a of accounts) {
        await manager.stopAccount(a.id);
      }
      await deleteWebUser(webUserId);
      sendJSON(res, 200, { ok: true });
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

    // GET /api/accounts/:id/status
    match = matchRoute(req.method, url, "GET /api/accounts/:id/status");
    if (match) {
      const account = await getAccount(match.id, webUserId);
      if (!account) {
        sendJSON(res, 404, { error: "账号不存在" });
        return;
      }
      const status = manager.getAccountStatus(match.id);
      sendJSON(res, 200, status);
      return;
    }

    // GET /api/logs
    if (req.method === "GET" && url === "/api/logs") {
      const urlParams = new URLSearchParams(req.url.split("?")[1] || "");
      const tag = urlParams.get("tag") || undefined;
      const user = await kPrisma.webUser.findUnique({ where: { id: webUserId } });
      const logs = LoggerManager.getLogs({ tag, username: user?.username, limit: 300 });
      sendJSON(res, 200, logs);
      return;
    }

    // GET /api/logs/history
    if (req.method === "GET" && url === "/api/logs/history") {
      const urlParams = new URLSearchParams(req.url.split("?")[1] || "");
      const from = urlParams.get("from") || "";
      const to = urlParams.get("to") || "";
      const tag = urlParams.get("tag") || undefined;
      const level = urlParams.get("level") || undefined;
      if (!from || !to) {
        sendJSON(res, 400, { error: "from 和 to 参数必填 (YYYY-MM-DD)" });
        return;
      }
      const fromDate = new Date(from + "T00:00:00");
      const toDate = new Date(to + "T23:59:59");
      const daysDiff = Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
      if (daysDiff < 0 || daysDiff > 31) {
        sendJSON(res, 400, { error: "时间范围不能超过31天" });
        return;
      }
      const user = await kPrisma.webUser.findUnique({ where: { id: webUserId } });
      const logs = LoggerManager.getHistoryLogs({
        from, to, tag, username: user?.username, level, limit: 1000,
      });
      sendJSON(res, 200, logs);
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
    } catch (err) {
      console.error("HTTP handler error:", err);
      if (!res.headersSent) {
        sendJSON(res, 500, { error: "Internal server error" });
      }
    }
  });

  server.listen(PORT, () => {
    console.log(`🔌 配置服务: http://localhost:${PORT}`);
    console.log(`🔑 登录页面: http://localhost:${PORT}/login`);
  });

  // 启动所有已配置的账号（fire-and-forget）
  manager.startAll().catch((e) => console.error("startAll error", e));
}

runWithDB(main);
