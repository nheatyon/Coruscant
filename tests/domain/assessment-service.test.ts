import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { migrate } from '../../server/db/migrate.js';
import { initialize } from '../../server/db/initialize.js';
import { hash,randomToken } from '../../server/security.js';
import { installTechnicalPlanning } from '../helpers/technical-planning.js';
import { createAssessmentService,type AssessmentOwner } from '../../server/orbital/assessment-service.js';
import { prepareAssessmentInput } from '../../server/orbital/plan-input.js';
import { ingestSources } from '../../server/orbital/repository.js';
import { parseSourceBytes } from '../../server/orbital/catalog.js';
import type { CalculationHooks } from '../../server/orbital/plan.js';
import type { AssessmentHandle,AssessmentPage,PlanSelectionInput } from '../../shared/plan-contracts.js';

async function fixture(options:{beforeManifestWrite?:()=>Promise<unknown>;calculationHooks?:CalculationHooks}={}) {
  const dataRoot=mkdtempSync(resolve(tmpdir(),'coruscant-assessment-')),config=createConfig({dataRoot,port:3196}),db=openDatabase(config);migrate(db,resolve(process.cwd(),'server/db/migrations'));
  let instant=new Date('2026-10-25T12:00:00.000Z');const clock=()=>new Date(instant);initialize(db,config,clock);const technical=installTechnicalPlanning(db,instant.toISOString());
  const sessionHash=hash(randomToken()),contextGeneration=1;db.prepare("INSERT INTO sessions(cookie_hash,audience,actor_id,organization_id,context_generation,context_token,csrf_token,active,created_at,last_seen_at,expires_at) VALUES(?,'CUSTOMER','a-owner','org-a',1,?,?,1,?,?,?)").run(sessionHash,randomToken(),randomToken(),instant.toISOString(),instant.toISOString(),new Date(instant.getTime()+86400000).toISOString());
  const owner:AssessmentOwner={sessionHash,contextGeneration,audience:'CUSTOMER',actorId:'a-owner',organizationId:'org-a',requestId:null};
  let service=createAssessmentService({db,config,clock,...options});
  return {db,config,clock,technical,owner,get service(){return service;},advance(ms:number){instant=new Date(instant.getTime()+ms);},restart(){service.close();service=createAssessmentService({db,config,clock});},async close(){service.close();await setImmediate();db.close();rmSync(dataRoot,{recursive:true,force:true});}};
}
async function finished(f:Awaited<ReturnType<typeof fixture>>,handle:AssessmentHandle):Promise<AssessmentPage>{for(let i=0;i<1000;i++){const page=await f.service.status(f.owner,handle);if(!['QUEUED','RUNNING'].includes(page.state))return page;await setImmediate();}throw new Error('The bounded isolated calculation did not finish.');}
function selected(page:AssessmentPage):PlanSelectionInput {const option=page.options.find(value=>value.outcome!=='INELIGIBLE')!;assert.ok(option);assert.ok(page.attachmentReference);return {handle:page.handle,attachmentReference:page.attachmentReference!,optionId:option.id,proposedAtUtc:option.proposedAtUtc,acknowledgedUnknownIds:option.unknowns.map(value=>value.id),assumptions:[]};}
test('actual generated-element calculation persists exact manifest, provisional selection and historical evidence across restart/expiry',async()=>{
  const f=await fixture();try{const raw={generation:1,brief:f.technical.brief},start=await f.service.start(f.owner,raw),page=await finished(f,start.handle);assert.equal(page.state,'COMPLETE');assert.equal(page.counts.positive,1);assert.ok(page.manifest);assert.ok(page.options.some(value=>value.outcome==='PROVISIONAL'));assert.ok(page.options.every(value=>value.proposedAtUtc===null));
    const brief=prepareAssessmentInput(f.db,raw,f.clock().toISOString()).brief,binding={organizationId:'org-a',requestId:null,requestVersion:null,briefRevision:null,currentPlanId:null,brief},prepared=await f.service.prepareSelection(f.owner,selected(page),binding);f.service.assertPreparedSelection(prepared,f.owner,binding);assert.equal(prepared.selectedAtUtc,null);assert.equal(prepared.manifest.manifestDigest,page.manifest!.manifestDigest);
    const view=await f.service.status(f.owner,{...page.handle,optionId:page.options[0]!.id});assert.equal(view.selectedView!.itemId,f.technical.itemId);assert.ok(view.selectedView!.arc!.points.length<=256);
    f.restart();const returned=await f.service.status(f.owner,page.handle);assert.deepEqual(returned.manifest,page.manifest);assert.deepEqual(returned.options,page.options);
    f.advance(16*60000);await assert.rejects(()=>f.service.prepareSelection(f.owner,selected(page),binding),/expired/);let authorized=0;const historical=await f.service.readSavedManifest(page.manifest!,()=>{authorized++;});assert.equal(authorized,2);assert.equal(historical.attachmentReference,null);assert.equal(historical.handle.readCapability,'');assert.deepEqual(historical.options,page.options);
  }finally{await f.close();}
});
test('new generation supersedes old attachment but leaves exact old evidence inspectable',async()=>{
  const f=await fixture();try{const old=await finished(f,(await f.service.start(f.owner,{generation:1,brief:f.technical.brief})).handle),brief=prepareAssessmentInput(f.db,{generation:1,brief:f.technical.brief},f.clock().toISOString()).brief;
    await finished(f,(await f.service.start(f.owner,{generation:2,brief:{...f.technical.brief,purpose:`${f.technical.brief.purpose} New reviewed question.`,areaReviewedPurpose:`${f.technical.brief.purpose} New reviewed question.`}})).handle);
    const earlier=await f.service.status(f.owner,old.handle);assert.deepEqual(earlier.options,old.options);assert.equal(earlier.attachmentReference,null);
    await assert.rejects(()=>f.service.prepareSelection(f.owner,selected(old),{organizationId:'org-a',requestId:null,requestVersion:null,briefRevision:null,currentPlanId:null,brief}),/superseded/);
  }finally{await f.close();}
});
test('final state is published only after immutable IO, and >100 outcomes cursors survive finalization but not a page-kind switch',async()=>{
  let release!:()=>void,reached!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{reached=resolve;}),f=await fixture({beforeManifestWrite:async()=>{reached();await held;}});
  try{
    const rows=Array.from({length:121},(_,i)=>({...f.technical.omm,NORAD_CAT_ID:String(990021001+i),OBJECT_NAME:`Original paging element ${i}`}));
    const sources=(['sar','resource'] as const).map(group=>{const source=parseSourceBytes(group,Buffer.from(JSON.stringify(group==='sar'?rows:[])),f.clock().toISOString());return {source,rawFilename:`${source.responseHash}.json`};});const version=ingestSources(f.db,sources,f.clock().toISOString());
    const brief={...f.technical.brief,catalogContext:{sourceKind:'PUBLIC_REAL' as const,snapshotVersion:version,factVersion:f.technical.catalog.factVersion}},start=await f.service.start(f.owner,{generation:1,brief});await entered;
    const interim=await f.service.status(f.owner,{...start.handle,kind:'OUTCOMES'});assert.equal(interim.state,'RUNNING');assert.equal(interim.manifest,null);assert.equal(interim.outcomes.length,100);assert.ok(interim.nextCursor);assert.ok(Buffer.byteLength(JSON.stringify(interim))<=256*1024);
    release();const page=await finished(f,start.handle),second=await f.service.status(f.owner,{...start.handle,kind:'OUTCOMES',cursor:interim.nextCursor!});assert.equal(page.counts.matching,121);assert.equal(second.outcomes.length,21);assert.equal(second.nextCursor,null);assert.equal(new Set([...interim.outcomes,...second.outcomes].map(value=>value.itemId)).size,121);
    await assert.rejects(()=>f.service.status(f.owner,{...start.handle,kind:'OPTIONS',cursor:interim.nextCursor!}),/page does not belong/);
  }finally{release();await f.close();}
});
test('authority loss, altered exact selection and malformed handles cannot retrieve or attach target artifacts',async()=>{
  const f=await fixture();try{const start=await f.service.start(f.owner,{generation:1,brief:f.technical.brief}),page=await finished(f,start.handle),brief=prepareAssessmentInput(f.db,{generation:1,brief:f.technical.brief},f.clock().toISOString()).brief,binding={organizationId:'org-a',requestId:null,requestVersion:null,briefRevision:null,currentPlanId:null,brief};
    await assert.rejects(()=>f.service.status({...f.owner,organizationId:'org-b'},start.handle));
    await assert.rejects(()=>f.service.prepareSelection(f.owner,{...selected(page),attachmentReference:`${page.attachmentReference}x`},binding),/reference changed/);
    await assert.rejects(()=>f.service.prepareSelection(f.owner,{...selected(page),acknowledgedUnknownIds:[]},binding),/acknowledge/);
    await assert.rejects(()=>f.service.status(f.owner,{assessmentId:randomUUID(),generation:1,readCapability:undefined as unknown as string}));
    f.db.prepare("UPDATE memberships SET active=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();await assert.rejects(()=>f.service.status(f.owner,start.handle));
  }finally{await f.close();}
});
test('manifest/key corruption fails new work without overwriting historical evidence or manufacturing replacement keys',async()=>{
  const f=await fixture();try{const page=await finished(f,(await f.service.start(f.owner,{generation:1,brief:f.technical.brief})).handle),root=resolve(f.config.dataRoot,'orbital'),key=resolve(root,'assessment-hmac.key');
    const originalKey=readFileSync(key);assert.equal(originalKey.length,32);unlinkSync(key);f.restart();await assert.rejects(()=>f.service.start(f.owner,{generation:2,brief:f.technical.brief}),/key is missing/);const historical=await f.service.readSavedManifest(page.manifest!,()=>{});assert.deepEqual(historical.options,page.options);
    const stored=f.db.prepare('SELECT manifest_filename FROM orbital_assessments WHERE id=?').get(page.handle.assessmentId) as {manifest_filename:string};writeFileSync(resolve(root,'assessments',stored.manifest_filename),'corrupt original test copy');await assert.rejects(()=>f.service.readSavedManifest(page.manifest!,()=>{}),/missing or has an invalid size/);
  }finally{await f.close();}
});
test('one active calculation retains other contexts, four waiting contexts are bounded, and replacement/cancel preserves explicit accounting',async()=>{
  let release!:()=>void,reached!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{reached=resolve;});let first=true;
  const f=await fixture({calculationHooks:{yieldControl:async()=>{if(first){first=false;reached();await hold;}else await setImmediate();}}});
  try{
    const active=await f.service.start(f.owner,{generation:1,brief:f.technical.brief});await entered;
    const owners=Array.from({length:5},()=>{const sessionHash=hash(randomToken()),now=f.clock().toISOString();f.db.prepare("INSERT INTO sessions(cookie_hash,audience,actor_id,organization_id,context_generation,context_token,csrf_token,active,created_at,last_seen_at,expires_at) VALUES(?,'CUSTOMER','a-owner','org-a',1,?,?,1,?,?,?)").run(sessionHash,randomToken(),randomToken(),now,now,new Date(Date.parse(now)+86400000).toISOString());return {...f.owner,sessionHash};});
    const waiting:AssessmentPage[]=[];for(const owner of owners.slice(0,4))waiting.push(await f.service.start(owner,{generation:1,brief:f.technical.brief}));
    assert.deepEqual(waiting.map(page=>page.queuePosition),[1,2,3,4]);await assert.rejects(()=>f.service.start(owners[4]!,{generation:1,brief:f.technical.brief}),error=>(error as {status?:number}).status===429);
    const replacement=await f.service.start(owners[0]!,{generation:2,brief:f.technical.brief});assert.equal(replacement.queuePosition,4);
    const canceled=await f.service.cancel(owners[0]!,waiting[0]!.handle);assert.equal(canceled.state,'CANCELED');assert.equal(canceled.counts.notAssessed,canceled.counts.matching);assert.equal(canceled.counts.remaining,0);assert.equal(canceled.attachmentReference,null);
    assert.equal((await f.service.status(f.owner,active.handle)).state,'RUNNING');release();await finished(f,active.handle);
    for(let i=1;i<4;i++)for(let tries=0;tries<1000;tries++){const page=await f.service.status(owners[i]!,waiting[i]!.handle);if(!['QUEUED','RUNNING'].includes(page.state)){assert.equal(page.state,'COMPLETE');break;}await setImmediate();}
    await f.service.cancel(owners[0]!,replacement.handle);
  }finally{release();await f.close();}
});
test('an edited instant is rechecked within its exact LOS opportunity and cannot borrow a different captured pass',async()=>{
  const f=await fixture();try{
    const raw={generation:1,brief:{...f.technical.brief,windowEnd:'2026-10-26T12:02'}},page=await finished(f,(await f.service.start(f.owner,raw)).handle),selection=selected(page),first=page.options.find(option=>option.id===selection.optionId)!;
    const other=page.options.find(option=>option.itemId===first.itemId&&option.los.startUtc>first.los.endUtc);assert.ok(other,'The actual generated24-hour orbit window must contain another independently detected pass.');
    const brief=prepareAssessmentInput(f.db,raw,f.clock().toISOString()).brief,binding={organizationId:'org-a',requestId:null,requestVersion:null,briefRevision:null,currentPlanId:null,brief};
    await assert.rejects(()=>f.service.prepareSelection(f.owner,{...selection,proposedAtUtc:other.los.peakUtc},binding),error=>(error as {code?:string;message?:string}).code==='PLAN_TIME_OTHER_OPPORTUNITY'&&(error as Error).message==='Choose the matching opportunity for this instant.');
    const reviewed=await f.service.prepareSelection(f.owner,{...selection,proposedAtUtc:first.los.peakUtc},binding);assert.equal(reviewed.selectedAtUtc,first.los.peakUtc);assert.equal(reviewed.option.los.startUtc,first.los.startUtc);assert.equal(reviewed.option.los.endUtc,first.los.endUtc);assert.equal(reviewed.option.checks.find(check=>check.id==='los')!.state,'PASS');assert.equal(reviewed.option.outcome,'PROVISIONAL');assert.equal(reviewed.option.checks.find(check=>check.id==='sensor-geometry')!.state,'UNKNOWN');
  }finally{await f.close();}
});
test('a valid in-LOS edited instant still refuses an actual failed optical swath-center constraint',async()=>{
  const f=await fixture();try{
    // Fresh original numerical elements for the independently cited identity. These are
    // not provider observations or a seeded successful plan; all geometry is calculated.
    const row={...f.technical.omm,NORAD_CAT_ID:'42063',OBJECT_ID:'2017-013A',OBJECT_NAME:'Original optical preflight numerical double'};
    const sources=(['sar','resource'] as const).map(group=>{const source=parseSourceBytes(group,Buffer.from(JSON.stringify(group==='resource'?[row]:[])),f.clock().toISOString());return {source,rawFilename:`${source.responseHash}.json`};});const version=ingestSources(f.db,sources,f.clock().toISOString());
    const raw={generation:1,brief:{...f.technical.brief,sensor:'VISIBLE',catalogContext:{sourceKind:'PUBLIC_REAL' as const,snapshotVersion:version,factVersion:f.technical.catalog.factVersion}}},page=await finished(f,(await f.service.start(f.owner,raw)).handle),option=page.options[0]!;assert.ok(option);assert.ok(option.nominalClosest);
    const brief=prepareAssessmentInput(f.db,raw,f.clock().toISOString()).brief,binding={organizationId:'org-a',requestId:null,requestVersion:null,briefRevision:null,currentPlanId:null,brief},proposedAtUtc=new Date(Date.parse(option.los.startUtc)+1000).toISOString();assert.ok(proposedAtUtc<option.los.endUtc);
    await assert.rejects(()=>f.service.prepareSelection(f.owner,{handle:page.handle,attachmentReference:page.attachmentReference!,optionId:option.id,proposedAtUtc,acknowledgedUnknownIds:[],assumptions:[]},binding),error=>(error as {code?:string}).code==='PLAN_KNOWN_MISMATCH');
  }finally{await f.close();}
});
