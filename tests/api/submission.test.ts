import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, unlinkSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createConfig } from '../../server/config.js';
import { openDatabase, transaction } from '../../server/db/database.js';
import { migrate, verifySchema } from '../../server/db/migrate.js';
import { getD0, initialize } from '../../server/db/initialize.js';
import { buildApp } from '../../server/app.js';
import type { TestHooks } from '../../server/commands.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import type { BriefInput, Context, CommandEnvelope, SubmissionOutcome, SubmissionReview } from '../../shared/contracts.js';

const port=3101;
function validBrief():BriefInput {
  const value=createEmptyBrief();
  return {...value,purpose:'Compare the river and estuary before and after the event.',sensor:'SAR',
    areaChoice:{latitude:0,longitude:0,radiusKm:25,method:'coordinates',generation:1},
    areaConfirmation:areaSignature({latitude:0,longitude:0,radiusKm:25,method:'coordinates',generation:1}),
    baselineDate:'2026-10-01',recentDate:'2026-10-08',maxResolution:'10',
    contact:{name:'Demonstration contact',email:'researcher@coruscant.example',organization:'Demonstration team'},
    selectedEvidence:[{itemId:'demo-sar-03',evidenceVersion:'demo-evidence-v1'}],acknowledged:true};
}
class Client {
  cookie='';context:Context|null=null;
  constructor(public app:FastifyInstance){}
  headers(){return {host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`,'content-type':'application/json',
    ...(this.cookie?{cookie:this.cookie}:{}),...(this.context?.csrfToken?{'x-coruscant-csrf':this.context.csrfToken}:{})};}
  async post(url:string,values:Record<string,unknown>={}){
    return this.app.inject({method:'POST',url,headers:this.headers(),payload:{contextGeneration:this.context?.contextGeneration,contextToken:this.context?.contextToken,...values}});
  }
  async contextPost(url:string,values:Record<string,unknown>={},bootstrap=false){
    const result=await this.app.inject({method:'POST',url,headers:this.headers(),payload:bootstrap?{}:{contextGeneration:this.context?.contextGeneration,contextToken:this.context?.contextToken,...values}});
    assert.equal(result.statusCode,200,result.body);
    const set=result.headers['set-cookie'];if(set)this.cookie=(Array.isArray(set)?set[0]!:set).split(';')[0]!;
    this.context=result.json<Context>();return this.context;
  }
  get(url:string){return this.app.inject({method:'GET',url,headers:this.headers()});}
  async enter(persona='a-owner',organization='org-a'){
    await this.contextPost('/api/demo/bootstrap',{},true);
    await this.contextPost('/api/demo/customer/enter',{personaId:persona});
    if(organization)await this.contextPost('/api/context/workspace',{organizationId:organization});
  }
  async review(brief=validBrief()){
    const response=await this.post('/api/command-reviews/submitRequest',{target:{organizationId:'org-a'},expected:{},payload:{brief}});
    assert.equal(response.statusCode,200,response.body);return response.json<SubmissionReview>();
  }
  envelope(review:SubmissionReview,brief=validBrief()):CommandEnvelope {
    return {commandId:randomUUID(),contextGeneration:this.context!.contextGeneration,contextToken:this.context!.contextToken!,
      target:{organizationId:'org-a'},expected:{},payload:{brief},reviewToken:review.reviewToken};
  }
}
async function fixture(hooks?:TestHooks,clientRoot?:string){
  const root=mkdtempSync(join(tmpdir(),'coruscant-api-'));let current=new Date('2026-10-21T13:42:16.123Z');
  const clock=()=>new Date(current);const config=createConfig({dataRoot:root,port});const db=openDatabase(config);
  migrate(db);initialize(db,config,clock);db.close();
  let app=await buildApp({dataRoot:root,port,clock,testHooks:hooks,...(clientRoot?{clientRoot}:{})});
  return {root,clock,config,get app(){return app;},advance(ms:number){current=new Date(current.getTime()+ms);},
    async restart(){await app.close();app=await buildApp({dataRoot:root,port,clock,...(clientRoot?{clientRoot}:{})});return app;},
    async close(){await app.close();rmSync(root,{recursive:true,force:true});}};
}
function counts(app:FastifyInstance){return Object.fromEntries(['service_requests','brief_revisions','request_events','action_receipts'].map(table=>[table,(app.coruscant.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n]));}

test('anonymous context is read-only; bootstrap grants no identity and cannot replace private access',async()=>{
  const f=await fixture();try{
    const client=new Client(f.app);const before=await client.get('/api/context');assert.equal(before.statusCode,200);assert.equal(before.headers['set-cookie'],undefined);assert.equal(before.json<Context>().csrfToken,null);
    await client.contextPost('/api/demo/bootstrap',{},true);assert.equal(client.context!.audience,'PUBLIC');assert.equal(client.context!.actor,null);
    const setCookie=client.cookie;assert.equal(setCookie.split('=')[1]!.length,43);
    const rows=f.app.coruscant.db.prepare('SELECT cookie_hash FROM sessions').all();assert.ok(!JSON.stringify(rows).includes(setCookie.split('=')[1]!));
    await client.contextPost('/api/demo/customer/enter',{personaId:'a-owner'});assert.equal(client.context!.organization,null);
    await client.contextPost('/api/context/workspace',{organizationId:'org-a'});
    const privateCookie=client.cookie;await client.contextPost('/api/demo/bootstrap',{},true);
    assert.equal(client.cookie,privateCookie);assert.equal(client.context!.actor!.id,'a-owner');assert.equal(client.context!.organization!.id,'org-a');
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM service_requests').get() as {n:number}).n,0);
  }finally{await f.close();}
});

test('transport, current CSRF, persona allowlist and separated staff audience are enforced',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);
    assert.equal((await f.app.inject({method:'POST',url:'/api/demo/bootstrap',headers:{host:'evil.example',origin:'http://evil.example','content-type':'application/json'},payload:{}})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:'/api/demo/bootstrap',headers:{host:`127.0.0.1:${port}`,origin:'http://evil.example','content-type':'application/json'},payload:{}})).statusCode,403);
    assert.equal((await f.app.inject({method:'POST',url:'/api/demo/bootstrap',headers:{host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`,'content-type':'text/plain'},payload:'{}'})).statusCode,415);
    await c.contextPost('/api/demo/bootstrap',{},true);
    assert.equal((await c.post('/api/demo/customer/enter',{personaId:'staff-admin'})).statusCode,422);
    const noCsrf={...c.headers(),'x-coruscant-csrf':''};
    assert.equal((await f.app.inject({method:'POST',url:'/api/demo/staff/enter',headers:noCsrf,payload:{contextGeneration:c.context!.contextGeneration,contextToken:c.context!.contextToken}})).statusCode,403);
    await c.contextPost('/api/demo/customer/enter',{personaId:'a-owner'});
    assert.equal((await c.get('/api/staff/requests')).statusCode,403);
    await c.contextPost('/api/demo/staff/enter');assert.equal(c.context!.audience,'STAFF');assert.equal(c.context!.memberships.length,0);
    assert.equal((await c.get('/api/customer/workspaces')).statusCode,403);
  }finally{await f.close();}
});

test('submission atomically saves canonical evidence and reopens the same record after restart',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);await c.enter();const review=await c.review();const input=c.envelope(review);
    const save=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);assert.equal(save.statusCode,201,save.body);const outcome=save.json<SubmissionOutcome>();
    assert.match(outcome.reference,/^SRS-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    assert.deepEqual(counts(f.app),{service_requests:1,brief_revisions:1,request_events:1,action_receipts:1});
    const response=await c.get(`/api/customer/org-a/requests/${outcome.requestId}`);assert.equal(response.statusCode,200,response.body);
    const saved=response.json();assert.equal(saved.brief.area.latitude,0);assert.equal(saved.brief.baselineDate,'2026-10-01');assert.equal(saved.evidence[0].name,'Estuary SAR 03');assert.equal(saved.evidence[0].verified,true);assert.equal(saved.matchingState,'Preliminary check ready');assert.equal(saved.responseTarget,null);
    assert.match(response.headers['cache-control']!,/no-store/);assert.equal(response.headers.vary,'Cookie');
    const d0=getD0(f.app.coruscant.db);assert.equal(d0,'2026-10-21T13:42:16.123Z');
    c.app=await f.restart();assert.equal((await c.get(`/api/customer/org-a/requests/${outcome.requestId}`)).json().reference,outcome.reference);
    assert.equal(getD0(f.app.coruscant.db),d0);assert.equal((await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>)).json().outcome,'replayed');
    assert.deepEqual(counts(f.app),{service_requests:1,brief_revisions:1,request_events:1,action_receipts:1});
    await c.contextPost('/api/demo/staff/enter');assert.equal((await c.get(`/api/staff/requests/${outcome.requestId}`)).json().id,outcome.requestId);
  }finally{await f.close();}
});

test('lost response retries before confirmation expiry checks and creates one durable effect',async()=>{
  let first=true;const f=await fixture({afterSubmitCommit:()=>{if(first){first=false;throw new Error('Test-only response loss after commit');}}});try{
    const c=new Client(f.app);await c.enter();const input=c.envelope(await c.review());
    const lost=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);assert.equal(lost.statusCode,503);assert.equal(counts(f.app).service_requests,1);
    f.advance(10*60*1000);
    const retry=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().outcome,'replayed');
    const changed={...input,payload:{brief:{...validBrief(),purpose:''}}};
    assert.equal((await c.post('/api/commands/submitRequest',changed as unknown as Record<string,unknown>)).statusCode,409);
    assert.deepEqual(counts(f.app),{service_requests:1,brief_revisions:1,request_events:1,action_receipts:1});
  }finally{await f.close();}
});

test('simultaneous identical attempts commit one request, event and receipt',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);await c.enter();const input=c.envelope(await c.review());
    const outcomes=await Promise.all([c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>),c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>)]);
    assert.deepEqual(outcomes.map(row=>row.statusCode).sort(),[200,201]);assert.equal(outcomes[0]!.json().requestId,outcomes[1]!.json().requestId);
    assert.deepEqual(counts(f.app),{service_requests:1,brief_revisions:1,request_events:1,action_receipts:1});
  }finally{await f.close();}
});

test('new expired/changed confirmations refuse without partial records',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);await c.enter();const input=c.envelope(await c.review());f.advance(5*60*1000+1);
    const expired=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);assert.equal(expired.statusCode,409,expired.body);
    const fresh=c.envelope(await c.review());fresh.payload.brief.purpose='An edited question after review';
    assert.equal((await c.post('/api/commands/submitRequest',fresh as unknown as Record<string,unknown>)).statusCode,409);
    assert.deepEqual(counts(f.app),{service_requests:0,brief_revisions:0,request_events:0,action_receipts:0});
  }finally{await f.close();}
});

test('Viewer writes, B known identifiers and forged staff operations are refused',async()=>{
  const f=await fixture();try{
    const owner=new Client(f.app);await owner.enter();const input=owner.envelope(await owner.review());const save=await owner.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);const id=save.json().requestId;
    const viewer=new Client(f.app);await viewer.enter('a-viewer');
    assert.equal((await viewer.post('/api/command-reviews/submitRequest',{target:{organizationId:'org-a'},expected:{},payload:{brief:validBrief()}})).statusCode,403);
    assert.equal((await viewer.get(`/api/customer/org-a/requests/${id}`)).statusCode,200);
    const b=new Client(f.app);await b.enter('b-owner','org-b');
    const unavailable=await b.get(`/api/customer/org-a/requests/${id}`);assert.equal(unavailable.statusCode,404);assert.ok(!unavailable.body.includes('river'));assert.ok(!unavailable.body.includes(save.json().reference));
    assert.equal((await b.get(`/api/customer/org-b/requests/${id}`)).statusCode,404);
    assert.equal((await owner.get(`/api/staff/requests/${id}`)).statusCode,403);
    assert.equal((await owner.post('/api/commands/startReview',{commandId:randomUUID(),target:{requestId:id},expected:{requestVersion:1,briefRevision:1},payload:{}})).statusCode,403);
  }finally{await f.close();}
});

test('current authority and context deny even a previously successful receipt',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);await c.enter();const input=c.envelope(await c.review());await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);
    f.app.coruscant.db.prepare("UPDATE memberships SET active=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();
    assert.equal((await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>)).statusCode,404);
    f.app.coruscant.db.prepare("UPDATE memberships SET active=1 WHERE actor_id='a-owner' AND organization_id='org-a'").run();
    const oldCookie=c.cookie;await c.contextPost('/api/context/workspace',{organizationId:'org-a'});
    assert.equal((await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>)).statusCode,409);
    assert.equal((await f.app.inject({method:'GET',url:'/api/customer/org-a/requests',headers:{host:`127.0.0.1:${port}`,cookie:oldCookie}})).statusCode,401);
    const other=new Client(f.app);await other.enter('a-requester');const otherInput=other.envelope(await other.review());otherInput.commandId=input.commandId;
    const collision=await other.post('/api/commands/submitRequest',otherInput as unknown as Record<string,unknown>);assert.equal(collision.statusCode,409);assert.ok(!collision.body.includes('SRS-'));assert.equal(counts(f.app).service_requests,1);
    await c.contextPost('/api/demo/leave');assert.equal(c.context!.actor,null);assert.equal((await c.get('/api/customer/org-a/requests')).statusCode,401);
  }finally{await f.close();}
});

test('session expires after inactivity while current access activity extends its bounded lifetime',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);await c.enter();f.advance(23*60*60*1000);
    assert.equal((await c.get('/api/context')).json<Context>().actor!.id,'a-owner');
    f.advance(2*60*60*1000);assert.equal((await c.get('/api/customer/org-a/requests')).statusCode,200);
    f.advance(24*60*60*1000+1);assert.equal((await c.get('/api/customer/org-a/requests')).statusCode,401);
    assert.equal((await c.get('/api/context')).json<Context>().csrfToken,null);
  }finally{await f.close();}
});

test('server validation rejects untouched, unsupported, date and DST work but retains deliberate zero',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);await c.enter();
    for(const patch of [{areaChoice:null,areaConfirmation:null},{latitude:''},{family:'COMMUNICATIONS'},{sensor:'UNSUPPORTED-SENSOR'},{outputs:['Video']},{baselineDate:''},{recentDate:'2026-09-01'},{timingToDiscuss:false,timezone:'Europe/Dublin',windowStart:'2026-10-25T01:30',windowEnd:'2026-10-25T04:30'}]){
      const response=await c.post('/api/command-reviews/submitRequest',{target:{organizationId:'org-a'},expected:{},payload:{brief:{...validBrief(),...patch}}});assert.equal(response.statusCode,422,response.body);assert.ok(response.json().fieldErrors);
    }
    assert.equal((await c.review()).brief.area.longitude,0);assert.equal(counts(f.app).service_requests,0);
  }finally{await f.close();}
});

test('unavailable evidence is an unverified intention and source failure does not lose a valid submission',async()=>{
  const f=await fixture({preliminaryCheck:()=>{throw new Error('Isolated source failure');}});try{
    const c=new Client(f.app);await c.enter();const input=c.envelope(await c.review());const result=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);
    assert.equal(result.statusCode,201,result.body);const saved=(await c.get(`/api/customer/org-a/requests/${result.json().requestId}`)).json();
    assert.equal(saved.matchingState,'Automatic check unavailable');assert.equal(saved.evidence[0].verified,false);assert.equal(saved.humanReview,'Manual review required');
  }finally{await f.close();}
  const normal=await fixture();try{
    const c=new Client(normal.app);await c.enter();const brief={...validBrief(),selectedEvidence:[{itemId:'missing-public-intention',evidenceVersion:'missing'}]};const input=c.envelope(await c.review(brief),brief);
    const result=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);assert.equal(result.statusCode,201,result.body);
    const saved=(await c.get(`/api/customer/org-a/requests/${result.json().requestId}`)).json();assert.equal(saved.evidence[0].verified,false);assert.equal(saved.evidence[0].itemId,'missing-public-intention');
  }finally{await normal.close();}
});

test('bounded busy refusal leaves no partial command and the unchanged action can be retried',async()=>{
  const f=await fixture();let blocker:ReturnType<typeof openDatabase>|undefined;try{
    const c=new Client(f.app);await c.enter();const input=c.envelope(await c.review());blocker=openDatabase(f.config);blocker.exec('BEGIN IMMEDIATE');
    const start=Date.now();const busy=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);assert.equal(busy.statusCode,503,busy.body);assert.equal(busy.json().code,'RETRY_LATER');assert.ok(Date.now()-start<3000);
    blocker.exec('ROLLBACK');blocker.close();blocker=undefined;assert.equal(counts(f.app).service_requests,0);
    assert.equal((await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>)).statusCode,201);
  }finally{if(blocker){blocker.exec('ROLLBACK');blocker.close();}await f.close();}
});

test('failure after request and brief writes rolls the whole mutation back without a receipt',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);await c.enter();const input=c.envelope(await c.review());
    // Test-only database fault, not a shipping API: fail after earlier inserts in the same transaction.
    f.app.coruscant.db.exec("CREATE TRIGGER test_event_failure BEFORE INSERT ON request_events BEGIN SELECT RAISE(ABORT,'test-only event failure'); END");
    assert.equal((await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>)).statusCode,503);
    assert.deepEqual(counts(f.app),{service_requests:0,brief_revisions:0,request_events:0,action_receipts:0});
    f.app.coruscant.db.exec('DROP TRIGGER test_event_failure');
    assert.equal((await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>)).statusCode,201);
    assert.deepEqual(counts(f.app),{service_requests:1,brief_revisions:1,request_events:1,action_receipts:1});
    assert.equal((f.app.coruscant.db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys,1);
    assert.equal((f.app.coruscant.db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode,'wal');
    assert.equal((f.app.coruscant.db.prepare('PRAGMA synchronous').get() as {synchronous:number}).synchronous,2);
    assert.equal((f.app.coruscant.db.prepare('PRAGMA busy_timeout').get() as {timeout:number}).timeout,250);
  }finally{await f.close();}
});

test('actual SQLiteFULL refuses a reviewed large submission atomically and the unchanged retry succeeds after capacity is restored',async()=>{
  const f=await fixture();const db=f.app.coruscant.db;
  const originalMaximum=(db.prepare('PRAGMA max_page_count').get() as {max_page_count:number}).max_page_count;
  try{
    const c=new Client(f.app);await c.enter();const brief=validBrief();
    brief.purpose='Compare the synthetic estuary. '+ 'p'.repeat(4000-'Compare the synthetic estuary. '.length);
    brief.timingNotes='Demonstration timing context. '+ 't'.repeat(4000-'Demonstration timing context. '.length);
    brief.unknowns=Array.from({length:20},(_,index)=>`${String(index).padStart(2,'0')} ${'u'.repeat(197)}`).join('\n');
    const input=c.envelope(await c.review(brief),brief),before=counts(f.app);
    const pageCount=(db.prepare('PRAGMA page_count').get() as {page_count:number}).page_count;
    const pageSize=(db.prepare('PRAGMA page_size').get() as {page_size:number}).page_size;
    assert.equal((db.prepare(`PRAGMA max_page_count=${pageCount}`).get() as {max_page_count:number}).max_page_count,pageCount);
    const full=(error:unknown)=>{
      assert.ok(error instanceof Error);assert.equal((error as Error&{errcode:number}).errcode,13);
      assert.match(error.message,/database or disk is full/i);return true;
    };
    // This bounds only the isolated SQLite file; it never fills the host disk.
    assert.throws(()=>transaction(db,()=>{
      db.exec('CREATE TABLE test_full_probe (payload BLOB NOT NULL) STRICT');
      db.prepare('INSERT INTO test_full_probe(payload) VALUES(zeroblob(?))').run((pageCount+1)*pageSize);
    }),full);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='test_full_probe'").get(),undefined);
    assert.equal(db.isTransaction,false);
    const failed=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);
    assert.equal(failed.statusCode,503,failed.body);assert.equal(failed.json().code,'SERVICE_UNAVAILABLE');assert.equal(failed.json().retryable,true);
    assert.ok(!failed.body.includes('database or disk is full'));assert.ok(!failed.body.includes(brief.purpose));assert.ok(!failed.body.includes(f.root));
    assert.deepEqual(counts(f.app),before);assert.deepEqual(before,{service_requests:0,brief_revisions:0,request_events:0,action_receipts:0});assert.equal(db.isTransaction,false);
    assert.equal((db.prepare('SELECT consumed_at FROM command_reviews').get() as {consumed_at:string|null}).consumed_at,null);
    db.exec(`PRAGMA max_page_count=${originalMaximum}`);
    const saved=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);assert.equal(saved.statusCode,201,saved.body);
    const replay=await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');assert.equal(replay.json().requestId,saved.json().requestId);
    assert.deepEqual(counts(f.app),{service_requests:1,brief_revisions:1,request_events:1,action_receipts:1});
    const reopened=await c.get(`/api/customer/org-a/requests/${saved.json().requestId}`);assert.equal(reopened.statusCode,200,reopened.body);assert.equal(reopened.json().brief.purpose,brief.purpose);assert.equal(reopened.json().brief.timingNotes,brief.timingNotes);
  }finally{db.exec(`PRAGMA max_page_count=${originalMaximum}`);await f.close();}
});

test('initialization preserves D0/records and startup refuses missing/newer migrations',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);await c.enter();const input=c.envelope(await c.review());await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);
    const before=getD0(f.app.coruscant.db);f.advance(86_400_000);initialize(f.app.coruscant.db,f.config,f.clock);assert.equal(getD0(f.app.coruscant.db),before);assert.equal(counts(f.app).service_requests,1);
    assert.throws(()=>verifySchema(f.app.coruscant.db,join(f.root,'missing-migrations')),/migrations are missing/);
    f.app.coruscant.db.prepare('INSERT INTO schema_migrations(name,hash,applied_at) VALUES(?,?,?)').run('999-unknown.sql','x',f.clock().toISOString());
    assert.throws(()=>verifySchema(f.app.coruscant.db),/schema is missing, newer or changed/);
    const source=f.app.coruscant.db.prepare('SELECT filename,content_hash FROM demo_source_assets LIMIT 1').get() as {filename:string;content_hash:string};assert.ok(readFileSync(join(f.config.sourceRoot,source.filename),'utf8').includes('SYNTHETIC DEMONSTRATION'));
  }finally{await f.close();}
  const empty=mkdtempSync(join(tmpdir(),'coruscant-empty-'));try{await assert.rejects(buildApp({dataRoot:empty,port}),/not migrated/);}finally{rmSync(empty,{recursive:true,force:true});}
});

test('a different recorded recipe refuses initialization before asset repair and preserves saved work',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);await c.enter();const input=c.envelope(await c.review());await c.post('/api/commands/submitRequest',input as unknown as Record<string,unknown>);
    const before=counts(f.app);const d0=getD0(f.app.coruscant.db);
    const source=f.app.coruscant.db.prepare('SELECT filename,content_hash FROM demo_source_assets LIMIT 1').get() as {filename:string;content_hash:string};
    const path=join(f.config.sourceRoot,source.filename);unlinkSync(path);
    f.app.coruscant.db.prepare("UPDATE demo_metadata SET value='unknown-demo-v2' WHERE key='recipe_version'").run();
    assert.throws(()=>initialize(f.app.coruscant.db,f.config,f.clock),/recipe version differs/);
    assert.equal(existsSync(path),false,'refusal must occur before regenerating source assets');
    assert.equal(getD0(f.app.coruscant.db),d0);assert.deepEqual(counts(f.app),before);
    assert.equal((f.app.coruscant.db.prepare("SELECT value FROM demo_metadata WHERE key='recipe_version'").get() as {value:string}).value,'unknown-demo-v2');
    assert.equal((f.app.coruscant.db.prepare('SELECT content_hash FROM demo_source_assets WHERE filename=?').get(source.filename) as {content_hash:string}).content_hash,source.content_hash);
  }finally{await f.close();}
});

test('private working paths and unknown API routes have no static file fallback',async()=>{
  const f=await fixture();try{
    const c=new Client(f.app);const response=await c.get('/api/material/demo-estuary-baseline/versions/1/preview');assert.equal(response.statusCode,401);assert.match(response.headers['content-type']!,/application\/json/);assert.ok(!response.body.includes('<svg'));
    assert.equal((await c.get('/api/does-not-exist')).statusCode,404);
    for(const path of ['/.local/coruscant/coruscant.sqlite','/server/db/migrations/001-core.sql','/demo-source/estuary-baseline-v1.svg']){
      const absent=await c.get(path);assert.ok(!absent.body.includes('SQLite format'));assert.ok(!absent.body.includes('CREATE TABLE'));assert.ok(!absent.body.includes('<svg'));
    }
  }finally{await f.close();}
});

test('the real static handler serves root HTML, assets and SPA paths without serving private or API bytes',async()=>{
  const clientRoot=mkdtempSync(join(tmpdir(),'coruscant-client-'));
  mkdirSync(join(clientRoot,'assets'));
  const html='<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body>Coruscant static regression</body></html>';
  writeFileSync(join(clientRoot,'index.html'),html);writeFileSync(join(clientRoot,'assets/app.js'),'window.coruscantFixture="newly authored route test";');
  writeFileSync(join(clientRoot,'.private-key'),'must never be served');
  const f=await fixture(undefined,clientRoot);try{
    const c=new Client(f.app);const root=await c.get('/');assert.equal(root.statusCode,200,root.body);assert.equal(root.body,html);assert.match(root.headers['content-type']!,/text\/html/);assert.equal(root.headers['cache-control'],'no-store');
    const script=await c.get('/assets/app.js');assert.equal(script.statusCode,200,script.body);assert.match(script.headers['content-type']!,/javascript/);assert.match(script.body,/newly authored route test/);
    assert.equal((await c.get('/access')).body,html);
    for(const path of ['/api','/api/unknown']){const response=await c.get(path);assert.equal(response.statusCode,404,response.body);assert.match(response.headers['content-type']!,/application\/json/);assert.ok(!response.body.includes('Coruscant static regression'));}
    const privateImage=await c.get('/api/material/demo/versions/1/preview');assert.equal(privateImage.statusCode,401);assert.match(privateImage.headers['content-type']!,/application\/json/);assert.ok(!privateImage.body.includes('<svg'));
    const hidden=await c.get('/.private-key');assert.equal(hidden.statusCode,404,hidden.body);assert.ok(!hidden.body.includes('must never be served'));
    writeFileSync(join(f.root,'not-public.txt'),'private working root sentinel');
    const absent=await c.get('/not-public.txt');assert.ok(!absent.body.includes('private working root sentinel'));
    await assert.rejects(buildApp({clientRoot}),/client-root fixture requires test mode/);
    await assert.rejects(buildApp({dataRoot:f.root,clientRoot:'relative'}),/client-root fixture requires test mode/);
  }finally{await f.close();rmSync(clientRoot,{recursive:true,force:true});}
});
