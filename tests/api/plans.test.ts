import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BriefInput, RequestProjection } from '../../shared/contracts.js';
import type { AssessmentPage, PlanSelectionInput } from '../../shared/plan-contracts.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { createEmptyQuoteDraft, planningToInput, revisionToInput } from '../../shared/workflow.js';
import { parseSourceBytes, normalizeSourceRow } from '../../server/orbital/catalog.js';
import { captureCatalog, ingestSources, orbitalRoot } from '../../server/orbital/repository.js';
import { createPropagator } from '../../server/orbital/propagation.js';
import { ApiClient, apiFixture, type ApiFixture } from './support.js';

// Original generated numerical input. It is not acquired GP data or a claim
// that this catalog identity represents a real operator or collection service.
const orbit={NORAD_CAT_ID:100001,OBJECT_NAME:'Original proposed-plan API test object',OBJECT_ID:'',EPOCH:'2026-10-21T11:00:00.123456',MEAN_MOTION:14.5,ECCENTRICITY:.002,INCLINATION:67,RA_OF_ASC_NODE:32,ARG_OF_PERICENTER:55,MEAN_ANOMALY:80,BSTAR:.00003,MEAN_MOTION_DOT:.000001,MEAN_MOTION_DDOT:0};
const contact={name:'Original plan test contact',email:'plan-test@coruscant.example',organization:'Generated test team'};
function seed(f:ApiFixture,changes:Record<string,unknown>={}) {
  const at=f.clock().toISOString();
  ingestSources(f.app.coruscant.db,(['sar','resource'] as const).map(group=>{
    const source=parseSourceBytes(group,Buffer.from(JSON.stringify(group==='sar'?[{...orbit,...changes}]:[])),at);
    return {source,rawFilename:`${source.responseHash}.json`};
  }),at);
}
function briefFor(f:ApiFixture):BriefInput {
  const normalized=normalizeSourceRow(orbit);assert.ok(normalized?.omm);
  const position=createPropagator(normalized.omm).at('2026-10-21T13:00:00.000Z');assert.ok(position.ok);
  const area={latitude:position.geodetic.latitude,longitude:position.geodetic.longitude,radiusKm:25,method:'coordinates' as const,generation:1};
  const catalog=captureCatalog(f.app.coruscant.db)!;
  const purpose='Plan a single observation over this deliberately chosen generated test target.';
  return {...createEmptyBrief(),purpose,areaReviewedPurpose:purpose,observationIntent:'single-observation',sensor:'SAR',latitude:String(area.latitude),longitude:String(area.longitude),radiusKm:'25',areaChoice:area,areaConfirmation:areaSignature(area),timingToDiscuss:false,windowStart:'2026-10-21T12:57',windowEnd:'2026-10-21T13:03',catalogContext:{sourceKind:'PUBLIC_REAL',snapshotVersion:catalog.snapshotVersion,factVersion:catalog.factVersion},selectedEvidence:[{itemId:catalog.items[0]!.id,evidenceVersion:catalog.items[0]!.evidenceVersion}]};
}
async function assessed(f:ApiFixture,brief:BriefInput,generation=1,row?:RequestProjection) {
  const response=await f.owner.post('/api/orbital-assessments',{generation,brief,...(row?{request:{requestId:row.id,requestVersion:row.requestVersion,briefRevision:row.briefRevision}}:{})});
  assert.equal(response.statusCode,200,response.body);let page=response.json<AssessmentPage>();
  for(let attempt=0;['QUEUED','RUNNING'].includes(page.state)&&attempt<500;attempt++){
    await yieldLoop();const next=await f.owner.post('/api/orbital-assessments/status',{...page.handle});assert.equal(next.statusCode,200,next.body);page=next.json<AssessmentPage>();
  }
  assert.equal(page.state,'COMPLETE',JSON.stringify(page));assert.ok(page.options.length>0,JSON.stringify(page));
  const option=page.options.find(value=>value.outcome!=='INELIGIBLE');assert.ok(option,JSON.stringify(page));assert.ok(page.attachmentReference);
  const selection:PlanSelectionInput={handle:page.handle,attachmentReference:page.attachmentReference,optionId:option.id,proposedAtUtc:option.proposedAtUtc,acknowledgedUnknownIds:option.unknowns.map(value=>value.id),assumptions:[]};
  return {page,selection};
}
function envelope(f:ApiFixture,brief:BriefInput,selection:PlanSelectionInput,row?:RequestProjection){return {commandId:randomUUID(),target:row?{requestId:row.id}:{organizationId:'org-a'},expected:row?{requestVersion:row.requestVersion,briefRevision:row.briefRevision,proposedPlanVersion:row.currentProposedPlan?.version??null}:{},payload:{brief,selection}};}
async function reviewed(f:ApiFixture,brief:BriefInput,selection:PlanSelectionInput,row?:RequestProjection){
  const input=envelope(f,brief,selection,row),response=await f.owner.post('/api/command-reviews/saveProposedPlan',input);assert.equal(response.statusCode,200,response.body);
  return {...input,reviewToken:response.json().reviewToken};
}
async function first(f:ApiFixture){seed(f);const brief=briefFor(f),calculated=await assessed(f,brief),command=await reviewed(f,brief,calculated.selection);const response=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(response.statusCode,201,response.body);return {brief,...calculated,command,id:response.json().requestId as string};}
async function submit(f:ApiFixture,id:string){const row=await f.owner.state(id),input=f.owner.envelope(row,{brief:{...planningToInput(row.brief),contact,acknowledged:true}});const preview=await f.owner.post('/api/command-reviews/submitPlanningRequest',input);assert.equal(preview.statusCode,200,preview.body);const response=await f.owner.post('/api/commands/submitPlanningRequest',{...input,reviewToken:preview.json().reviewToken});assert.equal(response.statusCode,200,response.body);return f.owner.state(id);}
async function quote(f:ApiFixture,id:string){await f.staff.action('startReview',id);const value={...createEmptyQuoteDraft(),priceType:'FIXED',amount:'2500',scope:'The exact saved single-observation test target and requested window. Proposed plan remains tentative.',licence:'Original generated local test only.',validUntil:'2026-10-21T12:50'};const draft=await f.staff.action('saveQuoteDraft',id,{quote:value});await f.staff.action('publishQuote',id,{replacesQuoteId:null},{quoteId:draft.quoteId!},{quoteContentVersion:draft.quoteContentVersion!});return draft;}

test('first proposed-plan save atomically creates one Planning request, immutable version and protected durable evidence',async()=>{
  const f=await apiFixture();try{
    const saved=await first(f),row=await f.owner.state(saved.id),db=f.app.coruscant.db;
    assert.equal(row.status,'Planning');assert.equal(row.requestVersion,1);assert.equal(row.briefRevision,1);assert.equal(row.currentProposedPlan!.version,1);assert.equal(row.currentProposedPlan!.briefRevision,1);assert.equal(row.acceptedPlan,null);assert.equal(row.history.length,1);assert.equal(row.submittedAt,null);assert.equal((await f.staff.get('/api/staff/requests')).json().total,0);
    assert.equal(row.currentProposedPlan!.assessment.assessmentId,saved.page.handle.assessmentId);assert.equal(row.currentProposedPlan!.option.itemId,'norad:100001');assert.equal(row.currentProposedPlan!.option.outcome,'PROVISIONAL');
    for(const table of ['service_requests','brief_revisions','request_events','action_receipts','proposed_plan_versions','orbital_assessment_attachments'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,1,table);
    const path=`/api/customer/org-a/requests/${saved.id}/plan-evidence`,input={planId:row.currentProposedPlan!.id};
    const evidence=await f.owner.post(path,input);assert.equal(evidence.statusCode,200,evidence.body);assert.equal(evidence.json().manifest.manifestDigest,row.currentProposedPlan!.assessment.manifestDigest);
    const other=new ApiClient(f.app);await other.enter('b-owner','org-b');assert.equal((await other.post(path,input)).statusCode,404);
    assert.equal((await f.owner.get(`/api/public/assessments/${saved.page.handle.assessmentId}`)).statusCode,404);
    const before=JSON.stringify(row);await f.restart();assert.equal(JSON.stringify(await f.owner.state(saved.id)),before);
    const replay=await f.owner.post('/api/commands/saveProposedPlan',saved.command);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');assert.equal(replay.json().requestId,saved.id);
  }finally{await f.close();}
});
test('authorized unchanged plan retry recovers receipt before expired review/manifest, missing file and advanced lifecycle',async()=>{
  let lose=true;const f=await apiFixture({afterWorkflowCommit(name){if(name==='saveProposedPlan'&&lose){lose=false;throw new Error('Original isolated lost-response injection.');}}});try{
    seed(f);const brief=briefFor(f),{page,selection}=await assessed(f,brief),command=await reviewed(f,brief,selection);const lost=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(lost.statusCode,503,lost.body);
    const receipt=f.app.coruscant.db.prepare('SELECT outcome_json FROM action_receipts WHERE command_id=?').get(command.commandId) as {outcome_json:string};assert.ok(receipt);const id=JSON.parse(receipt.outcome_json).requestId as string;
    await submit(f,id);f.advance(16*60*1000);
    const file=f.app.coruscant.db.prepare('SELECT manifest_filename FROM orbital_assessments WHERE id=?').get(page.handle.assessmentId) as {manifest_filename:string};rmSync(resolve(orbitalRoot(f.config),'assessments',file.manifest_filename));
    const replay=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');assert.equal((await f.owner.state(id)).status,'Submitted');assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM proposed_plan_versions').get()!.n,1);
    const altered=await f.owner.post('/api/commands/saveProposedPlan',{...command,payload:{...command.payload,selection:{...selection,assumptions:[{id:'processing-hours',hours:2,explanation:'Explicit original test assumption.'}]}}});assert.equal(altered.statusCode,409,altered.body);assert.equal(altered.json().code,'ACTION_CONFLICT');
    f.app.coruscant.db.prepare("UPDATE memberships SET active=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();const denied=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(denied.statusCode,404);assert.ok(!denied.body.includes(id));
  }finally{await f.close();}
});
test('new expired or forged attachment saves leave no partial request, plan, event or receipt',async()=>{
  const f=await apiFixture();try{
    seed(f);const brief=briefFor(f),{selection}=await assessed(f,brief),command=await reviewed(f,brief,selection);
    const forged=await f.owner.post('/api/commands/saveProposedPlan',{...command,payload:{brief,selection:{...selection,attachmentReference:selection.attachmentReference+'x'}}});assert.equal(forged.statusCode,409,forged.body);
    f.advance(16*60*1000);const expired=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(expired.statusCode,409,expired.body);assert.equal(expired.json().code,'ASSESSMENT_EXPIRED');
    for(const table of ['service_requests','brief_revisions','request_events','action_receipts','proposed_plan_versions','orbital_assessment_attachments'])assert.equal(f.app.coruscant.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,table);
  }finally{await f.close();}
});
test('identical plan attempt committed during failed preflight recovers receipt; a rolled-back failure leaves no partial selection',async()=>{
  let release!:()=>void,arrived!:()=>void,waiting=true;const held=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>arrived=resolve);
  const f=await apiFixture({async beforeProposedPlanPreflight(){if(waiting){waiting=false;arrived();await held;throw new Error('Original isolated failed preflight after identical commit.');}}});try{
    seed(f);const brief=briefFor(f),{selection}=await assessed(f,brief),command=await reviewed(f,brief,selection),firstAttempt=f.owner.post('/api/commands/saveProposedPlan',command);await entered;
    const second=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(second.statusCode,201,second.body);release();const recovered=await firstAttempt;assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().outcome,'replayed');assert.equal(recovered.json().requestId,second.json().requestId);
    assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM proposed_plan_versions').get()!.n,1);assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM action_receipts').get()!.n,1);
    const row=await f.owner.state(second.json().requestId),next=await assessed(f,planningToInput(row.brief),2,row),newCommand=await reviewed(f,planningToInput(row.brief),next.selection,row);
    f.app.coruscant.db.exec("CREATE TRIGGER isolated_reject_attachment BEFORE INSERT ON orbital_assessment_attachments BEGIN SELECT RAISE(ABORT,'Original isolated final attachment failure'); END");
    const rejected=await f.owner.post('/api/commands/saveProposedPlan',newCommand);assert.equal(rejected.statusCode,503,rejected.body);assert.equal((await f.owner.state(row.id)).currentProposedPlan!.id,row.currentProposedPlan!.id);assert.equal((await f.owner.state(row.id)).earlierProposedPlans.length,0);assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM action_receipts').get()!.n,1);
    f.app.coruscant.db.exec('DROP TRIGGER isolated_reject_attachment');const retry=await f.owner.post('/api/commands/saveProposedPlan',newCommand);assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().proposedPlanVersion,2);
  }finally{release?.();await f.close();}
});
test('contact-only submit preserves exact plan origin while technical revision invalidates with immutable reason/history',async()=>{
  const f=await apiFixture();try{
    const saved=await first(f),before=await f.owner.state(saved.id),after=await submit(f,saved.id);
    assert.equal(after.briefRevision,2);assert.equal(after.currentProposedPlan!.id,before.currentProposedPlan!.id);assert.equal(after.currentProposedPlan!.briefRevision,1);assert.deepEqual(after.currentProposedPlan,before.currentProposedPlan);assert.deepEqual(after.revisions[0]!.brief,before.brief);
    const purpose=after.brief.purpose+' Revised technical purpose.';await f.owner.action('reviseBrief',saved.id,{brief:{...revisionToInput(after.brief),purpose,areaReviewedPurpose:purpose}});
    const changed=await f.owner.state(saved.id);assert.equal(changed.currentProposedPlan,null);assert.equal(changed.earlierProposedPlans.length,1);assert.equal(changed.earlierProposedPlans[0]!.id,before.currentProposedPlan!.id);assert.match(changed.earlierProposedPlans[0]!.invalidationReason!,/Technical planning inputs changed/);assert.equal(changed.history.filter(value=>value.type==='Proposed plan invalidated').length,1);
    const db=f.app.coruscant.db;assert.throws(()=>db.prepare('UPDATE proposed_plan_versions SET option_id=? WHERE id=?').run('forged',before.currentProposedPlan!.id),/immutable/);assert.throws(()=>db.prepare('DELETE FROM proposed_plan_invalidations WHERE plan_version_id=?').run(before.currentProposedPlan!.id),/deleted/);
  }finally{await f.close();}
});
test('same-input plan version uses current refreshed source without rewriting historical brief/evidence or quote terms; acceptance freezes exact plan',async()=>{
  const f=await apiFixture();try{
    const saved=await first(f);await submit(f,saved.id);const draft=await quote(f,saved.id),before=await f.owner.state(saved.id);
    const oldAcceptance=f.owner.envelope(before,{}, {quoteId:draft.quoteId!},{quoteContentVersion:draft.quoteContentVersion!});const oldReview=await f.owner.post('/api/command-reviews/acceptQuote',oldAcceptance);assert.equal(oldReview.statusCode,200,oldReview.body);
    seed(f,{OBJECT_NAME:'Original proposed-plan API test object — refreshed source'});const current=captureCatalog(f.app.coruscant.db)!;assert.notEqual(current.snapshotVersion,before.currentProposedPlan!.assessment.snapshotVersion);
    const unchanged=planningToInput(before.brief),next=await assessed(f,unchanged,2,before);assert.equal(next.page.snapshotVersion,current.snapshotVersion);const command=await reviewed(f,unchanged,next.selection,before),response=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(response.statusCode,200,response.body);
    const after=await f.owner.state(saved.id);assert.equal(after.requestVersion,before.requestVersion+1);assert.equal(after.briefRevision,before.briefRevision);assert.deepEqual(after.brief,before.brief);assert.deepEqual(after.evidence,before.evidence);assert.deepEqual(after.currentQuote,before.currentQuote);assert.equal(after.currentProposedPlan!.version,2);assert.equal(after.earlierProposedPlans[0]!.id,before.currentProposedPlan!.id);assert.equal(after.currentProposedPlan!.assessment.snapshotVersion,current.snapshotVersion);assert.equal(after.currentProposedPlan!.briefRevision,before.briefRevision);
    const stale=await f.owner.post('/api/commands/acceptQuote',{...oldAcceptance,reviewToken:oldReview.json().reviewToken});assert.equal(stale.statusCode,409,stale.body);
    await f.owner.action('acceptQuote',saved.id,{}, {quoteId:draft.quoteId!},{quoteContentVersion:draft.quoteContentVersion!});const accepted=await f.owner.state(saved.id);assert.equal(accepted.acceptedPlan!.plan!.id,after.currentProposedPlan!.id);assert.equal(accepted.acceptedPlan!.plan!.state,'ACCEPTED_SNAPSHOT');assert.equal(accepted.acceptedQuote!.id,before.currentQuote!.id);
    const replay=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');
    const rejected=await f.owner.post('/api/command-reviews/saveProposedPlan',envelope(f,planningToInput(accepted.brief),next.selection,accepted));assert.equal(rejected.statusCode,409,rejected.body);assert.equal(rejected.json().code,'ACCEPTED_WORK_LOCKED');
  }finally{await f.close();}
});
test('new plan selection refuses changed requirements, stale plan versions, Viewer/staff/foreign scope and final authority loss',async()=>{
  let revoke=false;let f:ApiFixture;f=await apiFixture({afterProposedPlanPreflight(){if(revoke)f.app.coruscant.db.prepare("UPDATE memberships SET active=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();}});try{
    const saved=await first(f),row=await f.owner.state(saved.id),raw=planningToInput(row.brief),next=await assessed(f,raw,2,row);
    const changed={...raw,purpose:raw.purpose+' Changed.',areaReviewedPurpose:raw.purpose+' Changed.'};const wrong=await f.owner.post('/api/command-reviews/saveProposedPlan',envelope(f,changed,next.selection,row));assert.equal(wrong.statusCode,409,wrong.body);assert.equal(wrong.json().code,'BRIEF_REVISION_REQUIRED');
    const stale=envelope(f,raw,next.selection,row);stale.expected.proposedPlanVersion=9;assert.equal((await f.owner.post('/api/command-reviews/saveProposedPlan',stale)).statusCode,409);
    for(const [persona,org,expected] of [['a-viewer','org-a',403],['b-owner','org-b',404],['staff-admin','',403]] as const){const actor=new ApiClient(f.app);await actor.enter(persona,org);const response=await actor.post('/api/command-reviews/saveProposedPlan',envelope(f,raw,next.selection,row));assert.equal(response.statusCode,expected,response.body);}
    const command=await reviewed(f,raw,next.selection,row);revoke=true;const denied=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(denied.statusCode,404,denied.body);assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM proposed_plan_versions').get()!.n,1);assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM action_receipts').get()!.n,1);
  }finally{await f.close();}
});
test('acceptance without a selected plan freezes explicit None; an omitted plan on ordinary preparation never clears a selection',async()=>{
  const f=await apiFixture();try{
    seed(f);const brief=briefFor(f),input={target:{organizationId:'org-a'},expected:{},payload:{brief}},review=await f.owner.post('/api/command-reviews/savePlanningRequest',input);assert.equal(review.statusCode,200,review.body);
    const saved=await f.owner.post('/api/commands/savePlanningRequest',{...input,commandId:randomUUID(),reviewToken:review.json().reviewToken});assert.equal(saved.statusCode,201,saved.body);const id=saved.json().requestId as string;
    assert.equal((await f.owner.state(id)).acceptedPlan,null);await submit(f,id);const draft=await quote(f,id);await f.owner.action('acceptQuote',id,{}, {quoteId:draft.quoteId!},{quoteContentVersion:draft.quoteContentVersion!});
    const accepted=await f.owner.state(id);assert.deepEqual(accepted.acceptedPlan,{plan:null});assert.equal(accepted.currentProposedPlan,null);await f.restart();assert.deepEqual((await f.owner.state(id)).acceptedPlan,{plan:null});
    assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM proposed_plan_versions').get()!.n,0);
    const withPlan=await first(f),before=await f.owner.state(withPlan.id);await f.owner.action('reviseBrief',withPlan.id,{brief:revisionToInput(before.brief)});
    const after=await f.owner.state(withPlan.id);assert.equal(after.currentProposedPlan!.id,before.currentProposedPlan!.id);assert.equal(after.earlierProposedPlans.length,0);
  }finally{await f.close();}
});
