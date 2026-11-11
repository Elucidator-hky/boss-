// One browser bridge per port, shared by all stdio MCP clients.
import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

export const PROTOCOL = 1;
export const VERSION = "0.2.0";
export const DEFAULT_SIGNAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.new-message-signal");

export function startBridge({ port = 8765, signalFile = DEFAULT_SIGNAL } = {}) {
  const httpServer = http.createServer((req, res) => {
    if (req.url !== "/boss-bridge" || req.method !== "GET") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ name: "boss-assistant-bridge", protocol: PROTOCOL, version: VERSION }));
  });
  const wss = new WebSocketServer({ server: httpServer });
  const closeWebSockets = wss.close.bind(wss);
  wss.close = (callback) => { httpServer.close(); return closeWebSockets(callback); };
  httpServer.listen(port, "127.0.0.1");
  const clients = new Set();
  const pending = new Map();
  let extension = null;
  let extensionVersion = null;
  let owner = null;
  let sequence = 0;
  let queue = Promise.resolve();
  let lastWrite = 0;
  let idleTimer;
  const writes = new Set(["send_reply", "chat_action", "greet", "dom_click"]);
  const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const status = (client) => ({
    bridgeVersion: VERSION, protocol: PROTOCOL, pid: process.pid,
    extensionConnected: extension?.readyState === WebSocket.OPEN,
    extensionVersion,
    clients: clients.size, control: owner === client ? "yours" : owner ? "other_session" : "available",
    signalFile,
  });
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (!clients.size) idleTimer = setTimeout(() => { wss.close(); for (const ws of wss.clients) ws.close(); }, 60000);
  };
  const forward = (cmd, args) => new Promise((resolve, reject) => {
    if (extension?.readyState !== WebSocket.OPEN) return reject(new Error("浏览器扩展未连接；加载扩展并刷新 Boss 页面，再运行 connection_status。"));
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("扩展响应超时；动作结果未知。先回读页面核对，勿重复发送或换工具重试。"));
    }, cmd === "navigate" || cmd === "search_jobs" ? 30000 : 15000);
    pending.set(id, { resolve, reject, timer });
    send(extension, { id, cmd, args });
  });
  wss.on("connection", (ws, request) => {
    if (request.url === "/mcp" && !request.headers.origin) {
      clients.add(ws);
      clearTimeout(idleTimer);
      send(ws, { type: "hello", protocol: PROTOCOL, version: VERSION });
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type !== "call") return;
        if (msg.cmd === "connection_status") {
          send(ws, { id: msg.id, ok: true, data: status(ws) });
          return;
        }
        // Reserve the whole workflow, not just individual clicks: another chat
        // must not navigate between fill_reply and send_reply.
        if (owner && owner !== ws) {
          send(ws, { id: msg.id, ok: false, error: "另一个 AI 会话正在操作 Boss。请在原会话完成任务后调用 release_control，或关闭原会话。当前会话不要改用其它浏览器工具。" });
          return;
        }
        if (msg.cmd !== "release_control" && extension?.readyState !== WebSocket.OPEN) {
          send(ws, { id: msg.id, ok: false, error: "浏览器扩展未连接；加载扩展并刷新 Boss 页面后重试只读自检。" });
          return;
        }
        if (msg.cmd !== "release_control" && extensionVersion !== VERSION) {
          send(ws, { id: msg.id, ok: false, error: "浏览器扩展版本不匹配；请重载扩展并刷新 Boss 页面后重新自检。" });
          return;
        }
        owner = ws;
        queue = queue.then(async () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            if (msg.cmd === "release_control") {
              owner = null;
              send(ws, { id: msg.id, ok: true, data: { released: true } });
              return;
            }
            // Reacquire after an earlier queued release, unless another client won.
            if (owner && owner !== ws) throw new Error("控制权已交给另一会话；当前操作未执行。");
            owner = ws;
            if (writes.has(msg.cmd)) {
              const wait = lastWrite + 8000 + Math.floor(Math.random() * 7000) - Date.now();
              if (wait > 0) await new Promise((r) => setTimeout(r, wait));
              if (ws.readyState !== WebSocket.OPEN) return;
              lastWrite = Date.now();
            }
            const data = await forward(msg.cmd, msg.args || {});
            send(ws, { id: msg.id, ok: true, data });
          } catch (e) { send(ws, { id: msg.id, ok: false, error: e.message }); }
        });
      });
      ws.on("close", () => {
        clients.delete(ws);
        // Release only after outstanding browser commands finish or time out.
        queue = queue.then(() => { if (owner === ws) owner = null; });
        armIdle();
      });
    } else if (request.url === "/" && (!request.headers.origin || request.headers.origin.startsWith("chrome-extension://"))) {
      // Keep the established extension; a duplicate must not replace an in-flight connection.
      if (extension?.readyState === WebSocket.OPEN) { ws.close(1008, "已有浏览器扩展连接"); return; }
      extension = ws;
      extensionVersion = null;
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === "hello") { extensionVersion = msg.version; return; }
        if (msg.type === "event") {
          try { fs.appendFileSync(signalFile, `${Date.now()} ${msg.event || "event"}\n`); }
          catch (e) { console.error("[boss-bridge] 信号写入失败:", e.message); }
          return;
        }
        const p = pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error || "扩展操作失败"));
      });
      ws.on("close", () => {
        if (extension === ws) { extension = null; extensionVersion = null; }
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("扩展连接断开；先核对动作结果，再继续。")); }
        pending.clear();
      });
    } else ws.close(1008, "unsupported client");
    ws.on("error", (e) => console.error("[boss-bridge]", e.message));
  });
  const heartbeat = setInterval(() => { if (extension) send(extension, { type: "ping" }); }, 20000);
  wss.on("close", () => { clearInterval(heartbeat); clearTimeout(idleTimer); });
  wss.on("listening", () => {
    fs.closeSync(fs.openSync(signalFile, "a"));
    console.error(`[boss-bridge] v${VERSION} 127.0.0.1:${wss.address().port}`);
    armIdle();
  });
  wss.on("error", (e) => {
    clearInterval(heartbeat);
    clearTimeout(idleTimer);
    console.error("[boss-bridge]", e.message);
  });
  return wss;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startBridge({ port: Number(process.env.BOSS_WS_PORT || 8765), signalFile: process.env.BOSS_SIGNAL_FILE || DEFAULT_SIGNAL });
}
