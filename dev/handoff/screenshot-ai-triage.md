# 截圖 AI 分流建議 [BLOCKED: 等 Blake 確認「AI 確認樣本」50 張]
- updated: 2026-11-01 (claude)
- base: f2eedc8
<!-- 查核: 2026-11-01 -->
- identity: {"executor":"claude","device":"desktop","host":"DESKTOP-20251004","session_id":"unknown","session_name":"unknown","identity_source":"hostname"}
- 停點: A0 程式完成並已套用到真實照片庫 `D:\PhotoLibrary`（964 張匯入、2,134 條 pending 建議、50 張樣本已套 `source='ai'` tag）。
- 下一步: Blake 在 v2 開「AI 確認樣本」相簿修正 tag → `cd v2 && node cli/suggest.mjs eval --library D:/PhotoLibrary --finalize` → 數字寫回 Sprint A0 紀錄、標 ✅ → 開 A1（dHash、規則引擎、sensitive 規則層）與 A3（4b VLM）。
- 切入: dev/Sprint_Screenshot_AI_Triage.md（§1.1–1.2 實測、§7 里程碑、A0 紀錄）, v2/server/suggestions.mjs, v2/cli/suggest.mjs
- 事實:
  - [fact] `npm test` 72/72；mutation 7/7 被殺（Sprint A0 紀錄）。
  - [fact] Claude 初標在 `state/claude-labels/all.jsonl`、盲標 gold、答案對照 `gold-key.json`（G### → staging 類別與路徑）、VLM 30 張結果 `vlm-gold-{4b,8b}.jsonl` 都在 `state/claude-labels-gold/`（gitignored）；縮圖與腳本留在 session scratchpad，不保留，A3 重新產生即可。
  - [fact] Ollama 0.40.13 已裝，模型 `qwen3-vl:4b`／`8b` 在 `D:\Ollama Models`（使用者環境變數 `OLLAMA_MODELS`）；4b 100% GPU 每張中位數 2.3s（Sprint §1.2）。
  - [inference] VLM sensitive recall 0–25%（30 張），sensitive 必須規則優先，S3 外送開關在規則層驗收前不得啟用。
