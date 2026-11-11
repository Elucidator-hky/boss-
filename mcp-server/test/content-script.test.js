import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../../src/content/bridge.js", import.meta.url), "utf8");

function fixture({ button = true } = {}) {
  let handler, observer, clicks = 0, friendCount = 0;
  const events = [], signals = [];
  const input = { textContent: "测试回复", focus() {}, dispatchEvent(e) { events.push(e.type); } };
  const btn = { offsetParent: {}, disabled: false, getAttribute() { return null; }, click() { clicks++; } };
  const active = { innerText: "公司 HR 旧预览", querySelector() { return {}; } };
  const document = {
    body: {},
    querySelector(s) {
      if (s === "#chat-input") return input;
      if (s === "ul.user-list") return { querySelectorAll() { return [active]; } };
      if (s === "ul.im-list") return { querySelectorAll() { return Array(friendCount).fill({}); } };
      return null;
    },
    querySelectorAll() { return button ? [btn] : []; },
  };
  vm.runInNewContext(source, {
    document, window: { addEventListener() {} }, console: { log() {} },
    chrome: { runtime: { onMessage: { addListener(f) { handler = f; } }, sendMessage(msg) { signals.push(msg); } } },
    MutationObserver: class { constructor(cb) { observer = cb; } observe() {} },
    KeyboardEvent: class { constructor(type) { this.type = type; } },
    setTimeout(cb) { cb(); return 1; }, clearTimeout() {},
  });
  return {
    call(cmd) { return new Promise((resolve) => handler({ channel: "boss-bridge", cmd }, {}, resolve)); },
    incoming() { active.innerText = "公司 HR 新预览"; friendCount++; observer(); },
    get clicks() { return clicks; }, events, signals,
  };
}

test("send attempts exactly one path and never claims delivery", async () => {
  const page = fixture();
  const result = await page.call("send_reply");
  assert.equal(result.ok, true);
  assert.equal(result.data.verified, false);
  assert.equal(result.data.attempted, "测试回复");
  assert.equal(page.clicks, 1);
  assert.equal(page.events.length, 0, "do not also hit Enter after clicking");
  const fallback = fixture({ button: false });
  const other = await fallback.call("send_reply");
  assert.equal(other.data.method, "enter");
  assert.deepEqual(fallback.events, ["keydown", "keyup"]);
});

test("an incoming message changing the conversation preview still wakes the watcher", () => {
  const page = fixture();
  page.incoming();
  assert.equal(page.signals.length, 1);
  assert.equal(page.signals[0].event, "new_message");
});
