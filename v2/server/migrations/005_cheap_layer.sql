-- 005_cheap_layer：AI 分流 A1 便宜層（dev/Sprint_Screenshot_AI_Triage.md §3 S0／S1）。
-- asset_hashes：S0 dHash 近重複；tag_matchers：S1 規則引擎（Paperless-ngx 式 matcher）。

CREATE TABLE asset_hashes (
  asset_id      INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  dhash         TEXT NOT NULL CHECK (length(dhash) = 16),   -- 64-bit dHash，16 位小寫 hex
  flat          INTEGER NOT NULL DEFAULT 0,                 -- 9×8 灰階幾乎無變化（全白／全黑）→ 不參與分群
  dup_of        INTEGER REFERENCES assets(id) ON DELETE SET NULL,  -- 最近一次偵測時所屬群組的保留者
  dup_distance  INTEGER,                                    -- 與 dup_of 的漢明距離
  computed_at   TEXT NOT NULL
);
CREATE INDEX asset_hashes_dup ON asset_hashes (dup_of);

CREATE TABLE tag_matchers (
  id          INTEGER PRIMARY KEY,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,          -- 規則名稱；建議 reason 只寫「命中規則「name」」，永不寫命中原文
  kind        TEXT NOT NULL CHECK (kind IN ('any', 'all', 'regex', 'filename', 'dimension')),
  pattern     TEXT NOT NULL,          -- any/all：以 , 、 ， 或換行分隔的詞；regex/filename：JS 正規式（iu）；dimension：如 ratio>=2,w<=1200
  confidence  REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  enabled     INTEGER NOT NULL DEFAULT 1,
  is_seed     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX tag_matchers_tag ON tag_matchers (tag_id);

-- 預設種子規則。sensitive 為 recall 優先（寧可多標），confidence 刻意偏低，反映預期 precision 不高；
-- 預選門檻（precision ≥ 0.9）不會因這些規則自動成立。
INSERT INTO tag_matchers (tag_id, name, kind, pattern, confidence, is_seed, created_at)
  SELECT t.id, v.name, v.kind, v.pattern, v.conf, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM tags t,
    (SELECT '敏感關鍵字：帳密' AS name, 'any' AS kind, '密碼,驗證碼,OTP,一次性密碼,動態密碼,帳號,password,passcode' AS pattern, 0.6 AS conf
     UNION ALL SELECT '敏感關鍵字：金融', 'any', '卡號,信用卡,轉帳,匯款,餘額,帳戶,存款', 0.6
     UNION ALL SELECT '敏感關鍵字：身分', 'any', '身分證,身份證,護照,地址,電話,生日', 0.5
     UNION ALL SELECT '信用卡號樣式', 'regex', '(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)', 0.7
     UNION ALL SELECT '身分證字號樣式', 'regex', '(?<![A-Za-z0-9])[A-Z][12]\d{8}(?!\d)', 0.75
     UNION ALL SELECT '手機號碼樣式', 'regex', '(?<!\d)09\d{2}[- ]?\d{3}[- ]?\d{3}(?!\d)', 0.6) AS v
  WHERE t.parent_id IS NULL AND t.name = 'sensitive';

INSERT INTO tag_matchers (tag_id, name, kind, pattern, confidence, is_seed, created_at)
  SELECT t.id, v.name, v.kind, v.pattern, v.conf, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM tags t
    JOIN tags p ON p.id = t.parent_id AND p.parent_id IS NULL AND p.name = 'purpose',
    (SELECT 'receipt' AS tag, '收據關鍵字' AS name, 'any' AS kind,
            '發票,收據,訂單編號,付款成功,付款完成,轉帳成功,交易成功,交易明細' AS pattern, 0.7 AS conf
     UNION ALL SELECT 'receipt', '金額字樣', 'any', '金額,NT$,NTD', 0.5
     UNION ALL SELECT 'chat', '聊天介面字樣（弱）', 'any', '已讀,輸入訊息,傳送訊息', 0.4) AS v
  WHERE t.name = v.tag;
