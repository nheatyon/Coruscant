import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

// Read only orbital metadata, never contacts, sessions, private results or workflow records.
const dataRoot = process.argv[2];
assert.ok(dataRoot && isAbsolute(dataRoot), 'Supply the absolute configured data root after an explicit successful public catalog refresh.');
const root = resolve(dataRoot, 'orbital'), db = new DatabaseSync(join(dataRoot, 'coruscant.sqlite'), { readOnly: true });
const groups = {};
try {
  for (const group of ['sar', 'resource']) {
    const row = db.prepare(`SELECT v.* FROM orbital_source_state s JOIN orbital_source_versions v ON v.version=s.last_source_version WHERE s.source_key=?`).get(group);
    assert.ok(row, `${group}: no retained successful source; refresh it explicitly before exporting.`);
    assert.match(row.raw_filename, /^[a-f0-9]{64}\.json$/);
    const bytes = readFileSync(join(root, row.raw_filename)); assert.ok(bytes.length <= 8 * 1024 * 1024);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.response_hash, `${group}: cached bytes changed.`);
    const attempt = db.prepare(`SELECT attempted_at,next_allowed_at FROM orbital_source_attempts WHERE source_key=? AND outcome='SUCCESS' AND http_status=200 AND response_hash=? AND attempted_at<=? ORDER BY attempted_at DESC LIMIT 1`).get(group, row.response_hash, row.retrieved_at);
    assert.ok(attempt, `${group}: no corresponding successful acquisition receipt; do not manufacture one.`);
    groups[group] = { url: `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=JSON`, status: 'success', httpStatus: 200,
      attemptedAt: attempt.attempted_at, nextAllowedAt: attempt.next_allowed_at, retrievedAt: row.retrieved_at,
      sha256: row.response_hash, rawFile: row.raw_filename };
  }
} finally { db.close(); }
const destination = join(root, 'verification-ledger.json'), temporary = destination + '.' + randomUUID();
writeFileSync(temporary, JSON.stringify({ schema: 1, groups }, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, destination);
console.log('Saved private source-hash verification ledger. Original retrieval/epoch ages are unchanged; no provider call or workflow write occurred.');
