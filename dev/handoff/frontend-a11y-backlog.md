# 前端互動與無障礙待辦 [ACTIVE]
- updated: 2026-11-13 (claude)
- base: 8a3bed8
<!-- 查核: 2026-11-13 -->
- identity: {"executor":"claude","device":"desktop","host":"DESKTOP-20251004","session_id":"0f1288e4-85d4-4e94-95f7-ef8a26e49f96","session_name":"unknown","identity_source":"transcript-path"}
- 停點: 2026-11-13 一輪 skill A/B 測試的審查附帶找到下列既有問題，已對照 repo 現況查證；尚未動工，repo 程式碼未改。
- 下一步: (1) `ImportDialog` 改成真正的 modal（原生 `<dialog>`＋`showModal()` 可一次解決背景可操作、焦點陷阱、Esc；匯入進行中要攔下關閉）；(2) 輸入框 Enter 觸發匯入前排除輸入法組字中（`e.isComposing`）；(3) 匯入進度加 `role="status"`；(4) `ContextMenu` 關閉後把焦點還給觸發元素，補 Home／End 與 Tab 處理。
- 切入: v2/web/src/components/ImportDialog.svelte:48、v2/web/src/components/ContextMenu.svelte:16、v2/web/src/App.svelte:582
- 事實:
  - fact: `v2/web/src/components/ImportDialog.svelte:48-49` 無 `aria-modal`、無焦點陷阱、無初始聚焦、無 Esc 關閉（只能點背景關）；`v2/web/src/App.svelte:582` 渲染時背景沒有 `inert`。
  - fact: `v2/web/src/components/ImportDialog.svelte:55` 的 `onkeydown` 只判斷 `e.key === 'Enter'`，沒有檢查 `e.isComposing`。
  - fact: `v2/web/src/components/ImportDialog.svelte:59-62` 進度區塊沒有 `aria-live` 或 `role="status"`。
  - fact: `v2/web/src/components/ContextMenu.svelte:16-40` 已有 `role="menu"`／`menuitem`、ArrowUp／Down 循環、Esc 關閉；沒有 Home／End、沒有 Tab 處理、沒有關閉後的焦點還原。
