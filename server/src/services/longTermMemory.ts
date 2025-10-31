import { pool } from './db.js';

export type MemoryEntry = {
  id: string;
  text: string;
  createdAt: string;
  tags?: string[];
};

export async function getUserMemory(username: string): Promise<MemoryEntry[]> {
  try {
    const result = await pool.query(
      'SELECT id, text, created_at AS "createdAt", tags FROM user_memory WHERE username = $1 ORDER BY created_at DESC LIMIT 200',
      [username]
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get user memory:', err);
    return [];
  }
}

export async function addMemory(username: string, text: string, tags?: string[]): Promise<MemoryEntry> {
  try {
    const result = await pool.query(
      `INSERT INTO user_memory (username, text, tags)
       VALUES ($1, $2, $3)
       ON CONFLICT (username, text) DO UPDATE SET created_at = NOW()
       RETURNING id, text, created_at AS "createdAt", tags`,
      [username, text, tags || null]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Failed to add memory:', err);
    throw err;
  }
}

export async function clearMemory(username: string): Promise<void> {
  try {
    await pool.query('DELETE FROM user_memory WHERE username = $1', [username]);
  } catch (err) {
    console.error('Failed to clear memory:', err);
    throw err;
  }
}
