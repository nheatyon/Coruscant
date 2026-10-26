import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from './database.js';
import { transaction } from './database.js';

export const migrationNames = ['001-core.sql', '002-material.sql', '003-workflow.sql', '004-results.sql', '005-delivery-observations.sql', '006-orbital-catalog.sql', '007-planning.sql', '008-proposed-plans.sql'] as const;
export const defaultMigrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));
function sources(directory = defaultMigrationsDirectory) {
  let files: string[];
  try { files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort(); }
  catch { throw new Error('Compiled SQL migrations are missing. Run npm run build:server before db:migrate.'); }
  if (files.join('|') !== migrationNames.join('|')) throw new Error('Missing or unknown SQL migration. Rebuild and review the schema sources.');
  return migrationNames.map(name => {
    const sql = readFileSync(join(directory,name), 'utf8');
    return { name, sql, hash: createHash('sha256').update(sql).digest('hex') };
  });
}
export function migrate(db: Database, directory = defaultMigrationsDirectory): void {
  const files = sources(directory);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT');
  const existing = db.prepare('SELECT name,hash FROM schema_migrations ORDER BY name').all() as { name: string; hash: string }[];
  if (existing.some(row => !files.some(file => file.name === row.name))) throw new Error('Database has a newer unknown schema; do not reinitialize it.');
  for (const file of files) {
    const previous = existing.find(row => row.name === file.name);
    if (previous && previous.hash !== file.hash) throw new Error(`Applied migration ${file.name} changed. Review a forward migration.`);
    if (!previous) {
      const rebuild = file.name === '007-planning.sql';
      if (rebuild) {
        if (db.isTransaction || db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Review existing foreign relationships before the Planning migration.');
        db.exec('PRAGMA foreign_keys=OFF');
      }
      try { transaction(db, () => {
        db.exec(file.sql);
        if (rebuild && db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Planning migration did not preserve existing foreign relationships.');
        db.prepare('INSERT INTO schema_migrations(name,hash,applied_at) VALUES(?,?,?)').run(file.name, file.hash, new Date().toISOString());
      }); } finally { if (rebuild) db.exec('PRAGMA foreign_keys=ON'); }
    }
  }
}
export function verifySchema(db: Database, directory = defaultMigrationsDirectory): void {
  const files = sources(directory);
  let rows: { name: string; hash: string }[];
  try { rows = db.prepare('SELECT name,hash FROM schema_migrations ORDER BY name').all() as typeof rows; }
  catch { throw new Error('Database is not migrated. Run npm run db:migrate, then npm run demo:init.'); }
  if (rows.length !== files.length || rows.some((row, index) => row.name !== files[index]?.name || row.hash !== files[index]?.hash)) {
    throw new Error('Database schema is missing, newer or changed. Review migrations before starting; do not delete saved records.');
  }
}
