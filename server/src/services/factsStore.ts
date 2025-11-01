import { pool } from './db.js';
import { resolveEntity, tryResolveExistingEntity } from './entityResolver.js';
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

export async function storeFact(
  variable: MagicVariableValue,
  observedAt?: Date
): Promise<Fact> {

  const entityId = await resolveEntity(variable.subject.name, variable.subject.type);

  const now = observedAt || new Date();

  await pool.query(
    `UPDATE facts 
     SET valid_to = $1 
     WHERE entity_id = $2 AND name = $3 AND valid_to IS NULL`,
    [now, entityId, variable.name]
  );

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

export async function setTrustedFact(params: {
  entity: string;
  field: string;
  value: unknown;
  source?: string;
  updatedBy?: string;
}): Promise<any> {

  const existing = await tryResolveExistingEntity(params.entity);
  if (!existing) {
    throw new Error(`Entity "${params.entity}" not found. Cannot set trusted fact for unknown entity.`);
  }
  
  const existingFact = await getFact(existing.id, params.field);
  const originalConfidence = existingFact?.confidence ?? 0.5;
  const newConfidence = (originalConfidence + 1.0) / 2;
  
  const variable: MagicVariableValue = {
    subject: {
      name: existing.name,
      type: existing.type,
      canonical_id: existing.id
    },
    name: params.field,
    type: typeof params.value === 'number' ? 'number' :
          typeof params.value === 'boolean' ? 'boolean' :
          'string',
    value: params.value,
    confidence: newConfidence,
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

export async function findSimilarFactNames(entityId: string, patternBase: string, limit: number = 5): Promise<string[]> {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const base = normalize(patternBase);
  try {
    const res = await pool.query(
      `SELECT DISTINCT name FROM facts WHERE entity_id = $1 AND LOWER(name) LIKE LOWER($2) LIMIT $3`,
      [entityId, `%${base}%`, limit]
    );
    return res.rows.map((r: any) => r.name).filter((n: string) => normalize(n) !== base);
  } catch {
    return [];
  }
}
