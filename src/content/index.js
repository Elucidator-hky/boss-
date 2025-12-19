/**
 * Content Script（最小可用）
 * 监听 `ul.im-list` 的变化，打印对话；只在“新增 HR 消息”时调用大模型。
 * 自动填充规则：如果用户没有对输入框进行键盘打字（即 HR 消息触发后未发生输入），则把模型回复自动写入输入框。
 */
function watchImListAsDialogue() {
  // 只在聊天页运行（防止注入到别的页面）
  if (!location.pathname.includes("/web/geek/chat")) return;

  const ul = document.querySelector("ul.im-list");
  if (!ul) {
    console.log("[im-list] not found, retry...");
    setTimeout(watchImListAsDialogue, 1000);
    return;
  }

  /**
   * 获取当前输入框（contenteditable）。
   * 注意：页面可能会重新渲染输入框，所以不要长期缓存旧引用。
   */
  const getChatInputEl = () => document.getElementById("chat-input");

  // 会话内状态（最简单：用当前页面的 DOM 来判断；如需多会话隔离可再扩展）
  let lastPrinted = "";
  let timer = null;
  let lastHrMid = null; // 用 data-mid 去重：同一条 HR 消息不重复触发
  let typedAfterHr = false; // HR 消息触发后，用户是否有键盘输入（有的话就不自动填充）
  let isComposing = false; // 输入法合成中（合成中不自动填充）

  /**
   * 监听输入框输入：只要用户键盘输入/粘贴，就认为用户要自己回（不自动填充）。
   * 注意：这里只记录“发生过输入”，不阻止用户输入。
   */
  (() => {
    const inputEl = getChatInputEl();
    if (!inputEl) return;

    inputEl.addEventListener("keydown", () => {
      typedAfterHr = true;
    });
    inputEl.addEventListener("paste", () => {
      typedAfterHr = true;
    });
    inputEl.addEventListener("compositionstart", () => {
      isComposing = true;
      typedAfterHr = true;
    });
    inputEl.addEventListener("compositionend", () => {
      isComposing = false;
    });
  })();

  /**
   * 判断输入框是否“真的为空”。
   * contenteditable 常见空态：innerText 为空，或 innerHTML 只有 `<br>` / `&nbsp;`。
   */
  const isChatInputEmpty = (el) => {
    if (!el) return true;
    const text = String(el.innerText || "").replace(/\u200b/g, "").trim();
    if (text) return false;

    const html = String(el.innerHTML || "")
      .replace(/\u200b/g, "")
      .replace(/&nbsp;/gi, "")
      .trim()
      .toLowerCase();

    if (!html) return true;
    // 只剩换行标签也算空
    const onlyBr = html.replace(/<br\s*\/?>/g, "").trim() === "";
    if (onlyBr) return true;
    const onlyEmptyDiv = html.replace(/<(div|p)>\s*<\/(div|p)>/g, "").trim() === "";
    if (onlyEmptyDiv) return true;

    return true;
  };

  /**
   * 向 contenteditable 输入框写入文本，并触发 input 事件让页面框架感知变化。
   */
  const fillChatInput = (el, text) => {
    if (!el) return;

    // 1) 聚焦（否则部分页面不会接收 input）
    el.focus();

    // 2) 清空现有内容
    el.innerHTML = "";

    // 3) 优先用 execCommand 插入文本（对 contenteditable 通常更“像用户输入”）
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (_) {
      inserted = false;
    }

    // 4) 兜底：直接写 textContent
    if (!inserted) {
      el.textContent = text;
    }

    // 5) 把光标放到末尾
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {
      // ignore
    }

    // 6) 触发 input 事件（让 Vue/React 等框架更新其内部状态）
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    } catch (_) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  /**
   * 把多余空白整理一下，打印更好看，也减少发给模型的噪音。
   */
  const clean = (s) =>
    (s || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n\s+/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  /**
   * 从一条消息 li 中提取可读文本。
   */
  const extractText = (li) => {
    const textNode =
      li.querySelector(".message-content .text") ||
      li.querySelector(".message-content") ||
      li.querySelector(".text");

    let text = textNode ? textNode.innerText : li.innerText;
    text = text.replace(/\b已读\b/g, "").trim();
    return clean(text);
  };

  /**
   * 把 DOM 里的消息转成 OpenAI messages 格式：
   * - HR 的话 -> role=user
   * - 我说的话 -> role=assistant
   * 只取最近 max 条，减少 token 消耗。
   */
  const collectChatMessages = (max = 20) => {
    const lis = Array.from(ul.querySelectorAll("li.message-item")).slice(-max);
    const messages = [];

    for (const li of lis) {
      // 过滤“PK情况”卡片等噪音
      if (li.innerText && li.innerText.includes("你与该职位竞争者PK情况")) continue;
      // 系统消息不送模型（你也可以保留，看需求）
      if (li.classList.contains("item-system")) continue;

      const role = li.classList.contains("item-friend")
        ? "user"
        : li.classList.contains("item-myself")
          ? "assistant"
          : null;
      if (!role) continue;

      const text = extractText(li);
      if (!text) continue;

      messages.push({ role, content: text });
    }

    return messages;
  };

  /**
   * 获取“最后一条 HR 消息”的 mid（用于判断是否来了新 HR 消息）。
   */
  const getLastHrMid = () => {
    const hrLis = ul.querySelectorAll("li.message-item.item-friend");
    if (!hrLis.length) return null;
    const last = hrLis[hrLis.length - 1];
    return last.getAttribute("data-mid") || null;
  };

  /**
   * 仅用于打印：把对话格式化成可读文本。
   */
  const stringifyDialogue = () => {
    const lis = ul.querySelectorAll("li.message-item");
    const lines = [];

    for (const li of lis) {
      if (li.innerText && li.innerText.includes("你与该职位竞争者PK情况")) continue;

      const who = li.classList.contains("item-friend")
        ? "HR"
        : li.classList.contains("item-myself")
          ? "我"
          : li.classList.contains("item-system")
            ? "系统"
            : "未知";
      const time = clean(li.querySelector(".item-time .time")?.innerText || "");
      const text = extractText(li);
      if (!text) continue;

      const prefix = time ? `[${who}｜${time}]` : `[${who}]`;
      lines.push(`${prefix} ${text}`);
    }

    return lines.join("\n");
  };

  /**
   * 把最近 N 条消息发给后台，让后台调用大模型，然后把回复打印出来。
   * 回来后执行“自动填充判断”。
   */
  const sendToLLM = () => {
    const messages = collectChatMessages(20);
    if (!messages.length) return;

    chrome.runtime.sendMessage({ type: "LLM_CHAT", messages }, (res) => {
      if (chrome.runtime.lastError) {
        console.error("[LLM] runtime error:", chrome.runtime.lastError.message);
        return;
      }
      if (!res?.ok) {
        console.error("[LLM] failed:", res?.error);
        return;
      }
      console.log("[LLM] reply:\n" + res.reply);

      // 自动填充判断：用户没有键盘输入且输入框为空且不在输入法合成中 -> 自动写入
      const inputEl = getChatInputEl();
      if (!inputEl) return;
      if (!isChatInputEmpty(inputEl)) return;
      if (isComposing) return;
      if (typedAfterHr) return;

      fillChatInput(inputEl, res.reply || "");
    });
  };

  /**
   * 每次 DOM 变化（新增 li / 文本更新）后触发。
   * 这里做两件事：
   * 1) 打印最新对话
   * 2) 仅在“新增 HR 消息”时调用模型
   */
  const emit = () => {
    // 1) 打印对话（有变化才打印）
    const dialogue = stringifyDialogue();
    if (dialogue && dialogue !== lastPrinted) {
      lastPrinted = dialogue;
      console.log("[im-list] dialogue:\n" + dialogue);
    }

    // 2) 新增 HR 消息才调用模型
    const hrMid = getLastHrMid();
    if (!hrMid || hrMid === lastHrMid) return;

    // 新 HR 消息来了：重置“用户是否输入过”标记
    typedAfterHr = false;
    lastHrMid = hrMid;

    console.log("[LLM] new HR message -> call llm, mid:", hrMid);
    sendToLLM();
  };

  const observer = new MutationObserver((mutations) => {
    clearTimeout(timer);
    timer = setTimeout(emit, 200); // 去抖：200ms 内多次变化只执行一次
  });

  observer.observe(ul, {
    childList: true,
    subtree: true,
    characterData: true
  });

  // 首次进入页面：记录当前最后一条 HR 消息，避免“打开页面就触发一次模型”
  lastHrMid = getLastHrMid();

  emit(); // 初次先跑一次
}

watchImListAsDialogue();
