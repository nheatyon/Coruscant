import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import type { AppConfig } from '../config.js';

export type Database = DatabaseSync;
export function openDatabase(config: AppConfig): Database {
  mkdirSync(config.dataRoot, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;');
  return db;
}

/** Every callback is synchronous: a write lock never crosses awaited work. */
export function transaction<T>(db: Database, action: () => T, write = true): T {
  db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = action();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('Database transactions cannot contain asynchronous work.');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
