# Changelog

All notable changes to this plugin are documented in this file.

## [Unreleased]

- Declare the `dsh.bundle.patch` manifest in `package.json` with a dedicated `cordis.patch.yml` so the plugin loads as a profile bundle.
- Fix profile section rendering: `write()` now emits `## <section>` headings so the next `read()` parses the bullets back instead of losing them.

## [0.1.0-rc.1] - 2026-08-17

- Initial release of the persistent five-layer memory system (L0-L4).
- Entry-instruction injection with a hard truncation budget (200 lines / 40 000 chars).
- Per-step relevance injection with LLM ranking and keyword fallback.
- Idle-time LLM auto-extraction of topic files and index lines.
- L1 profile merge with Version-N rotation and `.bak` backup.
- Six agent tools for save / recall / search / forget.
