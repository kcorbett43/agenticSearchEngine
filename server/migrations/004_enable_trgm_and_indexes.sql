-- Enable trigram extension for fuzzy matching if not already present
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Speed up similarity/LIKE/ILIKE on entity names
CREATE INDEX IF NOT EXISTS entities_name_trgm_idx
  ON entities USING gin (canonical_name gin_trgm_ops);

-- Speed up variable-name lookups on current facts for synonym search/cache-miss flows
CREATE INDEX IF NOT EXISTS facts_name_trgm_idx
  ON facts USING gin (name gin_trgm_ops)
  WHERE valid_to IS NULL;


