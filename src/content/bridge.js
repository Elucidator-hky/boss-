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
  async function readCurrentPage() {
    const page = classifyPage();
    const base = { url: location.href, title: document.title, page };
    if (page === "chat") {
      // 消息列表是虚拟滚动，滚出视口的会被回收；先滚到底保证最新消息已渲染
      const ul = document.querySelector("ul.im-list");
      const scroller = ul && scrollableAncestor(ul);
      if (scroller) {
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(400);
      }
      // 切换对话后职位数据由页面异步请求推来；若还没到最多再等 ~1.5s。
      // 宁可返回 null 也不返回上一个对话的残留（messages 直接读当前 DOM，始终准确）。
      for (let i = 0; i < 6 && !bridgeJobData; i++) await sleep(250);
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
    // 带上元素中心的真实坐标：0,0 的事件既可能被处理器忽略，也更像机器人
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y + 80,
    };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse" }));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    // 真人点击自带焦点，很多组件（如 Boss 的只读输入框选择器）靠 focus 才弹面板
    try {
      if (typeof el.focus === "function") el.focus();
    } catch (_) {}
    try {
      el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse" }));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function simulateHover(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    el.dispatchEvent(new MouseEvent("mouseover", { ...opts, bubbles: true }));
    // mouseenter 不冒泡，对目标和各级祖先分别派发
    let n = el;
    while (n && n !== document.body) {
      n.dispatchEvent(new MouseEvent("mouseenter", { ...opts, bubbles: false }));
      n = n.parentElement;
    }
    el.dispatchEvent(new MouseEvent("mousemove", { ...opts, bubbles: true }));
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
    // 切换了对话：旧职位缓存立即作废，等新对话的 API 数据推来。
    // 否则 read_current_page 可能返回上一个对话残留的 job/jobInfo（曾导致按错误 JD 判断岗位）。
    bridgeJobData = null;
    bridgeJobInfo = null;
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
  // 聊天页工具栏动作：发简历 / 换微信 / 换电话（点按钮 + 自动确认弹窗）
  // -------------------------------------------------------------------------
  function findByText(texts, root = document) {
    const els = Array.from(root.querySelectorAll("button, a, span, div, li, p"));
    // 只要可见的、文本精确匹配的；同文本嵌套时文档序靠后的更深，取最后一个
    return els.filter((el) => {
      if (el.offsetParent === null) return false;
      const t = (el.innerText || "").trim();
      return texts.includes(t);
    });
  }

  function findVisibleDialog() {
    // Boss 聊天工具栏的确认框类名是 sentence-popover，且嵌在按钮元素内部
    const dialogs = Array.from(
      document.querySelectorAll(
        '[class*="dialog"], [class*="popup"], [class*="modal"], .sentence-popover'
      )
    ).filter((el) => el.offsetParent !== null && (el.innerText || "").trim().length > 0);
    return dialogs.pop() || null;
  }

  // d-c 是 Boss 埋点编号，比文字/aria-label 稳（按钮文字带空格且 aria-label 为空）
  const CHAT_ACTIONS = {
    send_resume: { dc: "62009", labels: ["发简历", "发送简历"] },
    exchange_wechat: { dc: "62011", labels: ["换微信", "交换微信"] },
    exchange_phone: { dc: "62007", labels: ["换电话", "交换电话"] },
  };

  async function chatAction(args) {
    const action = String(args?.action || "");
    const conf = CHAT_ACTIONS[action];
    if (!conf) throw new Error("action 必须是 send_resume / exchange_wechat / exchange_phone");
    const labels = conf.labels;
    let btn = document.querySelector(`.chat-controls [d-c="${conf.dc}"]`);
    if (!btn || btn.offsetParent === null) {
      const scope = document.querySelector(".chat-controls") || document;
      const btns = findByText(labels, scope);
      btn = btns[btns.length - 1] || null;
    }
    if (!btn) {
      throw new Error(`没找到「${labels[0]}」按钮（需已点开一个对话；DOM 改版用 debug_dom 排查）`);
    }

    // tooltip 类组件的面板常要 mouseenter 才挂载；先 hover，再依次试内层按钮/外层容器，
    // 每次点完轮询最多 1.8s 等弹窗出现
    const container = btn.closest(".toolbar-btn-content") || btn.parentElement || btn;
    simulateHover(btn);
    await sleep(300);
    let dialog = null;
    for (const target of [btn, container]) {
      simulateClick(target);
      for (let i = 0; i < 6 && !dialog; i++) {
        await sleep(300);
        dialog = findVisibleDialog();
      }
      if (dialog) break;
    }
    if (!dialog) {
      const html = (container.outerHTML || "").slice(0, 600);
      return {
        action,
        clicked: labels[0],
        confirmed: null,
        note: "点击后未出现确认弹窗（可能未触发处理器），请回读页面确认",
        container_html: html,
      };
    }
    // 发简历弹窗是「请选择要发送的简历」：必须先选中一份，发送键才解禁
    const resumeList = dialog.querySelector(".resume-list");
    if (action === "send_resume" && resumeList) {
      const items = Array.from(resumeList.querySelectorAll(".list-item"));
      const names = items.map((li) => clean(li.querySelector(".resume-name")?.innerText || ""));
      const closeDialog = () => {
        const x = document.querySelector(".boss-popup__close");
        if (x) simulateClick(x);
      };
      const kw = String(args?.resume || "").trim();
      if (!kw) {
        closeDialog();
        return {
          action,
          sent: false,
          resumes: names,
          note: "有多份简历可选，需用 resume 参数指定文件名关键词。已关闭弹窗，未发送。",
        };
      }
      const target = items.find((li) => (li.innerText || "").includes(kw));
      if (!target) {
        closeDialog();
        throw new Error(`简历列表里没有包含「${kw}」的文件。现有：${names.join(" / ")}（已关弹窗未发送）`);
      }
      simulateClick(target);
      await sleep(500);
      const sendBtn = dialog.querySelector("button.btn-confirm");
      if (!sendBtn || sendBtn.disabled || /disabled/.test(sendBtn.className)) {
        closeDialog();
        throw new Error("选中简历后发送按钮仍是禁用态，未发送（DOM 可能改版，用 debug_dom 排查）");
      }
      simulateClick(sendBtn);
      await sleep(800);
      return {
        action,
        sent: true,
        resume: clean(target.querySelector(".resume-name")?.innerText || kw),
        note: "已点发送，请回读确认聊天里出现简历消息",
      };
    }

    const dialogText = clean(dialog.innerText).slice(0, 300);
    // 跳过禁用态按钮（发送键在满足条件前是 disabled，盲点等于没点）
    const confirmBtns = findByText(["发送", "确定", "确认", "申请", "继续"], dialog).filter(
      (el) => !el.disabled && !/\bdisabled\b/.test(el.className || "")
    );
    if (!confirmBtns.length) {
      return { action, clicked: labels[0], confirmed: null, dialog: dialogText, note: "弹窗里没找到可用的确认按钮，未确认" };
    }
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    const confirmLabel = (confirmBtn.innerText || "").trim();
    simulateClick(confirmBtn);
    await sleep(800);
    return { action, clicked: labels[0], confirmed: confirmLabel, dialog: dialogText };
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
    // 点击后 Boss 多半直接跳转聊天页，跳转会销毁本脚本——必须立即返回，
    // 否则消息通道被关闭、MCP 收到假报错。弹窗（发送成功→留在当前页）改为后台处理。
    setTimeout(() => {
      const stay = Array.from(document.querySelectorAll("a, button")).find(
        (el) =>
          el.offsetParent !== null && /留在|稍后|取消/.test((el.innerText || "").trim())
      );
      if (stay) simulateClick(stay);
    }, 1500);
    return {
      greeted: true,
      note: "已点「立即沟通」建立对话；该动作通常不自动发招呼语，页面会跳到聊天页。请用 read_current_page 确认后，用 fill_reply + send_reply 发定制招呼。",
    };
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
  // 通用原语：看(debug_dom)/点(dom_click)/填(dom_fill)
  // 让 Claude 临场读 DOM 后直接操作任意页面，新界面无需再写专用代码
  // -------------------------------------------------------------------------
  function visibleBySelector(sel) {
    return Array.from(document.querySelectorAll(sel)).filter((e) => e.offsetParent !== null);
  }

  function domClick(args) {
    const sel = String(args?.selector || "").trim();
    if (!sel) throw new Error("需要 selector（先用 debug_dom 看结构）");
    let els = visibleBySelector(sel);
    const text = String(args?.text || "").trim();
    if (text) els = els.filter((e) => (e.innerText || "").includes(text));
    const el = els[Number(args?.index) || 0];
    if (!el) throw new Error(`没找到可见的匹配元素（selector=${sel}${text ? ` text含「${text}」` : ""}，命中 ${els.length} 个）`);
    simulateClick(el);
    return {
      clicked: clean(el.innerText || el.getAttribute("aria-label") || el.className || sel).slice(0, 120),
      matched: els.length,
    };
  }

  function domFill(args) {
    const sel = String(args?.selector || "").trim();
    if (!sel) throw new Error("需要 selector");
    const el = visibleBySelector(sel)[Number(args?.index) || 0];
    if (!el) throw new Error("没找到可见的匹配元素");
    const value = String(args?.value ?? "");
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      // 用原生 setter 绕过 Vue/React 的 value 劫持，否则框架收不到变更
      const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.isContentEditable) {
      el.focus();
      el.innerText = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      throw new Error(`元素是 <${tag}>，不是 input/textarea/contenteditable，填不了`);
    }
    return { filled: value.slice(0, 100), tag };
  }

  // -------------------------------------------------------------------------
  // 调试：查看指定选择器的 DOM 结构（测试阶段排查选择器用）
  // -------------------------------------------------------------------------
  function debugDom(args) {
    const sel = String(args?.selector || "body");
    const maxChars = Math.min(Number(args?.max_chars) || 3000, 20000);
    const all = document.querySelectorAll(sel);
    const nodes = Array.from(all).slice(0, Number(args?.max_nodes) || 3);
    // 表单控件的 value 是属性不进 outerHTML，单独收集，否则预填内容不可见
    const values = [];
    nodes.forEach((n, i) => {
      const fields = n.matches && n.matches("input, textarea, select")
        ? [n]
        : Array.from(n.querySelectorAll("input, textarea, select"));
      fields.forEach((f) => {
        const v = String(f.value ?? "");
        if (!v || f.type === "hidden") return;
        values.push({
          node: i,
          tag: f.tagName.toLowerCase(),
          placeholder: (f.placeholder || "").slice(0, 30),
          value: v.slice(0, 600),
        });
      });
    });
    return {
      count: all.length,
      values,
      html: nodes.map((n) => n.outerHTML).join("\n---\n").slice(0, maxChars),
    };
  }

  const HANDLERS = {
    read_current_page: () => readCurrentPage(),
    read_conversations: (args) => readConversations(args),
    open_conversation: (args) => openConversation(args),
    fill_reply: (args) => fillReply(args),
    send_reply: () => sendReply(),
    chat_action: (args) => chatAction(args),
    read_jobs: (args) => readJobs(args),
    open_job: (args) => openJob(args),
    read_job_detail: () => readJobDetail(),
    greet: () => greet(),
    scroll_jobs: (args) => scrollJobs(args),
    debug_dom: (args) => debugDom(args),
    dom_click: (args) => domClick(args),
    dom_fill: (args) => domFill(args),
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
      .then(() => { lastActionAt = Date.now(); return handler(req.args || {}); })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  });

  // -------------------------------------------------------------------------
  // 新消息事件推送：盯左侧对话列表，有新消息就通知 background → MCP server
  // （事件驱动唤醒 Claude，替代纯轮询）
  // -------------------------------------------------------------------------
  let lastActionAt = 0; // 命令 handler 里赋值；新逻辑不再依赖它过滤，仅保留声明
  let lastMsgCount = -1; // 顶部「消息」未读计数上次值，-1=未初始化

  // 顶部导航「消息」链接内的未读计数 .nav-chat-num（<a ka="header-message">消息<span class="nav-chat-num">N</span></a>）：
  // 全页面都在（含搜索页），只有 HR 真发来新消息时数字才增加；自己发消息/已读不会让它变大 → 天然过滤空唤醒。
  // 无未读时该 span 是 display:none（值0），用 textContent 读隐藏值。
  function readMsgBadge() {
    const el = document.querySelector(".nav-chat-num");
    if (!el) return 0;
    const n = parseInt((el.textContent || "").replace(/[^\d]/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }

  function notifyNewMessage() {
    const cur = readMsgBadge();
    if (lastMsgCount < 0) { lastMsgCount = cur; return; } // 首次只记基准
    if (cur > lastMsgCount) {
      lastMsgCount = cur; // 未读增加 = 有新消息，唤醒
      try {
        chrome.runtime.sendMessage({ channel: "boss-bridge", event: "new_message" });
      } catch (_) {}
    } else {
      lastMsgCount = cur; // 未读减少/不变：更新基准，不唤醒（消除已读/自发消息的空唤醒）
    }
  }

  let notifyTimer = null;
  function setupNewMessageWatcher() {
    lastMsgCount = readMsgBadge();
    // 监听整个 body：任何变化都触发 notify，但 notify 只在 .notice-badge 数字变大时才写信号
    const obs = new MutationObserver(() => {
      clearTimeout(notifyTimer);
      notifyTimer = setTimeout(notifyNewMessage, 800); // 防抖 0.8s，更快
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    console.log("[boss-assistant] 消息徽标监听已挂载（notice-badge，全页面有效）");
  }
  setupNewMessageWatcher();

  console.log("[boss-assistant] bridge.js 已加载");
})();
