-- 006_tag_actions：AI 分流 A4 用途 → 動作綁定（dev/Sprint_Screenshot_AI_Triage.md §5、§7.1 A4）。
-- 動作只在「人接受建議」時觸發（server/decisions.mjs）。
-- kind 刻意只有 album／tag：不存在任何 trash、刪檔或改 assets.status 的動作——
-- 「移入 trash」只能由回顧佇列中的人工決定觸發，CHECK 讓 DB 層也擋住（API 層另有驗證）。

CREATE TABLE tag_actions (
  id          INTEGER PRIMARY KEY,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('album', 'tag')),
  target      TEXT NOT NULL,          -- album：相簿名稱（不存在時於觸發時建立一般相簿）；tag：tag 路徑，如 triage/later
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_seed     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (tag_id, kind, target)
);
CREATE INDEX tag_actions_tag ON tag_actions (tag_id, enabled);

-- 種子：receipt → 相簿「收據」；ephemeral → triage/later。text-note 的 bundle＋OCR 延到 P3。
INSERT INTO tag_actions (tag_id, kind, target, is_seed, created_at)
  SELECT t.id, v.kind, v.target, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM tags t
    JOIN tags p ON p.id = t.parent_id AND p.parent_id IS NULL AND p.name = 'purpose',
    (SELECT 'receipt' AS tag, 'album' AS kind, '收據' AS target
     UNION ALL SELECT 'ephemeral', 'tag', 'triage/later') AS v
  WHERE t.name = v.tag;
