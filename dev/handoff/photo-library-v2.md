# Photo Library v2 重建 [ACTIVE]
- updated: 2026-10-11 (claude)
- base: f49393b
<!-- 查核: 2026-10-11 -->
- 停點: P0（匯入／縮圖／grid／loupe）與 P1（album／tag／三態篩選／查詢語言／智慧相簿）皆已實作並通過獨立驗收，驗收發現已補修；尚未對使用者真實照片庫（D:/PhotoLibrary）做正式匯入。
- 下一步: 等使用者實際試用 P1 回饋 → 開 P2（Triage 模式、1–9 快捷槽、非破壞 crop、undo、trash、原地引用 roots、依 album 分組顯示）。
- 切入: dev/Sprint_Photo_Library_v2.md（§10 里程碑、進度表、P0/P1 驗收紀錄）, v2/README.md, v2/server/catalog.mjs
- 事實:
  - [fact] 技術定案 node:sqlite＋sharp＋Fastify＋Svelte 5，spike 數據見 Sprint §9.1。
  - [fact] `npm test`（v2/）62/62 通過，含 mutation 驗證過的守衛（Sprint P0/P1 驗收紀錄）。
  - [fact] 舊工具（repo 根）未被修改，照常使用；v2 在 `v2/` 子目錄，預設 port 3040、library 由 PHOTO_LIBRARY 指定。
