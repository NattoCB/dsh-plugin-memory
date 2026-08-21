# @deepseek-ai/dsh-plugin-memory

[English](README.md) | 中文

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">为 DeepSeek Harness 打造的持久五层记忆：画像、项目上下文、每日日志、可召回主题——让 agent 记住的是「你」，而不只是「这一次会话」。</b><br /><br />
  <a href="https://github.com/NattoCB/dsh-plugin-memory/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <img alt="DeepSeek Harness Plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-Plugin-4d6bfe" /><br /><br />
  <img alt="相关性注入" src="https://img.shields.io/badge/-相关性注入-4d6bfe" />
  <img alt="LLM 自动提取" src="https://img.shields.io/badge/-LLM%20自动提取-4d6bfe" />
  <img alt="画像轮替" src="https://img.shields.io/badge/-画像轮替-4d6bfe" />
  <img alt="截断预算" src="https://img.shields.io/badge/-截断预算-4d6bfe" />
  <img alt="Agent 工具" src="https://img.shields.io/badge/-6%20个%20Agent%20工具-4d6bfe" /><br /><br />
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH 插件" /></a><br /><br />
  <b>两条 cordis 接入面</b> —— <code>agent/pre-step</code> 注入 + <code>ctx.tools.register</code>（六个工具）
</div>

> 一个为 DeepSeek Harness（DSH）打造的持久五层记忆系统：用户画像（L1）、项目级语义索引与主题文件（L2）、按天追加的日志（L3），分别落在 `~/.dsh/memory/` 与 `<cwd>/.dsh/memory/`。每个请求前自动注入相关记忆，会话空闲时由 LLM 自动把沉淀的事实写成新主题文件。以 DSH 插件形式接入两条 cordis 接口——`agent/pre-step` 负责注入，`ctx.tools.register` 注册六个 `memory_*` 工具。不配置 `llm` 也能用：入口注入、关键词相关性、画像轮替照常工作，仅 LLM 排序与自动提取被关闭。

## ✨ 功能一览

- 🧠 **五层模型**：L0 用户自有身份（`~/.dsh/AGENTS.md`，本插件不接管）→ L1 画像 → L2 项目索引 + 主题文件 → L3 按天追加日志 → L4 skills（既有）。每层都有独立的写入路径、截断预算与注入规则。
- 📇 **索引 + 主题文件分离（L2）**：`MEMORY.md` 永远是指针表，每行 ≤150 字符；详细内容落在 `<topic>.md`。单文件保持小巧、可检索、可截断。
- ✂️ **截断预算**：启动注入的索引硬截断为 200 行 / 40 000 字符，保证冷启动上下文开销很低。
- 🎯 **相关性注入**：每一步根据最新用户 query 选取相关主题文件（配置了 `llm` 时走 LLM 排序，否则走关键词打分），以 `<system-reminder data-role="memory">` 块追加；同一会话内已注入的文件会去重。两个通道在 GUI 上下文行中分别标注为 `memory-entry`（每会话一次）与 `memory-relevance`（按需注入）。
- 🤖 **LLM 自动提取**：会话进入空闲时，经防抖（60 s）、尽力而为地扫描最近 40 条事件，让 LLM 产出新主题文件与索引行并写入。绝不覆盖既有记忆；模型不可用时静默降级。
- 🔄 **画像轮替（L1）**：`memory_profile` 把新事实合并进四个固定小节（工作背景 / 个人背景 / 当前关注 / 近期动态）并递增版本号，旧版保留在 `profile.md.bak`。
- 🔒 **读回的是数据，不是指令**：记忆用 `fs/promises` 直接写入记忆根目录——预期中的持久化，而非自我修改——且路径被约束在存储根内。记忆文件是 agent 读回的上下文，绝不是授权指令。
- 🧩 **纯 harness 插件**：无 HTTP API / GUI 面板——只有注入与工具。DSH 服务于单一用户，路径不含 `<uid>` 层。
- 🛠️ **六个 agent 工具**，通过 `ctx.tools.register`（`@deepseek-ai/dsh-tools` 的 `defineTool`）注册：

| 工具 | 范围 | 效果 |
|:-----|:-----|:-----|
| `memory_write` | global/project | 写入/覆盖主题文件；可选追加一条索引。 |
| `memory_read` | global/project | 读取主题文件或 `MEMORY` 索引。 |
| `memory_search` | global/project/both | 关键词检索主题文件。 |
| `memory_daily` | cwd | 向 `<cwd>/.dsh/memory/YYYY-MM-DD.md` 追加一行当日记录。 |
| `memory_forget` | global/project | 删除主题文件及其索引指针。 |
| `memory_profile` | global | 读取，或合并轮替单一用户画像。 |

## 快速开始

### 前置要求

- 已安装 DeepSeek Harness（DSH），且 profile 支持插件（如 `web`）。
- 无需配置 `llm`——插件会降级为纯关键词相关性。

### 安装

```bash
dsh plugin --profile web add github:NattoCB/dsh-plugin-memory
```

### 运行

重启 `dsh web`。插件在首次使用时自动初始化两个记忆根目录：

```
~/.dsh/memory/
  MEMORY.md        # 全局索引（≤200 行 / 40K 字符）
  profile.md       # L1 画像（Version N）
  profile.md.bak   # 上一版本画像
  <topic>.md       # 全局主题文件
<cwd>/.dsh/memory/
  MEMORY.md        # 项目索引
  YYYY-MM-DD.md    # 每日记忆（只追加）
  <topic>.md       # 项目主题文件
```

告诉 agent 一句值得记住的话，或交给空闲自动提取——隔一个会话再查记忆根目录。

## 配置

通过 DSH bundle 条目部署（见 `cordis.patch.yml` 与 `package.json` 的 `exports`）：

| 键 | 默认值 | 含义 |
|:---|:-------|:-----|
| `enableEntryInjection` | `true` | 每会话前置注入一次「如何保存 + 索引」指令块。 |
| `enableRelevance` | `true` | 每步按 query 追加相关主题文件（`data-role=memory`）。 |
| `enableExtraction` | `true` | 空闲时 LLM 自动提取。 |
| `maxRelevant` | `5` | 每步最多注入的文件数（1–20）。 |
| `relevanceTopK` | `8` | LLM 选择器最多从多少个候选里挑选（1–40）。 |
| `relevanceBudgetChars` | `2000` | 喂给相关性/选择器的单主题字符上限（≥200）。 |
| `extractionDebounceMs` | `60000` | 空闲防抖时长后再执行一次提取。 |
| `extractionLookback` | `40` | 单次提取扫描的最近事件数（5–200）。 |
| `llm.provider` | `""` | 提取/相关性排序的 provider（留空 → 纯关键词）。 |
| `llm.model` | `""` | 提取/相关性排序的 model。 |
| `llm.maxTokens` | `1024` | LLM 调用的补全 token 上限。 |

示例条目：

```yaml
- id: memory
  name: '@deepseek-ai/dsh-plugin-memory'
  config:
    enableEntryInjection: true
    enableRelevance: true
    enableExtraction: true
    maxRelevant: 5
    relevanceTopK: 8
    relevanceBudgetChars: 2000
    extractionDebounceMs: 60000
    extractionLookback: 40
    llm:
      provider: deepseek   # 示例：填你的路由
      model: deepseek-chat
      maxTokens: 1024
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

---

<div align="center">

[提 issue](https://github.com/NattoCB/dsh-plugin-memory/issues) · [源码](https://github.com/NattoCB/dsh-plugin-memory)

</div>
