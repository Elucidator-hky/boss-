/**
 * Background Service Worker
 * 功能：接收内容脚本请求，调用 OpenAI 兼容的 Chat Completions 接口，返回生成结果
 */

// ============================================================================
// 消息监听
// ============================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // LLM 聊天处理
  if (msg?.type === "LLM_CHAT") {
    handleLlmChat(msg)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err?.message || String(err)
        })
      );
    return true; // keep sendResponse async
  }

  // 生成打招呼语
  if (msg?.type === "GENERATE_GREETING") {
    handleGenerateGreeting(msg)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err?.message || String(err)
        })
      );
    return true;
  }

  // 获取职位详情页完整 JD（通过新标签页）
  if (msg?.type === "FETCH_JOB_DETAIL") {
    handleFetchJobDetailViaTab(msg, sender.tab?.id)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err?.message || String(err)
        })
      );
    return true; // keep sendResponse async
  }

  // 测试 API 连接
  if (msg?.type === "TEST_API_CONNECTION") {
    handleTestApiConnection(msg)
      .then((res) => sendResponse({ ok: true, ...res }))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: err?.message || String(err)
        })
      );
    return true;
  }

  // 打开配置页（带锚点定位）
  if (msg?.type === "OPEN_OPTIONS") {
    const section = msg.section || "";
    chrome.runtime.openOptionsPage(() => {
      // 配置页打开后，通过 storage 传递要滚动到的区块
      if (section) {
        chrome.storage.local.set({ _scroll_to_section: section });
      }
    });
    return false;
  }
});

// ============================================================================
// 主流程
// ============================================================================

/**
 * 通过新标签页获取职位详情（页面是动态渲染的，需要在浏览器环境加载）
 */
async function handleFetchJobDetailViaTab(msg, originTabId) {
  const { encryptJobId, securityId } = msg;

  if (!encryptJobId || !securityId) {
    throw new Error("缺少 encryptJobId 或 securityId");
  }

  const url = `https://www.zhipin.com/job_detail/${encryptJobId}.html?securityId=${encodeURIComponent(securityId)}`;
  console.log("[FETCH_JOB_DETAIL] 打开新标签页:", url);

  // 创建新标签页（后台打开）
  const tab = await chrome.tabs.create({ url, active: false });

  try {
    // 等待页面加载完成
    await waitForTabLoad(tab.id, 10000);

    // 等待额外时间让 JS 渲染完成
    await sleep(2000);

    // 注入脚本提取职位描述
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.querySelector(".job-sec-text");
        return el ? el.innerText.trim() : null;
      }
    });

    const jobDescription = results?.[0]?.result;

    if (!jobDescription) {
      throw new Error("未能从页面提取职位描述");
    }

    console.log("[FETCH_JOB_DETAIL] 获取到职位描述，长度:", jobDescription.length);

    return { jobDescription, url };
  } finally {
    // 关闭标签页
    try {
      await chrome.tabs.remove(tab.id);
    } catch (_) {
      // ignore
    }
  }
}

/**
 * 等待标签页加载完成
 */
function waitForTabLoad(tabId, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const checkTab = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          resolve();
          return;
        }
        if (Date.now() - startTime > timeout) {
          reject(new Error("标签页加载超时"));
          return;
        }
        setTimeout(checkTab, 200);
      } catch (err) {
        reject(err);
      }
    };

    checkTab();
  });
}

/**
 * 延时函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 测试 API 连接
 */
async function handleTestApiConnection(msg) {
  const { api_base, api_key, model } = msg;

  if (!api_base || !api_key || !model) {
    throw new Error("配置信息不完整");
  }

  const url = buildChatCompletionsUrl(api_base);

  const body = {
    model: model,
    messages: [
      { role: "user", content: "hi" }
    ],
    max_tokens: 5
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${api_key}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    // 尝试解析错误信息
    try {
      const json = JSON.parse(text);
      throw new Error(json.error?.message || json.message || `HTTP ${res.status}`);
    } catch (e) {
      if (e.message.includes("HTTP")) throw e;
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
    }
  }

  const json = await res.json();
  if (!json.choices || json.choices.length === 0) {
    throw new Error("模型未返回有效响应");
  }

  return { message: "连接成功" };
}

/**
 * 生成打招呼语
 */
async function handleGenerateGreeting(msg) {
  const { settings, profile_static } = await storageGet(["settings", "profile_static"]);

  if (!settings?.api_base || !settings?.api_key || !settings?.model) {
    throw new Error("模型配置不完整：请在配置页填写 API Base / API Key / 模型名称");
  }

  const jobInfo = msg.jobInfo || {};
  const profileStaticZh = mapProfileStaticKeysToChinese(profile_static || {});

  const url = buildChatCompletionsUrl(settings.api_base);
  const systemPrompt = buildGreetingSystemPrompt(profileStaticZh);
  const userPrompt = buildGreetingUserPrompt(jobInfo);

  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.7,
    stream: true
  };

  console.log("[Greeting] request:", body);

  const content = await fetchStreamingContent(url, settings.api_key, body);

  if (!content) {
    throw new Error("模型未返回内容");
  }

  console.log("[Greeting] response:", content);

  return { greeting: content.trim() };
}

/**
 * 生成打招呼语的 system prompt
 */
function buildGreetingSystemPrompt(profileStaticZh) {
  const filtered = filterEmptyFields(profileStaticZh);
  return [
    "你是BOSS直聘打招呼语生成器。根据JD生成个性化开场白。",
    "",
    "【候选人信息】",
    JSON.stringify(filtered, null, 2),
    "",
    "【输出格式】固定两行：",
    "第一行：问候 + 提及JD中1-2个具体要求 + 表达兴趣",
    "第二行：我如何满足这些要求（技术/经验/项目，用数据说话）",
    "",
    "【核心规则】",
    "1. 第一行必须包含JD中的具体关键词（技术栈/经验要求/业务领域），不能只说\"xx岗位\"",
    "2. 第二行要回应第一行提到的要求，证明我能胜任",
    "3. 只提及JD明确要求且候选人确实具备的内容",
    "4. 禁止编造候选人信息中不存在的技能或经历",
    "5. 学历亮点：如果候选人是985/211/硕士/博士，可在第二行适当提及",
    "6. 称呼规则（按优先级判断）：",
    "   - 职位是尊称（经理/主管/总监/总/负责人）→「姓+职位」如「王经理」「张总」",
    "   - 职位不是尊称但能判断性别 →「姓+先生/女士」如「王女士」「李先生」",
    "   - 无法判断 → 直接「您好」开头，不加任何称呼",
    "",
    "【优质示例】",
    "",
    "您好，看到贵司招Java开发，要求熟悉微服务和高并发，很感兴趣。",
    "我有3年Java经验，做过日均百万订单系统，熟悉Spring Cloud和Redis。",
    "",
    "您好，看到前端岗位要求Vue3和TypeScript经验，很感兴趣。",
    "我熟悉Vue全家桶，有2年TS开发经验，负责过从0到1搭建管理后台。",
    "",
    "您好，看到算法岗要求NLP方向和深度学习框架经验，很感兴趣。",
    "我是985计算机硕士，研究方向NLP，熟悉PyTorch，发过ACL论文。",
    "",
    "王经理您好，看到测试岗要求自动化测试和CI/CD经验，很感兴趣。",
    "我有4年测试经验，熟悉Selenium和Jenkins，之前负责支付模块质量保障。",
    "",
    "李先生您好，看到运维岗要求熟悉K8s和云原生架构，很感兴趣。",
    "我有3年DevOps经验，负责过百台服务器的容器化改造和监控体系搭建。",
    "",
    "【反面示例 - 禁止】",
    "× \"看到Java开发岗很感兴趣\" - 没提JD具体要求，像群发",
    "× \"看到贵司岗位很匹配\" - 太泛，没有具体内容",
    "",
    "直接输出两行文字，60-100字，不要任何额外内容。"
  ].join("\n");
}

/**
 * 生成打招呼语的 user prompt
 */
function buildGreetingUserPrompt(jobInfo) {
  const hrInfo = [];
  if (jobInfo.hrName) hrInfo.push(`姓名：${jobInfo.hrName}`);
  if (jobInfo.hrTitle) hrInfo.push(`职位：${jobInfo.hrTitle}`);

  return [
    "职位信息：",
    `职位名称：${jobInfo.jobName || "未知"}`,
    `公司：${jobInfo.company || "未知"}`,
    `薪资：${jobInfo.salary || "未知"}`,
    `城市：${jobInfo.city || "未知"}`,
    hrInfo.length ? `HR信息：${hrInfo.join("，")}` : "",
    "",
    "职位描述：",
    jobInfo.description || "无",
    "",
    "请生成打招呼语："
  ].filter(Boolean).join("\n");
}

/**
 * 主流程：读取配置 -> 组装 prompt -> 请求模型 -> 解析输出
 */
async function handleLlmChat(msg) {
  const { settings, profile_static } = await storageGet(["settings", "profile_static"]);

  console.log("[LLM] settings:", JSON.stringify(settings, null, 2));

  if (!settings?.api_base || !settings?.api_key || !settings?.model) {
    throw new Error("模型配置不完整：请在配置页填写 API Base / API Key / 模型名称");
  }

  const dialogue = String(msg.dialogue || "").trim();
  if (!dialogue) {
    throw new Error("没有可发送的对话内容");
  }

  // 组装请求
  const url = buildChatCompletionsUrl(settings.api_base);
  const profileStaticZh = mapProfileStaticKeysToChinese(profile_static || {});
  const systemPrompt = buildSystemPrompt(profileStaticZh);
  const userPrompt = buildUserPrompt(dialogue);

  const body = {
    model: settings.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1,
    stream: true
  };

  console.log("[LLM] request:", body);

  const content = await fetchStreamingContent(url, settings.api_key, body);

  if (!content) {
    throw new Error("模型未返回内容");
  }

  console.log("[LLM] response content:", content);

  const parsed = parseAssistantJson(String(content));
  if (!parsed) {
    return { can_answer: false, reply: "", debug_request: body };
  }

  return {
    can_answer: Boolean(parsed.can_answer),
    reply: parsed.can_answer ? String(parsed.reply || "").trim() : "",
    debug_request: body
  };
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 流式请求，返回完整内容
 */
async function fetchStreamingContent(url, apiKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${url}\n${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n").filter(line => line.startsWith("data: "));

    for (const line of lines) {
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta;
        if (delta?.content) {
          fullContent += delta.content;
        }
      } catch (_) {
        // 忽略解析错误
      }
    }
  }

  return fullContent;
}

/**
 * 从 storage.local 读取指定键
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
 * 根据 api_base 生成 Chat Completions 请求地址
 */
function buildChatCompletionsUrl(apiBase) {
  const base = String(apiBase || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("API Base 为空");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

/**
 * fetch 请求并解析 JSON，非 2xx 抛错
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

/**
 * 解析模型输出的 JSON
 * 优先直接解析，失败则提取 { } 子串再解析
 */
function parseAssistantJson(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  try {
    return JSON.parse(t);
  } catch (_) {
    // ignore
  }

  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const sliced = t.slice(first, last + 1);
  try {
    return JSON.parse(sliced);
  } catch (_) {
    return null;
  }
}

// ============================================================================
// Prompt 构建
// ============================================================================

/**
 * 把 profile_static 英文属性名转为中文
 */
function mapProfileStaticKeysToChinese(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  const map = {
    city: "城市",
    status: "状态",
    years: "工作年限",
    degree: "学历",
    direction: "方向",
    tech_stack: "技术栈",
    salary_prev: "上一份薪资",
    leave_time: "到岗时间",
    leave_reason: "离职原因",
    skills: "职业技能",
    projects: "项目经验",
    extras: "自定义字段"
  };

  const out = {};
  for (const [key, value] of Object.entries(p)) {
    const zhKey = map[key];
    if (!zhKey) continue;
    out[zhKey] = value;
  }
  return out;
}

/**
 * 过滤掉空字段
 */
function filterEmptyFields(obj) {
  const filtered = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value && (typeof value !== "object" || Object.keys(value).length > 0)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * 生成 system prompt（规则 + 个人信息）
 */
function buildSystemPrompt(profileStaticZh) {
  const filtered = filterEmptyFields(profileStaticZh);
  return [
    "你是我的求职聊天助手，以我（候选人）的身份给 HR 写回复草稿。",
    "",
    "【我的个人信息】",
    JSON.stringify(filtered),
    "",
    "【对话格式】",
    "- HR：[消息] = HR发送的消息",
    "- 我：[消息] = 我已发送的回复",
    "- 系统提示：[消息] = 系统消息",
    "",
    "【可回答的问题类型 - 白名单】",
    "只有以下类型的问题才能回答，其他一律不回答：",
    "- 城市 → 问我在哪/坐标/哪个城市",
    "- 状态 → 问我在职还是离职",
    "- 工作年限 → 问我几年经验",
    "- 学历 → 问我什么学历/学校",
    "- 方向 → 问我做什么方向",
    "- 技术栈 → 问我会什么技术",
    "- 上一份薪资 → 问我薪资/期望薪资（必须个人信息里有）",
    "- 到岗时间 → 问我多久能入职（必须个人信息里有）",
    "- 离职原因 → 问我为什么离职（必须个人信息里有）",
    "- 项目经验 → 问我做过什么项目",
    "- 自定义字段 → 如果个人信息里有「自定义字段」对象，其中的键值对也可用于回答对应问题（如「是否接受外包：不接受」可回答外包相关问题）",
    "",
    "【硬性约束】",
    "1. 只能用个人信息里字面存在的内容回答",
    "2. 禁止编造任何个人信息里不存在的内容",
    "3. 禁止推断或延伸（如个人信息没写12薪就不能说12薪）",
    "4. 已回复过的问题不重复回答",
    "5. 回复越短越好，越准确越好，直接给答案，不要废话",
    "",
    "【判断流程】",
    "1. 遍历对话记录，找出所有 HR 提出但我还没有回复的问题",
    "2. 对每个未回复的问题，判断是否能在我的个人信息中找到准确答案",
    "3. 如果所有未回复问题都能找到答案 → can_answer=true，在 reply 中逐个回答，每个问题单独一行",
    "4. 如果有任何一个问题在个人信息中找不到准确答案 → can_answer=false",
    "",
    "【输出格式】只输出JSON，不要其他文字：",
    "{\"can_answer\": true/false, \"reply\": \"...\"}"
  ].join("\n");
}

/**
 * 生成 user prompt（对话记录）
 */
function buildUserPrompt(dialogue) {
  return "对话记录：\n" + dialogue;
}
