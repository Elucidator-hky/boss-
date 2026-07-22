#!/usr/bin/env node
/**
 * Boss 招聘助手 —— MCP server
 *
 * 一头连 Claude Code（MCP over stdio），一头连浏览器扩展（WebSocket）。
 * Claude 调用 MCP 工具 → 通过 WebSocket 把命令转发给扩展 → 扩展在真实 Chrome
 * 里操作 Boss 直聘页面 → 结果原路返回。
 *
 * 注意：stdout 被 MCP 协议独占，所有日志必须走 stderr（console.error）。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WS_PORT = Number(process.env.BOSS_WS_PORT || 8765);
// 新消息信号文件：扩展推来"页面有新消息"事件时，往这里追加一行。
// 外部后台进程（watch-messages.sh）盯着它的行数，一变就唤醒 Claude 去查 Boss（事件驱动，替代轮询）。
// 路径优先取环境变量 BOSS_SIGNAL_FILE，否则落在项目根目录（server.js 上一级），
// 不再硬编码 ~/job/boss，方便他人 clone 到任意目录复用。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNAL_FILE =
  process.env.BOSS_SIGNAL_FILE || path.join(__dirname, "..", ".new-message-signal");
// 启动时清空信号文件：避免跨会话无限累积增长（每次 MCP 重启从干净状态开始）。
try {
  fs.writeFileSync(SIGNAL_FILE, "");
} catch (e) {
  console.error("[boss-mcp] 初始化信号文件失败:", e.message);
}

// ---------------------------------------------------------------------------
// WebSocket：等待浏览器扩展连进来
// ---------------------------------------------------------------------------
let extSocket = null; // 当前扩展连接（同一时刻只保留最新一条）
const pending = new Map(); // reqId -> { resolve, reject, timer }
let reqSeq = 0;

const wss = new WebSocketServer({ host: "127.0.0.1", port: WS_PORT });

wss.on("listening", () => console.error(`[boss-mcp] WebSocket 监听 127.0.0.1:${WS_PORT}`));
wss.on("error", (e) => console.error("[boss-mcp] WebSocket 错误:", e.message));

wss.on("connection", (ws) => {
  console.error("[boss-mcp] 扩展已连接");
  extSocket = ws;

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }
    if (msg.type === "pong") return; // 心跳
    // 扩展推来的页面事件（新消息）→ 写信号文件，唤醒外部盯梢进程
    if (msg.type === "event") {
      try {
        fs.appendFileSync(SIGNAL_FILE, `${Date.now()} ${msg.event || "event"}\n`);
      } catch (e) {
        console.error("[boss-mcp] 写信号文件失败:", e.message);
      }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(msg.error || "扩展返回未知错误"));
  });

  ws.on("close", () => {
    console.error("[boss-mcp] 扩展断开");
    if (extSocket === ws) extSocket = null;
    // 连接断了：把还在等结果的请求立即失败，不必干等到 15s 超时。
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("扩展连接已断开，请确认 Chrome / 扩展 / Boss 页面正常后重试。"));
    }
    pending.clear();
  });
  ws.on("error", (e) => console.error("[boss-mcp] 扩展连接错误:", e.message));
});

// 心跳，保持 MV3 service worker 的 WebSocket 不被判空闲回收
setInterval(() => {
  if (extSocket && extSocket.readyState === 1) {
    try {
      extSocket.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }
}, 20000);

/** 向扩展下发一条命令并等待结果 */
function callExtension(cmd, args = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!extSocket || extSocket.readyState !== 1) {
      return reject(
        new Error(
          "浏览器扩展未连接。请确认：① Chrome 已打开；② 已在 chrome://extensions 加载本扩展；③ 打开了一个 Boss 直聘页面（zhipin.com）。"
        )
      );
    }
    const id = ++reqSeq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("扩展响应超时（15s）。可能页面未加载完或不是 Boss 直聘页面。"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extSocket.send(JSON.stringify({ id, cmd, args }));
  });
}

// ---------------------------------------------------------------------------
// MCP 工具定义
// ---------------------------------------------------------------------------
const TOOLS = [
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
      "点开聊天页左侧列表中的某个对话（模拟真实点击）。按 index（read_conversations 返回的序号）或 keyword（HR名/公司/职位关键词）定位。打开后可用 read_current_page 读取该对话详情。",
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
      "发送当前聊天输入框里的内容（模拟按 Enter）。发送的是输入框当前实际内容，先用 fill_reply 填好。⚠️ 真实发送给对方，不可撤回，需用户明确同意后再调用。",
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
      "点开推荐/搜索页列表中的某个职位卡片（模拟真实点击，详情出现在页面右侧/详情区）。推荐用 keyword（职位名或公司名）定位；index 是页面卡片顺序，可能与 read_jobs 顺序有偏差。打开后用 read_job_detail 读完整 JD。",
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
      "对当前打开的职位详情点「立即沟通」，真实发起打招呼（Boss 会发送默认招呼语）。若按钮是「继续沟通」说明已聊过，不会重复。⚠️ 真实对外动作，需用户明确同意后调用；频率过高有风控风险，建议一次会话内少量使用。",
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
      "【通用原语】按 CSS 选择器点击页面任意可见元素（带真实坐标的完整事件链）。配合 debug_dom 先看结构再点，任何 Boss 页面可用，无需专用工具。⚠️ 点击可能触发真实对外动作，谨慎使用。",
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
  { name: "boss-assistant", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// 拟人节奏：真实外发动作之间强制随机间隔，防止机器般的连续操作触发风控
const WRITE_CMDS = new Set(["send_reply", "chat_action", "greet"]);
const PACE_MIN_MS = 8000;
const PACE_JITTER_MS = 7000;
let lastWriteAt = 0;
async function paceWrite(cmd) {
  if (!WRITE_CMDS.has(cmd)) return;
  const gap = PACE_MIN_MS + Math.floor(Math.random() * PACE_JITTER_MS);
  const wait = lastWriteAt + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastWriteAt = Date.now();
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (!TOOL_NAMES.has(name)) throw new Error("未知工具: " + name);
    await paceWrite(name);
    // 工具名与扩展命令名一一对应，直接透传；导航类命令要等页面加载，超时放宽
    const timeout = name === "search_jobs" || name === "navigate" ? 30000 : 15000;
    const data = await callExtension(name, args || {}, timeout);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: "错误：" + e.message }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[boss-mcp] MCP server 已就绪（stdio）");
