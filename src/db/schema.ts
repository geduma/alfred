export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_message_at DATETIME,
  message_count INTEGER DEFAULT 0,
  metadata JSON,
  UNIQUE(channel, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT CHECK(role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_calls JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

CREATE TABLE IF NOT EXISTS command_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  command TEXT NOT NULL,
  result TEXT,
  exit_code INTEGER,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  duration_ms INTEGER,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_command_log_user_id ON command_log(user_id);
CREATE INDEX IF NOT EXISTS idx_command_log_executed_at ON command_log(executed_at);

CREATE TABLE IF NOT EXISTS user_context (
  user_id TEXT PRIMARY KEY,
  preferences JSON,
  timezone TEXT,
  language TEXT DEFAULT 'es',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skills_cache (
  name TEXT PRIMARY KEY,
  description TEXT,
  file_path TEXT NOT NULL,
  enabled BOOLEAN DEFAULT 1,
  requires_env JSON,
  last_loaded DATETIME,
  hash TEXT
);

CREATE TABLE IF NOT EXISTS token_usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  provider TEXT NOT NULL,
  tokens_used INTEGER NOT NULL,
  is_paid INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'interactive',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage_log(date);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  origin_channel TEXT NOT NULL,
  origin_chat_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  skill_name TEXT,
  input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error_detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  notified_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_origin ON tasks(origin_channel, origin_chat_id);
`;
