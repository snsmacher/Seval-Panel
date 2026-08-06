CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  country TEXT DEFAULT '',
  city TEXT DEFAULT '',
  region TEXT DEFAULT '',
  ua TEXT DEFAULT '',
  browser TEXT DEFAULT '',
  os TEXT DEFAULT '',
  device TEXT DEFAULT '',
  bot_score INTEGER DEFAULT 0,
  referrer TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hits_created ON hits(created_at);
CREATE INDEX IF NOT EXISTS idx_hits_path ON hits(path);
