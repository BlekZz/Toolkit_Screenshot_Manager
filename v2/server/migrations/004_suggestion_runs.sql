-- 004_suggestion_runs：記錄每個 stage 處理過哪些 asset（含沒產生建議與失敗者），供可續跑的 runner 跳過已完成項。
CREATE TABLE suggestion_runs (
  id           INTEGER PRIMARY KEY,
  asset_id     INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL CHECK (stage IN ('dup', 'rule', 'vlm', 'claude', 'import', 'ocr')),
  model        TEXT NOT NULL DEFAULT '',
  prompt_hash  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  detail       TEXT,
  ms           INTEGER,
  created_at   TEXT NOT NULL,
  UNIQUE (asset_id, stage, model, prompt_hash)
);
CREATE INDEX suggestion_runs_stage ON suggestion_runs (stage, model, prompt_hash, status);
