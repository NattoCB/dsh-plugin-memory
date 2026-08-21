# @deepseek-ai/dsh-plugin-memory

English | [中文](README.zh.md)

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">Persistent five-layer memory for DeepSeek Harness: profile, project context, daily log, and recallable topics — so the agent remembers you across sessions, not just within one.</b><br /><br />
  <a href="https://github.com/NattoCB/dsh-plugin-memory/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <img alt="DeepSeek Harness Plugin" src="https://img.shields.io/badge/DeepSeek%20Harness-Plugin-4d6bfe" /><br /><br />
  <img alt="Relevance Injection" src="https://img.shields.io/badge/-Relevance%20Injection-4d6bfe" />
  <img alt="LLM Auto-Extraction" src="https://img.shields.io/badge/-LLM%20Auto-Extraction-4d6bfe" />
  <img alt="Profile Rotation" src="https://img.shields.io/badge/-Profile%20Rotation-4d6bfe" />
  <img alt="Truncation Budget" src="https://img.shields.io/badge/-Truncation%20Budget-4d6bfe" />
  <img alt="Agent Tools" src="https://img.shields.io/badge/-6%20Agent%20Tools-4d6bfe" /><br /><br />
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH 插件" /></a><br /><br />
  <b>Two cordis seams</b> — <code>agent/pre-step</code> injection + <code>ctx.tools.register</code> (six tools)
</div>

> A persistent five-layer memory system for DeepSeek Harness (DSH): a user profile (L1), a per-project semantic index with topic files (L2), and append-only per-day logs (L3) under `~/.dsh/memory/` and `<cwd>/.dsh/memory/`. It injects relevant memories into every request and auto-extracts durable facts from finished sessions via the LLM. Integrates as a DSH plugin on two cordis seams — `agent/pre-step` for injection, `ctx.tools.register` for six `memory_*` agent tools. Without an `llm` route it still works: entry injection, keyword relevance, and profile rotation remain; only LLM ranking and auto-extraction are disabled.

## ✨ Features

- 🧠 **Five-layer model**: L0 user-owned identity (`~/.dsh/AGENTS.md`, not managed by the plugin) → L1 profile → L2 project index + topics → L3 per-day append-only log → L4 skills (existing). Each layer has its own write path, truncation budget, and injection rule.
- 📇 **Index + topic split (L2)**: `MEMORY.md` is always an index of one-line pointers (≤150 chars each); details live in `<topic>.md`. Keeps single files small, searchable, and truncatable.
- ✂️ **Truncation budget**: the booted index is hard-clamped to 200 lines / 40,000 chars, so cold-start context stays cheap.
- 🎯 **Relevance injection**: on each step, the latest user query selects relevant topic files (LLM ranking when `llm` is configured, keyword scoring otherwise) and appends them as a `<system-reminder data-role="memory">` block; files already surfaced in this session are de-duplicated. The two channels are labeled `memory-entry` (once per session) and `memory-relevance` (per step) in the GUI context rows.
- 🤖 **LLM auto-extraction**: when a session goes idle, a debounced (60 s) best-effort pass scans the recent 40 events, asks the LLM for new topic files and index lines, and writes them. Never overwrites existing memories; degrades silently if the model is unavailable.
- 🔄 **Profile rotation (L1)**: `memory_profile` merges new facts into four fixed sections (工作背景 / 个人背景 / 当前关注 / 近期动态) and rotates the version, keeping the previous copy in `profile.md.bak`.
- 🔒 **Read-back data, not instructions**: memory is written with `fs/promises` directly to the memory roots — intended persistence, not self-modification — and paths are confined to the store root. Memory files are context the agent reads back, never permission grants.
- 🧩 **Pure harness plugin**: no HTTP API or GUI panel — injection and tools only. DSH serves a single user, so paths carry no `<uid>` layer.
- 🛠️ **Six agent tools** registered via `ctx.tools.register` (`defineTool` from `@deepseek-ai/dsh-tools`):

| Tool | Scope | Effect |
|:-----|:------|:-------|
| `memory_write` | global/project | Write/overwrite a topic file; optionally add an index line. |
| `memory_read` | global/project | Read a topic file or the `MEMORY` index. |
| `memory_search` | global/project/both | Keyword-search topic files. |
| `memory_daily` | cwd | Append a dated line to `<cwd>/.dsh/memory/YYYY-MM-DD.md`. |
| `memory_forget` | global/project | Delete a topic file and its index pointer. |
| `memory_profile` | global | Read, or merge-and-rotate, the single-user profile. |

## Quick Start

### Prerequisites

- A DeepSeek Harness (DSH) installation with a plugin-capable profile (e.g. `web`).
- No LLM route required — the plugin falls back to keyword-only relevance.

### Install

```bash
dsh plugin --profile web add github:NattoCB/dsh-plugin-memory
```

### Run

Restart `dsh web`. On first use the plugin bootstraps both memory roots:

```
~/.dsh/memory/
  MEMORY.md        # global index (≤200 lines / 40K chars)
  profile.md       # L1 profile (Version N)
  profile.md.bak   # previous profile version
  <topic>.md       # global topic files
<cwd>/.dsh/memory/
  MEMORY.md        # project index
  YYYY-MM-DD.md    # daily memory (append-only)
  <topic>.md       # project topic files
```

Tell the agent something worth remembering, or let idle auto-extraction pick it up — then check the memory roots a session later.

## Configuration

Deploy the plugin via a DSH bundle entry (see `cordis.patch.yml` and `package.json` `exports`):

| Key | Default | Meaning |
|:----|:--------|:--------|
| `enableEntryInjection` | `true` | Prepend the how-to-save + index block once per session. |
| `enableRelevance` | `true` | Append relevant topic files per step (`data-role=memory`). |
| `enableExtraction` | `true` | Idle-time LLM auto-extraction. |
| `maxRelevant` | `5` | Max files surfaced per step (1–20). |
| `relevanceTopK` | `8` | Max candidates the LLM selector may pick from (1–40). |
| `relevanceBudgetChars` | `2000` | Per-topic char cap fed to relevance selection (≥200). |
| `extractionDebounceMs` | `60000` | Idle debounce before an extraction pass runs. |
| `extractionLookback` | `40` | Recent events scanned per pass (5–200). |
| `llm.provider` | `""` | Provider for extraction / relevance ranking (empty → keyword-only). |
| `llm.model` | `""` | Model for extraction / relevance ranking. |
| `llm.maxTokens` | `1024` | Completion token cap for LLM calls. |

Example entry:

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
      provider: deepseek   # example: fill in your route
      model: deepseek-chat
      maxTokens: 1024
```

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

[Open an issue](https://github.com/NattoCB/dsh-plugin-memory/issues) · [Source](https://github.com/NattoCB/dsh-plugin-memory)

</div>
