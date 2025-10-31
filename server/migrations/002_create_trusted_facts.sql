-- Create trusted_facts table for storing verified facts about entities
CREATE TABLE IF NOT EXISTS trusted_facts (
  entity      text        NOT NULL,
  field       text        NOT NULL,
  value       jsonb,
  source      text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (entity, field)
);

-- Index for quick lookups by entity (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_trusted_facts_entity ON trusted_facts ((lower(entity)));

-- Index for quick lookups by field (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_trusted_facts_field ON trusted_facts ((lower(field)));

