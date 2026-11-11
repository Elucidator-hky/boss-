import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startBridge } from "../bridge-runtime.js";

test("two MCP processes share a bridge; control, pacing and reconnect are enforced", { timeout: 35000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "boss-bridge-test-"));
  const signal = path.join(dir, "signal");
  await writeFile(signal, "preserved-history\n");
  const wss = startBridge({ port: 0, signalFile: signal });
  await once(wss, "listening");
  const port = wss.address().port;
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  async function client() {
    const c = new Client({ name: "test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("server.js")],
      env: { ...process.env, BOSS_WS_PORT: String(port), BOSS_SIGNAL_FILE: signal },
      stderr: "pipe",
    });
    await c.connect(transport);
    clients.push(c);
    return c;
  }
  const [a, b] = await Promise.all([client(), client()]);
  const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
  const data = (r) => JSON.parse(r.content[0].text);
  assert.equal((await a.listTools()).tools.length, 18);
  assert.equal((await b.listTools()).tools.length, 18);
  assert.equal(data(await call(a, "connection_status")).extensionConnected, false);
  assert.equal((await call(a, "read_current_page")).isError, true);
  assert.equal(data(await call(b, "connection_status")).control, "available");
  const seen = [];
  async function extension() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (!msg.cmd) return;
      seen.push({ cmd: msg.cmd, at: Date.now() });
      ws.send(JSON.stringify({ id: msg.id, ok: true, data: { cmd: msg.cmd, args: msg.args } }));
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "hello", version: "0.2.0" }));
    return ws;
  }
  let ext = await extension();
  assert.equal(data(await call(a, "read_current_page")).cmd, "read_current_page");
  assert.equal(data(await call(b, "connection_status")).control, "other_session");
  const blocked = await call(b, "navigate", { url: "https://www.zhipin.com/web/geek/chat" });
  assert.equal(blocked.isError, true);
  assert.equal(seen.length, 1, "blocked navigation must never reach the extension");
  await call(a, "send_reply");
  await call(a, "release_control");
  await call(b, "dom_click", { selector: ".btn-send" });
  assert.ok(seen[2].at - seen[1].at >= 7900, "all sessions and generic clicks share the write interval");
  ext.send(JSON.stringify({ type: "event", event: "new_message" }));
  await new Promise((r) => setTimeout(r, 50));
  assert.match(await readFile(signal, "utf8"), /^preserved-history\n\d+ new_message\n$/);
  await b.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(data(await call(a, "read_current_page")).cmd, "read_current_page");
  ext.close();
  await once(ext, "close");
  assert.equal((await call(a, "read_current_page")).isError, true);
  ext = await extension();
  assert.equal(data(await call(a, "read_current_page")).cmd, "read_current_page");
});

test("an occupied legacy endpoint fails startup instead of advertising unusable tools", { timeout: 10000 }, async (t) => {
  const legacy = new (await import("ws")).WebSocketServer({ host: "127.0.0.1", port: 0 });
  let connections = 0;
  legacy.on("connection", () => { connections++; });
  await once(legacy, "listening");
  t.after(async () => { for (const ws of legacy.clients) ws.terminate(); await new Promise((r) => legacy.close(r)); });
  const c = new Client({ name: "legacy-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.resolve("server.js")],
    env: { ...process.env, BOSS_WS_PORT: String(legacy.address().port) }, stderr: "pipe",
  });
  await assert.rejects(c.connect(transport));
  assert.equal(connections, 0, "probing must not replace a legacy extension connection");
  await c.close();
});

test("simultaneous first startup creates one shared daemon", { timeout: 15000 }, async (t) => {
  const net = await import("node:net");
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  const dir = await mkdtemp(path.join(os.tmpdir(), "boss-startup-test-"));
  const clients = [];
  let daemonPid;
  t.after(async () => {
    for (const c of clients) await c.close();
    if (daemonPid) process.kill(daemonPid, "SIGTERM");
    await rm(dir, { recursive: true, force: true });
  });
  const launch = async () => {
    const c = new Client({ name: "startup-test", version: "1" });
    clients.push(c);
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("server.js")],
      env: { ...process.env, BOSS_WS_PORT: String(port), BOSS_SIGNAL_FILE: path.join(dir, "signal") }, stderr: "pipe" }));
    return JSON.parse((await c.callTool({ name: "connection_status", arguments: {} })).content[0].text);
  };
  const [a, b] = await Promise.all([launch(), launch()]);
  daemonPid = a.pid;
  assert.equal(a.pid, b.pid);
  assert.equal(a.bridgeVersion, "0.2.0");
  assert.equal(a.extensionConnected, false);
});
