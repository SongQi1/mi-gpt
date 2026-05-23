import { existsSync, readFileSync, watch, writeFileSync } from "fs";
import { createServer } from "http";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import config from "./.migpt.js";
import { MiGPT } from "./dist/index.cjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, ".migpt.js");
const miConfigPath = join(__dirname, ".mi.json");
const editorPath = join(__dirname, "speakers-editor.html");
const PORT = parseInt(process.env.CONFIG_PORT || "8408", 10);

let restarting = false;
let restartTimer;

async function reloadAndStart(client) {
  MiGPT.logger.log("🔄 正在重启以加载新配置...");
  await client.stop();
  MiGPT.instance = null;
  const newConfig = (await import(`./.migpt.js?t=${Date.now()}`)).default;
  const newClient = MiGPT.create(newConfig);
  // start() 内部是无限轮询，不能 await
  newClient.start().catch((e) => MiGPT.logger.error("启动失败", e));
  MiGPT.logger.success("✅ 已加载新配置");
  return newClient;
}

async function main() {
  let client = MiGPT.create(config);

  // === HTTP 服务（必须在 client.start() 之前启动，因为 start() 内部死循环不返回）===
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // 编辑器页面
    if (req.method === "GET" && (req.url === "/" || req.url === "/editor")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(readFileSync(editorPath, "utf-8"));
      return;
    }

    if (req.method === "GET" && req.url === "/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // 获取当前配置
    if (req.method === "GET" && req.url === "/config") {
      try {
        const cfg = (await import(`./.migpt.js?t=${Date.now()}`)).default;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(cfg));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // 保存配置并重启
    if (req.method === "POST" && req.url === "/config") {
      if (restarting) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "正在重启中" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        restarting = true;
        try {
          writeFileSync(configPath, body, "utf-8");
          clearTimeout(restartTimer);
          client = await reloadAndStart(client);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        restarting = false;
      });
      return;
    }

    // 读取/写入 .mi.json 中的 passToken
    if (req.method === "GET" && req.url === "/mi-config") {
      try {
        if (existsSync(miConfigPath)) {
          const mi = JSON.parse(readFileSync(miConfigPath, "utf-8"));
          const token = mi?.mina?.pass?.passToken || mi?.miiot?.pass?.passToken || "";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ passToken: token }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ passToken: "" }));
        }
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/mi-config") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { passToken } = JSON.parse(body);
          const mi = existsSync(miConfigPath) ? JSON.parse(readFileSync(miConfigPath, "utf-8")) : {};
          if (mi.mina) mi.mina.pass = { ...mi.mina.pass, passToken };
          if (mi.miiot) mi.miiot.pass = { ...mi.miiot.pass, passToken };
          writeFileSync(miConfigPath, JSON.stringify(mi), "utf-8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(PORT, () => {
    MiGPT.logger.log(`🔌 配置服务: http://localhost:${PORT}`);
    MiGPT.logger.log(`🎛️  配置编辑器: http://localhost:${PORT}`);
  });

  // === 文件监听 ===
  watch(configPath, async () => {
    if (restarting) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(async () => {
      restarting = true;
      try { client = await reloadAndStart(client); } catch (e) { MiGPT.logger.error("重载配置失败", e); }
      restarting = false;
    }, 800);
  });

  // === 启动音箱轮询（死循环，永不返回）===
  await client.start();
}

main();
