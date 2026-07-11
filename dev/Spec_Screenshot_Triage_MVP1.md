# 截圖快速整理工具 MVP 1.0 PRD / Spec

> **狀態（2026-07-11 更新）**：MVP 1.0 已實作完成，並經程式碼逐項驗收比對。§14 驗收標準 12 條中 11 條完全達成，殘餘缺口移列 MVP2（見 [[Plan_Screenshot_Triage_MVP2]]）。

## 變更紀錄

- 2026-07-11：依實作驗收結果更新 §12 功能 checklist、§13 QA checklist、§14 驗收標準勾選狀態。MVP1 驗收 12 條中 11 條達成；以下殘餘缺口移列 MVP2：
  1. 獨立統計查看入口（快捷鍵/點擊查看、不暫停純查看）未實作，目前只能按 P 進入 paused。
  2. 統計畫面未顯示 Started at / Last updated（後端有回傳，UI 未顯示）。
  3. 暫停保存的是最後分類位置；前端方向鍵瀏覽位置不會回傳 server。
  4. 輸出流水號取自 stats.processed+1，E/R 也累加，Q/W 輸出序號會跳號。
  5. Undo 後 restored 檔插到 fileOrder 最前，非原本排序位置。
  6. Undo 失敗有顯示錯誤但未寫 log（§8.3 要求需寫 log）。
  7. Q/W 為先寫輸出再搬原圖，兩步之間失敗無 rollback，可能產生半套結果。

## 1. 文件目的

本文件定義「截圖快速整理工具」MVP 1.0 的產品需求、互動規格、資料夾規劃、功能清單、QA checklist，以及後續可擴充方向。

本文件原為規劃階段文件；MVP 1.0 現已實作完成並通過驗收比對（2026-07-11 更新，詳見上方狀態與變更紀錄）。

## 2. 背景與問題

使用者會在工作、閱讀、對話或臨時記錄時快速截圖，這些截圖會集中放入專案內的 `Input/` 資料夾。由於截圖當下通常沒有時間分類，導致後續整理時出現以下問題：

- `Input/` 內容很髒，包含文字資訊、對話紀錄、圖像素材、臨時截圖、可刪除圖片等。
- 單靠 OCR 或 AI 無法判斷截圖當下的保存意圖。
- 文字截圖常包含 UI 雜訊，需要先裁剪再 OCR 才能提高辨識準確度。
- 圖像保留類截圖也常需要裁剪成可保存的畫面。
- 使用者需要快速人工判斷，不希望每張圖都進入繁瑣流程。
- 截圖不可由工具自動刪除，只能移到候選刪除區，最後由人工決定。

因此 MVP 1.0 的核心不是自動分類，而是提供一個像全螢幕 image viewer 的快速審閱工具，讓使用者用鍵盤快捷鍵與裁剪工具快速分流截圖。

## 3. 產品定位

### 3.1 一句話定位

一個本地啟動的全螢幕截圖審閱與分流工具，可用快捷鍵快速分類圖片，並在需要時進入裁剪模式，為後續 OCR 或人工保存建立乾淨輸入。

### 3.2 MVP 1.0 不做的事情

- 不自動判斷截圖分類。
- 不執行 OCR。
- 不使用 AI 判斷圖片內容。
- 不自動刪除任何原始圖片。
- 不做圖片語意命名。
- 不做雲端同步或多人協作。
- 不處理影片、PDF、Word、網頁書籤等非圖片類型。

OCR、AI 整理、語意命名、批次摘要都屬於後續版本。

## 4. 目標使用流程

### 4.1 最短日常流程

```text
1. 使用者把截圖放進 Input/
2. 使用者啟動工具
3. 瀏覽器開啟本地審閱頁面
4. 工具自動載入 Input/ 中的圖片
5. 使用者逐張查看圖片
6. 使用者按 Q/W/E/R 分類
7. Q/W 進入裁剪模式，Enter 或 Space 確認
8. E/R 直接移動原圖
9. 工具自動切到下一張
10. 使用者可按 Z undo 最近 3 次操作
```

### 4.2 分流結果

```text
Input/
  原始待處理圖片

staging/
  extract-text/YYYY-MM-DD/
    Q 裁剪後或整張保存的圖片，供下一階段 OCR 使用

  keep/YYYY-MM-DD/
    W 裁剪後或整張保存的圖片，供人工長期保存或後續整理

  review-later/YYYY-MM-DD/
    E 移入的原圖，代表暫時不確定

  trash-candidate/YYYY-MM-DD/
    R 移入的原圖，代表候選刪除，但不真正刪除

archive/
  originals/YYYY-MM-DD/
    Q/W 操作時保存的原始圖片副本或移入版本，用來保留裁剪前證據

logs/
  YYYY-MM-DD.jsonl
    每次操作的 append-only log

state/
  current-session.json
    目前批次、目前檔案位置、最近 3 次 undo stack、操作統計、目前文字 group
```

## 5. 使用者分類設計

MVP 1.0 先固定 4 類，避免分類過細導致 review 速度下降。

| 快捷鍵 | 類別 | 行為 | 是否裁剪 |
|---|---|---|---|
| Q | 提取文字 | 進入裁剪模式，確認後輸出到 `staging/extract-text/YYYY-MM-DD/` | 是 |
| W | 裁剪圖片 | 進入裁剪模式，確認後輸出到 `staging/keep/YYYY-MM-DD/` | 是 |
| E | 稍後處理 | 直接移動原圖到 `staging/review-later/YYYY-MM-DD/`，本輪不再 loop | 否 |
| R | 候選刪除 | 直接移動原圖到 `staging/trash-candidate/YYYY-MM-DD/` | 否 |
| Z | Undo | 回復最近 3 次分類操作 | 不適用 |
| G | 文字 Group | 開始或結束目前文字 group，只影響 Q | 不適用 |
| Shift+G | 取消文字 Group | 取消目前尚未結束的文字 group，並復原已加入截圖 | 不適用 |

## 6. 互動模式

### 6.1 瀏覽模式

瀏覽模式是預設模式，用於快速查看單張圖片。

畫面需求：

- 單張圖片大預覽，偏向全螢幕 viewer 體驗。
- 圖片應盡量放大到可讀，但不可超出畫面。
- 支援深色背景，降低視覺干擾。
- 顯示目前進度，例如 `12 / 340`。
- 顯示目前檔名。
- 顯示簡短快捷鍵提示。
- 顯示目前批次日期。

鍵盤操作：

| 按鍵 | 行為 |
|---|---|
| ArrowLeft / A | 上一張，支援長按快速切換 |
| ArrowRight / D | 下一張或跳過目前圖片，支援長按快速切換 |
| ArrowUp | Zoom in 目前預覽圖片 |
| ArrowDown | Zoom out 目前預覽圖片 |
| 滾輪在圖片上 | Zoom in / Zoom out 目前預覽圖片 |
| 滾輪在圖片外空白處 | 上一張 / 下一張 |
| Q | 對目前圖片進入文字提取裁剪模式 |
| W | 對目前圖片進入裁剪圖片模式 |
| E | 移到稍後處理 |
| R | 移到候選刪除 |
| Z | Undo 最近 3 次操作 |
| P | 暫停目前 session 並保存進度 |
| G | 開始 / 結束文字 group |
| Shift+G | 取消目前尚未結束的文字 group |

瀏覽模式補充：

- 預覽圖放大後，可用滑鼠左鍵拖曳移動畫面。
- 進入 Q/W 裁剪模式時，預覽縮放與平移會重置，避免裁剪座標不準。
- Space 不再用於下一張；裁剪模式中 Space 等同 Enter。
- Group 只影響 Q 提取文字，不影響 W 裁剪圖片、E 稍後處理、R 候選刪除。

### 6.2 裁剪模式

Q/W 會進入裁剪模式。裁剪模式用於產生新的裁剪圖片。

共同需求：

- 使用者可用滑鼠拖曳建立裁剪框。
- 可拖曳調整裁剪框位置。
- 可調整裁剪框大小。
- 裁剪框以透明內容區與虛線框顯示，不應遮住使用者正在選取的圖片內容。
- 若沒有建立裁剪框，按 Enter 時預設使用整張圖片。
- Enter 或 Space 確認裁剪並分類。
- Esc 取消裁剪，回到瀏覽模式，不搬移檔案。
- 裁剪後應保留原始圖片關聯 log。

裁剪比例：

| 按鍵 | 裁剪比例 |
|---|---|
| 1 | 自由裁剪 |
| 2 | 1:1 |
| 3 | 3:4 |
| 4 | 16:9 |

MVP 1.0 規則：

- Q 預設自由裁剪。
- W 預設自由裁剪，但支援快速切換 1:1、3:4、16:9。
- 為了保持一致，Q 也可支援比例切換，但 UI 上以自由裁剪為主。

## 7. 檔案規則

### 7.1 支援圖片格式

MVP 1.0 支援主流圖片格式：

- `.png`
- `.jpg`
- `.jpeg`
- `.webp`
- `.bmp`

可選支援：

- `.gif` 不列入 MVP 1.0 支援範圍。
- `.heic` 暫不列入 MVP，因跨平台處理成本較高。

### 7.2 批次命名

預設批次名稱使用啟動當日日期：

```text
YYYY-MM-DD
```

例如：

```text
2026-06-21
```

後續可擴充讓使用者自訂 batch name，例如：

```text
2026-06-21-reading
2026-06-21-work
```

### 7.3 輸出檔名

裁剪輸出檔建議使用穩定流水號加來源檔名：

```text
0001__source-name.png
0002__source-name.png
```

若來源檔名包含不安全字元，需轉換為安全檔名。

圖片瀏覽排序固定使用檔案名稱排序。

若輸出檔名衝突，追加序號：

```text
0001__source-name__2.png
```

### 7.4 原圖保存

Q/W 操作會產生裁剪圖，因此需保留原始圖片，避免裁剪錯誤後失去來源。

建議 MVP 1.0 行為：

```text
Q/W:
  1. 從 Input/ 讀取原圖
  2. 產生裁剪圖到 staging/extract-text 或 staging/keep
  3. 將原圖移到 archive/originals/YYYY-MM-DD/
  4. 寫入 log
```

E/R 操作不產生裁剪圖：

```text
E:
  將原圖移到 staging/review-later/YYYY-MM-DD/

R:
  將原圖移到 staging/trash-candidate/YYYY-MM-DD/
```

### 7.5 文字 Group 輸出

Q 提取文字支援連續截圖 group。

未開啟 group 時：

```text
staging/extract-text/YYYY-MM-DD/single/
  0001__source-name.png
```

開啟 group 時：

```text
staging/extract-text/YYYY-MM-DD/group-001/
  0001__source-name.png
  0002__source-name.png
```

Group 操作規則：

- 按 `G` 開始一個新的文字 group。
- Group 開啟期間，每次 Q 裁剪確認後會加入目前 group。
- 再按一次 `G` 結束目前 group。
- 按 `Shift+G` 只取消目前尚未結束的 group。
- 取消 group 時，會刪除該 group 內已產生的裁剪圖，並把對應原圖從 `archive/originals/YYYY-MM-DD/` 移回 `Input/`。

## 8. Undo 規格

MVP 1.0 支援最近 3 次操作 undo。

### 8.1 可 Undo 的操作

- Q 確認裁剪後的分類操作。
- W 確認裁剪後的分類操作。
- E 移動到稍後處理。
- R 移動到候選刪除。

### 8.2 Undo 行為

Q/W undo：

```text
1. 刪除剛產生的裁剪輸出圖
2. 將 archive/originals/YYYY-MM-DD/ 的原圖移回 Input/
3. 回到該圖片位置
4. 寫入 undo log
```

E/R undo：

```text
1. 將 staging 對應資料夾中的原圖移回 Input/
2. 回到該圖片位置
3. 寫入 undo log
```

### 8.3 Undo 限制

- 工具重啟後不保證可 undo 前次操作。
- 若使用者手動移動或刪除了檔案，undo 可能失敗。
- Undo 失敗時不可破壞現有檔案，應顯示錯誤訊息並寫 log。

## 9. 暫停、恢復與統計

MVP 1.0 需要支援長批次整理，使用者不一定能一次完成所有圖片。因此工具需支援隨時暫停、關閉後恢復，以及批次進度統計。

### 9.1 暫停行為

使用者可在瀏覽模式按 `P` 暫停目前 session。

暫停時工具需：

```text
1. 保存目前 batch name
2. 保存目前圖片檔名
3. 保存目前圖片排序清單的狀態
4. 保存最近 3 次 undo stack
5. 保存 Q/W/E/R 操作統計
6. 顯示暫停畫面
```

暫停不應搬移目前尚未分類的圖片。

### 9.2 恢復行為

工具啟動時若偵測到 `state/current-session.json`，應提供恢復目前 session 的行為。

MVP 1.0 可採用預設自動恢復：

```text
1. 若 state 存在且 Input/ 仍有圖片，從上次目前圖片繼續
2. 若上次目前圖片已不存在，跳到排序清單中下一張仍存在的圖片
3. 若沒有可繼續圖片，顯示批次完成畫面
```

若 state 損壞或與實際檔案不一致，工具不可崩潰，應顯示可恢復的錯誤提示並重新掃描 `Input/`。

### 9.3 統計畫面

工具需提供本批次統計，並在以下情況顯示：

- 使用者按 `P` 暫停時。
- `Input/` 沒有剩餘可處理圖片時。
- 使用者在畫面中點擊或使用快捷鍵查看統計時。

MVP 1.0 統計至少包含：

```text
Batch: YYYY-MM-DD
Input remaining: 目前剩餘張數
Extract text: Q 累計張數
Keep image: W 累計張數
Review later: E 累計張數
Trash candidate: R 累計張數
Total processed: 已處理總張數
Started at: session 開始時間
Last updated: 最後操作時間
```

統計資料來源以 log 與 state 為準，實作時需避免只依賴前端記憶體。

## 10. Log 規格

工具需產生 append-only JSONL log。

位置：

```text
logs/YYYY-MM-DD.jsonl
```

每一行為一個 JSON object。

### 10.1 Q/W log 範例

```json
{
  "timestamp": "2026-06-21T16:30:00+08:00",
  "batch": "2026-06-21",
  "action": "extract-text",
  "source": "Input/IMG_1234.png",
  "archived_original": "archive/originals/2026-06-21/IMG_1234.png",
  "output": "staging/extract-text/2026-06-21/0001__IMG_1234.png",
  "crop": {
    "mode": "free",
    "x": 120,
    "y": 350,
    "width": 900,
    "height": 420
  }
}
```

### 10.2 E/R log 範例

```json
{
  "timestamp": "2026-06-21T16:31:00+08:00",
  "batch": "2026-06-21",
  "action": "trash-candidate",
  "source": "Input/IMG_1235.png",
  "output": "staging/trash-candidate/2026-06-21/IMG_1235.png"
}
```

### 10.3 Undo log 範例

```json
{
  "timestamp": "2026-06-21T16:32:00+08:00",
  "batch": "2026-06-21",
  "action": "undo",
  "undo_of": "trash-candidate",
  "restored": "Input/IMG_1235.png"
}
```

## 11. App 型態與啟動方式

### 11.1 推薦技術方向

MVP 1.0 建議做成本地 web app：

```text
Node.js local server + browser frontend
```

理由：

- 瀏覽器適合做全螢幕圖片預覽。
- 前端可用 Canvas 或瀏覽器原生能力實作裁剪。
- Node.js 後端負責讀取資料夾、搬移檔案、保存裁剪結果、寫 log。
- 使用者可用一個指令啟動，開啟 localhost 後直接使用。

### 11.2 預期啟動方式

MVP 1.0 目標：

```text
npm start
```

實作補充（2026-07-11）：專案根目錄的 `Start_Tool.bat` 也是啟動入口，效果等同 `npm start`。

啟動後：

```text
1. 檢查 Input/ 是否存在，不存在則建立
2. 檢查 staging/ archive/ logs/ 是否存在，不存在則建立
3. 啟動本地 server
4. 顯示本地網址，例如 http://localhost:3030
5. 使用者開啟後立即開始 review
```

後續可擴充：

```text
npm run review
npm run status
npm run extract
```

MVP 1.0 只需要 `review` 功能。（`npm run status` / `npm run extract` 未實作，屬後續版本。）

## 12. MVP 1.0 功能 Checklist

### 12.1 專案初始化

- [x] 建立 Node.js 專案。
- [x] 建立本地 server。
- [x] 建立前端 viewer 頁面。
- [x] 建立 `Input/` 掃描邏輯。
- [x] 建立必要資料夾自動初始化。

### 12.2 圖片載入

- [x] 掃描 `Input/` 中支援格式圖片。
- [x] 忽略非圖片檔。
- [x] 依檔案名稱排序。
- [x] 顯示目前圖片。
- [x] 顯示檔名、進度、批次日期。
- [x] Input 為空時顯示空狀態。

### 12.3 瀏覽模式

- [x] 大圖預覽。
- [x] 深色背景。
- [x] 上一張 / 下一張。
- [x] 左右鍵長按可快速切換圖片。
- [x] 上下鍵可縮放目前圖片。
- [x] 滾輪在圖片上可縮放目前圖片。
- [x] 滾輪在圖片外空白處可切換上一張 / 下一張。
- [x] 放大後可用滑鼠左鍵拖曳移動畫面。
- [x] Q 進入文字提取裁剪模式。
- [x] W 進入裁剪圖片模式。
- [x] E 直接分類到稍後處理。
- [x] R 直接分類到候選刪除。
- [x] Z undo 最近 3 次操作。
- [x] P 暫停並顯示統計畫面。（⚠️ 獨立統計查看入口（不暫停純查看，§9.3）未實作，移列 MVP2）
- [x] G 開始 / 結束文字 group。
- [x] Shift+G 取消目前尚未結束的文字 group。

### 12.4 裁剪模式

- [x] 滑鼠拖曳建立裁剪框。
- [x] 可調整裁剪框大小。
- [x] 可拖曳移動裁剪框。
- [x] Enter / Space 確認。
- [x] Esc 取消。
- [x] 沒有裁剪框時 Enter 使用整張圖片。
- [x] 支援自由裁剪。
- [x] 支援 1:1。
- [x] 支援 3:4。
- [x] 支援 16:9。
- [x] 裁剪輸出圖片品質可讀，不明顯壓縮劣化。

### 12.5 檔案搬移與輸出

- [x] 未開 group 的 Q 輸出裁剪圖到 `staging/extract-text/YYYY-MM-DD/single/`。（⚠️ 輸出流水號取自 stats.processed+1，E/R 也累加，Q/W 序號會跳號）
- [x] 開 group 的 Q 輸出裁剪圖到 `staging/extract-text/YYYY-MM-DD/group-###/`。
- [x] W 輸出裁剪圖到 `staging/keep/YYYY-MM-DD/`。
- [x] Q/W 原圖移到 `archive/originals/YYYY-MM-DD/`。
- [x] E 原圖移到 `staging/review-later/YYYY-MM-DD/`。
- [x] R 原圖移到 `staging/trash-candidate/YYYY-MM-DD/`。
- [x] 檔名衝突時不覆蓋既有檔案。
- [x] 檔案操作失敗時顯示錯誤，不跳過或吞掉錯誤。

### 12.6 Log 與 Undo

- [x] 每次操作寫入 JSONL log。
- [x] Q/W log 記錄 crop 座標。
- [x] E/R log 記錄來源與目的地。
- [ ] Z 可還原最近 3 次操作。（⚠️ 部分：undo 可還原檔案，但 restored 檔插到 fileOrder 最前，非原本排序位置）
- [x] Undo 操作也寫入 log。
- [ ] Undo 失敗時顯示錯誤並保留現狀。（⚠️ 部分：有顯示錯誤，但未寫 log，§8.3 要求需寫 log）

### 12.7 暫停、恢復與統計

- [ ] 按 P 可保存目前 session。（⚠️ 部分：保存的是最後分類位置，前端方向鍵瀏覽位置不會回傳 server）
- [ ] 暫停時顯示本批次統計。（⚠️ 部分：未顯示 Started at / Last updated，後端有回傳但 UI 未顯示）
- [x] 重啟工具後可從上次圖片附近恢復。
- [x] 若上次圖片已不存在，可跳到下一張仍存在圖片。
- [x] Input 清空時顯示批次完成畫面。
- [x] 批次完成畫面顯示 Q/W/E/R 統計。
- [x] state 損壞時可重新掃描，不造成工具崩潰。

## 13. QA Checklist

### 13.1 啟動 QA

- [x] 沒有 `Input/` 時，工具可自動建立並顯示空狀態。
- [x] 有 `Input/` 且有圖片時，工具可成功載入第一張圖。
- [x] server 啟動後可在瀏覽器開啟。
- [x] 重複啟動不會破壞既有資料夾。

### 13.2 圖片格式 QA

- [x] `.png` 可載入與分類。
- [x] `.jpg` 可載入與分類。
- [x] `.jpeg` 可載入與分類。
- [x] `.webp` 可載入與分類。
- [x] `.bmp` 可載入與分類。
- [x] `.gif` 不列入圖片清單。
- [x] 非圖片檔不會造成工具崩潰。

### 13.3 快捷鍵 QA

- [x] Q 進入裁剪模式。
- [x] W 進入裁剪模式。
- [x] E 直接移動到稍後處理。
- [x] R 直接移動到候選刪除。
- [x] Z 可 undo 最近 3 次操作。
- [x] P 可暫停並顯示統計。（⚠️ 純查看統計（不暫停）的快捷鍵/點擊入口未實作，移列 MVP2）
- [x] G 可開始 / 結束文字 group。
- [x] Shift+G 可取消目前尚未結束的文字 group。
- [x] Esc 可從裁剪模式回瀏覽模式。
- [x] Enter / Space 可確認裁剪。
- [x] ArrowLeft / ArrowRight 可切換圖片。
- [x] ArrowLeft / ArrowRight 長按可連續切換圖片。
- [x] ArrowUp / ArrowDown 可縮放圖片。
- [x] 滾輪在圖片上可縮放圖片。
- [x] 滾輪在圖片外空白處可切換圖片。

### 13.4 裁剪 QA

- [x] 自由裁剪輸出範圍正確。
- [x] 1:1 裁剪比例正確。
- [x] 3:4 裁剪比例正確。
- [x] 16:9 裁剪比例正確。
- [x] 沒有選取 crop box 時，Enter 輸出完整圖片。
- [x] 裁剪後圖片沒有變形。
- [x] 裁剪後圖片與預覽框位置一致。
- [x] 裁剪框不遮住選取範圍內的圖片內容。

### 13.5 檔案安全 QA

- [x] R 不會真正刪除圖片。
- [x] Q/W 會保留原始圖片到 archive。
- [x] Undo 可把圖片移回 Input。（⚠️ restored 檔插到 fileOrder 最前，非原本排序位置）
- [x] 取消尚未結束的 group 可把 group 內圖片移回 Input。
- [x] 檔名衝突不會覆蓋舊檔。
- [ ] 操作失敗時不會產生半套分類結果。（⚠️ Q/W 為先寫輸出再搬原圖，兩步之間失敗無 rollback）

### 13.6 Log QA

- [x] 每次操作都有 log。
- [x] log 是有效 JSONL。
- [x] crop 座標可追溯。
- [x] undo log 可看出回復了哪個操作。

### 13.7 暫停恢復 QA

- [x] 處理數張圖片後按 P，統計數字正確。（⚠️ Started at / Last updated 未顯示於 UI）
- [x] 關閉 server 後重新啟動，可從上次進度繼續。（⚠️ 恢復點為最後分類位置，非前端瀏覽位置）
- [x] 暫停後不會搬移尚未分類的目前圖片。
- [x] 重啟後 undo stack 最多保留最近 3 次。
- [x] 手動移動上次圖片後重新啟動，工具能跳到下一張可處理圖片。
- [x] 全部圖片處理完後顯示完成畫面與統計。

## 14. 驗收標準

MVP 1.0 可視為完成，需滿足（2026-07-11 驗收：12 條中 11 條達成）：

- [x] 使用者可以透過單一啟動指令開啟工具。
- [x] 工具能讀取 `Input/` 的主流圖片格式。
- [x] 使用者可以在全螢幕感的大圖預覽中逐張 review。
- [x] Q/W 能完成裁剪與分類。
- [x] E/R 能完成直接分類。
- [x] Z 能 undo 最近 3 次操作。
- [x] P 能暫停並保存目前 session。
- [x] 重啟後能恢復上次進度。
- [ ] 批次完成時能顯示 Q/W/E/R 統計。（⚠️ 完成/暫停畫面已顯示統計，但 §9.3 要求的獨立統計查看入口（快捷鍵/點擊、不暫停純查看）未實作，且 Started at / Last updated 未顯示於 UI，移列 MVP2）
- [x] 工具不會直接刪除任何圖片。
- [x] 所有操作都有 log。
- [x] 裁剪輸出與原圖來源可追溯。

## 15. 後續版本候選功能

> MVP2 規劃見 [[Plan_Screenshot_Triage_MVP2]]。以下候選功能於 MVP1 期間均未推進。

### 15.1 OCR 階段

- 對 `staging/extract-text/YYYY-MM-DD/` 執行 OCR。
- 產生 `output/text/YYYY-MM-DD.md`。
- 每張圖片成為一個 markdown chapter。
- OCR 只做原文擷取，不摘要、不改寫。
- OCR 後圖片移到 `output/pending-delete/YYYY-MM-DD/`，等待人工確認。

### 15.2 AI 後處理

- 將 OCR markdown 交給 AI 整理成筆記。
- 根據內容自動產生 tag。
- 將資訊整理成 task、reference、idea、quote 等分類。
- 將整理結果輸出到 Obsidian 或 Notion。

### 15.3 審閱效率

- 超過 3 次的完整多步 undo。
- 快速批次選取。
- 顯示縮圖列。
- 自訂快捷鍵。
- 自訂分類資料夾。
- 啟動時選擇 batch name。
- 支援滑鼠手勢或觸控 swipe。

### 15.4 圖片處理

- 旋轉圖片。
- 放大鏡。
- 自動去除手機狀態列。
- 自動偵測文字區塊並提供 crop 建議。
- 圖片壓縮或格式轉換。
- 支援 HEIC。

### 15.5 Validation 與安全

- dry-run 模式，只顯示將搬移哪些檔案。
- 匯出更完整的 batch summary markdown。
- 檢查 staging 與 archive 是否有孤兒檔案。
- 根據 log 產生還原報告。
- 對輸出檔產生 checksum。

## 16. 開發前決策與待確認問題

以下為開始實作前已確認的 MVP 1.0 決策：

- [x] `Input/` 固定使用目前大小寫，不改為 `input/`。
- [x] Q/W 原圖移到 `archive/originals/YYYY-MM-DD/`，不保留在 `Input/`。
- [x] 圖片排序使用檔案名稱排序。
- [x] `.gif` 不列入 MVP 1.0 支援範圍。
- [x] Undo 支援最近 3 次操作。
- [x] Q/W 都開放比例裁剪，但 Q 預設自由裁剪。
- [x] 需要本批次完成畫面與 Q/W/E/R 統計。
- [x] 需要可隨時暫停並於下次啟動恢復 session。
