import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEOMETRY_RECIPE, GEOMETRY_RECIPE_VERSION, makeGeometry } from '../../demo/geometry.js';
import { GEOMETRY_METHOD, GEOGRAPHIC_FRAME, validateTrack, type DemoGeometry } from '../../shared/globe.js';
import { createGeometryReader, geometryRecipeHash } from '../../server/geometry.js';
import { initialize, getD0 } from '../../server/db/initialize.js';
import { apiFixture, scheduledRequest, type ApiFixture } from './support.js';

function metadata(f:ApiFixture) {return f.app.coruscant.db.prepare('SELECT key,value FROM demo_metadata ORDER BY key').all();}
function definitions(f:ApiFixture) {return {catalog:f.app.coruscant.db.prepare('SELECT id,definition_hash FROM discovery_items ORDER BY id').all(),evidence:f.app.coruscant.db.prepare('SELECT item_id,evidence_version,definition_hash FROM evidence_versions ORDER BY item_id,evidence_version').all(),sources:f.app.coruscant.db.prepare('SELECT id,content_hash,definition_json FROM demo_source_assets ORDER BY id').all()};}
function savedFacts(value:unknown) {const {serverNow,contextGeneration,...facts}=value as Record<string,unknown>;return facts;}

test('public geometry uses the exact held recipe and ordered three-track synthetic context without private facts or authentication',async()=>{
  const f=await apiFixture();try {
    const id=await scheduledRequest(f),anonymous=await f.app.inject({method:'GET',url:'/api/public/geometry',headers:{host:f.config.allowedHost}});assert.equal(anonymous.statusCode,200,anonymous.body.slice(0,300));assert.match(anonymous.headers['content-type']!,/application\/json/);assert.equal(anonymous.headers['set-cookie'],undefined);
    const geometry=anonymous.json<DemoGeometry>();assert.equal(geometry.epoch,'2026-10-21T12:00:00.000Z');assert.equal(geometry.recipeVersion,GEOMETRY_RECIPE_VERSION);assert.equal(geometry.recipeHash,createHash('sha256').update(JSON.stringify(GEOMETRY_RECIPE)).digest('hex'));assert.equal(geometry.recipeHash,geometryRecipeHash);assert.equal(geometry.frame,GEOGRAPHIC_FRAME);assert.equal(geometry.method,GEOMETRY_METHOD);assert.equal(geometry.earthRadius,1);assert.equal(geometry.cadenceSeconds,300);assert.equal(geometry.spanStart,'2026-10-06T12:00:00.000Z');assert.equal(geometry.spanEnd,'2026-11-05T12:00:00.000Z');
    assert.deepEqual(geometry.tracks.map(track=>track.itemId),['demo-sar-03','demo-sar-08','demo-sar-country']);
    for(const track of geometry.tracks) {assert.equal(track.knots.length,8641);assert.equal(track.knots[0]!.at,geometry.spanStart);assert.equal(track.knots.at(-1)!.at,geometry.spanEnd);assert.equal(track.knots[4320]!.at,geometry.epoch);assert.deepEqual(validateTrack(track),{valid:true});assert.equal(track.noradId,null);assert.equal(track.cosparId,null);assert.equal(track.elements,null);assert.equal(track.altitudeKm,null);assert.equal(track.propagator,null);}
    assert.ok(!anonymous.body.includes(id));assert.ok(!anonymous.body.includes('Demonstration contact'));assert.ok(!anonymous.body.includes('org-a'));assert.ok(!anonymous.body.includes(f.dataRoot));assert.ok(!anonymous.body.includes('2400.00'));
    const changedQuery=await f.owner.get('/api/public/geometry?at=2099-01-01T00:00:00Z&requestId=not-a-public-request');assert.equal(changedQuery.body,anonymous.body,'query parameters cannot advance the held public instant or expose a private mission');
    const forgedHost=await f.app.inject({method:'GET',url:'/api/public/geometry',headers:{host:'other.example'}});assert.equal(forgedHost.statusCode,403);
  }finally{await f.close();}
});

test('geometry origin, recipe hash, public definitions and saved request stay unchanged through reinitialization and application restart',async()=>{
  const f=await apiFixture();try {
    const id=await scheduledRequest(f),request=await f.owner.state(id),first=await f.owner.get('/api/public/geometry'),oldMetadata=metadata(f),oldDefinitions=definitions(f);
    f.advance(3*86400*1000);assert.equal(initialize(f.app.coruscant.db,f.config,f.clock),'2026-10-21T12:00:00.000Z');assert.deepEqual(metadata(f),oldMetadata);assert.deepEqual(definitions(f),oldDefinitions);assert.equal((await f.owner.get('/api/public/geometry')).body,first.body);
    await f.restart();f.owner.context=null;f.owner.cookie='';await f.owner.enter();const reopened=await f.owner.state(id);assert.deepEqual(savedFacts(reopened),savedFacts(request));const held=await f.owner.get('/api/public/geometry');assert.equal(held.statusCode,200);assert.equal(held.body,first.body);assert.notEqual(held.json().epoch,f.clock().toISOString());
  }finally{await f.close();}
});

test('an older initialized project receives an honest geometry failure until explicit initialization adds only missing geometry metadata',async()=>{
  const f=await apiFixture();try {
    const id=await scheduledRequest(f),saved=await f.owner.state(id),oldDefinitions=definitions(f),d0=getD0(f.app.coruscant.db);f.app.coruscant.db.prepare("DELETE FROM demo_metadata WHERE key LIKE 'geometry_%'").run();await f.restart();
    const unavailable=await f.owner.get('/api/public/geometry');assert.equal(unavailable.statusCode,503);assert.equal(unavailable.json().code,'GEOMETRY_UNAVAILABLE');assert.ok(!unavailable.body.includes(f.dataRoot));assert.equal((await f.owner.get('/api/public/catalog')).statusCode,200);assert.deepEqual(await f.owner.state(id),saved);
    f.advance(12*60*60*1000);initialize(f.app.coruscant.db,f.config,f.clock);assert.equal(getD0(f.app.coruscant.db),d0);assert.deepEqual(definitions(f),oldDefinitions);assert.deepEqual(savedFacts(await f.owner.state(id)),savedFacts(saved));const restored=await f.owner.get('/api/public/geometry');assert.equal(restored.statusCode,200,restored.body.slice(0,250));assert.equal(restored.json().epoch,d0);
  }finally{await f.close();}
});

test('changed or incomplete geometry metadata refuses initialization before artwork repair and never resets saved work',async()=>{
  const f=await apiFixture();try {
    const id=await scheduledRequest(f),saved=await f.owner.state(id),oldDefinitions=definitions(f),d0=getD0(f.app.coruscant.db);const rows=f.app.coruscant.db.prepare("SELECT key,value FROM demo_metadata WHERE key LIKE 'geometry_%'").all() as {key:string;value:string}[];
    const source=f.app.coruscant.db.prepare('SELECT filename FROM demo_source_assets LIMIT 1').get() as {filename:string},path=join(f.config.sourceRoot,source.filename),bytes=readFileSync(path);unlinkSync(path);
    for(const key of ['geometry_recipe_version','geometry_recipe_hash','geometry_epoch']) {
      const original=rows.find(row=>row.key===key)!.value;f.app.coruscant.db.prepare('UPDATE demo_metadata SET value=? WHERE key=?').run(key==='geometry_epoch'?'2026-10-22T12:00:00.000Z':'different-recorded-recipe',key);
      assert.throws(()=>initialize(f.app.coruscant.db,f.config,f.clock),/geometry recipe version, hash or epoch differs/);assert.equal(existsSync(path),false);assert.equal(getD0(f.app.coruscant.db),d0);assert.deepEqual(definitions(f),oldDefinitions);assert.deepEqual(await f.owner.state(id),saved);
      const failure=await f.owner.get('/api/public/geometry');assert.equal(failure.statusCode,503);assert.equal(failure.json().code,'GEOMETRY_UNAVAILABLE');assert.equal((await f.owner.get('/api/public/catalog')).statusCode,200);f.app.coruscant.db.prepare('UPDATE demo_metadata SET value=? WHERE key=?').run(original,key);
    }
    f.app.coruscant.db.prepare("DELETE FROM demo_metadata WHERE key='geometry_recipe_hash'").run();assert.throws(()=>initialize(f.app.coruscant.db,f.config,f.clock),/geometry recipe version, hash or epoch differs/);assert.equal(existsSync(path),false);f.app.coruscant.db.prepare("INSERT INTO demo_metadata(key,value) VALUES('geometry_recipe_hash',?)").run(geometryRecipeHash);writeFileSync(path,bytes,{mode:0o600});assert.equal(initialize(f.app.coruscant.db,f.config,f.clock),d0);assert.deepEqual(await f.owner.state(id),saved);
  }finally{await f.close();}
});

test('one cached generator serves repeated reads, still detects changed identity and does not cache malformed geometry as success',async()=>{
  const f=await apiFixture();try {
    let calls=0;const read=createGeometryReader(f.app.coruscant.db,epoch=>{calls++;return makeGeometry(epoch);});const first=read();assert.equal(read(),first);assert.equal(read(),first);assert.equal(calls,1);
    f.app.coruscant.db.prepare("UPDATE demo_metadata SET value='changed' WHERE key='geometry_recipe_hash'").run();assert.throws(read,(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='GEOMETRY_UNAVAILABLE');assert.equal(calls,1);f.app.coruscant.db.prepare("UPDATE demo_metadata SET value=? WHERE key='geometry_recipe_hash'").run(geometryRecipeHash);assert.equal(read(),first);assert.equal(calls,1);
    let attempt=0;const corrupted=createGeometryReader(f.app.coruscant.db,epoch=>{const value=makeGeometry(epoch);if(++attempt===1)value.tracks[0]!.knots[1]!.at=value.tracks[0]!.knots[0]!.at;return value;});assert.throws(corrupted,(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='GEOMETRY_UNAVAILABLE');assert.equal(JSON.parse(corrupted()).tracks.length,3);assert.equal(attempt,2);
  }finally{await f.close();}
});

test('the already acquired static Earth texture retains its recorded bytes and historical-use credit',async()=>{
  const f=await apiFixture();try {
    const manifest=JSON.parse(readFileSync(join(f.config.projectRoot,'public/fonts/acquisition-manifest.json'),'utf8')) as {assets:{path:string;sha256:string}[]};const texture=manifest.assets.find(asset=>asset.path==='public/earth/world.200407.3x5400x2700.jpg');assert.ok(texture);const hash=createHash('sha256').update(readFileSync(join(f.config.projectRoot,texture.path))).digest('hex');assert.equal(hash,texture.sha256);const notice=readFileSync(join(f.config.projectRoot,'public/earth/NOTICE.txt'),'utf8');assert.match(notice,/NASA Earth Observatory/);assert.match(notice,/July 2004/);assert.match(notice,/not live imagery/);assert.match(notice,/no implied endorsement/);
  }finally{await f.close();}
});
