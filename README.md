# Boss 直聘 AI 求职助手

通过 **Codex / Claude Code + MCP + Chrome 扩展**，读取职位、按你的条件筛选、在你授权范围内投递和回复。

仓库包含工具、求职资料模板、投递和代聊流程。**装扩展只是其中一步**：AI 必须接通 MCP、加载规则、完成只读自检，才能开始任务。

## 安装与首次使用

需要 Node.js 18+、Chrome，以及支持本地 stdio MCP 的 AI 客户端。

1. 下载仓库，在 `mcp-server` 目录运行 `npm ci`。
2. Chrome 打开 `chrome://extensions/`，启用开发者模式，加载已解压的扩展，选择**本仓库根目录**。扩展设置里的模型 API Key 属于独立的旧版回复生成功能；使用 MCP 不需要填写。
3. 按 [接入说明](docs/接入-ClaudeCode-和-Codex.md) 配置 MCP，然后重启 AI 会话。
4. 复制 `AGENTS.example.md` 为 `AGENTS.md`（Claude Code 用 `CLAUDE.md`），复制 `templates/` 下两份 example 为同名无 `.example` 的文件，填写自己的真实资料、筛岗条件和授权范围。**在此仓库目录启动 AI**，让它读取规则与对应 skill。
5. 用正常登录的 Chrome 打开一个 Boss 标签页。先在 `mcp-server` 运行 `npm run doctor`，再让 AI 调用 `connection_status` 和 `read_current_page`，核对扩展连接、页面和账号。工具列表出现不等于浏览器已接通。

第一次给 AI 的指令可以是：

> 先读取 AGENTS.md、我的两份资料和 skills/boss-apply/SKILL.md。只用 boss-assistant MCP 操作 Boss。先调用 connection_status，再 read_current_page 做只读自检，把工具名和结果告诉我；自检成功后先筛选 3 个岗位供我核对，本轮不投递。连接失败或出现账号异常提示就停下，不切换其它浏览器工具。

确认筛选与账号正确后，再明确授权数量和动作，例如：

> 按我的条件投递最多 5 家，逐家核对 JD，发送后回读并记录；已聊过的不重复投。遇到 HR 回复按代聊 skill 和我的授权范围处理；面试时间按我给的可用时段协商，最终确认交给我。

## 多会话与更新

- 多个 AI 会话共享一个本地桥接进程。**同一时刻只有一个会话操作页面**；完成任务后调用 `release_control`，或关闭原会话，让另一会话接手。
- 写操作跨会话统一串行并间隔 8–15 秒，通用 `dom_click` 也计入。这个间隔只限制连续动作，**不代表平台认可或不会触发风控**。
- 更新：`git pull` → `mcp-server` 中 `npm ci` → Chrome 重载扩展并刷新 Boss 页面 → 重启 AI 会话 → 自检。旧版服务仍占端口时，按[排障步骤](docs/接入-ClaudeCode-和-Codex.md#连接排查)核对进程后处理。
- 扩展、MCP、规则三者都要更新；本人资料文件保留在本地，不会由仓库替你填写。

## 功能与边界

| 任务 | 入口 |
|---|---|
| 连接状态、交接控制权 | `connection_status`、`release_control` |
| 查岗、完整 JD、定向投递 | [投递 skill](skills/boss-apply/SKILL.md) |
| 读消息、回消息、发简历、面试安排 | [代聊 skill](skills/boss-reply/SKILL.md) |
| 页面改版后的结构检查 | `debug_dom`、`dom_click`、`dom_fill` |
| 可选新消息通知 | [架构与监听说明](docs/架构与原理.md) |

工具操作真实账号。合成 DOM 事件不等于真人操作，扩展不能保证免检测、免警告或免封禁。出现账号异常、访问限制、验证码时立即停止自动操作，保留提示，由本人按平台流程处理；不要持续重试或切换自动化通道。使用前自行评估并遵守平台规则，仅用于本人授权的求职。

## 验证

在 `mcp-server` 中运行 `npm test`。自动测试使用本地模拟扩展，覆盖多 MCP 客户端、页面控制权、断线、统一间隔、旧服务冲突；不向真实招聘方发送消息。真实网页兼容性需要另做只读自检，真实送达以聊天回读为准。

许可证见 [LICENSE](LICENSE)。
