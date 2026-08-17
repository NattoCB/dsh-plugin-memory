# @deepseek-ai/dsh-plugin-memory

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）设计的**持久化五层记忆系统**插件，实现一套五层记忆设计。

## 它能做什么

| 层级 | 位置 | 作用 |
|---|---|---|
| **L0** 长期身份 | `~/.dsh/AGENTS.md`（既有） | 长期身份与规则 —— 由用户维护，本插件不接管。 |
| **L1** 用户画像 | `~/.dsh/memory/profile.md` | 四个固定小节（工作背景 / 个人背景 / 当前关注 / 近期动态），带 Version-N 轮替与 `.bak` 备份。 |
| **L2** 项目语义 | `<cwd>/.dsh/memory/MEMORY.md` + 主题文件 | 索引 + 主题文件分离；会话开始时注入。 |
| **L3** 每日记忆 | `<cwd>/.dsh/memory/YYYY-MM-DD.md` | 按日期一个文件，逐行追加，永不合并。 |
| **L4** 方法论资产 | skills（既有） | 不在本插件范围内；DSH 已有 skills 机制。 |

按规格优先级实现的六个机制：

1. **索引 + 主题文件分离（L2）。** `MEMORY.md` 永远是指针表，每行 ≤150 字符；详细内容落在 `<topic>.md`。控制单文件膨胀、可检索、可截断。
2. **截断预算。** 启动注入的索引硬截断为 200 行 / 40 000 字符，保证冷启动上下文开销很低。
3. **相关性注入。** 每一步根据最新用户 query 选取相关主题文件（配置了 `llm` 时走 LLM 排序，否则走关键词兜底），以 `<system-reminder data-role="memory">` 块追加。同一会话内已注入的文件会去重。
4. **自动提取。** 会话进入空闲时，经防抖、尽力而为地调用 LLM 读取最近若干条消息，写出新的主题文件与索引行。绝不覆盖既有记忆；模型不可用时静默降级。
5. **画像轮替（L1）。** `memory_profile` 把新事实合并进四个小节并递增版本号，旧版存 `.bak`。
6. **Agent 工具。** 六个可由模型调用的工具，让 agent 直接保存、召回、检索、遗忘记忆。

## 架构

插件注册在两条 cordis 接口上，与官方插件（`dsh-time-context`、`dsh-tool-todo`）一致：

- **`agents`** —— 一个 `agent/pre-step` 监听器（前置注册，与 `dsh-time-context` 相同），以插件来源的 `user` 消息把入口指令与相关记忆注入请求历史。
- **`tools`** —— 通过 `@deepseek-ai/dsh-tools` 的 `defineTool` 注册六个工具。

记忆写入使用 Node 的 `fs/promises` **直接**写入记忆根目录，不走 agent 沙箱 —— 因为记忆目录是"预期中的持久化"（intended persistence），而非自我修改。同时保留 `Instruction Poisoning` 边界：记忆文件是 agent 读回的数据，绝不是授权指令。

```
src/
  paths.js    解析 DSH_HOME / 全局 / 项目记忆根目录
  store.js    MemoryStore、DailyMemory（L3）、ProfileMemory（L1 轮替）
  inject.js   入口指令、相关性提醒、关键词打分、截断
  llm.js      基于 harness `llm` 服务的单次补全（静默降级）
  index.js    插件入口：pre-step 注入、工具、空闲自动提取
```

## 配置

通过 DSH 插件条目部署（见 `package.json` 的 `exports`）：

```yaml
- id: memory
  name: '@deepseek-ai/dsh-plugin-memory'
  config:
    enableEntryInjection: true     # 每次会话前置注入"如何保存 + 索引"指令块
    enableRelevance: true          # 每步按 query 追加相关主题文件（data-role=memory）
    enableExtraction: true         # 空闲时 LLM 自动提取
    maxRelevant: 5                 # 每步最多命中的文件数
    relevanceTopK: 8               # LLM 选择器最多从多少个候选里挑选
    relevanceBudgetChars: 2000     # 喂给相关性/选择器的单主题字符上限
    extractionDebounceMs: 60000    # 空闲防抖时长后再执行一次提取
    extractionLookback: 40         # 单次提取扫描的最近事件数
    llm:                           # 可选；不填 provider/model 则只用关键词相关性且无自动提取
      provider: deepseek
      model: deepseek-chat
      maxTokens: 1024
```

未配置 `llm` 路由时，插件依然提供索引 + 主题、入口注入、关键词相关性、agent 工具与画像轮替 —— 仅 LLM 自动提取与 LLM 相关性排序被关闭。

## agent 可调用工具

| 工具 | 范围 | 效果 |
|---|---|---|
| `memory_write` | global/project | 写入/覆盖主题文件；可选追加一条索引。 |
| `memory_read` | global/project | 读取主题文件或 `MEMORY` 索引。 |
| `memory_search` | global/project/both | 关键词检索主题文件。 |
| `memory_daily` | cwd | 向 `<cwd>/.dsh/memory/YYYY-MM-DD.md` 追加一行当日记录。 |
| `memory_forget` | global/project | 删除主题文件及其索引指针。 |
| `memory_profile` | global | 读取或合并轮替单一用户画像。 |

## 数据布局（首次使用时创建）

```
~/.dsh/memory/
  MEMORY.md        # 全局索引（≤200 行 / 40K 字符）
  profile.md       # L1 画像（Version N）
  profile.md.bak   # 上一版本
  <topic>.md       # 主题文件
<cwd>/.dsh/memory/
  MEMORY.md        # 项目索引
  YYYY-MM-DD.md    # 每日记忆
  <topic>.md       # 项目主题文件
```

## 与参考规格的差异

- **无 `<uid>` 层。** DSH 只有一个用户；画像即 `~/.dsh/memory/profile.md`，而非 `<uid>_memory.md`。
- **无 HTTP API / GUI 面板。** 本插件是纯 harness 插件；GUI 集成由宿主负责。
- **提取为防抖 + LLM 驱动**，而非独立子 agent 进程。原设计的两轮 `NO_EXTRACTION_NEEDED` 子 agent 精神（尽力而为、静默降级）被保留，但改为空闲时内联执行，避免嵌套启动子 agent。
- **相关性在有 `llm` 服务时走 harness `llm`**，否则降级为确定性关键词打分。

## 许可证

MIT。
