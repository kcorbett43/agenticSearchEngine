import { pool } from './db.js';

export interface EntitySubject {
  name: string;
  type: string;
  canonical_id: string;
}

/**
 * Resolves a subject name and type to a canonical entity_id.
 * Creates a new entity if it doesn't exist.
 */
export async function resolveEntity(name: string, type: string): Promise<string> {
  if (!name || !type) {
    throw new Error('Entity name and type are required');
  }

  // Normalize the name
  const normalizedName = name.trim();
  const normalizedType = type.trim().toLowerCase();

  // Generate canonical_id: type_prefix_name (sanitized)
  // e.g., "cmp_artisan_ai", "per_john_doe"
  const prefix = normalizedType === 'company' ? 'cmp' : 
                 normalizedType === 'person' ? 'per' : 
                 normalizedType.slice(0, 3).toLowerCase();
  
  // Sanitize name for ID: lowercase, replace spaces/special chars with underscores
  const sanitized = normalizedName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  
  const candidateId = `${prefix}_${sanitized}`;

  // Check if entity exists with this ID
  const existing = await pool.query(
    'SELECT id FROM entities WHERE id = $1',
    [candidateId]
  );

  if (existing.rows.length > 0) {
    return candidateId;
  }

  // Check if entity exists with this name (case-insensitive)
  const existingByName = await pool.query(
    'SELECT id FROM entities WHERE LOWER(canonical_name) = LOWER($1) AND type = $2',
    [normalizedName, normalizedType]
  );

  if (existingByName.rows.length > 0) {
    return existingByName.rows[0].id;
  }

  // Create new entity
  await pool.query(
    `INSERT INTO entities (id, type, canonical_name, aliases, external_ids)
     VALUES ($1, $2, $3, '[]', '{}')
     ON CONFLICT (id) DO NOTHING`,
    [candidateId, normalizedType, normalizedName]
  );

  return candidateId;
}

/**
 * Gets an entity by its canonical_id
 */
export async function getEntity(entityId: string): Promise<EntitySubject | null> {
  const result = await pool.query(
    'SELECT id, type, canonical_name FROM entities WHERE id = $1',
    [entityId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    name: row.canonical_name,
    type: row.type,
    canonical_id: row.id
  };
}

/**
 * Adds an alias to an entity
 */
export async function addEntityAlias(entityId: string, alias: string): Promise<void> {
  const result = await pool.query(
    'SELECT aliases FROM entities WHERE id = $1',
    [entityId]
  );

  if (result.rows.length === 0) {
    throw new Error(`Entity ${entityId} not found`);
  }

  const aliases = result.rows[0].aliases || [];
  if (!aliases.includes(alias)) {
    aliases.push(alias);
    await pool.query(
      'UPDATE entities SET aliases = $1 WHERE id = $2',
      [JSON.stringify(aliases), entityId]
    );
  }
}

