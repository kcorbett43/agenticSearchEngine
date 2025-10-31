import { pool } from './db.js';
import { resolveEntity } from './entityResolver.js';
import { MagicVariableValue, SourceAttribution } from '../types.js';

export interface Fact {
  id: number;
  entity_id: string;
  name: string;
  value: unknown;
  dtype: string;
  confidence: number | null;
  sources: SourceAttribution[];
  notes: string | null;
  observed_at: Date;
  valid_from: Date;
  valid_to: Date | null;
}

/**
 * Stores a fact (magic variable) with entity resolution.
 * Closes any existing current fact for the same (entity_id, name) and creates a new one.
 */
export async function storeFact(
  variable: MagicVariableValue,
  observedAt?: Date
): Promise<Fact> {
  // Resolve the entity
  const entityId = await resolveEntity(variable.subject.name, variable.subject.type);

  const now = observedAt || new Date();
  const observedAtISO = now.toISOString();

  // Close any existing current fact (set valid_to to now)
  await pool.query(
    `UPDATE facts 
     SET valid_to = $1 
     WHERE entity_id = $2 AND name = $3 AND valid_to IS NULL`,
    [now, entityId, variable.name]
  );

  // Insert new fact as current (valid_to = NULL)
  const result = await pool.query(
    `INSERT INTO facts (
      entity_id, name, value, dtype, confidence, sources, notes, observed_at, valid_from, valid_to
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
    RETURNING id, entity_id, name, value, dtype, confidence, sources, notes, observed_at, valid_from, valid_to`,
    [
      entityId,
      variable.name,
      JSON.stringify(variable.value),
      variable.type,
      variable.confidence,
      JSON.stringify(variable.sources || []),
      null,
      now,
      now
    ]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    entity_id: row.entity_id,
    name: row.name,
    value: row.value,
    dtype: row.dtype,
    confidence: row.confidence,
    sources: row.sources as SourceAttribution[],
    notes: row.notes,
    observed_at: row.observed_at,
    valid_from: row.valid_from,
    valid_to: row.valid_to
  };
}

/**
 * Gets the current fact for a given entity and fact name.
 */
export async function getFact(entityId: string, factName: string): Promise<Fact | null> {
  const result = await pool.query(
    `SELECT id, entity_id, name, value, dtype, confidence, sources, notes, observed_at, valid_from, valid_to
     FROM facts
     WHERE entity_id = $1 AND name = $2 AND valid_to IS NULL
     LIMIT 1`,
    [entityId, factName]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    entity_id: row.entity_id,
    name: row.name,
    value: row.value,
    dtype: row.dtype,
    confidence: row.confidence,
    sources: row.sources as SourceAttribution[],
    notes: row.notes,
    observed_at: row.observed_at,
    valid_from: row.valid_from,
    valid_to: row.valid_to
  };
}

/**
 * Gets all current facts for an entity.
 */
export async function getFactsForEntity(entityId: string): Promise<Fact[]> {
  const result = await pool.query(
    `SELECT id, entity_id, name, value, dtype, confidence, sources, notes, observed_at, valid_from, valid_to
     FROM facts
     WHERE entity_id = $1 AND valid_to IS NULL
     ORDER BY name`,
    [entityId]
  );

  return result.rows.map(row => ({
    id: row.id,
    entity_id: row.entity_id,
    name: row.name,
    value: row.value,
    dtype: row.dtype,
    confidence: row.confidence,
    sources: row.sources as SourceAttribution[],
    notes: row.notes,
    observed_at: row.observed_at,
    valid_from: row.valid_from,
    valid_to: row.valid_to
  }));
}

/**
 * Legacy compatibility: Get trusted facts for an entity (by entity name string).
 * This resolves the entity name to an entity_id and returns facts as the old format.
 */
export async function getTrustedFactsForEntity(entityName: string): Promise<Record<string, any>> {
  try {
    // Try to find entity by name
    const entityResult = await pool.query(
      `SELECT id FROM entities WHERE LOWER(canonical_name) = LOWER($1) LIMIT 1`,
      [entityName]
    );

    if (entityResult.rows.length === 0) {
      return {};
    }

    const entityId = entityResult.rows[0].id;
    const facts = await getFactsForEntity(entityId);

    const out: Record<string, any> = {};
    for (const fact of facts) {
      out[fact.name] = {
        entity: entityName,
        field: fact.name,
        value: fact.value,
        source: fact.sources && fact.sources.length > 0 ? fact.sources[0].url : undefined,
        updatedAt: fact.observed_at,
        updatedBy: undefined
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Legacy compatibility: Set a trusted fact.
 */
export async function setTrustedFact(params: {
  entity: string;
  field: string;
  value: unknown;
  source?: string;
  updatedBy?: string;
}): Promise<any> {
  // Try to determine entity type from context (default to 'company')
  const entityType = 'company'; // Could be enhanced to detect from context
  
  const entityId = await resolveEntity(params.entity, entityType);
  
  const variable: MagicVariableValue = {
    subject: {
      name: params.entity,
      type: entityType,
      canonical_id: entityId
    },
    name: params.field,
    type: typeof params.value === 'number' ? 'number' :
          typeof params.value === 'boolean' ? 'boolean' :
          'string',
    value: params.value,
    confidence: 1.0,
    sources: params.source ? [{ url: params.source }] : [],
    observed_at: new Date().toISOString()
  };

  await storeFact(variable);
  
  return {
    entity: params.entity,
    field: params.field,
    value: params.value,
    source: params.source,
    updatedAt: new Date().toISOString(),
    updatedBy: params.updatedBy
  };
}


