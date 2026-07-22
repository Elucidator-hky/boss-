# Boss 直聘 AI 求职助手

用 **AI（Claude Code / Codex 等）+ 浏览器扩展 + MCP**，让 AI 帮你在 Boss 直聘上**读岗位、筛选、代聊、协助投递**——你只在「确认面试时间」这种关键节点出面。

> 本仓库是**通用工具 + 规则模板**。代码通用，规则（你的求职标准/口径）复制模板填自己的即可。

## 它是什么

```
   你 / AI（Claude Code 或 Codex）        ← 大脑：读 JD、判断、措辞
        ↕  MCP over stdio
   mcp-server/server.js                   ← 中转：把 AI 的指令转成浏览器操作
        ↕  WebSocket (127.0.0.1:8765)
   浏览器扩展（src/）                       ← 手：在你登录的真实 Chrome 里操作 Boss
        ↕  DOM
   Boss 直聘网页
   ＋ watch-messages.sh（可选）            ← 实时唤醒：HR 一发消息就叫醒 AI
```

**为什么这样最安全**：扩展跑在你平时登录的真实 Chrome 里，没有 webdriver 指纹、没有 CDP、用你的真实会话——Boss 的反自动化检测抓不到（Playwright/Selenium 会被直接屏蔽）。

## 快速开始（5 步）

### 1. 装 MCP server 依赖
```bash
cd mcp-server && npm install
```
（需要 Node 18+）

### 2. 加载浏览器扩展
1. Chrome 地址栏进 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选**本仓库根目录**
4. 扩展「BOSS 聊天助手」出现即成功

### 3. 配置 MCP（Claude Code / Codex）
见 **[docs/接入-ClaudeCode-和-Codex.md](docs/接入-ClaudeCode-和-Codex.md)**。本质就是让你的 agent 用 `node mcp-server/server.js` 起这个 MCP server。

### 4. 填你的配置（⭐ 灵魂，决定效果）
```bash
cp AGENTS.example.md AGENTS.md          # Codex 读这个；Claude Code 用 CLAUDE.md 同理
cp templates/求职标准.example.md templates/求职标准.md
cp templates/面试口径.example.md templates/面试口径.md
```
然后把里面所有 `<...>` 换成你自己的真实信息。**这一步不做，AI 只有手没有脑，跑不起来。**

### 5. 开用
1. Chrome 打开并登录 `https://www.zhipin.com/web/geek/chat`
2. 在 Claude Code / Codex 里让 AI「读一下我的 Boss 消息」，它就会按你的规则代聊了。

## 实时消息唤醒（可选）
```bash
zsh watch-messages.sh &     # 后台盯梢：HR 一发消息就唤醒 AI
```
原理见 [docs/架构与原理.md](docs/架构与原理.md)。不用也行——手动让 AI 定时扫消息即可。

## 目录结构
```
boss/
├── AGENTS.example.md          规则模板（复制成 AGENTS.md / CLAUDE.md 填）
├── templates/                 求职标准 / 面试口径 模板
├── manifest.json              扩展清单
├── src/                       浏览器扩展（content/background/options）
├── mcp-server/                MCP 服务器（server.js + package.json）
├── watch-messages.sh          盯梢脚本（实时唤醒，可选）
└── docs/                      接入说明 + 架构原理
```

## 注意事项
- **只开一个 Boss 标签页**：多个标签时命令发给你当前聚焦的那个。
- **真实发送 / 发简历 / 换微信不可撤回**：规则里默认这些可自动，介意就改成手动确认。
- **简历只写真实经历**：面试会深挖，编造必翻车。确保 Boss 上传的是你真实的最新简历再让 AI 发。
- **合规**：仅辅助你本人求职、模拟人工节奏操作；请遵守 Boss 直聘条款，别群发骚扰。

## 开源协议
[MIT](LICENSE)
