-- 007_undo_bundles：P2a 通用 undo 引擎與 bundle 最小資料層（dev/Sprint_Photo_Library_v2.md §7、§10 P2）。

-- events.undone_by：撤銷這筆事件的那筆事件 id（NULL＝未撤銷）。undo 引擎（server/undo.mjs）
-- 與 A4 decisions.undoDecision 都寫它；「已撤銷」只看這欄。
ALTER TABLE events ADD COLUMN undone_by INTEGER REFERENCES events(id);

-- 遷移 A4 既有語意：suggestions.undo 事件以 payload.event_id 指向被撤銷的決定。
UPDATE events SET undone_by = (
    SELECT u.id FROM events u
    WHERE u.action = 'suggestions.undo' AND json_extract(u.payload_json, '$.event_id') = events.id
    ORDER BY u.id LIMIT 1)
  WHERE action IN ('suggestions.accept', 'suggestions.reject');

CREATE INDEX events_undoable ON events (id) WHERE undo_json IS NOT NULL AND undone_by IS NULL;

-- bundle_items 原本沒有穩定識別（只有隱含 rowid，VACUUM 可能重編）：移除項目與其 undo 需要
-- 可引用的 id，故重建為 INTEGER PRIMARY KEY。表在 P2a 前未被任何程式寫入；仍完整複製既有列。
CREATE TABLE bundle_items_new (
  id         INTEGER PRIMARY KEY,
  bundle_id  INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  position   REAL NOT NULL,
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  crop_id    INTEGER REFERENCES crops(id) ON DELETE CASCADE
);
INSERT INTO bundle_items_new (bundle_id, position, asset_id, crop_id)
  SELECT bundle_id, position, asset_id, crop_id FROM bundle_items ORDER BY rowid;
DROP TABLE bundle_items;
ALTER TABLE bundle_items_new RENAME TO bundle_items;
CREATE INDEX bundle_items_bundle ON bundle_items (bundle_id, position);
CREATE INDEX bundle_items_crop ON bundle_items (crop_id) WHERE crop_id IS NOT NULL;
