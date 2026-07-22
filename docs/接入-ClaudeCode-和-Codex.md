# 接入 Claude Code / Codex（及其他 MCP agent）

`mcp-server/server.js` 是**标准 stdio MCP server**（用官方 `@modelcontextprotocol/sdk`），
所以**任何支持 MCP 的 agent 都能连**。下面给两个最常见的，其它（Cursor / Cline 等）同理。

> 把下文的 `<仓库路径>` 换成你 clone 下来的绝对路径，例如 `/Users/you/boss`。

---

## 一、Claude Code

### 方式 A：项目级 `.mcp.json`（推荐）
在你运行 Claude Code 的目录（或其父目录）建 `.mcp.json`：
```json
{
  "mcpServers": {
    "boss-assistant": {
      "command": "node",
      "args": ["<仓库路径>/mcp-server/server.js"]
    }
  }
}
```

### 方式 B：命令行添加
```bash
claude mcp add boss-assistant -- node <仓库路径>/mcp-server/server.js
```

### 生效
- 重启 Claude Code 会话，或在会话里 `/mcp` → 选 `boss-assistant` → reconnect。
- 规则文件：Claude Code 读 **`CLAUDE.md`**——把 `AGENTS.md` 内容复制一份成 `CLAUDE.md` 即可。

---

## 二、Codex（OpenAI）

Codex CLI 在 `~/.codex/config.toml` 里配 MCP server：
```toml
[mcp_servers.boss-assistant]
command = "node"
args = ["<仓库路径>/mcp-server/server.js"]
```
> 具体字段名以你安装的 Codex 版本的官方文档为准（MCP 配置各版本略有差异），但本质都是「用 stdio 启动 `node server.js`」。

### 规则文件
Codex 读 **`AGENTS.md`**——本仓库的 `AGENTS.example.md` 就是照这个约定写的，复制填好放项目根即可。

---

## 三、连接自检
1. **MCP 是否连上**：Claude Code `/mcp` 看 `boss-assistant` 状态；Codex 看它的 MCP 列表。
2. **扩展是否连上**：`chrome://extensions` →「BOSS 聊天助手」→「Service Worker」控制台，看到已连接 MCP server 的日志。
3. **报「Receiving end does not exist」**：刷新 Boss 页面，让 `bridge.js` 重新注入。
4. **报「扩展未连接」**：确认 Chrome 开着、扩展已加载、开了一个 zhipin.com 页面。

---

## 四、改代码后怎么生效（常踩坑）
| 改了什么 | 生效方式 |
|---|---|
| `src/`（bridge.js / inject.js / sw.js） | `chrome://extensions` 重载扩展 **+ 刷新 Boss 页面** |
| `mcp-server/server.js` | 重启 agent 会话，或 `/mcp` reconnect（server 进程是会话启动时拉起的） |
| **新增 MCP 工具** | 光 reconnect 可能不够，重启 agent 会话最稳 |
| `watch-messages.sh` | 杀掉旧进程重新 `zsh watch-messages.sh &` |

---

## 五、可选：自定义端口 / 信号文件路径
- WebSocket 端口默认 `8765`，改：环境变量 `BOSS_WS_PORT`。
- 盯梢信号文件默认在仓库根 `.new-message-signal`，改：环境变量 `BOSS_SIGNAL_FILE`（server.js 和 watch-messages.sh 都读它，要设成同一个值）。
