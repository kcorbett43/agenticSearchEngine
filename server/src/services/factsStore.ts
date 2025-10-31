import { promises as fs } from 'fs';
import path from 'path';
import { pool } from './db.js';

export type TrustedFactValue = string | number | boolean | null;

export interface TrustedFact {
  entity: string; // e.g., company/person/product identifier
  field: string;  // e.g., founding_date, headquarters, ceo
  value: TrustedFactValue;
  source?: string; // canonical URL where this was verified
  updatedAt: string;
  updatedBy?: string;
}

type FactsIndex = Record<string, Record<string, TrustedFact>>; // entity -> field -> fact

const DATA_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data');
const FACTS_PATH = path.join(DATA_DIR, 'trusted_facts.json');

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
    // ignore
  }
}

async function readFactsIndex(): Promise<FactsIndex> {
  try {
    await ensureDataDir();
    const buf = await fs.readFile(FACTS_PATH, 'utf-8');
    const parsed = JSON.parse(buf);
    return (parsed && typeof parsed === 'object') ? parsed as FactsIndex : {};
  } catch {
    return {};
  }
}

async function writeFactsIndex(idx: FactsIndex): Promise<void> {
  await ensureDataDir();
  const json = JSON.stringify(idx, null, 2);
  await fs.writeFile(FACTS_PATH, json, 'utf-8');
}

async function ensureTable(): Promise<void> {
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS trusted_facts (
        entity      text        NOT NULL,
        field       text        NOT NULL,
        value       jsonb,
        source      text,
        updated_at  timestamptz NOT NULL DEFAULT now(),
        updated_by  text,
        PRIMARY KEY (entity, field)
      )`
    );
  } catch {
    // ignore; fallback to file will handle if DB unavailable
  }
}

export async function getTrustedFact(entity: string, field: string): Promise<TrustedFact | undefined> {
  try {
    await ensureTable();
    const res = await pool.query(
      'SELECT entity, field, value, source, updated_at AS "updatedAt", updated_by AS "updatedBy" FROM trusted_facts WHERE entity = $1 AND field = $2',
      [entity, field]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      entity: row.entity,
      field: row.field,
      value: row.value as TrustedFactValue,
      source: row.source ?? undefined,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy ?? undefined
    };
  } catch {
    const idx = await readFactsIndex();
    return idx[entity]?.[field];
  }
}

export async function setTrustedFact(params: {
  entity: string;
  field: string;
  value: TrustedFactValue;
  source?: string;
  updatedBy?: string;
}): Promise<TrustedFact> {
  const { entity, field, value, source, updatedBy } = params;
  const updatedAt = new Date().toISOString();
  try {
    await ensureTable();
    const res = await pool.query(
      `INSERT INTO trusted_facts (entity, field, value, source, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (entity, field)
       DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
       RETURNING entity, field, value, source, updated_at AS "updatedAt", updated_by AS "updatedBy"`,
      [entity, field, JSON.stringify(value), source ?? null, updatedAt, updatedBy ?? null]
    );
    const row = res.rows[0];
    return {
      entity: row.entity,
      field: row.field,
      value: row.value as TrustedFactValue,
      source: row.source ?? undefined,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy ?? undefined
    };
  } catch {
    const idx = await readFactsIndex();
    const fact: TrustedFact = { entity, field, value, source, updatedAt, updatedBy };
    if (!idx[entity]) idx[entity] = {};
    idx[entity][field] = fact;
    await writeFactsIndex(idx);
    return fact;
  }
}

export async function getTrustedFactsForEntity(entity: string): Promise<Record<string, TrustedFact>> {
  try {
    await ensureTable();
    const res = await pool.query(
      'SELECT entity, field, value, source, updated_at AS "updatedAt", updated_by AS "updatedBy" FROM trusted_facts WHERE entity = $1',
      [entity]
    );
    const out: Record<string, TrustedFact> = {};
    for (const row of res.rows) {
      out[row.field] = {
        entity: row.entity,
        field: row.field,
        value: row.value as TrustedFactValue,
        source: row.source ?? undefined,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy ?? undefined
      };
    }
    return out;
  } catch {
    const idx = await readFactsIndex();
    return idx[entity] ?? {};
  }
}


