import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROTOCOL, VERSION } from "./bridge-runtime.js";
import http from "node:http";

const help = "本地桥接服务不可用或版本不匹配。检查占用端口的进程；确认旧 Boss 任务已结束后关闭旧会话，再重启当前会话。不要换用 Playwright/CDP 操作 Boss。";

async function connect(port) {
  // Probe over HTTP first: opening a WebSocket against the legacy server
  // would replace its live extension socket even if no command were sent.
  await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/boss-bridge`, { timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; if (body.length > 4096) request.destroy(new Error(help)); });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200 || data.name !== "boss-assistant-bridge" || data.protocol !== PROTOCOL || data.version !== VERSION) throw new Error(help);
          resolve();
        } catch { reject(new Error(help)); }
      });
      res.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(help)));
    request.on("error", reject);
  });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/mcp`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(help)); }, 2000);
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
    ws.once("close", () => { clearTimeout(timer); reject(new Error(help)); });
    ws.once("message", (raw) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(raw);
        if (msg.type !== "hello" || msg.protocol !== PROTOCOL || msg.version !== VERSION) throw new Error(help);
        resolve(ws);
      } catch (e) { ws.close(); reject(e); }
    });
  });
}

export async function openBridge() {
  const port = Number(process.env.BOSS_WS_PORT || 8765);
  let ws;
  try { ws = await connect(port); }
  catch (e) {
    if (e.code !== "ECONNREFUSED") throw e;
    const child = spawn(process.execPath, [fileURLToPath(new URL("./bridge-runtime.js", import.meta.url))], {
      env: process.env, detached: true, stdio: "ignore", windowsHide: true,
    });
    let spawnError;
    child.on("error", (err) => { spawnError = err; });
    child.unref();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (spawnError) throw spawnError;
      try { ws = await connect(port); break; }
      catch (err) { if (err.code !== "ECONNREFUSED") throw err; }
    }
    if (!ws) throw new Error(help);
  }
  let sequence = 0;
  const pending = new Map();
  const failAll = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(help + " 当前动作结果需回读核验。")); }
    pending.clear();
  };
  ws.on("close", failAll);
  ws.on("error", failAll);
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error));
  });
  return {
    close: () => ws.close(),
    call(cmd, args = {}) {
      return new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) return reject(new Error(help));
        const id = ++sequence;
        const timer = setTimeout(() => {
          // Closing cancels queued, unstarted operations. Already sent writes
          // are never replayed automatically.
          ws.close();
          failAll();
        }, 55000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ type: "call", id, cmd, args }));
      });
    },
  };
}
