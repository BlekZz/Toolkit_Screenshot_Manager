# Sprint：截圖分流工具 MVP2

> 建立日期：2026-07-11。依 [[Spec_Screenshot_Triage_MVP1]] 驗收結果、架構審查與功能規劃綜合而成。
> 2026-07-11 承諾執行，由 Plan 更名為 Sprint。進度在本文件內追蹤。

## 進度追蹤

| 里程碑 | 狀態 | 備註 |
|---|---|---|
| M0 穩定性與效能修復包 | ✅ 完成 | 2026-07-11 完成，沙箱回歸驗收通過（見 M0 驗收紀錄） |
| M1 OCR 批次管線 | ✅ 完成 | 2026-07-11 完成，引擎選型 Windows OCR，獨立驗收通過（見 M1 驗收紀錄） |
| M2 資料夾生命週期指令 | ✅ 完成 | 2026-07-11 完成，獨立驗收通過（見 M2 驗收紀錄） |
| M3 審閱效率與輸出品質包 | ✅ 完成 | 2026-07-11 完成，獨立驗收通過（見 M3 驗收紀錄）；真機確認：crop 縮放 / S 統計 / 頂欄 皆 OK |
| M6 使用者回饋批次 1 | 🔄 實作完成 | 2026-07-11 三項全部實作＋本機驗證通過；待真機確認 crop 游標與維護面板（見 M6 驗證紀錄） |

## 1. 背景與現況

- MVP1 已實作完成，§14 驗收 12 條中 11 條達成（詳見 [[Spec_Screenshot_Triage_MVP1]] 變更紀錄）。
- 架構審查結論：程式碼品質良好（路徑防護、uniquePath、JSONL log、undo 設計皆正確），但存在一批穩定性/效能問題需優先處理（見 M0）。
- 價值鏈斷點：staging 四個資料夾目前只進不出 — `extract-text` 的 OCR 消化（工具存在的核心理由）、`trash-candidate` 的清理、`review-later` 的回流機制皆未存在。

## 2. 里程碑總覽

| # | 里程碑 | 規模 | 建議順序 |
|---|---|---|---|
| M0 | 穩定性與效能修復包 | 小 | 1（先做，半天級） |
| M1 | OCR 批次管線 `npm run extract` | 中 | 2（價值最高） |
| M2 | 資料夾生命週期指令 status / requeue / purge | 小 | 3 |
| M3 | 審閱效率與輸出品質包 | 小 | 4 |
| M4 | 第二輪審閱模式（來源參數化） | 中 | 視 review-later 積壓速度決定 |
| M5 | AI 筆記化（OCR md → tag → Obsidian） | 大 | 留待 MVP3 |
| M6 | 使用者回饋批次 1（追加，2026-07-11） | 中 | crop 游標 / OCR 品質 / 維護指令進 UI |

MVP2 建議收斂為 **M0 + M1 + M2 + M3**。

---

## 3. 里程碑明細

### M0：穩定性與效能修復包

目標：消除已知 bug 與 1,000+ 張圖下的效能瓶頸，為後續里程碑鋪底。

工作項（依優先序，佐證行號為 2026-07-11 審查時點）：

1. **綁定 127.0.0.1**（`server.mjs:668`）：目前綁 0.0.0.0，全 LAN 可透過 /api/classify 操作檔案系統。一行修正，安全收益最大。
2. **修 crop 模式 resize bug**（`app.js:642-644`）：crop 模式中調整視窗大小時 `#mainImage` 為 hidden，`getBoundingClientRect()` 全為 0 → canvas 塌陷成 0×0、scale 除以 0。改為量測 viewer 容器或暫時解除 hidden。
3. **pause/resume 對稱化**：resume 只清 client flag（`app.js:635-640`），server 無 /api/resume → 重新整理後暫停畫面重現。加 POST /api/resume，或把 paused 改為純前端狀態。
4. **消除雙重掃描與 O(n²)**（`server.mjs:149-258, 427`）：
   - 每個 mutation handler 做兩輪完整目錄掃描 + 兩次 state 寫入（handler 自身一次、`sessionPayload()` 再一次）；GET /api/session 亦有寫入副作用（`loadState()` 內無條件 `saveState()`，`server.mjs:211`）。
   - `order.includes(name)` 等 O(n²) 迴圈（`server.mjs:177-180, 226, 253-257`）改用 Set/Map；`listInputImages` 逐一 await `fs.stat`（`server.mjs:157`）改 `Promise.all` 或直接移除（size/modifiedAt 前端未使用）。
5. **state 原子寫入 + mutation 序列化**：`writeJson` 直接覆寫（`server.mjs:99-102`）改為寫 `.tmp` 再 rename；全域 promise chain 序列化 mutation，防多分頁 last-write-wins。合計約 20 行。
6. **cancelGroup 逐筆還原時每筆 save state**（`server.mjs:542-547`）：避免中途失敗時 state 與磁碟脫節、undoStack 殘留失效紀錄。
7. **batch 換日邏輯**（`server.mjs:186`）：state 存在時永遠沿用首次日期。載入時若 `raw.batch !== today` 且 remaining 為 0 → 開新 session、歸檔舊 state。
8. **readBody 加大小上限**（`server.mjs:320-324`）：50MB 即可。
9. **`serveStatic` prefix check 補 `path.sep`**（`server.mjs:570-571`）：防禦性修正。

QA / 驗收條件：
- [x] `netstat` 確認僅監聽 127.0.0.1。
- [ ] crop 模式中縮放視窗，裁剪框仍正確可用。（⚠️ 邏輯經獨立 code review 確認正確，但未經瀏覽器實測 — 待使用者真機人工確認）
- [x] 暫停 → 繼續 → F5 重新整理，不再出現暫停畫面。（新增 POST /api/resume，server 端驗證通過）
- [x] 1,000 張圖下單次分類操作的 server 處理時間顯著下降。（GET /api/session 實測 6ms；雙掃描與 O(n²) 消除經 code 層確認）
- [x] 寫入中途 kill process 後重啟，state 不損毀（tmp+rename 生效，沙箱實證零 .tmp 殘留）。
- [x] MVP1 全部既有行為（Q/W/E/R/Z/G/P、group、undo、續傳）回歸通過。（沙箱 API 層全流程回歸 a–i 通過，含併發 4 classify 序列化煙測）

### M0 驗收紀錄（2026-07-11）

- 實作與驗收由不同 agent 執行（fresh-context 沙箱回歸），總判定 ✅ 通過，無阻擋級問題。
- 驗收後補修兩項備註級發現：resume 動作補寫 JSONL log（與 pause 對稱）；batch 換日時舊 state 歸檔至 `logs/state-archived-<batch>.json` 再重置。
- 已知並接受的殘餘風險：換日重置的 state 寫入發生在 GET /api/session 路徑、不經 mutation queue，理論競態條件為「跨日瞬間 + Input 空 + 併發 mutation」，極罕見，不處理。
- 待人工確認：crop 模式中拖拉視窗大小後裁剪框行為（唯一未經真機驗證項）。

明確不做（過度工程警告，架構審查結論）：
- 不引入 Express/React 等框架、不上 SQLite、不做 auth/HTTPS、不做 WebSocket 多分頁同步、不改 multipart 上傳、不擴 undo stack 架構、不全面 TypeScript 化。
- server.mjs 拆模組僅在 M0 完成後視需要順手做，不為拆而拆。

### M1：OCR 批次管線 `npm run extract`

目標：兌現 extract-text 的存在理由 — 分流產出自動變成 markdown 文字。

- 對 `staging/extract-text/YYYY-MM-DD/` 執行 OCR：`single/` 每圖一章、`group-###/` 合併成一章。
- 輸出 `output/text/YYYY-MM-DD.md`，含來源檔名回鏈。
- 已處理圖片移至 `output/pending-delete/`；重跑不重複處理（需狀態追蹤）；全程寫 log。
- **前置 spike**：以真實截圖比較 OCR 引擎（tesseract.js / Windows 內建 OCR / LLM vision）在中英混排下的品質後再選型 — 引擎選錯是本里程碑唯一高風險點。

QA / 驗收條件：
- [x] `npm run extract` 對指定批次一鍵執行。
- [x] single 每圖一章、group 合併一章，來源檔名可回溯。
- [x] 重跑同一批次不產生重複輸出。（沙箱實測 md hash byte-identical、零異動）
- [x] 已 OCR 圖片確實移至 pending-delete，原檔數量守恆。（含 low-yield 留置對帳）

### M1 驗收紀錄（2026-07-11）

- **引擎選型 spike**：以 5 張真實裁剪圖比對 Windows 內建 OCR（WinRT, zh-Hant-TW）vs tesseract.js（chi_tra+eng）。Windows OCR 三軸全勝：乾淨版面近乎全對、51–211ms/張（快 5–10 倍）、零相依。tesseract.js 在雜訊背景崩潰且會從照片幻覺文字。**採用 Windows OCR 單引擎**。spike 留檔：scratchpad ocr-spike/RESULTS.md。
- **實作**：`extract.mjs` + `extract-ocr.ps1`（單次 spawn powershell.exe 5.1 批次 OCR）+ CJK 字間空白清理。相容新版 single//group-###/ 與舊版散檔佈局。
- **獨立驗收**（fresh-context 沙箱）：4 條驗收 + 13 個額外情境全過（冪等、增量、--batch 過濾、錯誤隔離、中文檔名 round-trip、路徑安全、UTF-8）。真實環境 170 檔逐檔比對零異動。
- **驗收後補修**：崩潰視窗調序（先寫 md 再搬檔再存 state — 寧可重複不可遺失）；already-processed-but-present 告警；log 改寫 `logs/<batch>.jsonl` 對齊 server 慣例；README 新增 OCR 節（含 PowerShell `--` 剝除陷阱）。
- **已知限制**（留給後續）：low-yield 檔案留置 staging 無出口（M2 需涵蓋或人工處理）；雜訊背景/藝術字類兩免費引擎皆不可靠，未來可選擇性丟 LLM vision（需 API key，未排入）；group 分次補跑會產生重複章名（低頻，可回溯）。

### M2：資料夾生命週期指令

目標：staging 四資料夾都有出口，杜絕無限堆積。

- `npm run status`：讀 logs + 掃 staging，輸出各區積壓張數與最舊日期。
- `npm run requeue`：把 review-later 檔案移回 `Input/` 進下一輪；啟動時偵測積壓並提示。
- `npm run purge`：trash-candidate 清理，**預設 dry-run**，逾冷靜期（14 天）+ 人工確認才真刪，寫 purge log。archive/originals 可併入、設較長保留期（如 90 天）。

QA / 驗收條件：
- [x] status 統計與實際檔案數一致。（沙箱 15 項對帳全中；真實環境 Input 1057 / extract-text 36 / keep 45 / review-later 3 / trash 84 / archive 81 與磁碟吻合）
- [x] requeue 後下次啟動可見回流檔案。（沙箱實測 --apply 後啟動 server，GET /api/session 含全部回流檔）
- [x] purge dry-run 不動任何檔案；逾期過濾正確；確認後才刪且寫 log。工具永不自動刪。（所有 dry-run 路徑零異動實證；--apply 需 readline 輸入 yes 或 --yes）

### M2 驗收紀錄（2026-07-11）

- 實作：`status.mjs` / `requeue.mjs` / `purge.mjs` + 共用純函式抽至 `lib.mjs`（extract.mjs 同步改用，經機械逐字比對確認零行為變更）。
- 獨立驗收（fresh-context 沙箱 + 真實環境唯讀比對 1308 檔零異動）✅ 通過。
- 備註級已知小疵（訊息層級，不修）：purge --apply 遇 stdin EOF 時安全中止但不印訊息；status oldest batch 遇非日期資料夾名可能誤標；requeue 對「只剩非圖片殘留」的批次夾訊息不精確；purge 日期 regex 接受非法日期字串。
- low-yield 留置在 status 中可見化（顯示 held 數）；實際出口留給 MVP3 vision fallback。

### M3：審閱效率與輸出品質包

- full-crop（整張不裁）走 server 端直接搬檔，跳過 canvas 重編碼與 base64 round-trip（byte-identical、保留 EXIF）。
- W（keep）輸出保留原格式，不再一律轉 PNG（jpg 來源膨脹數倍）。
- Undo 深度 3 → 10（`server.mjs` slice 常數，state 已持久化）。
- 啟動時自訂 batch name（`npm start -- --batch <name>`，spec §7.2 已預留）。
- 頂欄顯示圖片尺寸/檔案大小。
- 補 MVP1 殘餘缺口：獨立統計查看入口（不暫停）、統計畫面補 Started at / Last updated、undo 失敗寫 log。

QA / 驗收條件：
- [x] 整張 keep 的輸出與原檔 byte-identical。（沙箱 SHA-256 比對一致，副檔名與 EXIF 保留）
- [x] jpg 來源裁剪後輸出不再強制 PNG。（keep + jpg 來源輸出 .jpg；Q 維持 PNG）
- [x] 連按 Z 可還原 10 步。（12 次分類後 undo 10 次成功、第 11 次正確回 400）
- [x] 自訂 batch name 反映在輸出路徑與 log。（`node server.mjs --batch <name>`，含 sanitize 與換日重置豁免）

### M3 驗收紀錄（2026-07-11）

- 附帶項全數完成：S 鍵獨立統計 overlay（唯讀、不進 paused）、統計畫面補 Started at / Last updated、undo 失敗寫 JSONL log、頂欄顯示尺寸與檔案大小（僅 stat 當前一張，不退化 M0 效能）、README 同步。
- 獨立驗收（fresh-context 沙箱）✅ 通過：Sprint 4 條 + 附帶項 + 8 情境全過，MVP1 全流程回歸正常，M0 特性（mutation queue、127.0.0.1、單掃描、tmp+rename）無退化，真實環境零異動。
- 備註級已知小疵（不修）：cancelGroup 失敗未寫 error log（pre-existing，M3 只承諾 undo）；Q 輸出格式僅由前端保證（直打 API 可繞過，localhost 單機風險低）；--batch 不擋 Windows 保留裝置名（CON 等）；S 統計用 client 快取不重新 GET；暫停畫面按 P 重複觸發 pause（冪等無害）。
- 待人工確認（真機瀏覽器）：S 鍵 overlay、頂欄資訊顯示、M0 的 crop 模式視窗縮放。

### M4：第二輪審閱模式（候選，可延後）

目標：同一 UI 以 `--source staging/review-later/...` 為來源再跑一輪 Q/W/E/R。成本在 `Input/` 寫死於 server 各處、state 需按來源隔離。若 M2 的 requeue 已滿足需求，可不做。

### M5：AI 筆記化（MVP3）

OCR md → tag / 類型分類（task/reference/idea/quote）→ Obsidian vault 落地，原文不改寫遺失。依賴 M1 品質穩定，MVP2 不排入。

### M6：使用者回饋批次 1（2026-07-11 追加）

來源：M0–M3 真機驗收後的使用者回饋。三個工作項。

**6.1 crop 邊線 hover 游標與邊線拖拉**（`public/app.js`）

- `cropHit` 補四條邊線中段判定（`resize-n/s/e/w`），四角判定維持優先；`cropCursors` 補 `ns-resize` / `ew-resize`。
- **附帶修 bug**：resize 拖拉分支以 `hit.includes("e")`/`includes("s")` 判向，但 `"resize-nw"` 等字串本身即含 `e`、`s`（在 "resize" 前綴裡），導致 NW/NE/SW 三角拖拉被 e/s 分支覆寫、方向錯亂。改為解析 `"resize-"` 後綴再判向。
- 邊線拖拉沿用既有 w/e/n/s 分支，天然相容。

QA：
- [ ] hover 四角 → 對角 resize 游標；四邊中段 → `ns-resize`/`ew-resize`；框內 → move；框外 → crosshair。（待真機）
- [ ] 四角、四邊拖拉方向皆正確（特別回歸 NW/NE/SW 三角）。（邏輯修正完成，待真機）
- [ ] ratio 鎖定下拖拉仍維持比例。（待真機）

**6.2 OCR 品質優化**（`extract-ocr.ps1` + `extract.mjs`）

現況問題（`output/text/2026-06-21.md` 實證）：低解析 CJK 被拆成部首（亻言→信、至丨→到）、字元混淆（`SSlS`→`SSIS`、`T0p`→`Top`、`一`→`-`）、標點雜訊（`" , "`、`1 · 5 萬`、`1 , 636`）。

- ps1：OCR 前以 `BitmapTransform`（Fant 插值）放大 2 倍，上限 `OcrEngine.MaxImageDimension`，並 RespectExifOrientation。放大是 Windows OCR CJK 準確率最大單一槓桿。
- `cleanText` 強化（保守規則、先後有序）：大寫序列中 `l`→`I`；ASCII 碼與數字間的 `一`→`-`；`數字·數字`→小數點；`數字 , 數字`→千分位；CJK 間半形逗號/括號→全形；全形標點前後空白清除；既有 Han-Han 空白清除保留。
- 不排入：LLM vision fallback（需 API key，留 MVP3）；行序重排（現輸出已按閱讀序）。

QA：
- [x] 以 pending-delete 既有樣本直跑 ps1，與舊輸出肉眼比對，部首拆字顯著減少。（4 張最差樣本實測：`亻言義區`→`信義區`、`至丨`→`到`、`SSlS`→`SSIS` 於 OCR 原生層即修復；地址整行復原）
- [x] cleanText 規則案例表驗證，不誤傷正常中英文句。（14 個修復案例 + 8 個安全案例全過，含英文句、hashtag、程式碼、單位）
- [x] 管線冪等 / 搬檔 / low-yield 行為零變更。（僅動 cleanText 與 ps1 解碼路徑；`extract` 空跑回報 up to date 正常）

**6.3 維護操作進前台 UI**（`server.mjs` + `public/*`）

- 新 API：`POST /api/maintenance/run`，body `{task}`；task 白名單 `status` / `extract` / `requeue-dry` / `requeue-apply` / `purge-dry` / `purge-apply`。以 `spawn(node, <script>)` 重用既經 M1/M2 驗收的 CLI（`purge-apply` 帶 `--yes`，人工確認移至 UI 按鈕）。單飛鎖（執行中回 409）+ 進 mutation queue（防與 classify 併發競態）。
- UI：頂欄「維護」按鈕 + 快捷鍵 `M` → overlay 面板；開啟即自動載入 status；extract 一鍵執行；requeue / purge 兩段式：先 dry-run 顯示清單 → 一鍵「確認執行」（不再要求終端輸入 yes）；輸出顯示於面板 `<pre>`；requeue-apply 成功後自動重載 session。
- 說明：裁剪本身（Q/W）已於 UI 即時完成，不屬本項範圍。

QA：
- [x] 白名單外 task 一律 400；執行中再觸發回 409。（curl 實測：bogus task 400；併發雙發 status 得 409+200）
- [x] dry-run 永不動檔；purge-apply 僅在 UI 確認後發出。（requeue-dry / purge-dry 實測輸出正確且零檔案異動；apply 僅由確認按鈕觸發）
- [ ] requeue-apply 後畫面立即出現回流圖片，無需重啟 server。（程式路徑完成，未對真實資料演練 — 待使用者於 UI 首跑）
- [ ] extract 執行中發出分類操作，被 mutation queue 序列化、state 不損毀。（by-construction：maintenance 與 classify 同走 mutation queue；未做長任務競態實測）

**6.4 low-yield 獨立 pool（2026-07-11 追加回饋）**（`extract.mjs` + `status.mjs`）

問題：low-yield 圖片原本靜默留在 extract-text（只進 state 不移動），使用者無法感知失敗、也沒有獨立出口。

- extract：low-yield 圖片改移至 `staging/low-yield/<批次>/`（保留 single/group 子結構、uniquePath 防撞名）；md 標註升級為「⚠️ low-yield — 原圖已移至 …」；log 補 `moved_to`；state 記錄去向。
- 重試機制：把圖移回 `staging/extract-text/<批次>/` 再跑 extract 即重試（stale-skip 規則本就豁免 low-yield）。正式出口留 MVP3 vision fallback。
- status：staging 掃描列表加入 `low-yield` 區（標註 `OCR failed, awaiting fallback/manual`）；extract-text 舊「low-yield held」註記移除（已無留置語意）。
- purge 刻意**不**納入 low-yield（待處理 pool 永不自動清）。

QA：
- [x] low-yield 圖確實移至 pool、md 有標註與去向、log 有 moved_to。（真實重跑實證：2 張 low-yield 全中）
- [x] 數量守恆：37 進 = 35 pending-delete + 2 low-yield，extract-text 清空。
- [x] status 顯示 low-yield 獨立區與批次數。

### M6 驗證紀錄（2026-07-11）

- 6.1：邊線 hover 游標與邊線拖拉完成；附帶修復既有 NW/NE/SW 角拖拉方向 bug（`"resize-nw".includes("e")` 誤中 "resize" 前綴的 e/s）。純視覺項待真機確認。
- 6.2：ps1 加 2 倍 Fant 放大（上限 `OcrEngine.MaxImageDimension`、RespectExifOrientation）；cleanText 新增 10 條保守修復規則。4 張最差樣本實測品質顯著提升；重跑舊批次的步驟見 README / 對話紀錄。
- 6.3：`POST /api/maintenance/run`（白名單 6 task、單飛鎖、進 mutation queue）+ 前台維護面板（`M` 鍵 / 頂欄按鈕，requeue/purge 兩段式 UI 確認取代終端 yes）。API 層 curl 全數驗證通過。
- 已知取捨：extract 長任務執行期間 classify 會排隊等待（同一 queue，防競態的刻意設計）；面板執行中不可關閉。
- 6.4 + 真實重跑：2026-06-21 批次 37 張以新管線重新 OCR（舊 md 已重建，品質顯著提升：`1.5萬`、`1,636`、全形標點、部首拆字消失），low-yield 2 張進 `staging/low-yield/2026-06-21/`。README 新增「運作全貌」節（2 張 Mermaid flow 圖 + 機制表，語法經 Mermaid 工具驗證）。

---

## 4. 最終驗收清單（MVP2 = M0–M3）

- [x] M0 全部 QA 通過，MVP1 行為回歸無退化。（唯 crop 視窗縮放待真機人工確認）
- [x] 一批真實截圖可走完完整價值鏈：Input → Q 分流 → `npm run extract` → markdown 產出 → pending-delete。（2026-07-11 真實資料完成：首跑 + M6 品質升級後全批重跑 37 張，35 extracted / 2 low-yield，零 error）
- [x] 四個 staging 資料夾各自有可執行的出口（extract / requeue / purge / status 可見）。
- [x] README 與 [[Spec_Screenshot_Triage_MVP1]] 同步更新至 MVP2 實際行為。

### Sprint 收尾狀態（2026-07-11）

M0–M3 四個里程碑全數完成並經獨立驗收。每個里程碑皆為獨立 commit（M0 `095eff5`、M1 `f24d507`、M2 `2edba20`、M3 見 git log）。待使用者執行的收尾動作：
1. 真機瀏覽器人工確認：crop 模式視窗縮放、S 鍵統計 overlay、頂欄尺寸/大小顯示。
2. 對真實資料首跑 `npm run extract`（36 張既存 extract-text 圖），確認 `output/text/2026-06-21.md` 品質。
3. 之後日常維護：`npm run status` 看積壓、`node requeue.mjs --apply` 回流、`node purge.mjs --apply` 清垃圾（皆預設 dry-run）。
