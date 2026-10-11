# Reference：Photo Library v2

> 從 [[Sprint_Photo_Library_v2]] 已驗收項目（P0、P1，2026-10-11）萃取的持久知識。Sprint 文件保留為不可變快照；本檔是之後查詢的入口。程式碼在 `v2/`，使用說明在 `v2/README.md`。

## 架構一覽

| 層 | 實作 | 位置 |
|---|---|---|
| Server | Fastify 5，**只綁 127.0.0.1**，預設 port 3040 | `v2/server/app.mjs`、`index.mjs` |
| DB | `node:sqlite`（Node 24 內建，SQLite 3.53.4）＋ WAL＋FTS5 trigram；`PRAGMA user_version` 遷移 | `v2/server/db.mjs`、`migrations/NNN_*.sql` |
| 匯入 | 受管理模式：hash → 去重 → 複製（tmp＋rename）→ 重新驗 hash → 寫 DB；來源永不改動 | `v2/server/importer.mjs` |
| 縮圖 | sharp → WebP 256／1024，首次請求時產生並快取；並發 4、**LIFO**、放棄的請求跳過 | `v2/server/thumbs.mjs` |
| 目錄 | tag／album／folder／smart album 的 CRUD、批次套用、facet | `v2/server/catalog.mjs`、`routes-catalog.mjs` |
| 查詢 | 字串語法 ⇄ AST → 參數化 SQL | `v2/server/query.mjs` |
| 前端 | Svelte 5＋Vite，build 輸出 `v2/dist/`（gitignored，由 server 靜態提供） | `v2/web/src/` |

## 照片庫目錄（library）

```text
<library>/library.db
<library>/originals/<yyyy>/<mm>/<sha256 前 2 碼>/<原檔名>   （同名不同內容 → __2、__3）
<library>/thumbs/<sha256 前 2 碼>/<sha256>_<256|1024>.webp   （可整個刪除，會自動重建）
<library>/exports/
```

- 位置：`--library` > `PHOTO_LIBRARY` > `~/PhotoLibrary`；本機慣例 `D:\PhotoLibrary`（`v2/Start_Library.bat`）。
- `library_roots.path` 對 managed root 存相對路徑 `originals`，library 整個搬家仍可用。
- 匯入**跳過 library 自身目錄**（匯入其上層資料夾時不會把縮圖當照片）。
- 支援 png／jpg／jpeg／webp；bmp／gif／heic／heif／tif／tiff／avif 回報為「不支援」（sharp prebuilt 不讀 BMP，見 technotes node-013）。

## 資料語意

- **Album**＝手動策展集合，多對多，`album_items.position` 排序（`reorder` API 已有，UI 拖曳排序未做）；**Folder** 只是 album 的分組，刪資料夾時 album 移到頂層。
- **Tag** 以 `parent_id` 分層；建立時可傳路徑 `a/b/c` 自動補齊祖先；同層名稱唯一（`COALESCE(parent_id,0), name` 索引）。
- **系統 tag**（`is_system=1`，不可改名／刪除／移動）：`sensitive`、`ocr/low-yield`、`triage/later`（migration `002`）。
- 刪除 tag 會連子樹與所有標記一起刪；刪除 album 只刪集合本身；兩者都**不刪照片**，且寫入 `events.undo_json` 供 P2 undo。
- 被其他智慧相簿引用的智慧相簿不能刪（409，列出引用者）。

## 查詢語言

- 語法與範例見 `v2/README.md`「相簿、Tag 與篩選」。要點：
  - 優先序 `NOT`（或 `-` 前綴）＞ `AND`（空白即 AND）＞ `OR`；括號分組。
  - `tag:x` 含整個子樹，`tag:=x` 只比對該層；`album:#12`／`tag:#5`／`smart:#3` 以 id 指定。
  - 引號內 `\"`、`\\` 跳脫；名稱不明時回 400 並附訊息。
  - 預設隱藏 `status != 'active'`，查詢中出現 `status:` 才改變。
  - 裸字＝搜尋檔名、note 與 OCR 文字（目前用 LIKE，`%`、`_` 已跳脫；FTS 排序待 P3）。
  - 智慧相簿巢狀上限 8 層（`MAX_SMART_DEPTH`），自我參照在存檔時即被拒。
- 前端篩選狀態（`v2/web/src/lib/filter.js`）：側欄三態 → AST；包含的 tag 預設「全部符合」、包含的 album 預設「任一」；狀態序列化在 URL hash `#f=`；目錄重新載入後會清掉指向已刪項目的條件。
- Facet：父 tag 的數字是**子樹去重後**的照片數，統計範圍是目前查詢結果。

## 已知風險與限制

- `node:sqlite` 在 Windows 曾有 file-backed bulk insert 硬當機的紀錄（knowledge/node.md）；本專案在 Node 24.20.0 以 5 萬列交易反覆測試未重現。`v2/test/perf.test.mjs` 每次 `npm test` 都會跑這條路徑；若重現，退路是換 better-sqlite3（API 幾乎一對一）。
- CLI 匯入（`cli/import.mjs`）與 server 內的匯入沒有互斥。
- 智慧相簿引用到已刪除的相簿／tag 時會安靜回 0 張。

## 測試

`cd v2 && npm test`：62 項（匯入、API、5 萬列效能、目錄／查詢、filter 單元、縮圖佇列）。關鍵防護都經 mutation 驗證會轉紅（紀錄見 Sprint P0／P1 驗收紀錄）。
