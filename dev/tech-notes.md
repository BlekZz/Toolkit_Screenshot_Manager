# tech-notes

跨 session 除錯脈絡與零散技術筆記。跨專案通用的陷阱上傳到 Hub `technotes/`（避坑）或 `knowledge/`（系統如何運作），本檔只留指標。

## [global] Ollama 結構化輸出（format＝JSON schema）在 temperature 0 下對少數圖片會輸出失控：done_reason=length、content 空白或 JSON 截斷

- 待上傳：Hub technotes 目前沒有 LLM／Ollama 的 domain，需先新增 domain 再上傳（2026-11-01 wrap-up 記）。
- **現象**：`qwen3-vl:4b` 以 `/api/chat`＋`format: <schema>`＋`think: false`＋`temperature: 0` 分類 1,271 張截圖，56 張（約 4%）回應 `done_reason: "length"`、`eval_count` 2,000 以上，但 `message.content` 是空字串或被截斷的 JSON；同一張圖每次重跑結果相同。失敗圖的長寬比、OCR 字數與成功圖沒有差別。
- **根因**：[inference] 受 grammar 約束的解碼允許 JSON token 之間的空白，模型在 temperature 0 下進入重複輸出空白的循環，直到碰到預設輸出上限；決定性解碼讓同一張圖必然重現。
- **正確做法**：
  1. `options.num_predict` 設上限（本專案 768），讓失控在幾秒內結束，不要等到預設上限。
  2. 解析失敗時用 `temperature: 0.7` 取樣重試一次：56 張補回 16 張。
  3. 這類「模型輸出壞掉」的錯誤不可計入「連續傳輸錯誤 → 暫停」，否則會被誤判成 GPU 忙碌。
  4. 仍失敗的改用較大模型（`qwen3-vl:8b`）：40 張補回 31 張，剩 9 張留人工。
- **記錄**：2026-11-01，`v2/server/vlm.mjs`（commit `b04132c`）；Ollama 0.40.13、Windows 11、GPU 無其他負載。細節見 [[Sprint_Screenshot_AI_Triage]] A3 紀錄。

## 已上傳的條目（指標）

- sharp 檔案快取在 Windows 鎖住原圖 → Hub `technotes/node.md` node-018（2026-11-01）。
- sharp `toFile()` 在 Windows 長路徑寫不出檔 → Hub `technotes/node.md` node-019（2026-11-01）。
- sharp prebuilt 不讀 BMP → Hub `technotes/node.md` node-013（2026-10-11）。
