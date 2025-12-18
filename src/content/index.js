function watchImListAsDialogue() {
  const ul = document.querySelector("ul.im-list");
  if (!ul) {
    console.log("[im-list] not found, retry...");
    setTimeout(watchImListAsDialogue, 1000);
    return;
  }

  const roleOf = (li) => {
    if (li.classList.contains("item-friend")) return "HR";
    if (li.classList.contains("item-myself")) return "我";
    if (li.classList.contains("item-system")) return "系统";
    return "未知";
  };

  const clean = (s) =>
    (s || "")
      .replace(/\s+\n/g, "\n")
      .replace(/\n\s+/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const extractText = (li) => {
    // 优先取聊天正文区域（尽量避开卡片/图标等噪音）
    const textNode =
      li.querySelector(".message-content .text") ||
      li.querySelector(".message-content") ||
      li.querySelector(".text");

    let text = textNode ? textNode.innerText : li.innerText;

    // 去掉“已读”等状态字样（按你页面实际再加规则）
    text = text.replace(/\b已读\b/g, "").trim();

    // 系统消息常见是超链接提示，直接拿 li.innerText 也行
    return clean(text);
  };

  const stringifyDialogue = () => {
    const lis = ul.querySelectorAll("li.message-item");
    const lines = [];

    for (const li of lis) {
      // 过滤“PK情况”卡片
      if (li.innerText && li.innerText.includes("你与该职位竞争者PK情况")) {
        continue;
      }

      const role = roleOf(li);
      const time = clean(li.querySelector(".item-time .time")?.innerText || "");
      const text = extractText(li);

      if (!text) continue;

      const prefix = time ? `[${role}｜${time}]` : `[${role}]`;
      lines.push(`${prefix} ${text}`);
    }

    return lines.join("\n");
  };

  let last = "";
  let timer = null;

  const emit = () => {
    const dialogue = stringifyDialogue();
    if (dialogue && dialogue !== last) {
      last = dialogue;
      console.log("[im-list] dialogue:\n" + dialogue);

      // 这里把 dialogue 发给你的大模型即可
      // sendToLLM(dialogue)
    }
  };

  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(emit, 200); // 去抖：200ms 内多次变化只输出一次
  });

  observer.observe(ul, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // 先输出一次全量
  emit();
}

watchImListAsDialogue();
