-- Create user_memory table for long-term memory storage
CREATE TABLE IF NOT EXISTS user_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_memory_username_text_unique UNIQUE(username, text)
);

-- Index for quick lookups by username
CREATE INDEX IF NOT EXISTS user_memory_username_idx ON user_memory (username);

-- Index for created_at to allow ordering
CREATE INDEX IF NOT EXISTS user_memory_created_at_idx ON user_memory (created_at DESC);

