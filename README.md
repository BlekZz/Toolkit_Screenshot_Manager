# 截圖快速整理工具

本工具是本地端截圖審閱與分流 app。把圖片放進 `Input/` 後，啟動工具即可用大圖預覽、快捷鍵、裁剪模式快速分類。

## 啟動

可直接雙擊：

```text
Start_Tool.bat
```

或在此資料夾執行：

```powershell
npm start
```

開啟終端機顯示的網址，預設為：

```text
http://localhost:3030
```

連接埠可用環境變數 `PORT` 覆寫。

## 快捷鍵

| 按鍵 | 行為 |
|---|---|
| Q | 進入裁剪模式，輸出到 `staging/extract-text/YYYY-MM-DD/single/` 或 `group-###/` |
| W | 進入裁剪圖片模式，輸出到 `staging/keep/YYYY-MM-DD/` |
| E | 移到 `staging/review-later/YYYY-MM-DD/`，本輪不再 loop |
| R | 移到 `staging/trash-candidate/YYYY-MM-DD/` |
| Z | Undo 最近 3 次操作 |
| P | 暫停並顯示本批次統計 |
| G | 開始 / 結束文字 group |
| Shift + G | 取消目前尚未結束的文字 group，並復原已加入圖片 |
| Enter / Space | 確認裁剪 |
| Esc | 取消裁剪 |
| 1/2/3/4 | 自由、1:1、3:4、16:9 裁剪比例 |
| ↑ / ↓ | 縮放目前預覽圖片 |
| 滾輪在圖片上 | 縮放目前預覽圖片 |
| 滾輪在圖片外空白處 | 上一張 / 下一張 |
| ← / → 或 A / D | 上一張 / 下一張，長按可快速切換 |
| Enter / Space / Esc（統計畫面中） | 繼續整理 |

放大預覽圖片後，可用滑鼠左鍵拖曳移動畫面。進入 Q/W 裁剪模式時，預覽縮放會重置，以保持裁剪座標準確。

## 檔案規則

- `Input/` 固定大寫。
- Q/W 會輸出裁剪圖，並把原圖移到 `archive/originals/YYYY-MM-DD/`。
- Q 沒有開 group 時輸出到 `staging/extract-text/YYYY-MM-DD/single/`。
- Q 開啟 group 時輸出到 `staging/extract-text/YYYY-MM-DD/group-###/`。
- E/R 只移動原圖，不真正刪除。
- `.gif` 不支援。
- 圖片依檔案名稱排序。
- 每次操作會寫入 `logs/YYYY-MM-DD.jsonl`。
- 目前進度保存在 `state/current-session.json`，可下次啟動後繼續。

## 文字擷取（OCR）

把 `staging/extract-text/` 累積的分流圖片批次轉成 markdown 文字（使用 Windows 內建 OCR，語言 zh-Hant-TW）：

```powershell
npm run extract
```

- 預設處理所有尚未處理的批次；指定單一批次用 `node extract.mjs --batch 2026-06-21`。
- 輸出到 `output/text/YYYY-MM-DD.md`：`single/` 每圖一章，`group-###/` 合併成一章並列出來源檔名。
- OCR 完成的圖片移到 `output/pending-delete/YYYY-MM-DD/`（保留 single/group 子結構），確認 md 內容沒問題後可整批刪除。
- OCR 結果為空或極短的圖判定為 low-yield：不移動、留在 staging，md 中標註 `⚠️ low-yield`（留給未來 vision fallback 處理）。
- 已處理紀錄保存在 `state/extract-state.json`，重跑只處理新增檔案；每張圖與批次摘要寫入 `logs/<批次>.jsonl`。
- ⚠️ PowerShell 會把 `npm run extract -- --batch X` 的 `--` 剝掉，導致參數遺失而跑全部批次；請直接用 `node extract.mjs --batch X`。
