import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { apiFixture } from './support.js';
import { parseSourceBytes } from '../../server/orbital/catalog.js';
import { adoptInitialAcquisition, captureBrowseSnapshot, captureCatalog, ingestSources, orbitalRoot, realDiscoveryDictionary } from '../../server/orbital/repository.js';
import { refreshPublicCatalog } from '../../server/orbital/source.js';
import { emptyDiscoveryValues } from '../../shared/discovery.js';
import { ORBITAL_SOURCE_URLS } from '../../shared/orbital-policy.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
function raw(id:number,extra:Record<string,unknown>={}){return {NORAD_CAT_ID:id,OBJECT_NAME:`New generated test object ${id}`,OBJECT_ID:`2026-001${id}`,EPOCH:'2026-10-21T11:00:00.123456',MEAN_MOTION:14.5,ECCENTRICITY:0.002,INCLINATION:67,RA_OF_ASC_NODE:32,ARG_OF_PERICENTER:55,MEAN_ANOMALY:80,BSTAR:0.00003,MEAN_MOTION_DOT:0.000001,MEAN_MOTION_DDOT:0,...extra};}
function parsed(group:'sar'|'resource',rows:unknown[],at='2026-10-21T12:00:00.000Z'){const source=parseSourceBytes(group,Buffer.from(JSON.stringify(rows)),at);return {source,rawFilename:`${source.responseHash}.json`};}
function filters(value:unknown){return encodeURIComponent(JSON.stringify(value));}

test('whole real snapshot matching, version-bound100-row pages, off-page excluded detail and real dictionary stay independent of demo',async()=>{
  const f=await apiFixture();try{
    const entries=[parsed('sar',Array.from({length:260},(_,i)=>raw(100001+i))),parsed('resource',[raw(100001),raw(62261)])];const v=ingestSources(f.app.coruscant.db,entries,f.clock().toISOString());
    const page=await f.owner.get('/api/public/real-catalog');assert.equal(page.statusCode,200,page.body);const first=page.json();assert.equal(first.counts.unique,261);assert.equal(first.counts.matching,261);assert.equal(first.items.length,100);assert.equal(first.counts.sourceTotal,null);assert.equal(first.snapshotVersion,v);assert.deepEqual(first.dictionary.places,[]);
    const next=await f.owner.get(`/api/public/real-catalog?snapshotVersion=${v}&cursor=${encodeURIComponent(first.nextCursor)}`);assert.equal(next.statusCode,200,next.body);assert.equal(next.json().items.length,100);
    const strict={...emptyDiscoveryValues(),family:'EO',sensor:'SAR',maxResolutionM:10,documentedOnly:true};const strictPage=await f.owner.get(`/api/public/real-catalog?criteria=${filters(strict)}`);assert.equal(strictPage.statusCode,200);assert.equal(strictPage.json().counts.matching,0);
    const detail=await f.owner.get(`/api/public/real-catalog/norad%3A100260?snapshotVersion=${v}&criteria=${filters(strict)}`);assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().item.id,'norad:100260');assert.equal(detail.json().match,null);assert.ok(detail.json().exclusionReasons.length);
    assert.equal((await f.owner.get(`/api/public/real-catalog?criteria=${filters(strict)}&cursor=${encodeURIComponent(first.nextCursor)}`)).statusCode,409);
    const demo=(await f.owner.get('/api/public/catalog')).json();assert.equal(demo.items.length,6);assert.ok(demo.items.every((i:{demonstration:boolean})=>i.demonstration));assert.equal(demo.personas.length>0,true);assert.equal(realDiscoveryDictionary(f.app.coruscant.db,v).places.length,0);
  }finally{await f.close();}
});
test('partial sources retain absent membership and prior elements with original ages; complete removal does not erase historical versions',async()=>{
  const f=await apiFixture();try{
    const initial=ingestSources(f.app.coruscant.db,[parsed('sar',[raw(123456),raw(234567)]),parsed('resource',[])],f.clock().toISOString());
    const partial=parsed('sar',[raw(123456,{MEAN_MOTION:-1}),{NORAD_CAT_ID:'not-an-id'}],'2026-10-21T15:00:00.000Z');ingestSources(f.app.coruscant.db,[partial],'2026-10-21T15:00:00.000Z');
    let capture=captureCatalog(f.app.coruscant.db)!;assert.equal(capture.validation,'PARTIAL');assert.equal(capture.items.length,2);assert.equal(capture.items.find(i=>i.id==='norad:234567')!.memberships[0]!.confirmation,'UNCONFIRMED');assert.equal(capture.items.find(i=>i.id==='norad:123456')!.orbit.retrievedAt,'2026-10-21T12:00:00.000Z');
    ingestSources(f.app.coruscant.db,[parsed('sar',[],'2026-10-21T18:00:00.000Z')],'2026-10-21T18:00:00.000Z');capture=captureCatalog(f.app.coruscant.db)!;assert.equal(capture.items.length,0);assert.equal(captureCatalog(f.app.coruscant.db,initial)!.items.length,2);
    assert.throws(()=>f.app.coruscant.db.prepare('UPDATE orbital_catalog_snapshots SET fact_version=? WHERE version=?').run('invented',initial),/immutable/);
  }finally{await f.close();}
});
test('render plan covers full matching population, selected/offpage priority and exact shortlist-only independent frommatch counts',async()=>{
  const f=await apiFixture();try{
    const version=ingestSources(f.app.coruscant.db,[parsed('sar',Array.from({length:260},(_,i)=>raw(200001+i))),parsed('resource',[])],f.clock().toISOString());
    const capture=captureCatalog(f.app.coruscant.db)!;
    const input={snapshotVersion:version,factVersion:capture.factVersion,representedAt:f.clock().toISOString(),generation:1,criteria:emptyDiscoveryValues(),selectedId:'norad:200260',shortlistedIds:['norad:200250'],visibility:'MATCHES' as const};
    const plan=captureBrowseSnapshot(f.app.coruscant.db,input);assert.equal(plan.matching,260);assert.equal(plan.candidates.length,260);assert.equal(plan.candidates[0]!.item.id,'norad:200260');assert.equal(plan.candidates[1]!.item.id,'norad:200250');assert.ok(plan.candidates.every(c=>c.omm!==null));
    const exact=captureBrowseSnapshot(f.app.coruscant.db,{...input,visibility:'SHORTLIST_ONLY'});assert.deepEqual(exact.candidates.map(c=>c.item.id),['norad:200250']);assert.equal(exact.matching,260);
  }finally{await f.close();}
});
test('shared refresh limiter survives restart, sends only adopted group URLs and stops immediately onHTTPerror',async()=>{
  const f=await apiFixture();try{
    const calls:string[]=[];const fetcher=async(url:string,options:RequestInit)=>{calls.push(url);assert.equal(options.redirect,'manual');assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(options.credentials,undefined);return new Response('limited',{status:429,headers:{'retry-after':'10800'}});};
    const result=await refreshPublicCatalog(f.app.coruscant.db,f.config,f.clock,fetcher);assert.equal(calls.length,1);assert.equal(calls[0],ORBITAL_SOURCE_URLS.sar);assert.equal(result.sources[0]!.state,'FAILED');assert.equal(result.sources[1]!.state,'NOT_ATTEMPTED');assert.equal(result.sources[0]!.nextAllowedAt,'2026-10-21T15:00:00.000Z');
    await f.restart();const second:string[]=[];await refreshPublicCatalog(f.app.coruscant.db,f.config,f.clock,async url=>{second.push(url);return new Response('[]',{status:200});});assert.deepEqual(second,[ORBITAL_SOURCE_URLS.resource]);
  }finally{await f.close();}
});
test('initial actual-acquisition ledger adopts exact private byte hashes and prevents duplicate fetches afterrestart',async()=>{
  const f=await apiFixture();try{
    const root=orbitalRoot(f.config);mkdirSync(root,{recursive:true,mode:0o700});const groups:Record<string,unknown>={};
    for(const key of ['sar','resource'] as const){const bytes=Buffer.from(JSON.stringify([raw(key==='sar'?543210:654321)])),source=parseSourceBytes(key,bytes,f.clock().toISOString()),rawFile=`${source.responseHash}.json`;writeFileSync(resolve(root,rawFile),bytes,{mode:0o600});groups[key]={url:ORBITAL_SOURCE_URLS[key],attemptedAt:f.clock().toISOString(),nextAllowedAt:'2026-10-21T14:00:00.000Z',status:'success',httpStatus:200,retrievedAt:f.clock().toISOString(),sha256:source.responseHash,rawFile};}
    writeFileSync(resolve(root,'initial-acquisition.json'),JSON.stringify({schema:1,groups}),{mode:0o600});const first=adoptInitialAcquisition(f.app.coruscant.db,f.config,f.clock().toISOString());assert.ok(first);await f.restart();assert.equal(adoptInitialAcquisition(f.app.coruscant.db,f.config,f.clock().toISOString()),first);
    let called=0;const result=await refreshPublicCatalog(f.app.coruscant.db,f.config,f.clock,async()=>{called++;throw new Error('not expected');});assert.equal(called,0);assert.ok(result.sources.every(o=>o.state==='RATE_LIMITED'));assert.equal(captureCatalog(f.app.coruscant.db)!.items.length,2);
  }finally{await f.close();}
});
test('actual real evidence saves exact immutable source facts acrossrefresh/customer/staff/restart whilelegacydemo remains',async()=>{
  const f=await apiFixture();try{
    const version=ingestSources(f.app.coruscant.db,[parsed('sar',[raw(62261)]),parsed('resource',[])],f.clock().toISOString()),item=captureCatalog(f.app.coruscant.db)!.items[0]!;
    const area={latitude:48.2,longitude:-8.4,radiusKm:25,method:'coordinates' as const,generation:1};
    const brief={...createEmptyBrief(),purpose:'Compare changes near this explicitly confirmed area.',latitude:'48.2',longitude:'-8.4',radiusKm:'25',areaChoice:area,areaConfirmation:areaSignature(area),baselineDate:'2026-10-01',recentDate:'2026-10-02',contact:{name:'Fresh test requester',email:'fresh@coruscant.example',organization:'Test researchers'},selectedEvidence:[{itemId:item.id,evidenceVersion:item.evidenceVersion}],catalogContext:{sourceKind:'PUBLIC_REAL',snapshotVersion:version,factVersion:item.factVersion},acknowledged:true};
    const rawCommand={target:{organizationId:'org-a'},expected:{},payload:{brief}},review=await f.owner.post('/api/command-reviews/submitRequest',rawCommand);assert.equal(review.statusCode,200,review.body);
    const envelope={...rawCommand,commandId:randomUUID(),reviewToken:review.json().reviewToken},saved=await f.owner.post('/api/commands/submitRequest',envelope);assert.equal(saved.statusCode,201,saved.body);const id=saved.json().requestId;
    const original=(await f.owner.state(id)).evidence[0]!;assert.equal((original as unknown as {sourceKind:string}).sourceKind,'PUBLIC_REAL');assert.equal(original.verified,true);assert.equal(original.resolutionM,null);
    ingestSources(f.app.coruscant.db,[parsed('sar',[],'2026-10-21T16:00:00.000Z')],'2026-10-21T16:00:00.000Z');await f.restart();assert.deepEqual((await f.owner.state(id)).evidence[0],original);assert.deepEqual((await f.staff.state(id)).evidence[0],original);
    const replay=await f.owner.post('/api/commands/submitRequest',envelope);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');
  }finally{await f.close();}
});

test('one shared explicit refresh atomically caches bounded bytes privately and publishes the fullacceptedunion',async()=>{
  const f=await apiFixture();try{
    let unblock!:()=>void;const wait=new Promise<void>(resolve=>{unblock=resolve;}),calls:string[]=[];
    const fetcher=async(url:string)=>{calls.push(url);if(calls.length===1)await wait;return new Response(JSON.stringify([raw(url===ORBITAL_SOURCE_URLS.sar?765432:876543)]),{status:200,headers:{'content-type':'application/json'}});};
    const first=refreshPublicCatalog(f.app.coruscant.db,f.config,f.clock,fetcher),second=refreshPublicCatalog(f.app.coruscant.db,f.config,f.clock,fetcher);assert.equal(first,second);unblock();const outcome=await first;assert.deepEqual(calls,[ORBITAL_SOURCE_URLS.sar,ORBITAL_SOURCE_URLS.resource]);assert.equal(outcome.sources.length,2);assert.ok(outcome.sources.every(s=>s.state==='UPDATED'));
    const {statSync,readdirSync}=await import('node:fs');const files=readdirSync(orbitalRoot(f.config));assert.equal(files.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).length,2);assert.equal(statSync(orbitalRoot(f.config)).mode&0o777,0o700);for(const filename of files){const item=statSync(resolve(orbitalRoot(f.config),filename));assert.equal(item.mode&0o777,item.isDirectory()?0o700:0o600);}
    const response=await f.owner.get('/api/public/real-catalog');assert.equal(response.statusCode,200);assert.equal(response.json().counts.unique,2);assert.equal(response.json().validation,'COMPLETE');assert.ok(!response.body.includes('rawFile'));assert.ok(!response.body.includes(f.dataRoot));
    let again=0;await refreshPublicCatalog(f.app.coruscant.db,f.config,f.clock,async()=>{again++;throw new Error('not expected');});assert.equal(again,0);
  }finally{await f.close();}
});
test('oversized source stops thebatch and retains lastgoodsource withoutfirst-Npromotion',async()=>{
  const f=await apiFixture();try{
    const original=ingestSources(f.app.coruscant.db,[parsed('sar',[raw(345678)]),parsed('resource',[])],f.clock().toISOString());let calls=0;
    const result=await refreshPublicCatalog(f.app.coruscant.db,f.config,f.clock,async()=>{calls++;return new Response('[]',{status:200,headers:{'content-length':String(8*1024*1024+1)}});});
    assert.equal(calls,1);assert.equal(result.snapshotVersion,original);assert.equal(result.sources[0]!.state,'FAILED');assert.equal(result.sources[1]!.state,'NOT_ATTEMPTED');assert.equal(captureCatalog(f.app.coruscant.db)!.validation,'PARTIAL');assert.equal(captureCatalog(f.app.coruscant.db)!.items.length,1);
  }finally{await f.close();}
});
test('partial retained-membership union cannot exceed reviewedlimit orreplace lastgood',async()=>{
  const f=await apiFixture();try{
    const initial=ingestSources(f.app.coruscant.db,[parsed('sar',Array.from({length:5000},(_,i)=>raw(100000+i))),parsed('resource',[raw(800000),raw(800001)])],f.clock().toISOString());
    const incoming=parsed('sar',[...Array.from({length:4999},(_,i)=>raw(200000+i)),{NORAD_CAT_ID:'invalid'}],'2026-10-21T15:00:00.000Z');
    assert.throws(()=>ingestSources(f.app.coruscant.db,[incoming],'2026-10-21T15:00:00.000Z'),/reviewed limit/);assert.equal(captureCatalog(f.app.coruscant.db)!.snapshotVersion,initial);assert.equal(captureCatalog(f.app.coruscant.db)!.items.length,5002);
  }finally{await f.close();}
});

test('unexpected source/filesystem error details are not exposed as public metadata',async()=>{
  const f=await apiFixture();try{const result=await refreshPublicCatalog(f.app.coruscant.db,f.config,f.clock,async()=>{throw new Error('ENOENT /private/secret-runtime/full-path');});assert.equal(result.sources[0]!.state,'FAILED');assert.ok(!JSON.stringify(result).includes('/private'));const page=(await f.owner.get('/api/public/real-catalog')).json();assert.ok(!JSON.stringify(page).includes('/private'));}finally{await f.close();}
});
