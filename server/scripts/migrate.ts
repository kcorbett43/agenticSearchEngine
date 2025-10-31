import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../src/services/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrations() {
  try {
    const migrationPath = join(__dirname, '../migrations/001_create_user_memory.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    
    await pool.query(sql);
    console.log('Migration completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

runMigrations();

