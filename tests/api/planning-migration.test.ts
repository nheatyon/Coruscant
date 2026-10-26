import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defaultMigrationsDirectory, migrate, migrationNames, verifySchema } from '../../server/db/migrate.js';
import { join } from 'node:path';
import { parseSourceBytes } from '../../server/orbital/catalog.js';
import { captureCatalog, ingestSources } from '../../server/orbital/repository.js';

test('ordered forward007/008 preserve legacy comparison JSON, accepted relationships, real source versions and all prior rows',()=>{
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  try {
    db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,hash TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT');
    // Construct the actual pre007 baseline; never apply a newer migration before
    // the historical table rebuild that it depends on.
    for(const name of migrationNames.slice(0,migrationNames.indexOf('007-planning.sql'))){
      const sql=readFileSync(join(defaultMigrationsDirectory,name),'utf8');db.exec(sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(name,createHash('sha256').update(sql).digest('hex'),'2026-10-21T10:00:00.000Z');
    }
    db.prepare('INSERT INTO organizations VALUES(?,?,?)').run('fresh-org','Fresh generated organization','fresh-org-hash');
    db.prepare('INSERT INTO actors VALUES(?,?,?,?,?)').run('fresh-actor','Fresh generated actor','CUSTOMER',1,'fresh-actor-hash');
    const contact=JSON.stringify({name:'Generated legacy contact',email:'legacy@coruscant.example',organization:'Generated only'});
    // Freshly authored source double: no fetched or older project fixture is imported.
    const bytes=Buffer.from(JSON.stringify([{NORAD_CAT_ID:100123,OBJECT_NAME:'Generated migration orbital row',OBJECT_ID:'2099-000A',EPOCH:'2026-10-21T09:00:00.123456',MEAN_MOTION:14.8,ECCENTRICITY:.002,INCLINATION:51,RA_OF_ASC_NODE:40,ARG_OF_PERICENTER:12,MEAN_ANOMALY:70,BSTAR:0,MEAN_MOTION_DOT:0,MEAN_MOTION_DDOT:0}]));
    const source=parseSourceBytes('resource',bytes,'2026-10-21T10:00:00.000Z');ingestSources(db,[{source,rawFilename:`${source.responseHash}.json`}],'2026-10-21T10:00:00.000Z');
    const real=captureCatalog(db)!,legacyBrief=JSON.stringify({purpose:'Fresh legacy-shaped migration comparison',family:'EO',sensor:'SAR',baselineDate:'2026-10-03',recentDate:'2026-10-10',selectedEvidence:[{itemId:real.items[0]!.id,evidenceVersion:real.items[0]!.evidenceVersion}]}),evidence=JSON.stringify([real.items[0]]);
    db.prepare("INSERT INTO service_requests(id,reference,organization_id,original_actor_id,original_contact_json,submitted_at,title,status,aggregate_version,current_brief_revision,matching_state) VALUES(?,?,?,?,?,?,?,'Accepted',3,1,'Preliminary check ready')").run('fresh-request','SRS-FRESH-LEGACY','fresh-org','fresh-actor',contact,'2026-10-21T10:00:00.000Z','Fresh migration comparison');
    db.prepare('INSERT INTO brief_revisions VALUES(?,?,?,?,?,?,?)').run('fresh-request','fresh-org',1,legacyBrief,evidence,'2026-10-21T10:00:00.000Z','fresh-actor');
    db.prepare("INSERT INTO quotes(id,request_id,organization_id,brief_revision,content_version,state,terms_json,priced_brief_json,created_by,created_at,updated_at,published_at) VALUES(?,?,?,?,?,'ACCEPTED',?,?,?,?,?,?)").run('fresh-quote','fresh-request','fresh-org',1,1,'{}',legacyBrief,'fresh-actor','2026-10-21T10:01:00.000Z','2026-10-21T10:02:00.000Z','2026-10-21T10:01:00.000Z');
    db.prepare('UPDATE service_requests SET accepted_quote_id=? WHERE id=?').run('fresh-quote','fresh-request');
    const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('service_requests','schema_migrations') ORDER BY name").all() as {name:string}[]).map(r=>r.name);
    const before=Object.fromEntries(tables.map(name=>[name,JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())]));
    const prior=db.prepare('SELECT * FROM service_requests').get()!;
    migrate(db);verifySchema(db);
    const after=db.prepare('SELECT * FROM service_requests').get()!;
    for(const [key,value]of Object.entries(prior))assert.deepEqual(after[key],value,key);
    assert.equal(after.first_saved_at,prior.submitted_at);assert.equal(after.submitted_actor_id,prior.original_actor_id);
    for(const name of tables)assert.equal(JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()),before[name],name);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(captureCatalog(db)!.snapshotVersion,real.snapshotVersion);assert.equal(captureCatalog(db)!.items[0]!.evidenceVersion,real.items[0]!.evidenceVersion);
    assert.throws(()=>db.prepare('UPDATE service_requests SET original_contact_json=? WHERE id=?').run('{}','fresh-request'),/immutable/);
    assert.throws(()=>db.prepare('UPDATE service_requests SET current_brief_revision=2 WHERE id=?').run('fresh-request'),/immutable/);
    assert.throws(()=>db.prepare("UPDATE service_requests SET status='Planning' WHERE id=?").run('fresh-request'));
    migrate(db);assert.equal(db.prepare('SELECT count(*) AS n FROM brief_revisions').get()!.n,1);
  }finally{db.close();}
});
