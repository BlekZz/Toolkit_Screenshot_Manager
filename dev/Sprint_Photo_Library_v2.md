# Sprint：Photo Library v2（截圖照片庫重建）

> 建立日期：2026-10-11。2026-10-11 承諾執行，由 `Plan_Photo_Library_v2` 更名為 Sprint；進度在本文件內追蹤。
> 與 [[Sprint_Screenshot_Triage_MVP2]] 並行——舊工具在 v2 完成 P2 並 migration 前持續使用，本計畫不修改舊工具任何檔案。

## 進度追蹤

| 里程碑 | 狀態 | 備註 |
|---|---|---|
| Spike（§9.1） | ✅ 完成 | 2026-10-11：node:sqlite / sharp / Svelte 5 定案 |
| P0 地基 | 🔄 進行中 | |
| P1 歸類與 filter | ⏳ | |
| P2 Triage 與裁剪 | ⏳ | |
| P2.5 Migration | ⏳ | |
| P3 文字整合 | ⏳ | |
| P4 加值 | ⏳ | |

## 1. 目標與定位

把「以資料夾路徑表達分類」的截圖分流工具，重建為 **metadata 驅動的本機照片庫**：

- 大量載入照片後，以 **Album（策展集合）＋ Tag（屬性）** 多對多歸類。
- All view 可依 album / tag 做 include / exclude / AND / OR 組合 filter，並存成 Smart Album。
- 保留並升級現有能力：鍵盤 Triage、裁剪、group → OCR → 文字整合（新增 LLM 整合翻譯）。

### 1.1 已裁定的設計決策（2026-10-11 與 Blake 討論）

| # | 決策 | 結論 |
|---|---|---|
| D1 | 檔案存放 | **受管理＋原地引用兩者皆支援**；schema 一開始即支援兩模式，P0 只實作受管理，原地引用排 P2+ |
| D2 | Album / Tag 語意 | **並存分工**：Album＝手動策展（多對多、可排序、可巢狀資料夾）；Tag＝屬性（可分層） |
| D3 | 內容與規模 | **以截圖為主，< 5 萬張**（PNG/JPG/WebP/BMP；不做 HEIC、影片、GPS） |
| D4 | 文字整合 | **Windows OCR ＋ LLM（Claude API）整合／翻譯** |
| D5 | LLM 隱私 | **兩者都做**：只在每個 bundle 手動觸發才外送（永不自動批次）；帶 `sensitive` 系統 tag 的圖一律禁止外送 |
| D6 | Inbox 概念 | **取消 inbox**：匯入即進公共 library，任何時候都可補 tag / album；Triage 改為「對任一 filter 結果跑的鍵盤模式」 |
| D7 | 舊工具 | **繼續使用**，v2 完成 P2 後一次性 migration 切換 |

### 1.2 不做（範圍外）

多使用者 / auth / 雲端同步、HEIC / RAW / 影片、人臉辨識、地圖、照片編輯（調色等；裁剪除外）、行動版 UI。

## 2. 核心概念模型

| 物件 | 語意 | 關鍵規則 |
|---|---|---|
| Asset | 一張原圖 | SHA-256 去重；`status`: `active` / `trashed` / `missing`（原地引用斷連結） |
| Album | 手動策展集合 | 多對多；album 內可排序、可設封面；`album_folders` 巢狀分組 |
| Tag | 屬性 | `parent_id` 分層（`類型/收據`）；顏色；`asset_tags.source`: manual / ocr / ai / migration |
| System tag | 內建保留 tag | `sensitive`（禁外送）、`ocr/low-yield`、`triage/later`；不可刪 |
| Smart Album | 存檔的 filter 查詢 | 只存查詢 AST，開啟時即時評估 |
| Crop | 非破壞裁剪 | 只存裁剪框（相對座標 0–1）；匯出或 OCR 時才 render；一圖可多 crop |
| Text Bundle | 有序的 asset / crop 組 | 取代 `group-###/`；承載 OCR 結果與 LLM revision |

**「未整理」不再是資料夾，而是一個查詢**：內建 Smart Album「未歸類」＝ `NOT has:album AND NOT has:tag`。

## 3. 資料模型（SQLite）

```sql
library_roots   (id, path, mode TEXT CHECK(mode IN ('managed','referenced')), created_at)
assets          (id, root_id, rel_path, sha256 UNIQUE, filename, ext, width, height,
                 bytes, file_mtime, imported_at, status, rating, note)
albums          (id, folder_id NULL, name, cover_asset_id NULL, sort_mode, created_at)
album_folders   (id, parent_id NULL, name)
album_items     (album_id, asset_id, position, added_at, PRIMARY KEY(album_id, asset_id))
tags            (id, parent_id NULL, name, color, is_system, UNIQUE(parent_id, name))
asset_tags      (asset_id, tag_id, source, added_at, PRIMARY KEY(asset_id, tag_id))
smart_albums    (id, folder_id NULL, name, query_json, created_at)
crops           (id, asset_id, x, y, w, h, ratio_label, created_at)        -- 0..1 相對座標
bundles         (id, name, status, created_at, updated_at)
bundle_items    (bundle_id, position, asset_id, crop_id NULL)
ocr_results     (id, asset_id, crop_id NULL, engine, lang, raw_text, cleaned_text,
                 char_count, created_at)
bundle_revisions(id, bundle_id, kind TEXT CHECK(kind IN ('ocr_merge','llm','manual')),
                 model NULL, prompt_hash NULL, text, created_at)          -- 只增不改
ocr_fts         -- FTS5 虛擬表，索引 ocr_results.cleaned_text ＋ bundle_revisions.text
events          (id, ts, actor, action, payload_json, undo_json NULL)      -- 審計 + undo
settings        (key, value)
```

- 開 WAL；`events` 承接舊工具 JSONL log 的審計職責與 undo。
- `bundle_revisions` 只追加：OCR 原文永不被 LLM 結果覆寫。

## 4. 檔案存放（D1）

```text
<library>/
  library.db
  originals/<yyyy>/<mm>/<sha256前2碼>/<原檔名>   ← managed 模式
  thumbs/<sha256>_{256,1024}.webp              ← 可再生快取，不入備份必要集合
  exports/                                      ← crop / md 匯出
```

- **匯入（managed）**：複製 → 驗 hash → 寫 DB；來源檔是否刪除由使用者選（預設保留）。重複 hash 直接略過並回報。
- **原地引用（P2+）**：只記 `root_id + rel_path + sha256`；重新掃描時依 hash 自動 relink 搬動過的檔案，找不到標 `missing`（metadata 保留，不刪）。
- library 位置預設在本 repo 外（照片是使用者資料，不入版控），由 `settings` / 啟動參數指定。

## 5. Filter 規格

### 5.1 查詢語法（搜尋框進階輸入；UI chip 生成同一 AST）

```text
expr    := term | expr AND expr | expr OR expr | NOT expr | ( expr )
term    := album:<name> | tag:<path> | has:album | has:tag | has:crop | has:ocr
         | text:"<fts query>" | date:<yyyy[-mm[-dd]]>[..<…>] | ext:<png|jpg|…>
         | rating:>=N | status:<trashed|missing> | smart:<name>
```

- `tag:類型` 預設**包含子 tag**（`類型/收據`、`類型/發票`）；`tag:=類型` 為精確匹配。
- 預設排除 `status:trashed`，除非查詢明確指定。
- AST 以 JSON 存進 `smart_albums.query_json`；後端編譯為參數化 SQL（`EXISTS` 子查詢），絕不字串拼接。

### 5.2 對照使用者情境

| 情境 | 查詢 |
|---|---|
| 所有照片，除了 xx album | `NOT album:xx` |
| 只看 xx album 內的 yy tag | `album:xx AND tag:yy` |
| 跨 album 的 yy tag | `tag:yy`（UI 可切「依 album 分組」） |
| 未歸類 | `NOT has:album AND NOT has:tag` |

### 5.3 UI 互動

- 側欄 album / tag 樹每項為**三態**：點擊＝include（綠）、Alt+點擊＝exclude（紅）、再點＝取消。
- 頂部 chip 列顯示生效條件，同類條件間可切 AND / OR。
- Facet count：每個 tag / album 顯示「在目前結果中的張數」。
- 「存為 Smart Album」一鍵保存；URL 帶查詢參數，可書籤。

## 6. 視圖

| 視圖 | 說明 |
|---|---|
| Grid | 虛擬捲動縮圖牆；Shift / Ctrl 多選；拖進 album；快捷鍵批次 tag；縮圖尺寸可調 |
| Loupe | 單張大圖（移植現有 viewer 縮放 / 拖曳）；側欄 metadata、tag、album、crops、OCR 文字 |
| Triage | 對**目前 filter 結果**逐張跑鍵盤流程（見 §7） |
| Bundle | 左：有序圖 / crop 縮圖（可拖曳排序）；右：OCR 原文 ↔ LLM revision 對照編輯 |
| Settings | library roots、快捷槽、LLM 設定、匯入 |

## 7. Triage 模式（D6 後的新語意）

- 不再有 inbox：Triage 是 **「對任一查詢結果逐張處理」** 的模式，預設來源為「未歸類」Smart Album；處理過的圖因有 tag / album 自然離開該查詢。
- 預設鍵位（可自訂）：

| 鍵 | 動作 |
|---|---|
| Q | 裁剪 → 加入目前 bundle（未開 bundle 時建立 single bundle） |
| W | 裁剪 → 存 crop（keep） |
| E | 加 `triage/later` 系統 tag，跳下一張 |
| R | 移入 trash（軟刪除） |
| 1–9 | **快捷槽**：各綁一個 tag 或 album，toggle 套用 |
| G / Shift+G | 開始・結束 bundle／取消目前 bundle |
| Z | undo（走 `events.undo_json`，深度 ≥ 20） |
| S | 本 session 統計 |

- 裁剪比例、縮放、拖曳、滾輪換圖等現有行為照搬。

## 8. 文字整合管線（D4 / D5）

```text
Bundle(有序 asset/crop)
  → [OCR] Windows OCR（沿用 extract-ocr.ps1：2x Fant 放大 + cleanText） → ocr_results
  → [merge] 依序拼接 → bundle_revisions(kind=ocr_merge)
  → [LLM，手動按鈕] 圖 + OCR 文字送 Claude API：修錯字／合併／(可選)翻譯
        → bundle_revisions(kind=llm, model, prompt_hash)
  → [manual] 使用者編修 → bundle_revisions(kind=manual)
  → 匯出 exports/<bundle>.md（含來源回鏈）
```

- **外送閘（D5，雙重）**：
  1. LLM 只能由 bundle 頁的按鈕逐 bundle 觸發；API 層不提供批次端點。
  2. bundle 任一項帶 `sensitive` tag → server 端拒絕（403），UI 標示原因。檢查在 server，不只前端。
- 送出前 UI 顯示「將外送 N 張圖＋M 字」確認。
- 模型與 API key 走 `settings` + 環境變數（key 不入 DB、不入 log）；模型可設定，預設 `claude-sonnet-5-5`，可切 `claude-opus-5-5`。
- OCR < 5 字自動加 `ocr/low-yield` tag——LLM 帶圖整合即其出口（取代舊 MVP3 vision fallback）。
- 所有 OCR / revision 文字進 `ocr_fts`，`text:"…"` 可搜。

## 9. 技術架構

| 層 | 選擇 | 理由 |
|---|---|---|
| Runtime | Node.js 22+（ESM） | 沿用現環境與 OCR ps1 |
| DB | SQLite（`node:sqlite` 或 `better-sqlite3`，實作時 spike 定案）＋ FTS5 ＋ WAL | 單檔零維運；查詢＋全文搜一庫解決 |
| Server | Fastify（或 Hono），僅綁 127.0.0.1 | 路由量增加，原生 `http` 不再划算 |
| 縮圖 | `sharp` → WebP 256 / 1024 | 5 萬張 grid 流暢度關鍵 |
| 前端 | Svelte ＋ Vite（或 React，spike 定案）＋虛擬捲動 | 多選 / 拖曳 / facet 狀態量 |
| LLM | `@anthropic-ai/sdk` | D4 |
| 打包 | 先 web；Tauri 包桌面 app 留待 P4 後評估 | — |

> 與 MVP2 Sprint「不上 SQLite、不引入框架」的結論刻意相反：該結論前提是單純分流工具規模，本計畫需求已改變。

**程式碼位置**（已裁定）：本 repo 子目錄 `v2/`（獨立 `package.json`），根層舊工具不動。**Library 位置**（已裁定）：repo 外，`PHOTO_LIBRARY` 環境變數或 `--library` 指定（本機用 `D:/PhotoLibrary`）。

### 9.1 Spike 結果（2026-10-11，Node v24.20.0，scratchpad 實測）

| 項目 | 實測 | 定案 |
|---|---|---|
| SQLite driver | `node:sqlite`（SQLite 3.53.4）零原生相依；5 萬 asset＋15 萬 asset_tags＋FTS 寫入 266ms；`tag AND NOT album` EXISTS 查詢 11.7ms；FTS5 `tokenize='trigram'` 可用（CJK 查詢需 ≥3 字，<3 字退回 LIKE） | **node:sqlite**（免裝 better-sqlite3 原生模組） |
| 縮圖 | sharp 0.35.5，真實 `Input/` 100 張（PNG/JPG）→ 256px WebP 平均 58ms/張、零失敗；**不支援 BMP** | sharp；縮圖**首次請求時產生並落快取**＋並發上限，匯入不阻塞；BMP 列為不支援格式 |
| 前端 | 同一 5 萬格虛擬 grid＋Shift 範圍選取：Svelte 5.57 / React 19。捲動 p50 皆 16.7ms（vsync 上限，兩者皆不掉幀）；build 36KB（gzip 14KB）vs 221KB（gzip 69KB）；程式行數相當 | **Svelte 5**（效能打平，以體積與 `bind:clientWidth` 等內建響應式減少樣板取勝） |
| Server | — | Fastify（未 spike，成熟度足夠） |

## 10. 里程碑

| # | 里程碑 | 交付 | 完成後能做到 |
|---|---|---|---|
| P0 | 地基 | schema + migration 機制、managed 匯入（hash 去重）、縮圖、Grid、Loupe | 載入並瀏覽全部照片 |
| P1 | 歸類與 filter | Album / Tag CRUD（含分層、巢狀）、批次套用、查詢 AST + 編譯器、三態側欄、chip、facet、Smart Album | **本次核心需求** |
| P2 | Triage 與裁剪 | Triage 模式、快捷槽、非破壞 crop、undo（events）、trash、原地引用 roots + relink | 可取代舊工具日常分流 |
| P2.5 | Migration | 舊 `Input/`、`staging/*`、`archive/`、`output/` → v2（資料夾轉系統 tag，例如 `migration/keep`） | 舊工具退役 |
| P3 | 文字整合 | Bundle、OCR 接管、FTS、LLM 整合翻譯、外送閘、md 匯出 | 舊 OCR 管線完整接管並升級 |
| P4 | 加值 | AI tag 建議、相似 / 重複圖偵測、Tauri 評估 | — |

### 10.1 各里程碑 QA

**P0**
- [ ] 匯入 1,000 張：DB 筆數＝來源檔數－重複數；重複檔不產生第二筆（以同檔複製兩份實測）。
- [ ] 每張 managed 原圖 SHA-256 與來源一致。
- [ ] 5 萬張合成資料下 Grid 首屏 < 1s、捲動無白塊（以合成 fixture 測，不碰真實資料）。
- [ ] server 僅監聽 127.0.0.1（`netstat` 實測）。

**P1**
- [ ] §5.2 四個情境各以 fixture（已知答案集）驗證結果集完全相等。
- [ ] 子 tag 繼承：`tag:類型` 命中 `類型/收據`；`tag:=類型` 不命中。
- [ ] 查詢編譯器 SQL injection 測試：album 名稱含 `'`、`"`、`;`、`--` 正常運作。
- [ ] Smart Album 存檔後新增符合條件的照片，重開即出現。
- [ ] Facet count 與實際 filter 結果數一致（抽 5 個 tag 對帳）。

**P2**
- [ ] Triage 預設來源「未歸類」：套 tag 後該圖從來源查詢消失。
- [ ] undo 20 步全部還原（tag、album、crop、trash 各類動作）。
- [ ] 非破壞 crop：原圖 hash 不變；匯出 crop 尺寸符合框。
- [ ] 原地引用：在檔案總管搬動檔案後重新掃描，tag / album 保留且自動 relink；刪除檔案則標 `missing` 不刪 metadata。

**P2.5**
- [ ] migration 前後檔案數守恆對帳（各來源資料夾 vs DB 筆數）。
- [ ] migration 冪等：重跑零新增。
- [ ] 預設 dry-run，舊資料夾不搬不刪（舊工具仍可運作）。

**P3**
- [ ] OCR 輸出與舊 `extract.mjs` 對同一樣本一致（cleanText 規則行為零變更）。
- [ ] LLM 外送閘：含 `sensitive` tag 的 bundle，直打 API 回 403（server 端驗證，非 UI）。
- [ ] 不存在任何批次 LLM 端點（路由表審查）。
- [ ] OCR 原文 revision 在 LLM 執行後仍存在且未被修改。
- [ ] `text:"…"` 可搜到 OCR 與 LLM revision 內容。
- [ ] API key 不出現在 DB、log、events（grep 實測）。

## 11. 最終驗收 checklist

- [ ] 以真實照片庫完成 P2.5 migration，舊工具資料零遺失（對帳表）。
- [ ] 使用者於真機完成：匯入 → 建 album / tag → §5.2 四種 filter → 存 Smart Album → Triage 一輪 → 建 bundle → OCR → LLM 整合 → 匯出 md。
- [ ] 驗收由不同於實作者的 fresh-context agent 透過真實入口（HTTP / UI）執行。
- [ ] README 與本文件同步更新。

## 12. 待裁

- ~~程式碼位置~~ → `v2/`（2026-10-11 裁定）。~~library 路徑~~ → repo 外（2026-10-11 裁定）。~~框架 / driver~~ → spike 定案（§9.1）。
- 雙 album 拖曳時的語意（複製 vs 移動）：預設「加入」（多對多），按住 Shift 拖＝移出原 album。（P1 實作時確認）
