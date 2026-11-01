# Sprint：截圖 AI 分流建議（AI Triage Suggestions）

> 狀態：**執行中**（2026-11-01 Blake 決定執行，由 `Plan_Screenshot_AI_Triage` 更名）。建立 2026-11-01（claude）。
> 上游：[[Sprint_Photo_Library_v2]]（本計畫＝其 P4「AI tag 建議」的展開並提前規劃）、[[Reference_Photo_Library_v2]]。

## 進度追蹤

| # | 狀態 | 備註 |
|---|---|---|
| A0 評估基線 | ✅ 2026-11-01 | 見下方 A0 紀錄 |
| A1 便宜層 | ✅ 2026-11-01 | 後端與 CLI 完成並已在真實庫執行；matcher UI 移至 A2。sensitive 規則 recall 39%，未達 S3 前提 |
| A2 建議 UI | ⏳ | 依賴 v2 P2 Triage |
| A3 本機 VLM | ✅ 2026-11-01 | 全庫涵蓋 99.3%（4b＋8b 補跑）；只有 receipt 達預選門檻（見 A3 紀錄） |
| A4 動作綁定 | 🔄 | 後端（決定 API＋綁定表）先行，UI 隨 A2；bundle＋OCR 動作待 P3 |
| A5 雲端開關 | ⏳ | 外送閘依 Q8 裁定：只送人工確認非 sensitive 且非 chat 的圖 |

### A0 紀錄（2026-11-01）

- 程式：`v2/server/migrations/003_suggestions.sql`（`asset_suggestions`、`tags.description`、purpose／context 系統 tag、7 個 custom tag）、`v2/server/suggestions.mjs`（`importLabels`／`sampleForReview`／`evaluate`／`sanitizeReason`）、`v2/cli/suggest.mjs`。
- 測試：`npm test` 72／72（新增 `test/suggestions.test.mjs` 10 項，其中 1 項走真實 CLI）。mutation 7／7 被殺：dry-run 不回滾、Input/ 消歧、數字遮蔽、UNIQUE 冪等、重複抽樣、FN 計算、junk→ephemeral 對應。
- 真實資料：`Input/` 964 張匯入 `D:\PhotoLibrary`（imported 964、dup 0、err 0）；Claude 初標 964／964 匹配，寫入 2,134 條 pending 建議；抽樣 50 張進相簿「AI 確認樣本」（chat 10、ephemeral 10、receipt 10、text-note 10、visual-ref 9、translate 1），只有這 50 張套上 `source='ai'` tag（120 個）。
- HTTP 實測（真實 server，port 3041）：`album:"AI 確認樣本"`＝50；`tag:purpose`＝50；全庫 964。
- Blake 確認 50 張（2026-11-01），`eval --finalize`：accepted 118、rejected 2。

| tag | TP | FP | FN | precision | recall |
|---|---|---|---|---|---|
| purpose/*（6 類合計） | 50 | 0 | 0 | 100% | 100%* |
| sensitive | 21 | 0 | 2 | 100% | 91% |
| context/personal | 29 | 0 | 0 | 100% | 100% |
| context/work | 6 | 2 | 1 | 75% | 86% |
| custom/AI工具、攝影、旅遊 | 7 | 0 | 0 | 100% | 100% |
| custom/資料分析 | 3 | 0 | 1 | 100% | 75% |
| custom/職涯 | 2 | 0 | 5 | 100% | 29% |
| context/Gaming（Blake 新建） | 0 | 0 | 1 | - | - |
| sensitive/Adult（Blake 新建） | 0 | 0 | 2 | - | - |

- 解讀與限制：
  - \*purpose recall 結構上必為 100%：樣本依「建議的 purpose」分層抽出，每張必有一個 purpose 建議；只有在使用者加上第二個 purpose 時才會下降。
  - [inference] tag 已預先套上，確認方式是「留著＝接受」，有錨定效應，precision 可能偏高；A3 VLM 對照時改用「不預套、盲選」的抽樣以校正。
  - Claude 的 sensitive 判斷可用（P 100%／R 91%），與本機 VLM（§1.2，R 0–25%）落差極大 → S3 開關前的 sensitive 規則層仍是硬前提。
  - custom tag 用 keyword 精確比對漏抓多（職涯 R 29%）→ A3 改由 VLM 依 tag 描述判斷，不再用 keyword 對應。
  - Blake 自建 `context/Gaming`、`sensitive/Adult`：分類體系需可由使用者擴充，VLM prompt 應動態帶入所有有描述的子 tag（A1 自訂 tag 描述欄的需求來源）。
- 評估程式修正：使用者在 `sensitive` 下建子 tag 後，`sensitive` 曾被誤當容器而不計分；改為 label root 永遠計分、子 tag 視同父 tag（回歸測試＋mutation 2／2 被殺，`npm test` 73／73）。
- 預選門檻（§6，precision ≥ 0.9）：purpose 6 類、sensitive、context/personal 達標；context/work 未達標，只顯示不預選。此門檻適用於 Claude 標註；VLM 需在 A3 自行重測。

### A1 紀錄（2026-11-01）

- 程式：`v2/server/dhash.mjs`（S0，64-bit dHash，分桶精確比對，保留最早者）、`v2/server/ocr.mjs`（S1 OCR 批次，可續跑）、`v2/server/rules.mjs`（S1 規則引擎，reason 只寫規則名稱）、migration `005_cheap_layer.sql`（`asset_hashes`、`tag_matchers` 與 9 條種子規則）、`v2/cli/cheap.mjs <dup|ocr|rules|all>`；查詢新增 `suggest:`／`confidence:`／`age:`；tag 描述可經 `/api/tags` 讀寫（系統 tag 仍 403）。commit `d29c9c6`，`npm test` 127／127；實作 agent mutation 12／12，主線另抽查 5／5 被殺。
- 真實照片庫（執行前備份 DB）：dup 1,324 張 → 45 組、58 張近重複建議；OCR 1,324／1,324 成功（low-yield 16）；規則命中 205 張、253 條建議。
- 以 50 張答案評估規則層：purpose/receipt P 90%／R 90%、purpose/chat P 100%／R 40%、**sensitive P 82%／R 39%**。
- sensitive 規則層＋VLM 聯集：R 仍為 39%（VLM 沒有補到任何一張）。漏掉的 14 張依用途分：chat 7、visual-ref 4、receipt 2、ephemeral 1。
  - [fact] 試算「有 chat 建議就視為 sensitive」：P 75%／R 65%。
  - [inference] 漏掉的主要是私人對話（沒有關鍵字可抓）與成人內容（OCR 抓不到）；要再提高 recall，需要 App 來源訊號（LINE 等）或把 chat 預設視為 sensitive，屬政策決定，列入 §9 待裁。
- **結論：sensitive 規則層未達 S3 開關前提，A5 雲端開關維持鎖定。**

### A4 紀錄（2026-11-01，後端）

- 程式：migration `006_tag_actions.sql`（`tag_actions`，kind CHECK 只允許 `album`／`tag`；種子 `purpose/receipt` → 相簿「收據」、`purpose/ephemeral` → tag `triage/later`）、`v2/server/decisions.mjs`、`v2/server/routes-decisions.mjs`（`GET /api/assets/:id/suggestions`、`POST /api/suggestions/accept|reject|undo`、`/api/tag-actions` CRUD）。commit `f74c09a`，`npm test` 146／146；實作 agent mutation 13／13，主線抽查 2／2 被殺。
- 行為：
  - 接受：寫 `asset_tags(source='ai')`；同 asset 同 tag 其他來源的建議一併 accepted；purpose 單選，其他 purpose pending 建議改 superseded；執行綁定動作。整批單一交易，任一筆非 pending → 409 全部回滾。
  - undo：精確反轉——狀態只在仍是該決定所設時才改回、只刪仍為 `source='ai'` 的 tag、移除加入的相簿項目、新建且已空的相簿刪除；同一決定只能 undo 一次（409）。
  - 不變式測試：接受庫內全部建議後 `assets.status` 完全不變；`kind:'trash'` 在 API（400）與 DB CHECK 都被拒。
- 真實資料庫副本試套 006：`user_version` 6，兩條種子綁定正確建立（正式庫在下次開啟時套用）。
- 主線決定（claude，可改）：
  - 已有人工 purpose tag 時接受另一個 AI purpose 建議，兩個 tag 並存——AI 決定不刪除使用者手動加的 tag。
  - 綁定動作加上的 tag（如 `triage/later`）不連帶處理同 tag 的 pending 建議，只有被接受的 tag 會連帶。
- 未做：文字筆記「建 bundle＋排 OCR」動作待 P3；UI（接受鍵、綁定設定頁）隨 A2。

### A3 紀錄（2026-11-01）

- 程式：`v2/server/vlm.mjs`（動態 taxonomy prompt、JSON schema 驗證、可續跑、連續 3 次傳輸錯誤自動暫停；schema 錯誤不計入）、`v2/server/vlm-compare.mjs`、`v2/cli/vlm.mjs`；`evaluate` 支援 `--only-stage/--only-model`。commit `14bd640`，mutation 8／8 被殺。
- 真實執行（`qwen3-vl:4b`，prompt_hash `8987699090dc94c4`，GPU 無遊戲負載）：50 張樣本 ok 48、錯誤 2（Ollama 回空內容，下次重跑會補），每張中位數 5.2 秒、p90 10.0 秒。
- 以 Blake 確認的 50 張為答案（`eval --only-stage vlm --only-model qwen3-vl:4b`）：

| tag | TP | FP | FN | precision | recall |
|---|---|---|---|---|---|
| purpose/chat | 9 | 2 | 1 | 82% | 90% |
| purpose/receipt | 7 | 0 | 3 | 100% | 70% |
| purpose/text-note | 9 | 4 | 1 | 69% | 90% |
| purpose/visual-ref | 8 | 8 | 1 | 50% | 89% |
| purpose/ephemeral | 1 | 0 | 9 | 100% | 10% |
| purpose/translate | 0 | 0 | 1 | - | 0% |
| context/personal | 21 | 6 | 8 | 78% | 72% |
| context/work | 7 | 13 | 0 | 35% | 100% |
| sensitive | 5 | 0 | 18 | 100% | 22% |
| custom/*（6 個有命中） | 9 | 17 | 9 | 35% | 50% |

- 解讀：
  - [fact] VLM 達預選門檻（P ≥ 0.9）的只有 purpose/receipt；其餘一律只顯示、不預選。
  - [fact] ephemeral 幾乎都被判成 visual-ref（與 Claude 對照：`ephemeral→visual-ref` 6 張）——「這張還要不要」本來就不是看圖能判斷的，符合 §2.3 把保留價值交給回顧佇列的設計。
  - [fact] sensitive recall 22%，再次確認 VLM 不能當 sensitive 來源；sensitive 由 A1 規則層負責（見 A1 紀錄）。
  - [fact] context/work 過度判定（FP 13），custom topics 亂貼（P 35%）→ 這兩類 VLM 建議預設不顯示或排在最後，待 A2 UI 決定。
  - [fact] 與 Claude 初標對照（`vlm compare`，兩者都跑過的 66 張）：purpose 一致 48／66、context 一致 43／66；sensitive 只有 Claude 判定的 26 張、只有 VLM 判定的 0 張。
  - [inference] 答案集是 Claude 預套 tag 後 Blake 確認的結果，對 VLM 不構成錨定，但答案本身偏向 Claude 的切法。
- 全庫執行（2026-11-01）：4b 跑 1,271 張共 3.0 小時（每張中位數 7.0 秒、p90 12.5 秒），ok 1,215、錯誤 56。
  - [fact] 56 張全部是模型輸出失控（`done_reason=length`，JSON 空白或截斷），temperature 0 下每次重跑結果相同；長寬比與 OCR 字數和成功的圖沒有差別。
  - 修正（commit `b04132c`，mutation 3／3）：`num_predict` 768 上限、壞 JSON 以 temperature 0.7 重試一次、輸出錯誤不觸發暫停。重跑補回 16 張。
  - 剩下 40 張改用 `qwen3-vl:8b`：補回 31 張（每張中位數 7.6 秒）。
  - **涵蓋率 1,315／1,324（99.3%）**；剩 9 張沒有 VLM 建議，留給人工判斷。


## 最終驗收 checklist

- [ ] `Input/` 全量經 S0–S2 產生建議，Blake 於 Triage 以「接受／覆寫」完成至少一輪 100 張，記錄接受率。
- [ ] 各 purpose precision 以完整 gold set 量測並記錄；未達 0.9 者確認不預選。
- [ ] sensitive 規則層 recall 以 gold set 量測並記錄；S3 開關在未達標時無法啟用（server 端驗證）。
- [ ] 回顧 Smart Album 依門檻（30 天／receipt 14 天）正確列出，Blake 完成一輪回顧。
- [ ] 任何 AI 建議都不會直接產生 trash（路由表與動作綁定審查）。
- [ ] 驗收由不同於實作者的 fresh-context agent 透過真實入口（HTTP／UI／CLI）執行。

## 0. 一句話

**AI 判斷「這是什麼」，人判斷「現在還值不值得留」**：本機管線替每張截圖預填內容類型、工作／個人與敏感標記；保留或刪除是隨時間變動的價值判斷，AI 不預測，只提供時效訊號與回顧佇列。

## 1. 現況證據（2026-11-01 實測）

| 項目 | 值 | 來源 |
|---|---|---|
| 已人工分流 | 226：trash-candidate 159（70%）、keep 46、extract-text 16、review-later 3、low-yield 2 | `staging/*` 檔數 |
| 未處理 | `Input/` 964 張，PNG 922／JPG 42，幾乎全為 iPhone 截圖 | 檔數 |
| `Input/` 來源 App（Claude 初標） | Instagram 300、Threads 270、LINE 41、Facebook 35、Safari 33、TikTok 30 … | `state/claude-labels/all.jsonl` |
| 本機 GPU | RTX 3070 Ti 8GB | `nvidia-smi` |
| Ollama | 0.40.13 已安裝；`qwen3-vl:8b`（6.2GB）已下載至 `D:\Ollama Models` | `ollama list` |
| schema 預留 | `asset_tags.source` 已含 `'ai'` | `v2/server/migrations/001_init.sql:69` |

### 1.1 Claude 盲標 vs 人工決定（226 張 staging，標註者不知答案）

| 人工決定 | Claude 判的內容類型 |
|---|---|
| extract-text（16） | text-note **16／16** |
| keep（46） | text-note 12、visual-ref 12、junk 14、chat 5、其他 3 |
| trash-candidate（159） | junk 61、visual-ref 42、receipt 25、text-note 24、chat 5、unsure 2 |

- **內容類型可靠**：要抽文字的圖 100% 判成 text-note。
- **刪除無法從內容推出**：trash 中只有 38%（61／159）看得出是 junk；其餘是訂單、轉帳、貼文、商品——內容本身正常，是**時間過了、事情辦完了、認知改變了**才不再需要（Blake 2026-11-01 指出）。
- junk 預測的 precision 79%（61／77）；高信心（≥0.7）82%（9／11）。仍未達 §6 的 0.9 預選門檻。
- [inference] keep 中 14 張被判 junk，部分可能因 keep 是裁剪後的局部圖、缺上下文；需要人工抽查確認。

### 1.2 本機 VLM 實測（2026-11-01，GPU 無遊戲負載，同 30 張 gold，對照 Claude 盲標）

| 模型 | 位置 | 每張中位數／P90 | purpose 一致 | context 一致 | sensitive 抓到（Claude 標 8 張） |
|---|---|---|---|---|---|
| qwen3-vl:8b | 14% CPU／86% GPU | 16.4s／29.9s | 18／30 | 27／30 | 2／8 |
| qwen3-vl:4b | 100% GPU（3.6GB） | 2.3s／14.7s | 18／30 | 25／30 | 0／8 |

- 兩者 schema 30／30 合格；不一致主要是 Claude 的 junk 被判成 visual-ref（8b 8 次、4b 7 次）——本機 VLM 幾乎不用「暫時性」類別。
- **4b 為預設**：一致率與 8b 相同、快 7 倍，千張約 40–60 分鐘可夜間跑完。8b 保留為「重判低信心」選項。
- **VLM 不能當 sensitive 判斷來源**（recall 0–25%）。sensitive 改為規則優先：OCR 文字比對（帳號／卡號／驗證碼／密碼等關鍵字與數字樣式）＋ App 來源（銀行、LINE 私訊）＋ VLM 只作補充。外送開關（S3）在此規則層通過 A3 recall 驗收前不得啟用。
- 8b 曾把卡號末四碼寫進 reason（見 §7.1 A3 過濾規則）。
- 樣本只有 30 張，結論為初步方向；A3 以完整 gold set 重測。

結論：**不把「刪除」當分類目標去加大判斷邏輯。** 時間造成的價值變化是誤差的本質來源，應由回顧流程處理（§2.3），不是由更複雜的模型處理。

## 2. 分類模型：三個正交維度＋一組時效訊號

### 2.1 內容類型（AI 建議，Blake 2026-11-01 確認）

| tag（`purpose/…`） | 綁定動作（§5） |
|---|---|
| `purpose/text-note` 文字筆記（文章、貼文長文、教學） | 建 single bundle 並排入 OCR |
| `purpose/chat` 對話紀錄 | 依 `bundle_hint` 建議同一 bundle |
| `purpose/translate` 外語（中、英以外） | 標記；翻譯走 bundle 手動 LLM（D5） |
| `purpose/visual-ref` 視覺參考（UI、穿搭、配色、構圖） | 加入 album「視覺參考」，提示裁剪 |
| `purpose/receipt` 收據、訂單、轉帳 | 抽欄位 → CSV（P3 後） |
| `purpose/ephemeral` 先天暫時性（驗證碼、載入中、通知、主畫面、誤觸、重複連拍） | 進回顧佇列（§2.3）；**不自動建議刪除** |

原草案的 `junk` 改名為 `ephemeral`：它描述的是「內容先天有時效」，不是「該刪」。

### 2.2 情境與自訂 tag

- `context/work`、`context/personal`（AI 建議；看不出來時不給）。
- **自訂 tag（`custom/…`）**：Blake 自由建立，**只用於篩選**，不綁動作。建立時可附一句描述；有描述的自訂 tag 會加入 VLM prompt，讓 AI 一併建議（沒有描述就純手動）。
- Claude 初標的 `keywords` 欄是自訂 tag 的候選來源：前幾名為 AI工具 75、資料分析 42、穿搭 41、交友 30、配色 30、提示詞 23、旅遊 23、職場 22。由 Blake 挑選要建立哪些，不自動建立。
- 系統 tag `sensitive`：AI 建議，作為所有外送的阻擋條件。

### 2.3 保留價值：時效訊號＋回顧佇列（取代「AI 預測刪除」）

- AI **只產生訊號**：`ephemeral`、`receipt`（訂單、票券類）、`sensitive`、重複或近重複、截圖年齡。
- Smart Album「回顧」：依「年齡 × 時效類型」排序，例如超過 30 天的 receipt 或 ephemeral 排在前面。在 Triage 模式逐張決定留或丟。
- 留或丟的人工決定寫入 events，但**不拿去訓練「刪除分類器」**，只用來統計各類型的平均保存期限，調整回顧排序。

## 3. 架構：四段漏斗，便宜的先跑

```text
匯入 asset
  → S0 重複／近重複：sharp 算 dHash → 訊號 dup_of=#id
  → S1 OCR（沿用 Windows OCR）＋ 規則引擎（Paperless-ngx 式 matcher：any/all/regex/檔名/尺寸）
  → S2 本機 VLM（Ollama qwen3-vl:4b 預設、8b 重判低信心，圖縮到長邊 ≤1280）→ 固定 JSON：
        {purpose, context, sensitive, confidence, reason, custom_tags[]}
  → S3 [開關，預設關] Claude API：只送 S2 信心低、且非 sensitive 者（§4 D5'）
→ asset_suggestions（不是 asset_tags）→ Triage／Grid 確認後才寫 asset_tags(source='ai')
```

### 3.1 資料模型（新 migration）

```sql
asset_suggestions(
  id, asset_id, tag_id, stage TEXT CHECK(stage IN ('dup','rule','vlm','claude','import')),
  confidence REAL, reason TEXT, model TEXT, prompt_hash TEXT,
  status TEXT CHECK(status IN ('pending','accepted','rejected','superseded')),
  created_at, decided_at)
```

- `stage='import'`：用來匯入本次 Claude 初標（`state/claude-labels/all.jsonl`），作為 A0 的起點。
- 拒絕的建議保留，作為評估資料；同 `prompt_hash`＋`model` 不重算。
- 查詢語言新增 `suggest:<tag>`、`confidence:>=N`、`age:>30d`。

### 3.2 執行方式

- 背景 job 佇列（併發 1，GPU 單工），匯入後自動排入 S0–S2。
- CLI `v2/cli suggest [--query …] [--stage …] [--dry-run]`：也是 Claude／Codex skill 呼叫的介面。

## 4. 隱私決策 D5'（2026-11-01 Blake 裁定：A 先做、B 為開關）

修訂 [[Sprint_Photo_Library_v2]] D5：

1. **S0–S2 全在本機**，預設設定即可完整運作（選項 A）。
2. **S3 Claude 外送＝設定開關，預設關**（選項 B）。開啟後只送「非 sensitive 且無 `sensitive` tag」者，由 server 端檢查（403）；每批送出前顯示張數與估計費用並要求確認。
3. bundle 的 LLM 整合／翻譯維持原 D5。
4. 一次性例外（2026-11-01，Blake 明示要求）：用 Claude Code subagent 初標 `Input/` 964 張＋`staging/` 226 張，結果只存在 gitignored 的 `state/claude-labels*/`。

## 5. 用途 → 動作綁定

- 動作只在**人接受建議時**觸發。首批動作：加入 album、建立 bundle 並排 OCR、加 `triage/later`。
- 「移入 trash」不綁在任何 AI 建議上，只能由回顧佇列中的人工決定觸發。

## 6. 評估

- **內容類型 gold set**：extract-text 16 張＋Blake 於 v2 確認的 `Input/` 樣本（由 Claude 初標中依類別分層抽 50 張，確認或修正）。
- 指標：各 purpose 的 precision／recall；`sensitive` 以 recall 為主。precision ≥ 0.9 的類別才在 Triage 預選。
- **不評估「刪除準確度」**（§1.1、§2.3）。
- 對照組：Claude 初標 vs 本機 VLM 在同一批圖上的一致率，決定 S2 是否夠用、S3 開關是否有必要。

## 7. 里程碑（排在 v2 P2 之前，Blake 2026-11-01 同意）

| # | 里程碑 | 交付 | 前置 |
|---|---|---|---|
| A0 | 評估基線 | `asset_suggestions` migration、Claude 初標匯入（stage=import）、分層抽 50 張確認、評估腳本 | v2 P1 ✅ |
| A1 | 便宜層 | S0 dHash、S1 規則引擎＋matcher UI、`suggest:`／`age:` 查詢、自訂 tag 描述欄 | A0 |
| A2 | 建議 UI | Triage 顯示建議（Enter 接受、數字鍵覆寫）、Grid 批次接受、回顧 Smart Album | A1、v2 P2 Triage |
| A3 | 本機 VLM | S2 JSON 分類、job 佇列、CLI；與 Claude 初標對照 | A0（可與 A1 並行） |
| A4 | 動作綁定 | 接受後動作；收據抽取（等 P3） | A2 |
| A5 | 雲端開關 | S3 Claude、外送閘、成本預估確認 | A3 |

### 7.1 各里程碑 QA（草案）

- A0：初標 964 張全數匹配 asset（unmatched／ambiguous／invalid 皆 0）✅；重匯冪等 ✅；評估腳本對已知答案集輸出正確 TP／FP／FN ✅（`test/suggestions.test.mjs`）；Blake 確認 50 張後 eval 產出數字 ✅。
- A1：重複圖 fixture（同圖、縮放、重新壓縮）全數命中；規則改動後重跑可重現。
- A2：接受 → `asset_tags.source='ai'` 且可 undo；拒絕 → `rejected` 且 tag 不變；回顧 Smart Album 排序符合年齡×類型。
- A3：`reason` 欄在落庫前經程式過濾（連續 4 位以上數字、email、電話樣式一律遮蔽）——2026-11-01 實測 qwen3-vl:8b 違反 prompt 把卡號末四碼寫進 reason，不能只靠 prompt；VLM 輸出不合 schema 時記錄錯誤、不產生建議；拔網路仍可完整跑 S0–S2；**在 GPU 無其他負載下**量測每張耗時。
- A4：任何綁定動作都不改 `assets.status`（不變式測試）；`trash` 類動作在 DB CHECK 與 API 兩層都被拒；接受可精確 undo（狀態、AI tag、相簿項目）。
- A5：開關關閉時 S3 端點回 403；帶 `sensitive` 的 asset 直打 API 回 403；**未經人工確認非 sensitive、或帶 `purpose/chat`（建議或 tag）的 asset 回 403**（Q8）；API key 不出現在 DB／log。

## 8. 為何不是純 skill（記錄取捨與實測）

- 實測（2026-11-01）：8 個 Sonnet subagent 平行處理 964 張約 5 分鐘，每個 agent 約 23–25 萬 tokens（合計約 190 萬）；226 張盲標約 55 萬 tokens。適合**一次性**建立樣本或重新歸類，不適合每天的匯入流程。
- 輸出不可重現、沒有校正介面 → agent 定位為 **CLI 的使用者**（呼叫 `v2/cli suggest`、讀評估報告、調整規則），分類結果與校正留在 library。

## 9. 待裁

- ~~Q5~~：GPU 空閒時已測（§1.2）。注意：遊戲占用 GPU 時 8b 單張超過 10 分鐘，S2 job 佇列需在偵測到 GPU 高負載時暫停。
- ~~Q6~~（2026-11-01 裁定）：回顧門檻預設 30 天；`purpose/receipt` 14 天。設定頁可依類型調整。
- ~~Q7~~（2026-11-01 由 claude 代決，Blake 授權）：初始自訂 tag 7 個，皆附描述供 VLM 使用：
  - `custom/AI工具`：AI 產品、提示詞、自動化、開源工具
  - `custom/資料分析`：SQL、Python、KPI、資料庫、報表
  - `custom/職涯`：求職、職場、管理
  - `custom/穿搭`：服裝、外套、搭配
  - `custom/配色設計`：配色、版面、設計參考
  - `custom/攝影`：構圖、擺姿、人像
  - `custom/旅遊`：景點、行程、交通

  未納入「交友」「命理」：涉及個人隱私、或數量少，由 Blake 需要時自行建立。
- ~~Q8~~（2026-11-01 Blake 裁定：(c)＋(a)）：S3 只對已人工確認「非 sensitive」的圖開放，且有任何 `purpose/chat` 建議或 tag 的圖一律視為 sensitive、不外送。A5 外送閘依此實作與驗收。原題：sensitive 規則層 recall 只有 39%，主要漏掉私人對話與成人內容。S3 外送開關前要補哪種訊號？
  - (a) 只要有 `purpose/chat` 建議就視為 sensitive：50 張試算 R 65%、P 75%，實作最簡單，但所有聊天截圖都無法外送。
  - (b) App 來源訊號（LINE、銀行 App 的介面特徵或 EXIF／檔名）：較精準，但需另外實作與驗證。
  - (c) 不補，S3 永久只對已人工確認「非 sensitive」的圖開放。
  - 建議：(c) 為底線，並加上 (a)——外送本來就是選用功能，寧可少送。

## 參考

外部調查（2026-11-01，摘要；細節未逐頁驗證）：
- Paperless-ngx matching／workflows：<https://docs.paperless-ngx.com/advanced_usage>
- Eagle AI Action：<https://en.eagle.cool/blog/post/eagle-plugin-ai-action>
- screenpipe pipes：<https://github.com/screenpipe/screenpipe>
- Immich CLIP 讀字弱：<https://github.com/immich-app/immich/discussions/3168>
- Claude vision token 估算：<https://platform.claude.com/docs/en/build-with-claude/vision>
