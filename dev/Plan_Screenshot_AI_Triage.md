# Plan：截圖 AI 分流建議（AI Triage Suggestions）

> 狀態：Plan（規劃中，未承諾執行）。建立 2026-11-01（claude）。
> 上游：[[Sprint_Photo_Library_v2]]（本計畫＝其 P4「AI tag 建議」的展開並提前規劃）、[[Reference_Photo_Library_v2]]。

## 0. 一句話

**AI 只「建議」，人「裁定」**：本機管線（重複偵測 → OCR 規則 → 本機 VLM）替每張截圖預填「用途」建議與信心，Triage 模式一鍵接受或覆寫；雲端 Claude 只是預設關閉的開關。

MVP1 的前提「單靠 OCR 或 AI 無法判斷截圖當下的保存意圖」仍成立——所以本計畫不做自動歸檔，只把人工判斷從「每張想一次」降為「多數按 Enter 確認」。

## 1. 現況證據（2026-11-01 實測）

| 項目 | 值 | 來源 |
|---|---|---|
| 已分流張數 | 226：trash-candidate 159（70%）、keep 46、extract-text 16、review-later 3、low-yield 2 | `staging/*` 檔數 |
| 未處理 | `Input/` 964 張 | 檔數 |
| 本機 GPU | RTX 3070 Ti 8GB | `nvidia-smi` |
| Ollama | 未安裝 | `ollama --version` 失敗 |
| schema 預留 | `asset_tags.source` 已含 `'ai'` | `v2/server/migrations/001_init.sql:69` |

[inference] 最大省時點不是精準分類，而是**判斷「這張不要」**：70% 的決策是丟棄。

## 2. 用途分類（由現有功能推斷，待 Blake 確認 → §9 Q1）

| 用途 tag（`purpose/…`） | 推斷依據 | 綁定動作（§5） |
|---|---|---|
| `purpose/text-note` 文字筆記（文章、文件、說明） | Q 鍵 → OCR → bundle → md 匯出 | 建 single bundle 並排入 OCR |
| `purpose/chat` 對話紀錄（LINE／Slack／訊息串） | MVP1 背景「對話紀錄」；多張連續截圖常成組 | 依時間相鄰自動建議同一 bundle |
| `purpose/translate` 外文內容 | D4「LLM 整合／翻譯」 | 標記，翻譯仍走 bundle 手動 LLM（D5） |
| `purpose/visual-ref` 視覺參考／素材（UI、設計、圖表） | W 鍵 crop keep（46 張） | 加入 album「視覺參考」，提示裁剪 |
| `purpose/receipt` 收據／發票／帳單 | spec 範例 `類型/收據`、`類型/發票` | 抽欄位（日期／金額／商家）→ CSV（P3 後） |
| `purpose/junk` 暫時截圖、重複、過期 | R 鍵 70% | 建議 trash，**永不自動刪除** |
| 系統 tag `sensitive`（密碼、帳號、金融、證件） | D5 外送閘 | 只加 tag；阻擋任何外送 |

其餘：信心不足 → 不給建議，留給人工（等同現在）。

## 3. 架構：四段漏斗，便宜的先跑

```text
匯入 asset
  → S0 重複／近重複：sharp 算 dHash，漢明距離 ≤ N → 建議 purpose/junk（理由：與 #id 重複）
  → S1 OCR（沿用 Windows OCR）＋ 規則引擎（Paperless-ngx 式 matcher）
        每個 purpose tag 可掛 matcher：any / all / regex / 檔名 / 尺寸（例：檔名含 LINE → chat）
        命中 → 建議（source=rule, confidence=1.0 或規則權重）
  → S2 本機 VLM（Ollama，qwen2.5vl:7b 量化版，圖縮到長邊 ≤1280）
        只跑 S0/S1 沒命中者；輸出固定 JSON schema：
        {purpose, confidence, sensitive, reason}
  → S3 [開關，預設關] Claude API：只送 S2 信心 < 閾值 且 非 sensitive 者（§4 D5'）
→ 寫入 asset_suggestions（不是 asset_tags）
→ Triage／Grid 顯示建議 → 接受才寫 asset_tags(source='ai')
```

### 3.1 資料模型（新 migration）

```sql
asset_suggestions(
  id, asset_id, tag_id, stage TEXT CHECK(stage IN ('dup','rule','vlm','claude')),
  confidence REAL, reason TEXT, model TEXT, prompt_hash TEXT,
  status TEXT CHECK(status IN ('pending','accepted','rejected','superseded')),
  created_at, decided_at)
```

- 建議與事實分離：拒絕的建議保留，作為評估資料（§6）。
- 重跑同 `prompt_hash`＋`model` 不重算（快取，可重現）。
- 查詢語言新增 `suggest:<tag>` 與 `confidence:>=N`，可做「全選信心 ≥0.9 的 junk → 一次確認」。

### 3.2 執行方式

- 背景 job 佇列（併發 1，GPU 單工），匯入後自動排入 S0–S2；進度顯示在 Settings。
- CLI 入口 `v2/cli suggest [--query …] [--stage …] [--dry-run]`：同時也是給 Claude／Codex skill 呼叫的介面（agent 不直接看圖，只觸發與檢閱結果）。

## 4. 隱私決策 D5'（2026-11-01 Blake 裁定：A 先做、B 為開關）

修訂 [[Sprint_Photo_Library_v2]] D5：

1. **S0–S2 全在本機**，不經網路；預設設定即可完整運作（選項 A）。
2. **S3 Claude 外送＝設定開關，預設關**（選項 B）。開啟後仍須：
   - 只送「S2 判為非 sensitive 且 asset 無 `sensitive` tag」者；server 端檢查（403），不只 UI。
   - 每次批次送出前顯示「將外送 N 張、估計 X tokens／約 $Y」確認；不存在無確認的排程外送。
   - [inference] S2 漏判 sensitive 為已知殘餘風險 → 開關說明需明示。
3. bundle 的 LLM 整合／翻譯維持原 D5（逐 bundle 手動）。

## 5. 用途 → 動作綁定

- 每個 purpose tag 可綁一個「接受後動作」（設定頁可改）；動作只在**人接受建議時**觸發，不在建議產生時觸發。
- 首批動作：加入 album、建立 bundle 並排 OCR、移入 trash（軟刪除）、加 `triage/later`。
- 收據欄位抽取依賴 P3 的 bundle／LLM，排在最後（A4）。

## 6. 評估（先量測再上 UI）

- **Gold set**：現有 `staging/*` 226 張已分好類（trash／keep／extract-text），另由 Blake 標 50 張 `Input/` 樣本補 receipt／chat／sensitive。
- 指標：每個 purpose 的 precision／recall；`junk` 以 precision 為主（誤丟比漏抓嚴重）；`sensitive` 以 recall 為主。
- 上線門檻（草案）：某 purpose precision ≥ 0.9 才在 Triage 預選，未達者只顯示不預選。
- 線上回饋：accepted／rejected 比率持續累積，可回頭調規則與 prompt。

## 7. 里程碑（草案）

| # | 里程碑 | 交付 | 前置 |
|---|---|---|---|
| A0 | 評估基線 | gold set 匯入、`asset_suggestions` migration、評估腳本 | v2 P1 ✅ |
| A1 | 便宜層 | S0 dHash 重複偵測、S1 規則引擎＋matcher 設定 UI、`suggest:` 查詢 | A0 |
| A2 | 建議 UI | Triage 顯示建議（Enter 接受、數字鍵覆寫）、Grid 批次接受 | A1、v2 P2 Triage |
| A3 | 本機 VLM | Ollama 安裝、S2 JSON 分類、sensitive 偵測、job 佇列、CLI | A0（可與 A1 並行） |
| A4 | 動作綁定 | 接受後動作；收據抽取（等 P3） | A2 |
| A5 | 雲端開關 | S3 Claude、外送閘、成本預估確認 | A3 |

### 7.1 各里程碑 QA（草案）

- A0：評估腳本對手工構造的已知答案集輸出正確 precision／recall。
- A1：重複圖 fixture（同圖、縮放、重新壓縮）全數命中；不相干圖零誤判。規則改動後重跑結果可重現。
- A2：接受建議 → `asset_tags.source='ai'` 且可 undo；拒絕 → suggestion `rejected` 且 tag 不變。
- A3：VLM 輸出不合 schema 時記錄錯誤、不產生建議（不猜）；拔網路仍可完整跑 S0–S2。
- A5：開關關閉時 S3 端點回 403；帶 `sensitive` 的 asset 直打 API 回 403；API key 不出現在 DB／log。

## 8. 為何不是純 skill（記錄取捨）

- 純 Claude Code skill：每批重新看圖、成本隨張數線性（1080p 約 2,765 tokens／張，千張約 2.8M tokens——[inference] 公式 `w*h/750` 出自官方 vision 文件）、輸出不可重現、無校正介面。
- 本計畫把 agent 定位為 **CLI 的使用者**：skill 可呼叫 `v2/cli suggest`、閱讀評估報告、調整規則，但分類結果與校正留在 library。

## 9. 待裁

- Q1：§2 用途分類是否正確？要增刪哪些（例：工作／個人分開、特定專案）？
- Q2：同意在本機安裝 Ollama＋qwen2.5vl:7b（約 6GB 模型檔，8GB VRAM 可跑——[inference] 需實測）？
- Q3：A0／A1 是否插在 v2 P2 之前做（不依賴 Triage UI，Grid 已可用 `suggest:` 查詢）？
- Q4：gold set 補標 50 張是否由 Blake 用現有工具分流產生？

## 參考

外部調查（2026-11-01，摘要；細節未逐頁驗證）：Paperless-ngx matching／workflows（https://docs.paperless-ngx.com/advanced_usage）、Eagle AI Action（https://en.eagle.cool/blog/post/eagle-plugin-ai-action）、screenpipe pipes（https://github.com/screenpipe/screenpipe）、Immich CLIP 讀字弱（https://github.com/immich-app/immich/discussions/3168）、Claude vision token 估算（https://platform.claude.com/docs/en/build-with-claude/vision）。
