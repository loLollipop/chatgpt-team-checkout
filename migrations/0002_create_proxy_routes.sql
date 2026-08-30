CREATE TABLE IF NOT EXISTS proxy_routes (
  country TEXT PRIMARY KEY,
  encrypted_url TEXT NOT NULL,
  display_url TEXT NOT NULL,
  protocol TEXT NOT NULL,
  host TEXT NOT NULL,
  port TEXT NOT NULL,
  masked_username TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  last_tested_at TEXT,
  last_test_status TEXT NOT NULL DEFAULT 'untested',
  last_exit_ip TEXT,
  last_latency_ms INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_proxy_routes_test_status
  ON proxy_routes(last_test_status, last_tested_at);
