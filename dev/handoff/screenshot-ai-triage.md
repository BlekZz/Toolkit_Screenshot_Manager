# 截圖 AI 分流建議 [ACTIVE]
- updated: 2026-11-01 (claude)
- base: 543dcac
<!-- 查核: 2026-11-01 -->
- identity: {"executor":"claude","device":"desktop","host":"DESKTOP-20251004","session_id":"4ebbf730-be62-4d59-aad2-31ec78c7ad3e","session_name":"unknown","identity_source":"scratchpad-path"}
- 停點: A0 ✅（50 張樣本經 Blake 確認並 finalize：accepted 118／rejected 2；數字與限制見 Sprint A0 紀錄）。
- 下一步: A1（dHash 重複偵測、規則引擎、sensitive 規則層、自訂 tag 描述欄）與 A3（qwen3-vl:4b 跑全 `Input/`，prompt 動態帶入有描述的子 tag，改用不預套 tag 的盲選抽樣與 Claude 標註對照）可並行；A3 需 GPU 空閒（遊戲中暫停）。
- 切入: dev/Sprint_Screenshot_AI_Triage.md（A0 紀錄、§1.2、§7）, v2/server/suggestions.mjs, v2/cli/suggest.mjs
- 事實:
  - [fact] `npm test` 73/73；A0 mutation 7/7＋評估修正 2/2 被殺（Sprint A0 紀錄）。
  - [fact] 真實照片庫 `D:\PhotoLibrary`：964 assets、asset_suggestions accepted 118／rejected 2／pending 2014；相簿「AI 確認樣本」50 張；Blake 自建 tag `context/Gaming`、`sensitive/Adult`。
  - [fact] Claude 初標 `state/claude-labels/all.jsonl`；盲標 gold、答案對照 `gold-key.json`、VLM 30 張結果 `vlm-gold-{4b,8b}.jsonl` 在 `state/claude-labels-gold/`（皆 gitignored）。
  - [fact] Ollama 0.40.13，模型 `qwen3-vl:4b`／`8b` 在 `D:\Ollama Models`（使用者環境變數 `OLLAMA_MODELS`）；4b 100% GPU 每張中位數 2.3s（Sprint §1.2）。
  - [inference] 樣本確認採「預套 tag、留著＝接受」，有錨定效應，precision 可能偏高（Sprint A0 紀錄）。
