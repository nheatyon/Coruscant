import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PlaceLookupOptions } from '../../server/place-lookup.js';
import type { PlaceLookupResult, PlaceSourceReference } from '../../shared/place-contracts.js';
import type { BriefInput } from '../../shared/contracts.js';
import { buildApp } from '../../server/app.js';
import { createConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { migrate } from '../../server/db/migrate.js';
import { initialize } from '../../server/db/initialize.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { planningToInput, revisionToInput } from '../../shared/workflow.js';
import { extractPlacePhrase } from '../../shared/place-phrase.js';
import { API_TEST_PORT, ApiClient } from './support.js';

const provider='https://place-provider.coruscant.example/search';
interface CapturedCall {url:URL;init:RequestInit|undefined}
type Respond=(call:CapturedCall,index:number)=>Response|Promise<Response>;
function json(value:unknown,status=200,headers:Record<string,string>={}) {return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});}
function candidate(label='Dakar, Senegal',lat='14.7167',lon='-17.4677',id='987654321') {return {display_name:label,lat,lon,osm_type:'relation',osm_id:id,type:'city',address:{country:'Senegal',state:'Dakar'},boundingbox:['14.6','14.8','-17.6','-17.3']};}
async function fixture(respond:Respond) {
  const dataRoot=mkdtempSync(join(tmpdir(),'coruscant-place-api-')),config=createConfig({dataRoot,port:API_TEST_PORT});
  let now=new Date('2026-10-25T12:00:00.000Z');const clock=()=>new Date(now),calls:CapturedCall[]=[];
  const fetcher:typeof fetch=async(input,init)=>{const call={url:new URL(String(input)),init};calls.push(call);assert.equal(call.url.origin,'https://place-provider.coruscant.example');return respond(call,calls.length-1);};
  const placeLookup:PlaceLookupOptions={provider,fetcher,userAgent:'CoruscantPlaceApiTest/1.0 (fresh isolated response doubles)'};
  const db=openDatabase(config);migrate(db);initialize(db,config,clock);db.close();
  let app:FastifyInstance=await buildApp({dataRoot,port:API_TEST_PORT,clock,placeLookup});
  const owner=new ApiClient(app),staff=new ApiClient(app);await owner.enter();await staff.enter('staff-admin');
  return {dataRoot,config,calls,owner,staff,clock,get app(){return app;},advance(ms:number){now=new Date(now.getTime()+ms);},
    async restart(){await app.close();app=await buildApp({dataRoot,port:API_TEST_PORT,clock,placeLookup});owner.app=app;staff.app=app;},
    async close(){await app.close();rmSync(dataRoot,{recursive:true,force:true});}};
}
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
function sourcedBrief(lookup:PlaceLookupResult,purpose='Visible imagery over Dakar with 10 m resolution.'):BriefInput {
  const chosen=lookup.candidates[0]!,phrase=extractPlacePhrase(purpose),area={latitude:chosen.latitude,longitude:chosen.longitude,radiusKm:25,method:'coordinates' as const,generation:1};
  const areaSource:PlaceSourceReference={lookupVersion:lookup.version,candidateId:chosen.id,sourcePhrase:lookup.query,phraseOrigin:'stated',phraseSpan:phrase.span,questionAtLookup:purpose,reviewedPurpose:purpose,radiusAssumptionKm:25};
  return {...createEmptyBrief(),observationIntent:'single-observation',sensor:'Visible',purpose,areaReviewedPurpose:purpose,latitude:String(area.latitude),longitude:String(area.longitude),areaChoice:area,areaConfirmation:areaSignature(area),areaSource};
}
async function save(f:Awaited<ReturnType<typeof fixture>>,brief:BriefInput) {
  const raw={target:{organizationId:'org-a'},expected:{},payload:{brief}},review=await f.owner.post('/api/command-reviews/savePlanningRequest',raw);
  assert.equal(review.statusCode,200,review.body);const command={...raw,commandId:randomUUID(),reviewToken:review.json().reviewToken};
  const response=await f.owner.post('/api/commands/savePlanningRequest',command);assert.equal(response.statusCode,201,response.body);return response.json().requestId as string;
}

test('place lookup sends only the disclosed phrase and fixed public parameters, never private question/contact/context',async()=>{
  const f=await fixture(()=>json([candidate()]));try {
    const response=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:3});assert.equal(response.statusCode,200,response.body);
    assert.equal(f.calls.length,1);const {url,init}=f.calls[0]!;
    assert.deepEqual(Object.fromEntries(url.searchParams),{format:'jsonv2',q:'Dakar',limit:'5',addressdetails:'1','accept-language':'en'});
    assert.equal(init?.method,'GET');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'manual');assert.equal(init?.body,undefined);
    const headers=new Headers(init?.headers);assert.match(headers.get('user-agent')!,/CoruscantPlaceApiTest/);assert.equal(headers.get('cookie'),null);assert.equal(headers.get('authorization'),null);
    const result=response.json<PlaceLookupResult>();assert.equal(result.query,'Dakar');assert.equal(result.limit,5);assert.equal(result.exhaustive,false);assert.equal(result.candidates.length,1);assert.equal(result.candidates[0]!.latitude,14.7167);assert.match(result.attribution,/OpenStreetMap/);
    const rejected=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:4,purpose:'Private full mission',contact:'private@coruscant.example'});assert.equal(rejected.statusCode,422,rejected.body);assert.equal(f.calls.length,1);
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM service_requests').get() as {n:number}).n,0);
  }finally{await f.close();}
});
test('input shape, printable bounds and current CSRF/context are checked before a provider attempt',async()=>{
  const f=await fixture(()=>json([]));try {
    for(const payload of [{query:'X',generation:0},{query:'x'.repeat(201),generation:0},{query:'Da\nkar',generation:0},{query:'Dakar',generation:-1},{query:'Dakar',generation:1.5},{query:'Dakar',generation:0,latitude:14}]) {
      const response=await f.owner.post('/api/place-lookups',payload);assert.equal(response.statusCode,422,response.body);
    }
    const unauthenticated=await f.app.inject({method:'POST',url:'/api/place-lookups',headers:{host:f.config.allowedHost,origin:f.config.origin,'content-type':'application/json'},payload:{query:'Dakar',generation:1}});assert.ok([401,403].includes(unauthenticated.statusCode),unauthenticated.body);
    const headers=f.owner.headers();delete headers['x-coruscant-csrf'];const csrf=await f.app.inject({method:'POST',url:'/api/place-lookups',headers,payload:{query:'Dakar',generation:1,contextGeneration:f.owner.context!.contextGeneration,contextToken:f.owner.context!.contextToken}});assert.equal(csrf.statusCode,403,csrf.body);
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
test('identity dedup preserves actual ambiguity, no-OSM identities and empty results without selecting an area',async()=>{
  const f=await fixture((_,index)=>index===0?json([candidate(),candidate('Duplicate OSM label'),candidate('Dakar, different generated district','14.8','-17.4','987654322'),{display_name:'An unnamed-source locality',lat:'15.1',lon:'-16.8'}]):json([]));try {
    const response=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:1});assert.equal(response.statusCode,200,response.body);const result=response.json<PlaceLookupResult>();
    assert.equal(result.candidates.length,3);assert.equal(new Set(result.candidates.map(c=>c.id)).size,3);assert.equal(result.candidates[2]!.osmId,null);assert.equal(result.candidates[2]!.osmType,null);assert.equal(result.candidates[2]!.country,null);
    f.advance(1100);const empty=await f.owner.post('/api/place-lookups',{query:'Different generated empty location',generation:2});assert.equal(empty.statusCode,200,empty.body);assert.deepEqual(empty.json().candidates,[]);assert.equal(empty.json().exhaustive,false);
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM brief_revisions').get() as {n:number}).n,0);
  }finally{await f.close();}
});
test('shared cooldown and seven-day cache survive a complete app/DB close and block per-tab bursts',async()=>{
  const f=await fixture(()=>json([candidate()]));try {
    const first=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:1});assert.equal(first.statusCode,200,first.body);
    const limited=await f.staff.post('/api/place-lookups',{query:'Rabat',generation:1});assert.equal(limited.statusCode,429,limited.body);assert.equal(f.calls.length,1);
    await f.restart();const same=await f.staff.post('/api/place-lookups',{query:'dakar',generation:2});assert.equal(same.statusCode,200,same.body);assert.equal(same.json().cached,true);assert.equal(same.json().version,first.json().version);assert.equal(f.calls.length,1);
    assert.equal((await f.owner.post('/api/place-lookups',{query:'Rabat',generation:3})).statusCode,429);
    f.advance(1100);assert.equal((await f.owner.post('/api/place-lookups',{query:'Rabat',generation:4})).statusCode,200);assert.equal(f.calls.length,2);
    f.advance(7*86400000+1);f.owner.context=null;f.owner.cookie='';await f.owner.enter();const renewed=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:5});assert.equal(renewed.statusCode,200,renewed.body);assert.equal(renewed.json().cached,false);assert.equal(f.calls.length,3);
  }finally{await f.close();}
});
test('429 Retry-After is persistent and errors never retry automatically or overwrite an existing result',async()=>{
  const f=await fixture((_,index)=>index===0?json([candidate()]):json({error:'generated rate refusal'},429,{'retry-after':'30'}));try {
    const first=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:1});assert.equal(first.statusCode,200,first.body);f.advance(1100);
    const refused=await f.owner.post('/api/place-lookups',{query:'Rabat',generation:2});assert.equal(refused.statusCode,429,refused.body);assert.equal(f.calls.length,2);
    await f.restart();f.advance(1100);const blocked=await f.owner.post('/api/place-lookups',{query:'Tangier',generation:3});assert.equal(blocked.statusCode,429,blocked.body);assert.equal(f.calls.length,2);
    const retained=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:4});assert.equal(retained.statusCode,200,retained.body);assert.equal(retained.json().version,first.json().version);assert.equal(retained.json().cached,true);
  }finally{await f.close();}
});
test('a pending lookup is shared, and a context exit refuses its late candidate response',async()=>{
  const entered=deferred<void>(),answer=deferred<Response>();const f=await fixture(()=>{entered.resolve();return answer.promise;});try {
    const pending=f.owner.post('/api/place-lookups',{query:'Dakar',generation:1});await entered.promise;
    const other=await f.staff.post('/api/place-lookups',{query:'Rabat',generation:1});assert.equal(other.statusCode,429,other.body);assert.equal(other.json().code,'PLACE_LOOKUP_PENDING');assert.equal(f.calls.length,1);
    await f.owner.enter('a-requester');answer.resolve(json([candidate()]));const stale=await pending;assert.ok([401,403,409].includes(stale.statusCode),stale.body);assert.equal(stale.body.includes('Dakar, Senegal'),false);
  }finally{answer.resolve(json([]));await f.close();}
});
test('malformed, too-large, invalid coordinates and redirect responses stop without fabricated candidates',async()=>{
  for(const [label,response]of [
    ['declared-byte-limit',()=>new Response('[]',{headers:{'content-length':String(256*1024+1)}})],
    ['stream-byte-limit',()=>new Response(' '.repeat(256*1024+1))],
    ['too-many-candidates',()=>json(Array.from({length:6},(_,i)=>candidate('Generated '+i,'1','2',String(i+1))))],
    ['invalid-center',()=>json([candidate('Generated bad coordinate','91','2')])],
    ['non-array',()=>json({results:[]})],
    ['malformed-json',()=>new Response('not JSON')],
    ['redirect',()=>new Response(null,{status:302,headers:{location:'https://must-not-follow.coruscant.example/'}})],
    ['provider-error',()=>json({error:'generated outage'},500)],
  ] as const){const f=await fixture(()=>response());try {
    const result=await f.owner.post('/api/place-lookups',{query:'Generated error locality',generation:1});assert.equal(result.statusCode,503,`${label}: ${result.body}`);assert.equal(f.calls.length,1);assert.equal(result.body.includes('"candidates"'),false);
    const immediate=await f.staff.post('/api/place-lookups',{query:'Another generated locality',generation:2});assert.equal(immediate.statusCode,429,`${label}: ${immediate.body}`);assert.equal(f.calls.length,1);
  }finally{await f.close();}}
});
test('five-second provider timeout is an explicit unavailable result with one aborted attempt',async t=>{
  const entered=deferred<void>();let aborted=false;
  const f=await fixture(({init})=>new Promise<Response>((_resolve,reject)=>{entered.resolve();init!.signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('generated abort'));},{once:true});}));
  try {
    t.mock.timers.enable({apis:['setTimeout']});
    const pending=f.owner.post('/api/place-lookups',{query:'Generated timeout locality',generation:1});await entered.promise;t.mock.timers.tick(5000);
    const response=await pending;assert.equal(response.statusCode,503,response.body);assert.equal(aborted,true);assert.equal(f.calls.length,1);
  }finally{t.mock.timers.reset();await f.close();}
});
test('only cached candidates authorize canonical place provenance; forged IDs/spans/source facts create no record',async()=>{
  const f=await fixture(()=>json([candidate()]));try {
    const response=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:1});const lookup=response.json<PlaceLookupResult>(),brief=sourcedBrief(lookup),source=brief.areaSource!;
    for(const patch of [{candidateId:source.candidateId+'-forged'},{lookupVersion:'place:unknown'},{sourcePhrase:'Rabat'},{phraseSpan:{start:0,end:5}},{reviewedPurpose:'Another purpose'}]) {
      const review=await f.owner.post('/api/command-reviews/savePlanningRequest',{target:{organizationId:'org-a'},expected:{},payload:{brief:{...brief,areaSource:{...source,...patch}}}});assert.equal(review.statusCode,422,review.body);
    }
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM service_requests').get() as {n:number}).n,0);
    const id=await save(f,{...brief,areaSource:{...source,provider:'Invented authority',sourceCenter:{latitude:0,longitude:0}} as PlaceSourceReference});
    const saved=await f.owner.state(id);assert.equal(saved.brief.areaSource!.provider,provider);assert.deepEqual(saved.brief.areaSource!.sourceCenter,{latitude:14.7167,longitude:-17.4677});
    assert.equal(JSON.stringify(saved.brief).includes('questionAtLookup'),false);assert.equal(JSON.stringify(saved.brief.areaSource).includes('Invented authority'),false);assert.equal(f.calls.length,1);
  }finally{await f.close();}
});
test('sourced Planning→reviewed retained-purpose/numeric-correction revision→same-ID submission preserves exact original provenance',async()=>{
  const f=await fixture(()=>json([candidate()]));try {
    const response=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:1});assert.equal(response.statusCode,200,response.body);
    const id=await save(f,sourcedBrief(response.json<PlaceLookupResult>())),first=await f.owner.state(id),original=first.brief.areaSource!;
    assert.equal(first.status,'Planning');assert.equal(original.adjusted,false);assert.deepEqual((await f.staff.state(id)).brief.areaSource,original);
    const purpose='Plan a visible shoreline inspection after the local requirements review.';
    const circle={...first.brief.area,latitude:14.72,longitude:-17.46,radiusKm:12,generation:2};
    const revised={...revisionToInput(first.brief),purpose,areaReviewedPurpose:purpose,latitude:String(circle.latitude),longitude:String(circle.longitude),radiusKm:String(circle.radiusKm),areaChoice:circle,areaConfirmation:areaSignature(circle)};
    await f.owner.action('reviseBrief',id,{brief:revised});const second=await f.owner.state(id),source=second.brief.areaSource!;
    assert.equal(second.status,'Planning');assert.equal(second.briefRevision,2);assert.equal(second.reference,first.reference);assert.equal(source.questionDigest,original.questionDigest);assert.equal(source.lookupVersion,original.lookupVersion);assert.equal(source.candidateId,original.candidateId);assert.deepEqual(source.sourceCenter,original.sourceCenter);assert.equal(source.adjusted,true);assert.notEqual(source.reviewedPurposeDigest,original.reviewedPurposeDigest);assert.notEqual(source.purposeAreaDigest,original.purposeAreaDigest);assert.equal(source.appliedRadiusKm,12);assert.deepEqual(second.revisions[0]!.brief.areaSource,original);
    const brief={...planningToInput(second.brief),acknowledged:true,contact:{name:'Generated sourced planner',email:'place@coruscant.example',organization:'Generated test research'}};
    await f.owner.action('submitPlanningRequest',id,{brief});const submitted=await f.owner.state(id);assert.equal(submitted.status,'Submitted');assert.equal(submitted.reference,first.reference);assert.equal(submitted.briefRevision,3);assert.deepEqual(submitted.brief.areaSource,source);
    await f.restart();assert.deepEqual((await f.owner.state(id)).brief.areaSource,source);assert.deepEqual((await f.staff.state(id)).brief.areaSource,source);assert.equal(f.calls.length,1);
    const manual={...revisionToInput(submitted.brief),areaSource:null};await f.owner.action('reviseBrief',id,{brief:manual});const cleared=await f.owner.state(id);assert.equal(cleared.brief.areaSource,null);assert.deepEqual(cleared.revisions[2]!.brief.areaSource,source);
  }finally{await f.close();}
});

test('case-insensitive cache reuse preserves the current stated phrase span without relabeling the original provider query',async()=>{
  const f=await fixture(()=>json([candidate()]));try {
    const first=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:1});assert.equal(first.statusCode,200,first.body);
    const cached=await f.owner.post('/api/place-lookups',{query:'dakar',generation:2});assert.equal(cached.statusCode,200,cached.body);assert.equal(cached.json().cached,true);
    const brief=sourcedBrief(cached.json<PlaceLookupResult>(),'Visible imagery over dakar with 10 m resolution.');
    brief.areaSource={...brief.areaSource!,sourcePhrase:'dakar'};
    const id=await save(f,brief),saved=await f.owner.state(id);assert.equal(saved.brief.areaSource!.sourcePhrase,'dakar');
    assert.equal(saved.brief.areaSource!.query,'Dakar');assert.equal(saved.brief.areaSource!.lookupVersion,first.json().version);assert.equal(f.calls.length,1);
  }finally{await f.close();}
});


test('tampered persistent place coordinates cannot retain a valid source version or become a cached result',async()=>{
  const f=await fixture(()=>json([candidate()]));try {
    const response=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:1});assert.equal(response.statusCode,200,response.body);
    const file=join(f.dataRoot,'place-cache','lookups.json'),cache=JSON.parse(readFileSync(file,'utf8'));
    cache.entries[0].candidates[0].latitude=0; // Source version is intentionally left unchanged.
    writeFileSync(file,JSON.stringify(cache));await f.restart();f.advance(1100);
    const recovered=await f.owner.post('/api/place-lookups',{query:'Dakar',generation:2});assert.equal(recovered.statusCode,200,recovered.body);
    assert.equal(recovered.json().cached,false);assert.equal(recovered.json().candidates[0].latitude,14.7167);assert.equal(f.calls.length,2);
  }finally{await f.close();}
});
