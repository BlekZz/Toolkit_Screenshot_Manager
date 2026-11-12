# 前端互動與無障礙待辦 [ACTIVE]
- updated: 2026-11-13 (claude)
- base: 57e49d7
<!-- 查核: 2026-11-13 -->
- identity: {"executor":"claude","device":"desktop","host":"DESKTOP-20251004","session_id":"0f1288e4-85d4-4e94-95f7-ef8a26e49f96","session_name":"unknown","identity_source":"transcript-path"}
- 停點: 2026-11-13 四項待辦與審查要求的修正（輪詢失敗退避、接回匯入的焦點、progressbar 語意、選單 Tab、觸控點背景穿透）都已在工作樹完成，已提交；`npm run build`、`npm test`（224/224）通過，Chrome 157 headless（含觸控模擬）實機操作驗收通過。
- 下一步: (1) 已提交並推送；(2) Safari（無 `closedby`、`isComposing` 時序不同）與 Firefox 未實測，需真機確認 Esc 攔截、點背景關閉、`keyCode 229` 判斷；(3) 輸入法只用合成 `compositionstart`／`keyCode 229` 事件驗證，未用真實 IME 組字；(4) 螢幕報讀器實際播報（progressbar、「匯入中」與結果摘要）未實聽；(5) 觸控穿透只在 Chrome 行動模擬（`hasTouch`／`isMobile`）驗證，未在實體觸控裝置驗證；(6) 另案：`Picker`、`Prompt` 關閉後不還原焦點（超出本 lane 範圍）。
- 切入: v2/web/src/components/ImportDialog.svelte:15、v2/web/src/components/ImportDialog.svelte:116、v2/web/src/components/ContextMenu.svelte:20
- 事實:
  - fact: `v2/web/src/components/ImportDialog.svelte:116-128` 改為原生 `<dialog>`，`:62` 以 `showModal()` 開啟（背景 inert、焦點限制、Esc、關閉後焦點還原由瀏覽器處理）；`:121` 鎖定時 `closedby="none"`、平時 `closerequest`；`:68` `cancel` preventDefault 與 `:73-74` 鎖定時被關即重開，兩者是無 `closedby` 瀏覽器的防線。
  - fact: 實測（Chrome 157、移除 `closedby` 模擬不支援）連按 Esc 時事件序為 `cancel, cancel, close, …`——第二次 Esc 不經 preventDefault 直接 close，只靠 `cancel` 擋不住，`:73-74` 的重開是必要的。
  - fact: `v2/web/src/components/ImportDialog.svelte:15-23` 鎖定條件為 `running && pollFailures < 4`；`:41-55` 輪詢失敗以 600ms 起倍增退避（上限 5s）持續重試。實測以 `page.route` 讓 GET /api/import 失敗：連續 4 次失敗（約 4.9s）後顯示 `:169` 的「匯入可能仍在背景進行」提示，`closedby` 回到 `closerequest`、「關閉」鈕可用並取得焦點、Esc 可關；解除攔截後提示消失，進度 `aria-valuenow` 由 1451 繼續增加到 1715，並重新鎖定。
  - fact: 觸控點背景穿透實測（Chrome 157、`hasTouch`／`isMobile`，在「Triage」鈕上方點背景）：原生 `closedby="any"` 不穿透；舊的 pointerup 關閉 fallback 會穿透（Triage 被打開）。現改為 `:78-93` 在 dialog 的 `click` 事件判斷（目標是 dialog 本身、座標在框外、按下時也在框外），原生與移除 `closedby` 兩種模式下觸控與滑鼠都 0 次穿透。
  - fact: `v2/web/src/components/ImportDialog.svelte:95-102` 鎖定開始時焦點移到 dialog 本身（`tabindex="-1"`），解鎖時移到「關閉／完成」鈕；重新整理後接回進行中匯入時實測焦點在 DIALOG，不在 BODY。
  - fact: `v2/web/src/components/ImportDialog.svelte:104-110` Enter 前排除 `e.isComposing`、`e.keyCode === 229` 與 composition 事件旗標；變異測試（拿掉判斷）時組字中 Enter 會送出 POST /api/import，恢復後為 0 次。
  - fact: `v2/web/src/components/ImportDialog.svelte:141` 進度用 `role="progressbar"`（`aria-valuenow`／`aria-valuemax`／`aria-valuetext`），不在 live region 內；`:150` 常駐的 `role="status"` 只放「匯入中」（視覺隱藏）與完成後的結果摘要。
  - fact: `v2/web/src/components/ContextMenu.svelte:20-27` 記住開啟前的焦點元素，Esc／選取／點外面／Tab 關閉時還原（選取在執行 action 前還原，讓 action 開的對話框可再搶焦點）；`:44-45` Home／End；`:41` Tab 與 Shift+Tab 都 preventDefault 並還原焦點（實測從 grid 縮圖開的選單按 Tab 後焦點回到該縮圖）；`:49` catcher 的 pointerdown preventDefault，否則 mousedown 預設行為會把還原的焦點丟回 body（實測確認）。
