#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openBridge } from "./bridge-client.js";
import { VERSION } from "./bridge-runtime.js";

// The bridge must be reachable before exposing tools to the agent.
let bridge;
try { bridge = await openBridge(); }
catch (e) { console.error("[boss-mcp] 启动失败:", e.message); process.exit(1); }

// ---------------------------------------------------------------------------
// MCP 工具定义
// ---------------------------------------------------------------------------
const TOOLS = [
  { name: "connection_status", description: "先调用此工具核对 Boss 共享桥接版本、浏览器扩展连接和会话控制权；不操作页面。连接异常时停止，不改用其它浏览器工具。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "release_control", description: "完成一轮 Boss 任务、核对消息并清理草稿后释放页面控制权，让另一个 AI 会话接手。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "read_current_page",
    description:
      "读取当前 Boss 直聘页面的信息。若在聊天页，返回该职位的结构化信息（职位名/薪资/城市/公司/HR）以及最近的聊天记录；其它页面返回 URL、标题和页面类型。用于让 Claude 了解你当前看的是什么岗位、聊到哪了。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_conversations",
    description:
      "读取聊天页左侧的对话列表（找过我的 HR / 我沟通过的职位）。返回每条对话的序号和文本摘要（HR名/公司/职位/最后一条消息）。用于批量浏览有哪些对话、决定回复谁。",
    inputSchema: {
      type: "object",
      properties: {
        max: { type: "number", description: "最多返回多少条，默认 30" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "open_conversation",
    description:
      "点开聊天页左侧列表中的某个对话（派发页面点击事件）。按 index（read_conversations 返回的序号）或 keyword（HR名/公司/职位关键词）定位。打开后可用 read_current_page 读取该对话详情。",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number", description: "对话序号（优先）" },
        keyword: { type: "string", description: "按文本关键词匹配对话" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "fill_reply",
    description:
      "把回复文本填入当前打开对话的聊天输入框（不发送）。填好后用户可自行检查修改，或调用 send_reply 发送。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要填入的回复内容" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "send_reply",
    description:
      "发送当前聊天输入框里的内容（优先点击可见发送按钮，否则模拟 Enter）。发送的是输入框当前实际内容，先用 fill_reply 填好。⚠️ 真实发送给对方，不可撤回，按用户本次已授权范围调用；回读聊天记录确认送达。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "chat_action",
    description:
      "在当前打开的聊天对话里执行工具栏动作：send_resume（发简历）/ exchange_wechat（换微信）/ exchange_phone（换电话）。⚠️ 真实对外动作。注意：三个动作 Boss 有门控——双方互发过消息后才可用，否则点击被静默忽略。send_resume 会弹「选择简历」框：不带 resume 参数时只返回可选简历清单（关弹窗不发送）；带 resume 关键词才选中并真实发送。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["send_resume", "exchange_wechat", "exchange_phone"],
          description: "send_resume=发简历，exchange_wechat=换微信，exchange_phone=换电话",
        },
        resume: {
          type: "string",
          description:
            "仅 send_resume 用：要发送的简历文件名关键词（如「AI 应用」）。不传则只列清单不发送。",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "read_jobs",
    description:
      "读取推荐页/搜索页的职位列表（来自 API 拦截，数据干净：含 encryptJobId/securityId/职位名/薪资/公司/城市/经验学历/技能标签/公司规模融资阶段）。列表随页面滚动分页累积，用 scroll_jobs 加载更多。需在 Chrome 打开 Boss 推荐或搜索页。",
    inputSchema: {
      type: "object",
      properties: {
        max: { type: "number", description: "最多返回多少条，默认 50" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "scroll_jobs",
    description: "滚动职位列表触发分页加载更多职位。返回当前已缓存职位数和页面卡片数。",
    inputSchema: {
      type: "object",
      properties: {
        times: { type: "number", description: "滚动几次（每次约 1.2s），默认 1，最多 8" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "open_job",
    description:
      "点开推荐/搜索页列表中的某个职位卡片（派发页面点击事件，详情出现在页面右侧/详情区）。推荐用 keyword（职位名或公司名）定位；index 是页面卡片顺序，可能与 read_jobs 顺序有偏差。打开后用 read_job_detail 读完整 JD。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "职位名/公司名关键词（推荐）" },
        index: { type: "number", description: "页面卡片序号" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_job_detail",
    description: "读取当前打开的职位详情面板完整文本（JD、公司信息、地址等）。先 open_job。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "greet",
    description:
      "对当前打开的职位详情点「立即沟通」，真实发起打招呼（页面可能发送默认招呼语，先回读核对）。若按钮是「继续沟通」说明已聊过，不会重复。⚠️ 真实对外动作，按用户本次已授权范围调用；频率过高有风控风险，建议一次会话内少量使用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_jobs",
    description:
      "在 Boss 直聘发起职位搜索：跳转到搜索结果页（query 关键词 + 可选城市）。完成后用 read_jobs 读取结果列表。薪资/经验/学历等进一步筛选建议拿到列表后由 Claude 按数据过滤。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，如「AI应用开发」「大模型」" },
        city: {
          type: "string",
          description:
            "城市名（支持：全国/北京/上海/广州/深圳/杭州/武汉/成都/重庆/南京/苏州/西安）或 9 位城市代码，留空为默认",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "navigate",
    description:
      "把 Boss 标签页导航到指定 zhipin.com 页面（仅限 www.zhipin.com 域）。常用：聊天页 https://www.zhipin.com/web/geek/chat 、推荐页 https://www.zhipin.com/web/geek/job-recommend",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "目标 URL，必须以 https://www.zhipin.com/ 开头" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "debug_dom",
    description:
      "【调试用】返回页面上指定 CSS 选择器命中的元素数量和 outerHTML 片段。Boss 页面 DOM 改版导致其它工具失效时，用它排查真实结构。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器，默认 body" },
        max_nodes: { type: "number", description: "最多返回几个节点的 HTML，默认 3" },
        max_chars: { type: "number", description: "HTML 总长度上限，默认 3000" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dom_click",
    description:
      "【通用原语】按 CSS 选择器点击页面任意可见元素（带元素坐标的合成事件链）。配合 debug_dom 先看结构再点，任何 Boss 页面可用，无需专用工具。⚠️ 点击可能触发真实对外动作，谨慎使用。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器" },
        text: { type: "string", description: "可选：在命中元素中筛选 innerText 包含此文本的" },
        index: { type: "number", description: "命中多个时取第几个（可见元素序号，默认 0）" },
      },
      required: ["selector"],
      additionalProperties: false,
    },
  },
  {
    name: "dom_fill",
    description:
      "【通用原语】往页面任意 input/textarea/contenteditable 填入文本（原生 setter + input/change 事件，Vue/React 表单可感知）。只填不提交。配合 debug_dom 先看结构。",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS 选择器" },
        value: { type: "string", description: "要填入的文本" },
        index: { type: "number", description: "命中多个时取第几个（可见元素序号，默认 0）" },
      },
      required: ["selector", "value"],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const server = new Server(
  { name: "boss-assistant", version: VERSION },
  {
    capabilities: { tools: {} },
    instructions: "Boss 页面只通过本 MCP 操作。先 connection_status，再 read_current_page 核对页面；不调用其它浏览器/CDP/Playwright 工具。控制权被另一会话占用时等待其 release_control。账号异常、验证码或限制提示出现时停止自动化，交本人处理。外发仅限用户已授权范围，发送后回读验证；每次任务按顺序执行工具，完成后 release_control。",
  }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (!TOOL_NAMES.has(name)) throw new Error("未知工具: " + name);
    const data = await bridge.call(name, args || {});
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "错误：" + e.message }], isError: true };
  }
});
const transport = new StdioServerTransport();
const close = () => { bridge.close(); process.exit(0); };
process.stdin.on("end", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);
await server.connect(transport);
console.error(`[boss-mcp] v${VERSION} 已就绪（共享浏览器桥接）`);
