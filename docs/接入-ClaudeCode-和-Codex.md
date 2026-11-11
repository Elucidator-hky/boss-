# 接入 Claude Code / Codex

## 先安装

在仓库的 `mcp-server` 中运行 `npm ci`。Chrome 加载仓库根目录作为扩展，打开一个已登录的 Boss 标签页。MCP 使用 AI 客户端本身的模型，扩展设置页的模型 Key 无需填写。

所有路径替换为本机绝对路径，包含空格时保留引号。Windows 的 JSON 路径用 `/` 或双反斜杠。

## Codex

在终端执行：

```sh
codex mcp add boss-assistant -- node "/absolute/path/boss/mcp-server/server.js"
codex mcp list
```

也可在 `~/.codex/config.toml` 或受信任项目的 `.codex/config.toml` 添加：

```toml
[mcp_servers.boss-assistant]
command = "node"
args = ["/absolute/path/boss/mcp-server/server.js"]
startup_timeout_sec = 15
tool_timeout_sec = 60
```

重启 AI 会话，复制规则模板为 `AGENTS.md`，在仓库目录启动任务。配置方式见 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## Claude Code

在任务目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "boss-assistant": {
      "command": "node",
      "args": ["/absolute/path/boss/mcp-server/server.js"]
    }
  }
}
```

重启会话，按客户端要求启用该 MCP。规则模板复制为 `CLAUDE.md`。`/mcp` 可核对连接；新增工具或改代码后重启会话，以确保加载当前版本。

## 首次验收

1. `mcp-server` 中执行 `npm run doctor`：检查桥接版本、扩展连接和控制权。这只查询状态，不操作页面。
2. 让 AI **实际调用** `connection_status`：`bridgeVersion` 和 `extensionVersion` 应为 `0.2.0`，`extensionConnected` 应为 `true`。
3. 调用 `read_current_page`，核对实际 URL、页面、对话，`bridgeScriptVersion` 应为 `0.2.0`；缺失时刷新页面。账号资料不足时由本人核对浏览器账号，不能凭聊天对象猜账号。
4. 确认 AI 使用的工具来自 `boss-assistant`，读取 `AGENTS.md` / `CLAUDE.md` 和对应 skill。先做少量只读筛岗，再在用户授权范围内投递。

## 连接排查

| 现象 | 处理 |
|---|---|
| AI 没有 Boss 工具 | 核对 MCP 配置、Node 路径和安装目录，重启会话；Chrome 装了扩展不代表 AI 加载了 MCP |
| `extensionConnected: false` | 加载或重载扩展，打开 Boss 并刷新页面，等待几秒再自检 |
| `Receiving end does not exist` | 刷新 Boss 标签页，让页面脚本重新注入 |
| `other_session` / 另一会话正在操作 | 原任务完成后调用 `release_control`，或关闭原会话；当前会话等待交接 |
| 本地桥接版本不匹配 / 旧端口占用 | 核对监听 8765 的 PID 和启动命令，确认对应任务已结束后关闭那个旧会话/进程，再重启新会话；不批量杀 Node |
| 工具超时、连接断开 | 当前动作可能已执行；恢复后先读聊天、按钮状态和记录再决定下一步，外发动作不自动重试 |
| 发出指令但聊天没消息 | 读聊天历史与输入框，按代聊 skill 有限补救；工具的 `attempted` 只代表触发动作 |
| 账号异常、验证码、平台限制 | 立即停止自动操作，由本人核对并按平台提示处理，保存具体警告和调用日志 |

macOS/Linux 可用 `lsof -nP -iTCP:8765 -sTCP:LISTEN` 查监听者，再用 `ps -p <PID> -o pid,command` 核对。Windows PowerShell 可用 `Get-NetTCPConnection -LocalPort 8765 -State Listen`，再以 `Get-CimInstance Win32_Process -Filter "ProcessId=<PID>"` 查命令行。旧会话仍在工作时保留它，安排完成后更新。

## 多会话与配置

每个 AI 客户端启动自己的 stdio MCP 适配器，适配器共用一个本地 WebSocket 桥接进程。桥接自动启动；最后一个客户端断开 60 秒后退出。浏览器控制权按完整工作流持有，防止另一任务在填入与发送之间切换页面。

默认端口 `8765`。`BOSS_WS_PORT` 只配置服务端；自定义端口还须同步修改 `src/background/sw.js` 中的 `WS_URL` 并重载扩展。日常保持默认即可。

信号文件由桥接唯一写入，默认仓库根 `.new-message-signal`，`BOSS_SIGNAL_FILE` 可指定绝对路径。多个客户端共用桥接时，以 `connection_status.signalFile` 返回的实际路径为准。重启不会清空已有信号。
