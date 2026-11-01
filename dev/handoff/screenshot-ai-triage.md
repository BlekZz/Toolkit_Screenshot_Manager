# 截圖 AI 分流建議 [ACTIVE]
- updated: 2026-11-01 (claude)
- base: f74c09a
<!-- 查核: 2026-11-01 -->
- identity: {"executor":"claude","device":"desktop","host":"DESKTOP-20251004","session_id":"4ebbf730-be62-4d59-aad2-31ec78c7ad3e","session_name":"unknown","identity_source":"scratchpad-path"}
- 停點: A0 ✅、A1 ✅、A3 ✅（全庫 VLM 涵蓋 1,315／1,324）；A4 後端完成（決定 API＋綁定表，commit f74c09a），UI 隨 A2；Q8 已裁定（只送人工確認非 sensitive 且非 chat 的圖）。
- 下一步: A2 建議 UI 依賴 v2 P2 Triage（需先做 v2 P2）；A5 外送閘依 Q8 實作。
- 切入: dev/Sprint_Screenshot_AI_Triage.md（A1／A3／A4 紀錄、§9 Q8）, v2/server/decisions.mjs, v2/server/vlm.mjs
- 事實:
  - [fact] `npm test` 127/127（commit d29c9c6）；A1 mutation 12/12＋抽查 5/5、A3 mutation 8/8 被殺。
  - [fact] 真實照片庫 `D:\PhotoLibrary`：1,324 assets（含舊工具 360 張，tag `migration/*`）；dup 45 組／58 張；OCR 1,324 ok；規則命中 205 張／253 條。A1 前 DB 備份在 session scratchpad `library-pre-a1.db`（暫存，非長期）。
  - [fact] 50 張評估：VLM（qwen3-vl:4b）只有 purpose/receipt 達 P ≥ 0.9；sensitive——VLM R 22%、規則 R 39%、聯集 R 39%（Sprint A1／A3 紀錄）。
  - [fact] Claude 初標與盲標資料在 `state/claude-labels/`、`state/claude-labels-gold/`（gitignored）。
  - [fact] Ollama 模型在 `D:\Ollama Models`；4b 在 GPU 空閒時每張中位數 5.2s（全庫實跑）。
