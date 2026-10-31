-- 003_suggestions：AI 分流建議（dev/Sprint_Screenshot_AI_Triage.md §2、§3.1）。
-- 建議與事實分離：asset_suggestions 只是候選，人接受後才寫 asset_tags(source='ai')。

ALTER TABLE tags ADD COLUMN description TEXT;   -- 自訂 tag 的描述；有描述者會進 VLM prompt

CREATE TABLE asset_suggestions (
  id           INTEGER PRIMARY KEY,
  asset_id     INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id       INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL CHECK (stage IN ('dup', 'rule', 'vlm', 'claude', 'import')),
  confidence   REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason       TEXT,
  model        TEXT NOT NULL DEFAULT '',
  prompt_hash  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
  created_at   TEXT NOT NULL,
  decided_at   TEXT,
  UNIQUE (asset_id, tag_id, stage, model, prompt_hash)       -- 同模型同 prompt 重跑不重複
);
CREATE INDEX asset_suggestions_asset ON asset_suggestions (asset_id, status);
CREATE INDEX asset_suggestions_tag ON asset_suggestions (tag_id, status, confidence);

-- 內容類型與情境：系統 tag（建議會引用，不可刪改）
INSERT INTO tags (parent_id, name, color, is_system) VALUES (NULL, 'purpose', NULL, 1);
INSERT INTO tags (parent_id, name, color, is_system, description)
  SELECT id, v.name, v.color, 1, v.descr FROM tags,
    (SELECT 'text-note' AS name, '#2f6fb3' AS color, '要保存文字內容當筆記：文章、貼文長文、教學、文件' AS descr
     UNION ALL SELECT 'chat', '#3b8f6b', '對話紀錄：訊息串，重點是誰說了什麼'
     UNION ALL SELECT 'translate', '#7a5bb5', '主要內容為中文、英文以外的外語'
     UNION ALL SELECT 'visual-ref', '#c27a2d', '保存畫面本身：UI、穿搭、配色、構圖、圖表'
     UNION ALL SELECT 'receipt', '#8a6d1f', '收據、發票、訂單、付款或轉帳成功'
     UNION ALL SELECT 'ephemeral', '#6b6b66', '內容先天有時效：驗證碼、載入中、通知、主畫面、誤觸、重複連拍') AS v
  WHERE tags.parent_id IS NULL AND tags.name = 'purpose';

INSERT INTO tags (parent_id, name, color, is_system) VALUES (NULL, 'context', NULL, 1);
INSERT INTO tags (parent_id, name, color, is_system, description)
  SELECT id, v.name, v.color, 1, v.descr FROM tags,
    (SELECT 'work' AS name, '#1f5f8b' AS color, '數位行銷代理商工作：廣告、GA4、報表、客戶、公司通訊、資料工程、程式' AS descr
     UNION ALL SELECT 'personal', '#9b4f7a', '生活、娛樂、購物、人際、個人興趣') AS v
  WHERE tags.parent_id IS NULL AND tags.name = 'context';

-- 初始自訂 tag（Sprint §9 Q7）：只用於篩選，可自由改刪
INSERT INTO tags (parent_id, name, color, is_system) VALUES (NULL, 'custom', NULL, 0);
INSERT INTO tags (parent_id, name, color, is_system, description)
  SELECT id, v.name, NULL, 0, v.descr FROM tags,
    (SELECT 'AI工具' AS name, 'AI 產品、提示詞、自動化、開源工具' AS descr
     UNION ALL SELECT '資料分析', 'SQL、Python、KPI、資料庫、報表'
     UNION ALL SELECT '職涯', '求職、職場、管理'
     UNION ALL SELECT '穿搭', '服裝、外套、搭配'
     UNION ALL SELECT '配色設計', '配色、版面、設計參考'
     UNION ALL SELECT '攝影', '構圖、擺姿、人像'
     UNION ALL SELECT '旅遊', '景點、行程、交通') AS v
  WHERE tags.parent_id IS NULL AND tags.name = 'custom';
