/**
 * bridge.js —— content script（ISOLATED world，document_idle）
 *
 * 职责：
 *  1. 接收 inject.js 通过 postMessage 推来的结构化职位信息并缓存；
 *  2. 接收 background(sw.js) 转发的命令，在页面上执行读取，把结果回传。
 *
 * 复用旧项目 index.js 的选择器（作者已验证）。整体用 IIFE 包裹，避免与
 * index.js 在同一 isolated world 里的顶层变量重名冲突。
 */
(function () {
  // -------------------------------------------------------------------------
  // 缓存 inject.js 推送的职位信息
  // -------------------------------------------------------------------------
  let bridgeJobData = null; // 来自 getBossData：含 encryptJobId/securityId 等
  let bridgeJobInfo = null; // 来自 historyMsg：含（可能截断的）职位描述
  const bridgeJobs = new Map(); // 来自 joblist API：encryptJobId -> job，随滚动分页累积

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (d?.type === "BOSS_JOB_LIST" && Array.isArray(d.jobs)) {
      for (const j of d.jobs) {
        if (j.encryptJobId) bridgeJobs.set(j.encryptJobId, j);
      }
    } else if (d?.type === "BOSS_JOB_DATA" && d.jobData) {
      bridgeJobData = d.jobData;
    } else if (d?.type === "BOSS_JOB_INFO" && d.jobInfo) {
      const j = d.jobInfo;
      bridgeJobInfo = {
        title: j.title || "",
        salary: j.salary || "",
        city: j.city || "",
        education: j.education || "",
        experience: j.experience || "",
        company: j.company || "",
        hrName: j.boss?.name || "",
        hrTitle: j.bossTitle || "",
        description: j.content || "",
      };
    }
  });

  // -------------------------------------------------------------------------
  // DOM 读取
  // -------------------------------------------------------------------------
  function clean(s) {
    return (s || "")
      .replace(/ /g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function classifyPage() {
    const p = location.pathname;
    if (p.includes("/web/geek/chat")) return "chat";
    if (p.includes("/web/geek/job-recommend") || p.includes("/web/geek/recommend")) return "recommend";
    if (p.includes("/web/geek/job") || p.includes("/job_detail")) return "joblist_or_detail";
    return "other";
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function extractText(li) {
    if (li.innerText && li.innerText.includes("你与该职位竞争者PK情况")) return null;
    if (li.querySelector(".item-image") || li.querySelector(".message-image")) return "[图片]";

    const cardTitle = li.querySelector(".message-card-top-title");
    if (cardTitle) return clean(cardTitle.innerText);

    const dialogTitle = li.querySelector(".msg-dialog-title");
    if (dialogTitle) {
      const location = li.querySelector(".msg-dialog-desc");
      let text = dialogTitle.innerText;
      if (location) text += " " + location.innerText;
      return clean(text);
    }

    const textSpan = li.querySelector(".message-content .text p span");
    if (textSpan) {
      return clean(textSpan.innerText.replace(/已读\s*/g, "").replace(/送达\s*/g, "").trim());
    }

    const textNode =
      li.querySelector(".message-content .text") ||
      li.querySelector(".message-content") ||
      li.querySelector(".text");
    if (!textNode) return null;
    return clean(textNode.innerText.replace(/已读\s*/g, "").replace(/送达\s*/g, "").trim());
  }

  function collectMessages(max = 30) {
    const ul = document.querySelector("ul.im-list");
    if (!ul) return [];
    const lis = Array.from(ul.querySelectorAll("li.message-item")).slice(-max);
    const out = [];
    for (const li of lis) {
      const who = li.classList.contains("item-friend")
        ? "HR"
        : li.classList.contains("item-myself")
          ? "我"
          : li.classList.contains("item-system")
            ? "系统"
            : null;
      if (!who) continue;
      const text = extractText(li);
      if (!text) continue;
      const time = clean(li.querySelector(".item-time .time")?.innerText || "");
      out.push({ who, text: text.replace(/\n+/g, " ").trim(), time });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------
  function readCurrentPage() {
    const page = classifyPage();
    const base = { url: location.href, title: document.title, page };
    if (page === "chat") {
      return {
        ...base,
        job: bridgeJobData,
        jobInfo: bridgeJobInfo,
        messages: collectMessages(30),
      };
    }
    return base;
  }

  // -------------------------------------------------------------------------
  // 左侧对话列表（聊天页）
  // -------------------------------------------------------------------------
  function getConversationLis() {
    // 兼容多版本 DOM：按候选容器找，找到有 li 的为准
    const containers = [
      document.querySelector("ul.user-list"),
      document.querySelector('[class*="user-list"]'),
      document.querySelector('[class*="friend-list"]'),
      document.querySelector('[class*="chat-list"]'),
    ].filter(Boolean);
    for (const c of containers) {
      const lis = Array.from(c.querySelectorAll("li"));
      if (lis.length) return lis;
    }
    return [];
  }

  function readConversations(args) {
    const max = Number(args?.max) || 30;
    const lis = getConversationLis();
    if (!lis.length) {
      throw new Error("没找到左侧对话列表（可能 DOM 改版，用 debug_dom 排查）");
    }
    return lis.slice(0, max).map((li, i) => ({
      index: i,
      text: clean(li.innerText).replace(/\n+/g, " | ").slice(0, 200),
      active:
        !!li.querySelector(".friend-content.selected") ||
        /active|selected|cur/.test(li.className || ""),
    }));
  }

  function simulateClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try {
      el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function openConversation(args) {
    const lis = getConversationLis();
    if (!lis.length) throw new Error("没找到左侧对话列表");
    let li = null;
    if (args?.index !== undefined && args.index !== null) {
      li = lis[Number(args.index)];
      if (!li) throw new Error(`index ${args.index} 超出范围（共 ${lis.length} 条）`);
    } else if (args?.keyword) {
      const kw = String(args.keyword);
      li = lis.find((l) => (l.innerText || "").includes(kw));
      if (!li) throw new Error(`没有找到包含「${kw}」的对话`);
    } else {
      throw new Error("需要提供 index 或 keyword");
    }
    // Boss 的点击监听在 li 内层 .friend-content 上，事件要派发到它
    const target = li.querySelector(".friend-content") || li;
    simulateClick(target);
    return { clicked: clean(li.innerText).replace(/\n+/g, " | ").slice(0, 100) };
  }

  // -------------------------------------------------------------------------
  // 填输入框 / 发送（油猴同款：contenteditable + input 事件 + 模拟 Enter）
  // -------------------------------------------------------------------------
  function findChatInput() {
    return (
      document.querySelector("#chat-input") ||
      document.querySelector('div.chat-input[contenteditable="true"]') ||
      document.querySelector('.chat-conversation div[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  function fillReply(args) {
    const text = String(args?.text || "").trim();
    if (!text) throw new Error("text 不能为空");
    const input = findChatInput();
    if (!input) throw new Error("找不到聊天输入框（请确认已点开某个对话）");
    input.focus();
    input.textContent = text;
    // 光标置尾（Vue 组件依赖）
    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, data: text, inputType: "insertText" })
    );
    return { filled: text };
  }

  function sendReply() {
    const input = findChatInput();
    if (!input) throw new Error("找不到聊天输入框");
    const content = (input.textContent || "").trim();
    if (!content) throw new Error("输入框为空，请先用 fill_reply 填内容");
    input.focus();
    const evOpts = {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
    };
    input.dispatchEvent(new KeyboardEvent("keydown", evOpts));
    input.dispatchEvent(new KeyboardEvent("keyup", evOpts));
    return { sent: content };
  }

  // -------------------------------------------------------------------------
  // 推荐/搜索页：职位列表、点开职位、读详情、主动打招呼
  // -------------------------------------------------------------------------
  function readJobs(args) {
    const max = Number(args?.max) || 50;
    const jobs = Array.from(bridgeJobs.values()).slice(0, max);
    if (!jobs.length) {
      throw new Error(
        "职位列表缓存为空。请确认：① 当前在推荐页或搜索页；② 页面是本次重载扩展后打开/刷新的（inject.js 需拦到列表接口）。可滚动列表触发加载。"
      );
    }
    return { count: bridgeJobs.size, jobs };
  }

  function getJobCards() {
    const selectors = [
      "ul.rec-job-list li",
      "li.job-card-wrapper",
      "ul.job-list-box li",
      '[class*="job-card"]',
    ];
    for (const s of selectors) {
      const els = Array.from(document.querySelectorAll(s));
      if (els.length > 1) return els;
    }
    return [];
  }

  function openJob(args) {
    const cards = getJobCards();
    if (!cards.length) throw new Error("没找到职位卡片（当前不在推荐/搜索页？可用 debug_dom 排查）");
    let card = null;
    if (args?.keyword) {
      const kw = String(args.keyword);
      card = cards.find((c) => (c.innerText || "").includes(kw));
      if (!card) throw new Error(`没有找到包含「${kw}」的职位卡片`);
    } else if (args?.index !== undefined && args.index !== null) {
      card = cards[Number(args.index)];
      if (!card) throw new Error(`index ${args.index} 超出范围（页面上共 ${cards.length} 张卡片）`);
    } else {
      throw new Error("需要提供 keyword（推荐）或 index");
    }
    const target =
      card.querySelector(".job-title, .job-name, .job-card-body, .job-info") || card;
    simulateClick(target);
    return { clicked: clean(card.innerText).replace(/\n+/g, " | ").slice(0, 150) };
  }

  function readJobDetail() {
    const candidates = [
      document.querySelector(".job-detail-box"),
      document.querySelector('[class*="job-detail"]'),
    ].filter(Boolean);
    const el = candidates.find((c) => (c.innerText || "").trim().length > 50);
    if (!el) throw new Error("没找到职位详情面板（先 open_job 点开一个职位）");
    return { text: clean(el.innerText).slice(0, 6000) };
  }

  async function greet() {
    const all = Array.from(document.querySelectorAll("a, button")).filter((el) => {
      const t = (el.innerText || "").trim();
      return t === "立即沟通" || t === "继续沟通";
    });
    if (!all.length) throw new Error("没找到「立即沟通」按钮（先 open_job 打开职位详情）");
    const visible = all.filter((el) => el.offsetParent !== null);
    // 优先详情面板里的按钮（卡片上悬浮也可能有）
    const btn =
      visible.find((el) => el.closest('[class*="job-detail"], .job-detail-box')) ||
      visible[0] ||
      all[0];
    const label = (btn.innerText || "").trim();
    if (label === "继续沟通") {
      return { greeted: false, note: "该职位已沟通过（按钮为「继续沟通」），未重复打招呼" };
    }
    simulateClick(btn);
    await sleep(1500);
    // 打招呼后可能弹「发送成功」对话框，点「留在当前页面/稍后再说/取消」留在列表页
    const stay = Array.from(document.querySelectorAll("a, button")).find(
      (el) =>
        el.offsetParent !== null && /留在|稍后|取消/.test((el.innerText || "").trim())
    );
    if (stay) {
      simulateClick(stay);
      await sleep(300);
    }
    return { greeted: true, note: stay ? "已打招呼，已关闭弹窗留在当前页" : "已打招呼（未见弹窗）" };
  }

  function scrollableAncestor(el) {
    let n = el;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY) && n.scrollHeight > n.clientHeight) return n;
      n = n.parentElement;
    }
    return null;
  }

  async function scrollJobs(args) {
    const times = Math.min(Number(args?.times) || 1, 8);
    const cards = getJobCards();
    const scroller = cards.length ? scrollableAncestor(cards[0]) : null;
    for (let i = 0; i < times; i++) {
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      } else {
        window.scrollTo(0, document.body.scrollHeight);
      }
      await sleep(1200);
    }
    return { cached_jobs: bridgeJobs.size, dom_cards: getJobCards().length };
  }

  // -------------------------------------------------------------------------
  // 调试：查看指定选择器的 DOM 结构（测试阶段排查选择器用）
  // -------------------------------------------------------------------------
  function debugDom(args) {
    const sel = String(args?.selector || "body");
    const maxChars = Math.min(Number(args?.max_chars) || 3000, 20000);
    const all = document.querySelectorAll(sel);
    const nodes = Array.from(all).slice(0, Number(args?.max_nodes) || 3);
    return {
      count: all.length,
      html: nodes.map((n) => n.outerHTML).join("\n---\n").slice(0, maxChars),
    };
  }

  const HANDLERS = {
    read_current_page: () => readCurrentPage(),
    read_conversations: (args) => readConversations(args),
    open_conversation: (args) => openConversation(args),
    fill_reply: (args) => fillReply(args),
    send_reply: () => sendReply(),
    read_jobs: (args) => readJobs(args),
    open_job: (args) => openJob(args),
    read_job_detail: () => readJobDetail(),
    greet: () => greet(),
    scroll_jobs: (args) => scrollJobs(args),
    debug_dom: (args) => debugDom(args),
  };

  chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
    if (req?.channel !== "boss-bridge") return; // 只处理 bridge 命令，避免抢 index.js 的消息
    const handler = HANDLERS[req.cmd];
    if (!handler) {
      sendResponse({ ok: false, error: "未知命令: " + req.cmd });
      return true;
    }
    // 支持同步/异步命令（greet、scroll_jobs 等需要等待页面反应）
    Promise.resolve()
      .then(() => handler(req.args || {}))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  });

  console.log("[boss-assistant] bridge.js 已加载");
})();
