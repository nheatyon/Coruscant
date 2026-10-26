import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiClient, apiFixture } from './support.js';
import type { BriefInput } from '../../shared/contracts.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { createEmptyQuoteDraft, planningToInput, revisionToInput } from '../../shared/workflow.js';

function planningBrief(patch:Partial<BriefInput>={}):BriefInput {
  const purpose='Plan a Visible shoreline observation over this deliberately chosen area.';
  const area={latitude:14.7,longitude:-17.4,radiusKm:12,method:'coordinates' as const,generation:1};
  return {...createEmptyBrief(),purpose,areaReviewedPurpose:purpose,observationIntent:'single-observation',sensor:'Visible',latitude:'14.7',longitude:'-17.4',radiusKm:'12',areaChoice:area,areaConfirmation:areaSignature(area),...patch};
}
const contact={name:'Generated planning contact',email:'single@coruscant.example',organization:'Generated shoreline team'};
async function save(f:Awaited<ReturnType<typeof apiFixture>>,brief=planningBrief()) {
  const raw={target:{organizationId:'org-a'},expected:{},payload:{brief}};
  const review=await f.owner.post('/api/command-reviews/savePlanningRequest',raw);assert.equal(review.statusCode,200,review.body);
  const envelope={...raw,commandId:randomUUID(),reviewToken:review.json().reviewToken};
  const result=await f.owner.post('/api/commands/savePlanningRequest',envelope);assert.equal(result.statusCode,201,result.body);
  return {id:result.json().requestId as string,envelope,reference:result.json().reference as string};
}
async function submit(f:Awaited<ReturnType<typeof apiFixture>>,id:string,brief:BriefInput) {
  const envelope=f.owner.envelope(await f.owner.state(id),{brief});
  const review=await f.owner.post('/api/command-reviews/submitPlanningRequest',envelope);assert.equal(review.statusCode,200,review.body);
  const command={...envelope,reviewToken:review.json().reviewToken};
  const result=await f.owner.post('/api/commands/submitPlanningRequest',command);assert.equal(result.statusCode,200,result.body);return {command,result};
}

test('first Planning save has one reference, actual first-save time, no submission/contact fiction or staff-queue entry',async()=>{
  const f=await apiFixture();try {
    const saved=await save(f),row=await f.owner.state(saved.id);
    assert.equal(row.status,'Planning');assert.equal(row.firstSavedAt,f.clock().toISOString());
    assert.equal(row.submittedAt,null);assert.equal(row.submittedBy,null);assert.equal(row.originalSubmittedContact,null);
    assert.equal(row.brief.sensor,'VISIBLE');assert.equal(row.brief.baselineDate,'');assert.equal(row.brief.recentDate,'');
    assert.equal(row.brief.requestedWindow,null);assert.equal(row.currentQuote,null);assert.equal(row.schedule,null);assert.equal(row.history.length,1);
    assert.equal(row.history[0]!.type,'Planning saved');assert.equal(row.humanReview,'Not submitted');assert.equal(row.revisions.length,1);
    const staff=await f.staff.state(saved.id);assert.equal(staff.reference,row.reference);assert.deepEqual(staff.brief,row.brief);
    const list=await f.staff.get('/api/staff/requests');assert.equal(list.statusCode,200,list.body);assert.equal(list.json().total,0);
    const missions=await f.owner.get('/api/customer/org-a/missions');assert.equal(missions.statusCode,200,missions.body);assert.equal(missions.json().requests[0].status,'Planning');
    await f.restart();assert.deepEqual((await f.owner.state(saved.id)).brief,row.brief);assert.equal((await f.staff.state(saved.id)).submittedAt,null);
    const replay=await f.owner.post('/api/commands/savePlanningRequest',saved.envelope);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().requestId,saved.id);
    assert.equal((await f.owner.state(saved.id)).history.length,1);
  }finally{await f.close();}
});
test('explicit submit validates actual contact and appends reviewed completion revision on the same request exactly once',async()=>{
  const f=await apiFixture();try {
    const saved=await save(f),before=await f.owner.state(saved.id),raw=planningToInput(before.brief);
    const bad=await f.owner.post('/api/command-reviews/submitPlanningRequest',f.owner.envelope(before,{brief:raw}));assert.equal(bad.statusCode,422,bad.body);
    assert.equal((await f.owner.state(saved.id)).status,'Planning');
    const {command}=await submit(f,saved.id,{...raw,contact,acknowledged:true});
    const row=await f.owner.state(saved.id);assert.equal(row.reference,saved.reference);assert.equal(row.status,'Submitted');assert.equal(row.briefRevision,2);assert.equal(row.requestVersion,2);
    assert.equal(row.revisions.length,2);assert.deepEqual(row.revisions[0]!.brief.contact,{name:'',email:'',organization:''});assert.deepEqual(row.originalSubmittedContact,contact);
    assert.equal(row.submittedAt,f.clock().toISOString());assert.equal(row.submittedBy,f.owner.context!.actor!.name);assert.equal(row.firstSavedAt,before.firstSavedAt);
    assert.deepEqual(row.history.map(h=>h.type),['Planning saved','Submitted']);
    f.advance(10*60*1000);const replay=await f.owner.post('/api/commands/submitPlanningRequest',command);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');assert.equal((await f.owner.state(saved.id)).revisions.length,2);
    const firstReplay=await f.owner.post('/api/commands/savePlanningRequest',saved.envelope);assert.equal(firstReplay.statusCode,200,firstReplay.body);assert.equal(firstReplay.json().requestId,saved.id);
    assert.equal((await f.staff.get('/api/staff/requests')).json().total,1);
  }finally{await f.close();}
});
test('unchanged complete Planning input submits without an invented extra brief revision',async()=>{
  const f=await apiFixture();try {
    const saved=await save(f,planningBrief({contact})),row=await f.owner.state(saved.id);
    await submit(f,saved.id,{...planningToInput(row.brief),acknowledged:true});
    const after=await f.owner.state(saved.id);assert.equal(after.briefRevision,1);assert.equal(after.revisions.length,1);assert.equal(after.requestVersion,2);
  }finally{await f.close();}
});
test('comparison preparation can remain incomplete but separate submission requires the actual ordered pair',async()=>{
  const f=await apiFixture();try {
    const saved=await save(f,planningBrief({observationIntent:'comparison',sensor:'SAR'})),row=await f.owner.state(saved.id);
    const raw={...planningToInput(row.brief),contact,acknowledged:true};
    const bad=await f.owner.post('/api/command-reviews/submitPlanningRequest',f.owner.envelope(row,{brief:raw}));assert.equal(bad.statusCode,422,bad.body);assert.ok(bad.json().fieldErrors.baselineDate);
    await submit(f,saved.id,{...raw,baselineDate:'2026-10-10',recentDate:'2026-10-17'});const after=await f.owner.state(saved.id);
    assert.equal(after.briefRevision,2);assert.equal(after.brief.baselineDate,'2026-10-10');assert.equal(after.revisions[0]!.brief.baselineDate,'');
  }finally{await f.close();}
});
test('Owner/Requester may prepare; Viewer, other workspace and staff cannot write; Planning staff detail is read-only',async()=>{
  const f=await apiFixture();try {
    const saved=await save(f),row=await f.owner.state(saved.id),raw={target:{organizationId:'org-a'},expected:{},payload:{brief:planningBrief()}};
    const viewer=new ApiClient(f.app);await viewer.enter('a-viewer');assert.equal((await viewer.post('/api/command-reviews/savePlanningRequest',raw)).statusCode,403);
    const other=new ApiClient(f.app);await other.enter('b-owner','org-b');assert.equal((await other.post('/api/command-reviews/savePlanningRequest',raw)).statusCode,404);
    assert.equal((await f.staff.post('/api/command-reviews/savePlanningRequest',raw)).statusCode,403);
    const requester=new ApiClient(f.app);await requester.enter('a-requester');assert.equal((await requester.post('/api/command-reviews/savePlanningRequest',raw)).statusCode,200);
    const start=await f.staff.post('/api/commands/startReview',f.staff.envelope(row));assert.equal(start.statusCode,409,start.body);
    const quote=await f.staff.post('/api/commands/saveQuoteDraft',f.staff.envelope(row,{quote:createEmptyQuoteDraft()}));assert.equal(quote.statusCode,409,quote.body);
    const viewerSubmit=await viewer.post('/api/command-reviews/submitPlanningRequest',viewer.envelope(row,{brief:{...planningToInput(row.brief),contact,acknowledged:true}}));assert.equal(viewerSubmit.statusCode,403);
    const revision={...revisionToInput(row.brief),contact};await f.owner.action('reviseBrief',saved.id,{brief:revision});
    const revised=await f.owner.state(saved.id);assert.equal(revised.status,'Planning');assert.equal(revised.briefRevision,2);assert.equal(revised.originalSubmittedContact,null);assert.deepEqual(revised.brief.contact,contact);
  }finally{await f.close();}
});
test('new submit binds exact versions/payload and one durable receipt; current authority still gates recovery',async()=>{
  const f=await apiFixture();try {
    const saved=await save(f),row=await f.owner.state(saved.id),brief={...planningToInput(row.brief),contact,acknowledged:true};
    const envelope=f.owner.envelope(row,{brief}),review=await f.owner.post('/api/command-reviews/submitPlanningRequest',envelope);assert.equal(review.statusCode,200,review.body);
    const altered=await f.owner.post('/api/commands/submitPlanningRequest',{...envelope,reviewToken:review.json().reviewToken,payload:{brief:{...brief,timingNotes:'Changed after review'}}});assert.equal(altered.statusCode,409,altered.body);
    await f.owner.action('reviseBrief',saved.id,{brief:{...revisionToInput(row.brief),timingNotes:'Deliberate preparation revision'}});
    const stale=await f.owner.post('/api/commands/submitPlanningRequest',{...envelope,reviewToken:review.json().reviewToken});assert.equal(stale.statusCode,409,stale.body);
    const current=await f.owner.state(saved.id);const sent=await submit(f,saved.id,{...planningToInput(current.brief),contact,acknowledged:true});
    f.app.coruscant.db.prepare("UPDATE memberships SET active=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();
    const denied=await f.owner.post('/api/commands/submitPlanningRequest',sent.command);assert.ok([403,404].includes(denied.statusCode),denied.body);
    const db=f.app.coruscant.db;assert.equal((db.prepare("SELECT count(*) AS n FROM request_events WHERE request_id=? AND type='Submitted'").get(saved.id) as {n:number}).n,1);
  }finally{await f.close();}
});
test('new optical/single commercial review preserves gates and cannot invoke the illustrative SAR material recipe',async()=>{
  const f=await apiFixture();try {
    const saved=await save(f,planningBrief({contact,timingToDiscuss:false,windowStart:'2026-10-23T08:00',windowEnd:'2026-10-24T18:00'})),row=await f.owner.state(saved.id);
    const sent=await submit(f,saved.id,{...planningToInput(row.brief),acknowledged:true});await f.staff.action('startReview',saved.id);
    const draft=await f.staff.action('saveQuoteDraft',saved.id,{quote:{...createEmptyQuoteDraft(),priceType:'FIXED',amount:'42.50',scope:'EO technical review only; no collection claim.',licence:'Generated review terms.',validUntil:'2026-10-22T18:00'}});
    await f.staff.action('publishQuote',saved.id,{replacesQuoteId:null},{quoteId:draft.quoteId!},{quoteContentVersion:draft.quoteContentVersion!});
    await f.owner.action('acceptQuote',saved.id,{},{quoteId:draft.quoteId!},{quoteContentVersion:draft.quoteContentVersion!});
    const accepted=await f.staff.state(saved.id),unsupported=await f.staff.post('/api/commands/createResultSet',f.staff.envelope(accepted));assert.equal(unsupported.statusCode,409,unsupported.body);assert.equal(unsupported.json().code,'RECIPE_UNSUPPORTED');
    const replay=await f.owner.post('/api/commands/submitPlanningRequest',sent.command);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');
    const initial=await f.owner.post('/api/commands/savePlanningRequest',saved.envelope);assert.equal(initial.statusCode,200,initial.body);
    const locked=await f.owner.post('/api/command-reviews/reviseBrief',f.owner.envelope(await f.owner.state(saved.id),{brief:revisionToInput(accepted.brief)}));assert.equal(locked.statusCode,409,locked.body);
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM result_sets').get() as {n:number}).n,0);
  }finally{await f.close();}
});

test('submitting an unchanged complete Planning brief preserves explicit manual-source null and its revision',async()=>{
  const f=await apiFixture();try {
    const saved=await save(f,planningBrief({contact,areaSource:null})),before=await f.owner.state(saved.id);
    const {command}=await submit(f,saved.id,{...planningToInput(before.brief),acknowledged:true});
    const after=await f.owner.state(saved.id);assert.equal(after.briefRevision,1);assert.equal(after.revisions.length,1);
    assert.deepEqual(after.brief,before.brief);assert.equal(after.brief.areaSource,null);assert.equal(after.status,'Submitted');
    const replay=await f.owner.post('/api/commands/submitPlanningRequest',command);assert.equal(replay.statusCode,200,replay.body);
    assert.equal((await f.owner.state(saved.id)).history.filter(item=>item.type==='Submitted').length,1);
  }finally{await f.close();}
});
