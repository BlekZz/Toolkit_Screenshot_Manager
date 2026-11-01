# Photo Library v2 重建 [ACTIVE]
- updated: 2026-11-01 (claude)
- base: 37f9ace
<!-- 查核: 2026-11-01 -->
- identity: {"executor":"claude","device":"desktop","host":"DESKTOP-20251004","session_id":"4ebbf730-be62-4d59-aad2-31ec78c7ad3e","session_name":"unknown","identity_source":"scratchpad-path"}
- 停點: P0 ✅、P1 ✅、P2 QA ✅（獨立驗收四條＋紅線全 PASS，見 Sprint P2 驗收紀錄）。
- 下一步: Blake 用 `D:\PhotoLibrary` 試用 Triage（確認可取代舊工具）→ P2.5 舊工具退役；並行可接 AI 分流 A2（建議 UI，見 lane screenshot-ai-triage）。
- 待裁: Blake 試用回饋（W 未框選是否改存整張、Triage 快捷鍵、鍵位自訂優先度）。
- 切入: dev/Sprint_Photo_Library_v2.md（P2 紀錄、§7、§10.1）, v2/server/undo.mjs, v2/web/src/components/Triage.svelte
- 事實:
  - [fact] `cd v2 && npm test` 225/225（commit 37f9ace）；P2 mutation 合計 44 項全數被殺（Sprint P2 紀錄）。
  - [fact] 真實照片庫 `D:\PhotoLibrary` 1,324 assets，DB 目前 user_version 5；下次開啟自動套用 006／007（副本試套筆數不變、FK 0）。
  - [fact] v2 預設 port 3040；library 由 `--library` 或 `PHOTO_LIBRARY` 指定；舊工具（repo 根）未被修改。
  - [inference] `node:sqlite` 在 Windows 的 bulk insert 當機紀錄（knowledge/node.md）本專案未重現；若出現 native crash 先懷疑它，退路 better-sqlite3。
