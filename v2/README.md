# Photo Library v2

本機照片庫（截圖為主）：匯入 → 縮圖 grid 瀏覽 → 單張檢視；後續加入 Album / Tag / filter、Triage、OCR 文字整合。
規劃與進度：[`dev/Sprint_Photo_Library_v2.md`](../dev/Sprint_Photo_Library_v2.md)。舊版分流工具（repo 根目錄）照常使用，互不影響。

## 啟動

雙擊 `Start_Library.bat`（首次會自動 `npm install` 與 build），或：

```powershell
cd v2
npm install
npm run build
$env:PHOTO_LIBRARY = "D:\PhotoLibrary"
npm start            # http://127.0.0.1:3040（僅綁 127.0.0.1）
```

- 照片庫位置：`--library <dir>` > 環境變數 `PHOTO_LIBRARY` > `~/PhotoLibrary`。放在 repo 外，內容是使用者資料不入版控。
- 連接埠：`--port <n>` 或 `PORT`，預設 3040。
- 前端開發：另開終端 `npm run dev:web`（Vite，http://127.0.0.1:5173，API 代理至 3040）。

## 匯入

- UI：右上角「匯入」→ 輸入資料夾完整路徑。
- CLI：`node cli/import.mjs "D:\Screenshots" [--library <dir>] [--no-recursive]`
- 行為：檔案**複製**進 `originals/<yyyy>/<mm>/<sha 前 2 碼>/`，依 SHA-256 去重（重跑冪等），複製後重新驗 hash；**來源檔永不移動或刪除**。
- 支援 PNG / JPG / WebP；BMP / GIF / HEIC / TIFF / AVIF 列為不支援並回報。

## 照片庫結構

```text
<library>/
  library.db        SQLite（WAL）— 所有 metadata
  originals/        受管理原圖
  thumbs/           WebP 縮圖快取（首次顯示時產生，可整個刪除後自動重建）
  exports/          匯出（P2+）
```

## 相簿、Tag 與篩選

- **相簿**＝你手動策展的集合（一張照片可以放進多本，可以放在資料夾裡）；**Tag**＝照片屬性（可分層，例如 `類型/收據`）。
- **側欄三態篩選**：點擊＝包含（綠 ✓），`Alt`+點擊＝排除（紅 ⊘），再點一次＝取消。數字是「目前結果裡有幾張」。
- 多個包含的相簿／tag 之間可以在篩選列切換「任一／全部」。
- **加入**：選取照片後按 `T`（tag）、`B`（相簿），或直接把照片拖到側欄的相簿／tag 上；輸入不存在的名稱會直接建立。`Shift+T`／`Shift+B` 移除。
- **管理**：側欄項目按右鍵可以重新命名、改顏色、移動、刪除。刪除相簿或 tag **不會刪除照片**。
- **進階查詢**（篩選列輸入框，`/` 聚焦）：

  | 語法 | 意思 |
  |---|---|
  | `NOT album:X`、`-album:X` | 排除相簿 X |
  | `album:客戶A tag:類型/收據` | 相簿 A 裡帶「收據」的（空白＝AND） |
  | `tag:類型` / `tag:=類型` | 含所有子 tag / 只有這一層 |
  | `(tag:收據 OR tag:發票) AND NOT album:"已報帳"` | 括號、OR、引號 |
  | `has:album` `has:tag` `date:2026-09` `date:2026-09-01..2026-09-15` `ext:jpg` `status:trashed` | 其他條件 |
  | 任何其他文字 | 搜尋檔名（P3 起也搜尋 OCR 文字） |

- **智慧相簿**：篩選好後按「存為智慧相簿」，之後符合條件的新照片會自動出現。「未歸類」是內建的智慧相簿（沒有相簿也沒有 tag）。
- 篩選狀態會寫進網址，可以加書籤。
- 系統 tag：`sensitive`（P3 起禁止外送 LLM）、`ocr/low-yield`、`triage/later`，不可刪除或改名。

## 快捷鍵

| 畫面 | 按鍵 | 動作 |
|---|---|---|
| Grid | ← ↑ → ↓ / PageUp / PageDown / Home / End | 移動焦點 |
| Grid | Enter、雙擊 | 開啟單張檢視 |
| Grid | Space | 切換選取 |
| Grid | Shift / Ctrl + 點擊、Shift + 方向鍵 | 範圍 / 追加選取 |
| Grid | Ctrl + A / Esc | 全選 / 取消選取 |
| Grid | T / B | 為選取（或焦點）照片加 tag / 加入相簿 |
| Grid | Shift + T / Shift + B | 移除 tag / 移出相簿 |
| Grid | / | 聚焦進階查詢 |
| Grid | \ | 切換側欄 |
| 單張 | T / B | 為目前照片加 tag / 加入相簿 |
| 單張 | ← → / A D | 上一張 / 下一張 |
| 單張 | 滾輪、+ − ↑ ↓ | 以游標為中心縮放 |
| 單張 | 拖曳 | 平移 |
| 單張 | 0 / 1 / 雙擊 | 符合視窗 / 100% / 切換 |
| 單張 | I | 資訊面板 |
| 單張 | Esc / Enter | 返回 grid |

## 測試

```powershell
npm test
```

涵蓋匯入（去重、hash 一致、冪等、路徑防護）、HTTP API（真實 server、127.0.0.1 綁定、id 驗證、縮圖、併發匯入 409）、5 萬筆列表效能。
