-- Entities (companies, people, etc.)
CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,          -- canonical_id, e.g. "cmp_artisan_ai"
  type          TEXT NOT NULL,             -- 'company' | 'person' | ...
  canonical_name TEXT NOT NULL,
  aliases       JSONB DEFAULT '[]',
  external_ids  JSONB DEFAULT '{}'         -- { "domain": "artisan.co", "crunchbase": "...", ... }
);

-- Facts (magic variables)
CREATE TABLE IF NOT EXISTS facts (
  id           BIGSERIAL PRIMARY KEY,
  entity_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,              -- e.g. 'ceo_name'
  value        JSONB NOT NULL,             -- typed value (string/number/date/url/text)
  dtype        TEXT NOT NULL,              -- mirror of type: 'string'|'number'|'date'|'url'|'text'|'boolean'
  confidence   DOUBLE PRECISION CHECK (confidence >= 0 AND confidence <= 1),
  sources      JSONB DEFAULT '[]',         -- [{title,url,snippet}]
  notes        TEXT,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when you scraped/observed it
  valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- start of claim validity
  valid_to     TIMESTAMPTZ                      -- null => current
);

-- Fast lookups for "latest value per (entity_id, name)"
CREATE INDEX IF NOT EXISTS facts_entity_name_current_idx
  ON facts(entity_id, name, valid_to);

-- Ensure only one current row per (entity_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS facts_one_current_per_name
  ON facts(entity_id, name)
  WHERE valid_to IS NULL;

-- Index for entity type lookups
CREATE INDEX IF NOT EXISTS entities_type_idx ON entities(type);

-- Index for entity canonical_name lookups (case-insensitive)
CREATE INDEX IF NOT EXISTS entities_name_idx ON entities(lower(canonical_name));

