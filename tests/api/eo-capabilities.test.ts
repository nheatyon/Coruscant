import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { apiFixture } from './support.js';
import { CAPABILITY_FACT_VERSION, canonicalJson, digest, parseSourceBytes } from '../../server/orbital/catalog.js';
import { captureCatalog, ensureCapabilityVersion, ingestSources } from '../../server/orbital/repository.js';
import { EO_IDENTITY_DESIGNATORS } from '../../server/orbital/eo-facts.js';
import { makeDiscoveryDictionary } from '../../shared/discovery.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import type { CatalogCapture, RealCatalogItem } from '../../shared/orbital-contracts.js';

function generatedRow(id:number) {return {NORAD_CAT_ID:id,OBJECT_NAME:`Fresh capability reprojection response double ${id}`,OBJECT_ID:EO_IDENTITY_DESIGNATORS[`norad:${id}`]??'2099-001A',EPOCH:'2026-10-21T10:00:00.123456',MEAN_MOTION:14.3,ECCENTRICITY:.002,INCLINATION:72,RA_OF_ASC_NODE:30,ARG_OF_PERICENTER:10,MEAN_ANOMALY:80,BSTAR:0,MEAN_MOTION_DOT:0,MEAN_MOTION_DDOT:0};}

test('cached v1→v2 fact reprojection preserves adopted population/source ages and old saved evidence JSON across reopen',async()=>{
  const f=await apiFixture();try {
    const db=f.app.coruscant.db,rows=[generatedRow(42063),generatedRow(60989),generatedRow(39084),generatedRow(49260),...Array.from({length:140},(_,i)=>generatedRow(900001+i))];
    const source=parseSourceBytes('resource',Buffer.from(JSON.stringify(rows)),f.clock().toISOString());
    const v2=ingestSources(db,[{source,rawFilename:`${source.responseHash}.json`}],f.clock().toISOString()),current=captureCatalog(db)!;
    // A newly authored historical-shaped snapshot for compatibility testing only;
    // no previous application source, acquired dataset or external fixture is imported.
    const factVersion='coruscant-primary-facts-v1',oldVersion=digest(canonicalJson({test:'newly authored v1 compatibility snapshot',source:source.version,factVersion}));
    const oldItems=current.items.map(item=>{
      const old:RealCatalogItem={...item,snapshotVersion:oldVersion,factVersion,capabilityFacts:[],bandCapabilities:undefined,sensors:null,familyDocumented:false,capabilityState:'UNKNOWN',evidenceVersion:'',caveats:['Historical-shaped missing-capability test evidence; not an acquired orbit fixture.']};
      old.evidenceVersion='real-'+digest(canonicalJson(old));return old;
    });
    const old:CatalogCapture={...current,snapshotVersion:oldVersion,factVersion,items:oldItems,dictionary:makeDiscoveryDictionary(oldItems)};
    const elements=(db.prepare('SELECT elements_json FROM orbital_catalog_snapshots WHERE version=?').get(v2) as {elements_json:string}).elements_json;
    db.prepare('INSERT INTO orbital_catalog_snapshots VALUES(?,?,?,?,?)').run(oldVersion,factVersion,f.clock().toISOString(),JSON.stringify(old),elements);
    for(const item of oldItems)db.prepare('INSERT INTO orbital_evidence_versions VALUES(?,?,?)').run(item.id,item.evidenceVersion,JSON.stringify(item));
    db.prepare('UPDATE orbital_catalog_current SET version=? WHERE singleton=1').run(oldVersion);
    const selected=oldItems.find(i=>i.id==='norad:42063')!,purpose='Single Visible shoreline planning from a freshly generated compatibility source.';
    const area={latitude:14.7,longitude:-17.4,radiusKm:25,method:'coordinates' as const,generation:1};
    const brief={...createEmptyBrief(),purpose,areaReviewedPurpose:purpose,observationIntent:'single-observation' as const,sensor:'Visible',latitude:'14.7',longitude:'-17.4',areaChoice:area,areaConfirmation:areaSignature(area),maxResolution:'10',selectedEvidence:[{itemId:selected.id,evidenceVersion:selected.evidenceVersion}],catalogContext:{sourceKind:'PUBLIC_REAL' as const,snapshotVersion:oldVersion,factVersion}};
    const raw={target:{organizationId:'org-a'},expected:{},payload:{brief}},review=await f.owner.post('/api/command-reviews/savePlanningRequest',raw);assert.equal(review.statusCode,200,review.body);
    const saved=await f.owner.post('/api/commands/savePlanningRequest',{...raw,commandId:randomUUID(),reviewToken:review.json().reviewToken});assert.equal(saved.statusCode,201,saved.body);
    const id=saved.json().requestId as string,before=await f.owner.state(id),revision=db.prepare('SELECT brief_json,evidence_json FROM brief_revisions WHERE request_id=?').get(id)!;
    assert.equal(before.evidence[0]!.verified,true);assert.equal('factVersion' in before.evidence[0]!&&before.evidence[0]!.factVersion,factVersion);
    assert.deepEqual('capabilityFacts' in before.evidence[0]!&&before.evidence[0]!.capabilityFacts,[]);
    const sourceRows=JSON.stringify(db.prepare('SELECT * FROM orbital_source_versions ORDER BY version').all()),attempts=(db.prepare('SELECT count(*) AS n FROM orbital_source_attempts').get() as {n:number}).n;
    f.advance(60000);ensureCapabilityVersion(db,f.clock().toISOString());const next=captureCatalog(db)!;
    assert.equal(next.factVersion,CAPABILITY_FACT_VERSION);assert.equal(next.items.length,current.items.length);assert.deepEqual(next.items.map(i=>i.id),current.items.map(i=>i.id));
    assert.equal(next.items.filter(i=>i.bandCapabilities?.length).length,4);assert.equal(next.items.find(i=>i.id===selected.id)!.bandCapabilities!.find(c=>c.sensor==='VISIBLE')!.spatialResolutionM,10);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM orbital_source_versions ORDER BY version').all()),sourceRows);assert.equal((db.prepare('SELECT count(*) AS n FROM orbital_source_attempts').get() as {n:number}).n,attempts);
    assert.deepEqual(next.items.map(i=>i.orbit),current.items.map(i=>i.orbit));assert.deepEqual(db.prepare('SELECT brief_json,evidence_json FROM brief_revisions WHERE request_id=?').get(id),revision);
    assert.equal(captureCatalog(db,oldVersion)!.factVersion,factVersion);assert.deepEqual(captureCatalog(db,oldVersion)!.items.find(i=>i.id===selected.id)!.capabilityFacts,[]);
    const detail=await f.owner.get('/api/public/real-catalog/norad%3A42063');assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().item.factVersion,CAPABILITY_FACT_VERSION);
    await f.restart();const after=await f.owner.state(id);assert.deepEqual(after.evidence,before.evidence);assert.deepEqual((await f.staff.state(id)).evidence,before.evidence);assert.deepEqual(after.brief,before.brief);
    assert.equal((await f.owner.get('/api/public/real-catalog')).json().counts.unique,144);
  }finally{await f.close();}
});
