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

## 快捷鍵

| 畫面 | 按鍵 | 動作 |
|---|---|---|
| Grid | ← ↑ → ↓ / PageUp / PageDown / Home / End | 移動焦點 |
| Grid | Enter、雙擊 | 開啟單張檢視 |
| Grid | Space | 切換選取 |
| Grid | Shift / Ctrl + 點擊、Shift + 方向鍵 | 範圍 / 追加選取 |
| Grid | Ctrl + A / Esc | 全選 / 取消選取 |
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
