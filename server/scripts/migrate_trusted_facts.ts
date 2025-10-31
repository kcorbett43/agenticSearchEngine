import { promises as fs } from 'fs';
import path from 'path';
import { pool } from '../src/services/db.js';

async function ensureTable(): Promise<void> {
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
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trusted_facts_entity ON trusted_facts ((lower(entity)))');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_trusted_facts_field ON trusted_facts ((lower(field)))');
}

async function backfillFromJson(): Promise<void> {
  const dataDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../data');
  const filePath = path.join(dataDir, 'trusted_facts.json');
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, Record<string, any>>;
    for (const [entity, fields] of Object.entries(parsed || {})) {
      for (const [field, fact] of Object.entries(fields || {})) {
        const value = (fact as any).value ?? null;
        const source = (fact as any).source ?? null;
        const updatedBy = (fact as any).updatedBy ?? null;
        const updatedAt = (fact as any).updatedAt ?? null;
        await pool.query(
          `INSERT INTO trusted_facts (entity, field, value, source, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), $6)
           ON CONFLICT (entity, field)
           DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
          [entity, field, JSON.stringify(value), source, updatedAt, updatedBy]
        );
      }
    }
    console.log('Backfill from JSON complete');
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      console.log('No JSON file found for backfill; skipping');
      return;
    }
    throw e;
  }
}

async function main() {
  await ensureTable();
  await backfillFromJson();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


