/**
 * Background Service Worker
 * 功能：接收内容脚本请求，调用 OpenAI 兼容的 Chat Completions 接口，返回生成结果。
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "LLM_CHAT") return;

  handleLlmChat(msg)
    .then((res) => sendResponse({ ok: true, ...res }))
    .catch((err) =>
      sendResponse({
        ok: false,
        error: err?.message || String(err)
      })
    );

  return true; // keep sendResponse async
});

/**
 * 主流程：读取配置 -> 组装 prompt -> 请求模型 -> 解析输出
 */
async function handleLlmChat(msg) {
  const { settings, profile_static } = await storageGet(["settings", "profile_static"]);

  if (!settings?.api_base || !settings?.api_key || !settings?.model) {
    throw new Error("模型配置不完整：请在配置页填写 API Base / API Key / 模型名称");
  }

  const userMessages = Array.isArray(msg.messages) ? msg.messages : [];
  if (!userMessages.length) {
    throw new Error("没有可发送的 messages");
  }

  const url = buildChatCompletionsUrl(settings.api_base);
  const systemPrompt = buildSystemPrompt(profile_static);

  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt },
      ...userMessages
    ],
    temperature: 0.4
  };

  const json = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.api_key}`
    },
    body: JSON.stringify(body)
  });

  const content = json?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("模型未返回内容（choices[0].message.content 为空）");
  }

  return { reply: String(content).trim(), raw: json };
}

/**
 * 从 storage.local 读取指定键。
 */
function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(err);
      else resolve(items);
    });
  });
}

/**
 * 根据用户填写的 api_base 生成最终请求地址。
 * 约定：用户填写形如 `https://xxx/v1`（OpenAI 兼容）。
 */
function buildChatCompletionsUrl(apiBase) {
  const base = String(apiBase || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("API Base 为空");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

/**
 * 生成 system prompt：把个人信息塞进去，让模型用“候选人”视角回复 HR。
 */
function buildSystemPrompt(profile) {
  const safeProfile = profile && typeof profile === "object" ? profile : {};
  return [
    "你是我的求职聊天助手，你要以“我（候选人）”的身份回复 HR。",
    "要求：中文，简短礼貌，信息真实，不要编造；不确定就说“我需要确认一下再回复您”。",
    "不要输出多余解释、不要带 Markdown。",
    "",
    "这是我的个人信息（JSON）：",
    JSON.stringify(safeProfile)
  ].join("\n");
}

/**
 * fetch + JSON 解析，非 2xx 直接抛错并带上返回文本（方便排查）。
 */
async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}\n${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON：${url}\n${text}`);
  }
}

