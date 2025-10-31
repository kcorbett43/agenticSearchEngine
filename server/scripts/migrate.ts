import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/services/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Ensures the schema_migrations table exists to track which migrations have been run
 */
async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Gets the list of migrations that have already been executed
 */
async function getExecutedMigrations(): Promise<Set<string>> {
  const result = await pool.query('SELECT migration_name FROM schema_migrations');
  return new Set(result.rows.map((row: { migration_name: string }) => row.migration_name));
}

/**
 * Gets all SQL migration files from the migrations directory, sorted by filename
 */
async function getMigrationFiles(): Promise<string[]> {
  const migrationsDir = join(__dirname, '../migrations');
  const files = await readdir(migrationsDir);
  return files
    .filter((file) => file.endsWith('.sql'))
    .sort(); // Sort alphabetically (001, 002, etc.)
}

/**
 * Records that a migration has been executed
 */
async function recordMigration(migrationName: string): Promise<void> {
  await pool.query(
    'INSERT INTO schema_migrations (migration_name) VALUES ($1) ON CONFLICT (migration_name) DO NOTHING',
    [migrationName]
  );
}

/**
 * Runs all pending migrations
 */
async function runMigrations(): Promise<void> {
  try {
    // Ensure migrations table exists
    await ensureMigrationsTable();

    // Get list of executed and pending migrations
    const executedMigrations = await getExecutedMigrations();
    const migrationFiles = await getMigrationFiles();

    if (migrationFiles.length === 0) {
      console.log('No migration files found');
      return;
    }

    const migrationsDir = join(__dirname, '../migrations');
    let executedCount = 0;
    let skippedCount = 0;

    for (const file of migrationFiles) {
      if (executedMigrations.has(file)) {
        console.log(`⏭️  Skipping ${file} (already executed)`);
        skippedCount++;
        continue;
      }

      console.log(`▶️  Running ${file}...`);
      const migrationPath = join(migrationsDir, file);
      const sql = await readFile(migrationPath, 'utf-8');

      // Run migration in a transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await recordMigration(file);
        await client.query('COMMIT');
        console.log(`✅ Completed ${file}`);
        executedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    console.log(`\n📊 Migration summary: ${executedCount} executed, ${skippedCount} skipped`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
