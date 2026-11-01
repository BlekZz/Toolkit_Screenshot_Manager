# Photo Library v2 重建 [ACTIVE]
- updated: 2026-11-01 (claude)
- base: b37e114
<!-- 查核: 2026-11-01 -->
- identity: {"executor":"claude","device":"desktop","host":"DESKTOP-20251004","session_id":"4ebbf730-be62-4d59-aad2-31ec78c7ad3e","session_name":"unknown","identity_source":"scratchpad-path"}
- 停點: P0 ✅、P1 ✅；P2 實作完成（P2a undo／trash／crop／bundle／快捷槽、P2b 原地引用、P2c Triage 前端），尚未獨立驗收。
- 下一步: fresh-context agent 依 Sprint §10.1 P2 QA 走真實入口驗收 → Blake 用 `D:\PhotoLibrary` 試用 Triage → P2 ✅ → 接 AI 分流 A2（建議 UI，見 lane screenshot-ai-triage）。
- 切入: dev/Sprint_Photo_Library_v2.md（P2 紀錄、§7、§10.1）, v2/server/undo.mjs, v2/web/src/components/Triage.svelte
- 事實:
  - [fact] `cd v2 && npm test` 224/224（commit b37e114）；P2 mutation 合計 44 項全數被殺（Sprint P2 紀錄）。
  - [fact] 真實照片庫 `D:\PhotoLibrary` 1,324 assets，DB 目前 user_version 5；下次開啟自動套用 006／007（副本試套筆數不變、FK 0）。
  - [fact] v2 預設 port 3040；library 由 `--library` 或 `PHOTO_LIBRARY` 指定；舊工具（repo 根）未被修改。
  - [inference] `node:sqlite` 在 Windows 的 bulk insert 當機紀錄（knowledge/node.md）本專案未重現；若出現 native crash 先懷疑它，退路 better-sqlite3。
