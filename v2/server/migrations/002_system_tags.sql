-- 002_system_tags：內建保留 tag（Sprint §2）。is_system = 1 者不可刪除／改名。
INSERT INTO tags (parent_id, name, color, is_system) VALUES (NULL, 'sensitive', '#c2412d', 1);
INSERT INTO tags (parent_id, name, color, is_system) VALUES (NULL, 'ocr', NULL, 1);
INSERT INTO tags (parent_id, name, color, is_system)
  SELECT id, 'low-yield', '#b7791f', 1 FROM tags WHERE parent_id IS NULL AND name = 'ocr';
INSERT INTO tags (parent_id, name, color, is_system) VALUES (NULL, 'triage', NULL, 1);
INSERT INTO tags (parent_id, name, color, is_system)
  SELECT id, 'later', '#6b6b66', 1 FROM tags WHERE parent_id IS NULL AND name = 'triage';
