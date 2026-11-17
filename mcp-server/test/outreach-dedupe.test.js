import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../../src/content/bridge.js", import.meta.url), "utf8");
const claimsSource = await readFile(new URL("../../src/background/outbound-claims.js", import.meta.url), "utf8");
const origin = "https://www.zhipin.com";
const jobId = "a1b2c3d4e5f60789";
const recruiterId = "abcdef1234567890";
const defaultGreeting = "能和您沟通一下吗？我对这个岗位兴趣很浓。";
const supplement = "您好，我做过企业知识库，方便发份简历吗？";
const accountResume = "示例候选人_大模型应用开发简历.pdf";

function message(id, role, text) {
  const content = { innerText: text, textContent: text, querySelector: () => null };
  return {
    innerText: text,
    classList: { contains: (name) => name === `item-${role}` },
    getAttribute: (name) => name === "data-mid" ? id : null,
    querySelector: (selector) => selector === ".message-content" ? content : null,
  };
}

function page({ detail = false, records = [], draft = "", claimedKeys = new Set(), receiptOnSubmit } = {}) {
  const clicks = [];
  const claims = [];
  let handleCommand;
  let receiveJobData;
  let time = 0;
  let chooserOpen = false;

  function button(label, selector, attributes = {}, onClick = () => {}) {
    const node = {
      innerText: label,
      textContent: label,
      offsetParent: {},
      isConnected: true,
      classList: { contains: () => false },
      getClientRects: () => [{}],
      getAttribute: (name) => attributes[name] ?? null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
      closest: (value) => value.includes(selector) ? node : null,
      click() { clicks.push(label); onClick(); },
      dispatchEvent(event) {
        if (event.type === "click") node.click();
      },
    };
    return node;
  }

  const greeting = button("立即沟通", "a.btn-startchat", {
    "redirect-url": `/web/geek/chat?jobId=${jobId}&id=${recruiterId}`,
  });
  const send = button("发送", "button.btn-send");
  const resume = button("发简历", '[d-c="62009"]', {}, () => {
    chooserOpen = true;
    confirm.disabled = true;
  });
  const confirm = button("发送简历", "button.btn-confirm", {}, () => {
    if (receiptOnSubmit) records.push(receiptOnSubmit);
    chooserOpen = false;
  });
  confirm.disabled = true;
  const close = button("关闭", ".boss-popup__close", {}, () => { chooserOpen = false; });
  const file = button(accountResume, ".list-item", {}, () => { confirm.disabled = false; });
  file.querySelector = (selector) => selector === ".resume-name" ? { textContent: accountResume } : null;
  const popup = {
    innerText: "请选择要发送的简历",
    offsetParent: {},
    matches: () => true,
    querySelector: (selector) => selector === ".boss-popup__close" ? close : null,
    querySelectorAll: (selector) => selector === "button.btn-confirm" ? [confirm] : [],
  };
  const list = {
    isConnected: true,
    parentElement: popup,
    getClientRects: () => [{}],
    closest: () => popup,
    querySelectorAll: (selector) => selector === ".list-item" ? [file] : [],
  };
  const request = message("11", "friend", "想查看您的附件简历，是否同意？");
  const accept = button("同意", ".card-btn", {}, () => { confirm.disabled = false; });
  accept.closest = (selector) => selector.includes(".card-btn") ? accept :
    selector === "li.item-friend[data-mid]" ? request : null;
  const input = { textContent: draft, focus() {} };
  const selected = { isConnected: true };
  const timeline = { isConnected: true, getClientRects: () => [{}], querySelectorAll: () => records };
  let toolbarLookups = 0;
  const document = {
    body: {},
    querySelector(selector) {
      switch (selector) {
        case "#chat-input": return input;
        case ".friend-content.selected": return selected;
        case "ul.im-list": return detail ? null : timeline;
        case '.chat-controls [d-c="62009"]':
          toolbarLookups++;
          return resume;
        default: return null;
      }
    },
    querySelectorAll(selector) {
      switch (selector) {
        case "ul.im-list": return detail ? [] : [timeline];
        case ".job-banner a.btn-startchat, .job-detail-box a.op-btn-chat":
        case "a.btn-startchat": return detail ? [greeting] : [];
        case ".btn-send": return [send];
        case ".resume-list": return chooserOpen ? [list] : [];
        case ".card-btn": return [accept];
        case "button.btn-confirm": return [confirm];
        case '[class*="dialog"], [class*="popup"], [class*="modal"], .sentence-popover': return chooserOpen ? [popup] : [];
        default: return [];
      }
    },
  };
  const window = { addEventListener: (_, listener) => { receiveJobData = listener; } };
  class Event {
    constructor(type) { this.type = type; }
  }
  vm.runInNewContext(source, {
    document, window, URL, MouseEvent: Event, PointerEvent: Event,
    console: { log() {} },
    Date: class extends Date { static now() { return time; } },
    setTimeout: (callback, delay) => { time += delay; callback(); return 1; },
    clearTimeout() {},
    getComputedStyle: () => ({ visibility: "visible", overflowY: "visible" }),
    location: { origin, pathname: detail ? `/job_detail/${jobId}.html` : "/web/geek/chat" },
    MutationObserver: class { observe() {} },
    chrome: { runtime: {
      onMessage: { addListener: (listener) => { handleCommand = listener; } },
      async sendMessage(args) {
        assert.equal(args.type, "BOSS_CLAIM_OUTBOUND");
        const key = [args.kind, args.jobId, args.recruiterId].join(":");
        claims.push(key);
        const claimed = !claimedKeys.has(key);
        claimedKeys.add(key);
        return { ok: true, claimed };
      },
    } },
  });
  if (!detail) {
    receiveJobData({ source: window, data: { type: "BOSS_JOB_DATA", jobData: {
      encryptJobId: jobId, encryptBossId: recruiterId,
    } } });
  }
  return {
    clicks, claims,
    get toolbarLookups() { return toolbarLookups; },
    call(cmd, args) {
      return new Promise((resolve) => handleCommand({ channel: "boss-bridge", cmd, args }, {}, resolve));
    },
  };
}

test("automatic greeting blocks a supplemental greeting through both reply paths", async () => {
  const chat = page({ records: [message("10", "myself", defaultGreeting)], draft: supplement });
  for (const [command, args] of [["send_reply"], ["dom_click", { selector: ".btn-send" }]]) {
    const result = await chat.call(command, args);
    assert.equal(result.ok, false);
    assert.match(result.error, /已经发送或待核对/);
  }
  assert.deepEqual(chat.clicks, []);
});

test("a new HR message permits an ordinary reply once", async () => {
  const chat = page({ records: [message("10", "myself", defaultGreeting),
    message("11", "friend", "可以说说您的知识库经历吗？")], draft: "我做过企业知识库问答。" });
  const result = await chat.call("send_reply");
  assert.equal(result.ok, true, result.error);
  assert.equal(result.data.method, "button");
  assert.equal((await chat.call("send_reply")).ok, false);
  assert.deepEqual(chat.clicks, ["发送"]);
});

test("initial greeting and generic click share the same claim after reopening the page", async () => {
  const claimedKeys = new Set();
  const original = page({ detail: true, claimedKeys });
  const first = await original.call("greet");
  assert.equal(first.ok, true, first.error);
  assert.equal(first.data.status, "attempted");
  assert.deepEqual(original.clicks, ["立即沟通"]);

  const reopened = page({ detail: true, claimedKeys });
  const second = await reopened.call("dom_click", { selector: "a.btn-startchat" });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.data.status, "already_attempted");
  assert.deepEqual(reopened.claims, original.claims);
  assert.deepEqual(reopened.clicks, []);
});

test("prior attachment receipts or pending requests block a new attachment before the toolbar", async (t) => {
  for (const [label, evidence, expected] of [
    ["old name", "您的附件简历 示例候选人 已发送给Boss点击查看附件", "already_sent"],
    ["truncated new name", "您的附件简历 示例候选人_大... 已发送给Boss点击查看附件", "already_sent"],
    ["delivery without a name", "对方已同意，您的附件简历已发送给对方", "already_sent"],
    ["earlier view receipt", "对方已查看您的附件简历", "already_sent"],
    ["pending request", "附件简历请求已发送", "unconfirmed"],
  ]) {
    await t.test(label, async () => {
      const chat = page({ records: [message("12", "system", evidence)] });
      const result = await chat.call("chat_action", { action: "send_resume", resume: accountResume });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.data.status, expected);
      if (expected === "already_sent") assert.equal(result.data.receiptId, "12");
      assert.equal(chat.toolbarLookups, 0);
      assert.deepEqual(chat.clicks, []);
      assert.deepEqual(chat.claims, []);
    });
  }
});

test("a chooser confirms delivery only on a new delivery receipt", async (t) => {
  for (const [label, receipt, expected] of [
    ["new delivery", message("13", "system", "您的附件简历 示例候选人 已发送给Boss点击查看附件"), "sent"],
    ["older receipt re-rendered", message("10", "system", "您的附件简历 示例候选人 已发送给Boss点击查看附件"), "unconfirmed"],
    ["new view of previously sent file", message("13", "system", "对方已查看您的附件简历"), "unconfirmed"],
    ["platform request pending", message("13", "system", "附件简历请求已发送"), "unconfirmed"],
    ["no receipt", undefined, "unconfirmed"],
  ]) {
    await t.test(label, async () => {
      const chat = page({ records: [message("12", "friend", "您好")], receiptOnSubmit: receipt });
      const result = await chat.call("chat_action", { action: "send_resume", resume: accountResume });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.data.status, expected);
      assert.equal(result.data.sent, expected === "sent" ? true : null);
      assert.deepEqual(chat.clicks, ["发简历", accountResume, "发送简历"]);
      assert.equal(chat.claims.length, 1);
    });
  }
});

test("native resume acceptance and its confirmation reserve the attempt only once", async () => {
  const claimedKeys = new Set();
  const chat = page({ claimedKeys });
  const accept = { selector: ".card-btn" };
  const confirm = { selector: "button.btn-confirm" };
  assert.equal((await chat.call("dom_click", accept)).ok, true);
  assert.equal((await chat.call("dom_click", confirm)).ok, true);
  assert.equal((await chat.call("dom_click", confirm)).ok, false);
  assert.deepEqual(chat.clicks, ["同意", "发送简历"]);
  const reopened = page({ claimedKeys });
  assert.equal((await reopened.call("dom_click", accept)).ok, false);
  assert.deepEqual(reopened.clicks, []);
  const pending = page({ records: [message("12", "system", "附件简历请求已发送")] });
  assert.equal((await pending.call("dom_click", accept)).ok, false);
  assert.deepEqual(pending.claims, []);
});

test("outbound claim serializes duplicate jobs and recruiters across tabs and worker reload", async () => {
  const values = {};
  function worker() {
    let handle;
    vm.runInNewContext(claimsSource, { chrome: {
      runtime: { id: "extension", onMessage: { addListener: (listener) => { handle = listener; } } },
      storage: { local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]])),
        set: async (items) => Object.assign(values, items),
      } },
    } });
    return (args, tab = 1) => new Promise((resolve) => handle({ type: "BOSS_CLAIM_OUTBOUND", ...args }, {
      id: "extension", frameId: 0, tab: { id: tab }, url: origin + "/web/geek/chat",
    }, resolve));
  }
  const reserve = worker();
  const original = { kind: "greeting", jobId, recruiterId };
  const [first, sameRecruiter] = await Promise.all([reserve(original),
    reserve({ ...original, jobId: "another-job", recruiterId: recruiterId + "~" }, 2)]);
  assert.equal(first.claimed, true);
  assert.equal(sameRecruiter.claimed, false);
  const reloaded = worker();
  assert.equal((await reloaded({ ...original, recruiterId: "another-recruiter" })).claimed, false);
  assert.equal((await reloaded({ ...original, kind: "resume" })).claimed, true);
});
