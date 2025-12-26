# BOSS直聘浏览器助手功能文档

## 概述

Chrome/Edge 浏览器扩展，帮助求职者在 BOSS 直聘聊天页面：
1. **自动回复**：HR 提问时自动生成精准回复，减少重复回答
2. **智能打招呼**：根据职位 JD 和个人信息生成个性化开场白，提高回复率

## 技术架构

- **浏览器扩展**：Chrome/Edge Manifest V3
- **模块划分**：
  - `inject.js`：注入页面上下文，拦截 XHR 获取职位信息
  - `index.js`：Content Script，监听聊天消息，管理 UI 悬浮菜单
  - `sw.js`：Background Service Worker，调用 LLM API
- **本地存储**：`chrome.storage.local`

## 文件结构

```
src/
├── background/
│   └── sw.js              # Service Worker，处理 LLM 调用
├── content/
│   ├── index.js           # Content Script，监听聊天页面 + UI
│   └── inject.js          # 页面注入脚本，拦截 XHR
├── options/
│   ├── index.html         # 配置页面（备用）
│   └── index.js           # 配置页面逻辑
└── popup/
    └── index.html         # 弹出页面（备用）
manifest.json              # 扩展配置
```

---

## 功能1：自动回复

### 功能说明

HR 提问具体问题（城市、经验、学历、薪资等）时，根据预设的个人信息自动生成精准回复到输入框。

### 触发条件

- 检测到新 HR 消息
- HR 消息包含可识别的问题
- 个人信息中有对应字段
- 自动回复开关已开启
- 输入框为空且用户未手动输入

### 工作流程

```
1. 用户打开聊天页面
2. Content Script 监听 ul.im-list 变化
3. 检测到新 HR 消息（通过 data-mid 判断）
4. 收集最近 20 条消息
5. 发送给 Background Service Worker
6. 调用 LLM 判断能否回答
7. can_answer=true 且输入框为空 → 填充回复
8. can_answer=false → 不处理
```

### 可回答的问题类型（白名单）

| 字段 | 问题类型 |
|------|----------|
| 城市 | 问我在哪/坐标/哪个城市 |
| 状态 | 问我在职还是离职 |
| 工作年限 | 问我几年经验 |
| 学历 | 问我什么学历/学校 |
| 方向 | 问我做什么方向 |
| 技术栈 | 问我会什么技术 |
| 上一份薪资 | 问我薪资（必须个人信息里有） |
| 到岗时间 | 问我多久能入职（必须个人信息里有） |
| 离职原因 | 问我为什么离职（必须个人信息里有） |
| 项目经验 | 问我做过什么项目 |

### 禁止回答的问题类型

- 是否接受/介意类：是否接受地点、是否介意外包
- 意见态度类：你怎么看、你关注什么
- 选择决策类：你优先考虑什么
- 个人信息里没有的字段

### Prompt 结构

**System Prompt**：包含个人信息、问题类型白名单、硬性约束、判断流程、反面示例

**User Prompt**：对话记录（格式：`HR：[消息]`、`我：[消息]`）

**输出格式**：`{"can_answer": true/false, "reply": "..."}`

---

## 功能2：智能打招呼

### 功能说明

根据职位 JD 具体要求 + 个人真实经历，生成个性化打招呼语，提高 HR 回复率。

### 触发条件

用户点击悬浮菜单的「生成打招呼语」按钮

### 工作流程

```
1. 用户点击「生成打招呼语」
2. 检查 API 是否已配置
3. 获取当前职位数据（encryptJobId、securityId）
4. 如果没有完整 JD，后台打开职位详情页提取
5. 调用 LLM 生成打招呼语
6. 填充到输入框
```

### JD 信息获取

**数据来源**：
1. `inject.js` 拦截 `getBossData` API 获取职位基本信息
2. `inject.js` 拦截 `historyMsg` API 获取职位描述（可能截断）
3. 后台打开职位详情页获取完整描述（`.job-sec-text`）

**职位数据字段**：

| 字段 | 说明 |
|------|------|
| jobName | 职位名称 |
| salary | 薪资 |
| city | 城市 |
| company | 公司名称 |
| hrName | HR 姓名 |
| hrTitle | HR 职位 |
| description | 职位描述 |

### 称呼规则

1. 职位是尊称（经理/主管/总监/总/负责人）→「姓+职位」如「王经理」
2. 职位不是尊称但能判断性别 →「姓+先生/女士」如「王女士」
3. 无法判断 → 直接「您好」开头

### 打招呼语格式

固定两行：
- 第一行：问候 + 提及 JD 中 1-2 个具体要求 + 表达兴趣
- 第二行：我如何满足这些要求（技术/经验/项目，用数据说话）

### 示例

```
王经理您好，看到贵司招 Java 开发，要求熟悉微服务和高并发，很感兴趣。
我有 3 年 Java 经验，做过日均百万订单系统，熟悉 Spring Cloud 和 Redis。
```

---

## UI 悬浮菜单

### 入口

页面右下角的悬浮按钮（🤖），点击展开菜单

### 菜单项

| 菜单项 | 功能 |
|--------|------|
| 📚 使用教程 | 显示功能说明弹窗 |
| ⚙️ 配置API | 配置 LLM API（Base URL、Key、Model） |
| 👤 个人信息 | 配置个人信息（用于自动回复和打招呼） |
| 🔄 自动生成回复 | 开关，控制是否自动回复 |
| 💬 生成打招呼语 | 手动触发生成打招呼语 |

---

## 配置说明

### API 配置

| 字段 | 说明 | 示例 |
|------|------|------|
| API Base | OpenAI 兼容接口地址 | `https://api.deepseek.com/v1` |
| API Key | 接口密钥 | `sk-xxx` |
| Model | 模型名称 | `deepseek-chat`、`qwen-plus` |

**推荐模型**：deepseek-chat、qwen-plus、qwen-max

**测试连接**：配置后可点击「测试连接」验证配置是否正确

### 个人信息字段

| 字段 | 说明 | 必填 |
|------|------|------|
| 当前城市 | 如「北京」 | 推荐 |
| 离职状态 | 如「已离职」 | 推荐 |
| 工作年限 | 如「3年」 | 推荐 |
| 学历 | 如「本科」 | 推荐 |
| 求职方向 | 如「Java后端」 | 推荐 |
| 技术栈 | 如「Java, Spring」 | 推荐 |
| 上一份薪资 | 如「25k×16」 | 可选 |
| 到岗时间 | 如「随时」 | 可选 |
| 离职原因 | 如「项目收尾」 | 可选 |
| 职业技能 | 详细技能描述 | 推荐 |
| 项目经验 | 项目描述 | 推荐 |
| 自定义字段 | 可添加多个自定义字段 | 可选 |

---

## 存储结构

### settings（API 配置）

```javascript
{
  api_base: "https://api.deepseek.com/v1",
  api_key: "sk-xxx",
  model: "deepseek-chat"
}
```

### profile_static（个人信息）

```javascript
{
  schema_version: 1,
  city: "武汉",
  status: "已离职",
  years: "3年",
  degree: "本科",
  direction: "Java后端",
  tech_stack: "Java, Spring Boot",
  salary_prev: "15k×14",
  leave_time: "随时",
  leave_reason: "项目收尾",
  skills: "熟悉 Java...",
  projects: "订单系统...",
  extras: {
    "政治面貌": "共产党员"
  }
}
```

### auto_reply_enabled（自动回复开关）

```javascript
true / false  // 默认 true
```

---

## 消息通信

### Content Script → Background

| type | 说明 |
|------|------|
| `LLM_CHAT` | 自动回复，传递对话记录 |
| `GENERATE_GREETING` | 生成打招呼语，传递职位信息 |
| `FETCH_JOB_DETAIL` | 获取完整职位描述 |
| `TEST_API_CONNECTION` | 测试 API 连接 |

### inject.js → Content Script（window.postMessage）

| type | 说明 |
|------|------|
| `BOSS_JOB_INFO` | historyMsg 返回的职位信息 |
| `BOSS_JOB_DATA` | getBossData 返回的职位数据 |

---

## 注意事项

1. **API 配置必填**：使用前必须配置 API，否则功能不可用
2. **个人信息完整性**：信息越完整，自动回复和打招呼效果越好
3. **自动填充条件**：只有输入框为空且用户未手动输入时才会自动填充
4. **回复需确认**：生成的回复填充到输入框后，用户需检查确认后再发送
5. **禁止编造**：LLM 被严格约束只能使用个人信息中存在的内容回答
