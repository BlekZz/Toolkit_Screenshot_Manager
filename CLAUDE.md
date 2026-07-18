# CLAUDE.md

This file provides guidance to Claude Code when working with code in this
repository. Single source of truth for AI instructions and project specs.

---

## Project Context

截圖快速整理工具（Screenshot Triage Manager）：本機 Node.js 工具，將 `Input/` 內大量截圖
以鍵盤快捷鍵（Q/W/E/R）快速人工分流至 `staging/` 四資料夾，並提供 OCR 批次管線
（`npm run extract`，Windows OCR）與資料夾生命週期指令（status / requeue / purge）。

### Tech Stack & Project Standards

- Node.js（零框架，原生 `http`）＋ 原生前端（`public/`）；OCR 走 PowerShell WinRT
  （`extract-ocr.ps1`）。
- 入口：`npm start`（server.mjs，僅綁 127.0.0.1）；CLI：`extract.mjs` / `status.mjs` /
  `requeue.mjs` / `purge.mjs`（共用 `lib.mjs`）。根層 `.mjs` 為產品程式碼，非 dev script。
- 資料夾（`Input/`、`staging/`、`archive/`、`output/`、`logs/`、`state/`）皆 gitignored
  —— 內容是使用者資料，勿入版控。
- purge 類破壞性操作預設 dry-run，永不自動刪檔。

### Document Naming & Filing Convention
Format: `<Prefix>_<Subject>[_<Qualifier>].ext` (PascalCase prefix, underscore
separator, lowercase/mixed subject).

| Prefix | Purpose | Directory |
|--------|---------|-----------|
| `Tracker_` | Long-term monitoring of continuously updated state — never sprint progress (that lives inside the `Sprint_` doc) | `dev/` |
| `Workflow_` | Repeatable step-by-step operational SOP | `dev/runbooks/` |
| `Backup_` | Backup operation runbook | `dev/runbooks/` |
| `Restart_` | Restart operation runbook | `dev/runbooks/` |
| `ArchDesign_` | Architecture design: system structure, pipeline architecture, process/flow design — content decides, not file format (an architecture visualization in HTML is still `ArchDesign_`) | `dev/` |
| `VisualDesign_` | Visual design of the product itself: UI layout, typography, page/component composition. NOT system architecture or flow diagrams — those are `ArchDesign_` | `dev/` |
| `Env_` | Environment identity, settings, SSH/network connection reference | `dev/` |
| `Audit_` | Read-only snapshot / audit — filename MUST end with the snapshot date: `Audit_<subject>_<yyyymmdd>` | `dev/` |
| `Reference_` | Documents other docs consult: technical reference, lookup tables, cross-reference maps | `dev/` |
| `Plan_` | Planning-stage doc, pre-commitment: hypotheses and still-being-validated ideas allowed | `dev/` |
| `Sprint_` | Execution-committed plan — a `Plan_` renamed at the moment execution is decided; renamed `Sprint_end_` once final acceptance passes | `dev/` |

Directory rule: "Read it for reference → `dev/` root. Execute it as steps →
`dev/runbooks/`."

**Plan → Sprint → Reference lifecycle**
- Execution decided → rename `Plan_<subject>` → `Sprint_<subject>` (plan
  content stays as preamble).
- A `Sprint_` doc MUST contain: (1) sprint milestones, (2) QA items per
  milestone, (3) final acceptance checklist. Progress is tracked inside the
  Sprint doc itself — never open a `Tracker_` for it.
- When a Sprint item passes acceptance ✅, **extract** its durable knowledge
  into `Reference_<subject>` (extraction, never a rename; back-link
  `[[Sprint_<subject>]]`). The Sprint doc stays as the immutable snapshot.
- Sprint passes **final acceptance** → rename `Sprint_<subject>` →
  `Sprint_end_<subject>` (update all wiki links / path references). Only the
  filename and status line change; the Reference-extraction rule above is
  unchanged.

**Exceptions**
- `tech-notes.md` — no prefix, flat catch-all scratchpad for cross-session
  debugging notes.
- `dev/decisions/` — ADRs, `ADR-NNN-kebab-name.md` (no prefix).
- `dev/script/` — local dev scripts, not production container code.
- Platform rule files (`CLAUDE.md` etc.) — project root, fixed name.

### 知識歸檔路由表
Wrap-up（session 收尾 / 知識整合）時，project-local insight 依此表歸檔：

| 洞見類型 | 歸檔目標檔案 |
|----------|--------------|
| Schema / 事實類知識 | `dev/Reference_<subject>.md` |
| 已解 bug 的 fix pattern | 相關 Reference/schema 檔；並在 debug log 對應條目打 ✅ |
| 零散技術筆記、跨 session 除錯脈絡 | `dev/tech-notes.md` |
| 架構決策（含取捨理由） | `dev/decisions/ADR-NNN-<kebab-name>.md` |
