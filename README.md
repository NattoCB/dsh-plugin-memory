# @deepseek-ai/dsh-plugin-memory

English | [中文](README.zh.md)

A persistent **5-layer memory system** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), implementing a five-layer memory design.

## What it does

| Layer | Where | Purpose |
|---|---|---|
| **L0** Global identity | `~/.dsh/AGENTS.md` (existing) | Long-term identity & rules — owned by the user, not this plugin. |
| **L1** User profile | `~/.dsh/memory/profile.md` | Four fixed sections (工作背景 / 个人背景 / 当前关注 / 近期动态), Version-N rotation with `.bak`. |
| **L2** Project semantic | `<cwd>/.dsh/memory/MEMORY.md` + topic files | Index + topic-file split; injected at session start. |
| **L3** Daily memory | `<cwd>/.dsh/memory/YYYY-MM-DD.md` | One dated file, appended line-by-line, never merged. |
| **L4** Method assets | skills (existing) | Out of scope; skills already live in DSH. |

Six mechanisms, in priority order from the spec:

1. **Index + topic split (L2).** `MEMORY.md` is always an index of one-line pointers (≤150 chars each); detailed notes live in `<topic>.md`. Controls single-file bloat, stays searchable and truncatable.
2. **Truncation budget.** The booted index is hard-clamped to 200 lines / 40 000 chars, so cold-start context stays cheap.
3. **Relevance injection.** On each step, the latest user query selects relevant topic files (LLM ranking when `llm` is configured, keyword fallback otherwise) and appends them as a `<system-reminder data-role="memory">` block. Within a session, already-surfaced files are de-duplicated.
4. **Auto-extraction.** When a session goes idle, a debounced, best-effort pass sends the recent transcript to the LLM and writes new topic files + index lines. It never overwrites existing memories and degrades silently if the model is unavailable.
5. **Profile rotation (L1).** `memory_profile` merges new facts into the four sections and rotates the version, keeping `.bak`.
6. **Agent tools.** Six model-callable tools let the agent save, recall, search, and forget memories directly.

## Architecture

The plugin registers on two cordis seams, mirroring first-party plugins (`dsh-time-context`, `dsh-tool-todo`):

- **`agents`** — an `agent/pre-step` listener (prepended, like `dsh-time-context`) that injects the entry instruction and relevant memories into the request history as plugin-sourced `user` messages.
- **`tools`** — six tools registered via `defineTool` from `@deepseek-ai/dsh-tools`.

Memory is written with Node's `fs/promises` directly to the memory roots — **not** through the agent sandbox — because the memory directory is intended persistence, not self-modification. The `Instruction Poisoning` boundary still applies: memory files are data the agent reads back, never permission grants.

```
src/
  paths.js    DSH_HOME / global / project memory root resolution
  store.js    MemoryStore, DailyMemory (L3), ProfileMemory (L1 rotation)
  inject.js   entry instruction, relevance reminder, keyword scoring, truncation
  llm.js      one-shot completion over the harness `llm` service (silent fallback)
  index.js    plugin entry: pre-step injection, tools, idle auto-extraction
```

## Configuration

Deploy via a DSH plugin entry (see `package.json` `exports`):

```yaml
- id: memory
  name: '@deepseek-ai/dsh-plugin-memory'
  config:
    enableEntryInjection: true     # prepend the how-to-save + index block each session
    enableRelevance: true          # append relevant topic files per step (data-role=memory)
    enableExtraction: true         # idle-time LLM auto-extraction
    maxRelevant: 5                 # max files surfaced per step
    relevanceTopK: 8               # max candidates the LLM selector may pick from
    relevanceBudgetChars: 2000     # per-topic char cap fed to relevance/selector
    extractionDebounceMs: 60000    # idle debounce before a pass runs
    extractionLookback: 40         # recent events scanned for a pass
    llm:                           # optional; omit provider/model to use keyword-only relevance + no extraction
      provider: deepseek
      model: deepseek-chat
      maxTokens: 1024
```

Without an `llm` route, the plugin still provides index+topics, entry injection, keyword relevance, the agent tools, and profile rotation — only LLM-based extraction and LLM relevance ranking are disabled.

## Tools the agent can call

| Tool | Scope | Effect |
|---|---|---|
| `memory_write` | global/project | Write/overwrite a topic file; optionally add an index line. |
| `memory_read` | global/project | Read a topic file or `MEMORY` index. |
| `memory_search` | global/project/both | Keyword search topic files. |
| `memory_daily` | cwd | Append a dated line to `<cwd>/.dsh/memory/YYYY-MM-DD.md`. |
| `memory_forget` | global/project | Delete a topic file and its index pointer. |
| `memory_profile` | global | Read or merge-and-rotate the single-user profile. |

## Data layout (created on first use)

```
~/.dsh/memory/
  MEMORY.md        # global index (≤200 lines / 40K chars)
  profile.md       # L1 profile (Version N)
  profile.md.bak   # previous version
  <topic>.md       # topic files
<cwd>/.dsh/memory/
  MEMORY.md        # project index
  YYYY-MM-DD.md    # daily memory
  <topic>.md       # project topic files
```

## Differences from the reference spec

- **No `<uid>` layer.** DSH has one user; the profile is `~/.dsh/memory/profile.md`, not `<uid>_memory.md`.
- **No HTTP API / GUI panel.** This is a pure harness plugin; GUI integration is the host's concern.
- **Extraction is debounced + LLM-driven**, not a separate subagent process. The original two-turn `NO_EXTRACTION_NEEDED` subagent design is preserved in spirit (best-effort, silent degradation) but runs inline on idle to avoid spawning nested agents.
- **Relevance uses the harness `llm` service** when available, degrading to deterministic keyword scoring otherwise.

## License

MIT.
