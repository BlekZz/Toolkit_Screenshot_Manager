-- 001_init：Photo Library v2 完整 schema（見 dev/Sprint_Photo_Library_v2.md §3）
-- P0 只使用 library_roots / assets / events / settings；其餘表先建好，P1+ 直接使用。

CREATE TABLE library_roots (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,          -- managed：相對 library 目錄；referenced：絕對路徑
  mode        TEXT NOT NULL CHECK (mode IN ('managed', 'referenced')),
  created_at  TEXT NOT NULL
);

CREATE TABLE assets (
  id           INTEGER PRIMARY KEY,
  root_id      INTEGER NOT NULL REFERENCES library_roots(id),
  rel_path     TEXT NOT NULL,                -- 相對 root，正斜線
  sha256       TEXT NOT NULL UNIQUE,
  filename     TEXT NOT NULL,
  ext          TEXT NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  file_mtime   TEXT NOT NULL,
  imported_at  TEXT NOT NULL,
  source_path  TEXT,                         -- 匯入來源絕對路徑（溯源／migration 用）
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trashed', 'missing')),
  rating       INTEGER,
  note         TEXT,
  UNIQUE (root_id, rel_path)
);
CREATE INDEX assets_imported ON assets (status, imported_at);
CREATE INDEX assets_mtime ON assets (status, file_mtime);

CREATE TABLE album_folders (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES album_folders(id) ON DELETE CASCADE,
  name       TEXT NOT NULL
);

CREATE TABLE albums (
  id              INTEGER PRIMARY KEY,
  folder_id       INTEGER REFERENCES album_folders(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  cover_asset_id  INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  sort_mode       TEXT NOT NULL DEFAULT 'manual',
  created_at      TEXT NOT NULL
);

CREATE TABLE album_items (
  album_id  INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  asset_id  INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  position  REAL NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (album_id, asset_id)
) WITHOUT ROWID;
CREATE INDEX album_items_asset ON album_items (asset_id);

CREATE TABLE tags (
  id         INTEGER PRIMARY KEY,
  parent_id  INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT,
  is_system  INTEGER NOT NULL DEFAULT 0
);
-- parent_id 為 NULL 時 UNIQUE 不生效，以 COALESCE 索引補足頂層唯一
CREATE UNIQUE INDEX tags_unique ON tags (COALESCE(parent_id, 0), name);

CREATE TABLE asset_tags (
  asset_id  INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source    TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ocr', 'ai', 'migration')),
  added_at  TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX asset_tags_tag ON asset_tags (tag_id, asset_id);

CREATE TABLE smart_albums (
  id          INTEGER PRIMARY KEY,
  folder_id   INTEGER REFERENCES album_folders(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  query_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE crops (
  id           INTEGER PRIMARY KEY,
  asset_id     INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,   -- 0..1 相對座標
  ratio_label  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX crops_asset ON crops (asset_id);

CREATE TABLE bundles (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE bundle_items (
  bundle_id  INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  position   REAL NOT NULL,
  asset_id   INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  crop_id    INTEGER REFERENCES crops(id) ON DELETE CASCADE
);
CREATE INDEX bundle_items_bundle ON bundle_items (bundle_id, position);

CREATE TABLE ocr_results (
  id            INTEGER PRIMARY KEY,
  asset_id      INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  crop_id       INTEGER REFERENCES crops(id) ON DELETE CASCADE,
  engine        TEXT NOT NULL,
  lang          TEXT,
  raw_text      TEXT NOT NULL,
  cleaned_text  TEXT NOT NULL,
  char_count    INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE bundle_revisions (
  id           INTEGER PRIMARY KEY,
  bundle_id    INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('ocr_merge', 'llm', 'manual')),
  model        TEXT,
  prompt_hash  TEXT,
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- CJK 需 trigram（查詢 <3 字時由應用層退回 LIKE）
CREATE VIRTUAL TABLE text_fts USING fts5 (body, kind UNINDEXED, ref_id UNINDEXED, tokenize = 'trigram');

CREATE TABLE events (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  undo_json     TEXT
);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
