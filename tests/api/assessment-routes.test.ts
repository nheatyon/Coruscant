import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { AssessmentHandle, AssessmentPage, AssessmentHandoffInput } from '../../shared/plan-contracts.js';
import type { Context } from '../../shared/contracts.js';
import { ApiClient, apiFixture } from './support.js';
import { installTechnicalPlanning } from '../helpers/technical-planning.js';

async function publicClient(f: Awaited<ReturnType<typeof apiFixture>>) {
  const client=new ApiClient(f.app);client.takeContext(await client.post('/api/demo/bootstrap',{}));return client;
}
async function complete(client: ApiClient, handle: AssessmentHandle) {
  for(let index=0;index<200;index++){
    const response=await client.post('/api/orbital-assessments/status',{...handle});assert.equal(response.statusCode,200,response.body);
    const page=response.json<AssessmentPage>();if(!['QUEUED','RUNNING'].includes(page.state))return page;
    await setImmediate();
  }
  throw new Error('Actual bounded assessment did not finish.');
}
async function start(f: Awaited<ReturnType<typeof apiFixture>>, client: ApiClient) {
  const fixture=installTechnicalPlanning(f.app.coruscant.db,f.clock().toISOString());
  const response=await client.post('/api/orbital-assessments',{generation:1,brief:fixture.brief});assert.equal(response.statusCode,200,response.body);
  const page=await complete(client,response.json<AssessmentPage>().handle);assert.equal(page.state,'COMPLETE');assert.ok(page.options.length>0);
  return {fixture,page};
}
test('guarded public calculation creates no workflow; handoff spans actual customer and workspace rotations exactly once',async()=>{
  const f=await apiFixture();try{
    const client=await publicClient(f),{fixture,page}=await start(f,client),originalCookie=client.cookie,originalContext=client.context!;
    assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM service_requests').get()!.n,0);
    assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM action_receipts').get()!.n,0);
    const handoff=await client.post('/api/orbital-assessments/handoff',{handle:page.handle});assert.equal(handoff.statusCode,200,handoff.body);
    const proof=handoff.json<AssessmentHandoffInput>();
    const entered=await client.post('/api/demo/customer/enter',{personaId:'a-owner',planningHandoff:proof});client.takeContext(entered);
    assert.equal(client.context!.planningHandoff?.phase,'CONTINUE');const continuation=client.context!.planningHandoff!;
    assert.equal(continuation.phase,'CONTINUE');if(continuation.phase!=='CONTINUE')throw new Error('Expected continuation');
    assert.notEqual(continuation.continuation.handle.readCapability,page.handle.readCapability);
    const hidden=await client.post('/api/orbital-assessments/status',{...continuation.continuation.handle});assert.equal(hidden.statusCode,404,hidden.body);
    const old=new ApiClient(f.app);old.cookie=originalCookie;old.context=originalContext;
    assert.equal((await old.post('/api/orbital-assessments/status',{...page.handle})).statusCode,401);
    client.takeContext(await client.post('/api/context/workspace',{organizationId:'org-a',planningHandoff:continuation.continuation}));
    const finished=(client.context as Context).planningHandoff!;assert.equal(finished.phase,'COMPLETE');if(finished.phase!=='COMPLETE')throw new Error('Expected complete');
    assert.notEqual(finished.result.handle.readCapability,continuation.continuation.handle.readCapability);
    assert.equal(finished.result.manifest.attachmentExpiresAt,page.manifest!.attachmentExpiresAt);
    const transferred=await complete(client,finished.result.handle);assert.equal(transferred.inputDigest,page.inputDigest);
    const option=transferred.options.find(value=>value.outcome==='PROVISIONAL')!;assert.ok(option);
    const raw={target:{organizationId:'org-a'},expected:{},payload:{brief:fixture.brief,selection:{handle:finished.result.handle,attachmentReference:finished.result.attachmentReference,optionId:option.id,proposedAtUtc:option.proposedAtUtc,acknowledgedUnknownIds:option.unknowns.map(value=>value.id),assumptions:[]}}};
    const review=await client.post('/api/command-reviews/saveProposedPlan',raw);assert.equal(review.statusCode,200,review.body);
    const command={...raw,commandId:randomUUID(),reviewToken:review.json().reviewToken},saved=await client.post('/api/commands/saveProposedPlan',command);assert.equal(saved.statusCode,201,saved.body);
    const row=await client.state(saved.json().requestId);assert.equal(row.status,'Planning');assert.equal(row.submittedAt,null);assert.equal(row.schedule,null);assert.equal(row.currentQuote,null);
    assert.equal(row.currentProposedPlan!.assessment.assessmentId,page.handle.assessmentId);assert.equal(row.currentProposedPlan!.option.id,option.id);
    const evidence=await client.post(`/api/customer/org-a/requests/${row.id}/plan-evidence`,{planId:row.currentProposedPlan!.id});assert.equal(evidence.statusCode,200,evidence.body);
    assert.equal(evidence.json().attachmentReference,null);assert.equal(evidence.json().handle.readCapability,'');
    const staffEvidence=await f.staff.post(`/api/staff/requests/${row.id}/plan-evidence`,{planId:row.currentProposedPlan!.id});assert.equal(staffEvidence.statusCode,200,staffEvidence.body);assert.equal(staffEvidence.json().manifest.manifestDigest,page.manifest!.manifestDigest);
    const viewer=new ApiClient(f.app);await viewer.enter('a-viewer');
    const viewerEvidence=await viewer.post(`/api/customer/org-a/requests/${row.id}/plan-evidence`,{planId:row.currentProposedPlan!.id});assert.equal(viewerEvidence.statusCode,200,viewerEvidence.body);
    assert.equal(viewerEvidence.json().handle.readCapability,'');assert.equal(viewerEvidence.json().attachmentReference,null);
    const replay=await client.post('/api/commands/saveProposedPlan',command);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');
    assert.equal((await client.state(row.id)).history.length,1);assert.equal((await f.staff.state(row.id)).currentProposedPlan!.id,row.currentProposedPlan!.id);
    const other=new ApiClient(f.app);await other.enter('b-owner','org-b');
    const denied=await other.post(`/api/customer/org-b/requests/${row.id}/plan-evidence`,{planId:row.currentProposedPlan!.id});assert.equal(denied.statusCode,404,denied.body);
    assert.ok(!denied.body.includes(row.reference));assert.ok(!denied.body.includes(option.name));
    assert.equal((await other.post('/api/orbital-assessments/status',{...finished.result.handle})).statusCode,404);
  }finally{await f.close();}
});
test('assessment routes enforce origin/context and separate staff/customer authority without conferring browser roles',async()=>{
  const f=await apiFixture();try{
    const fixture=installTechnicalPlanning(f.app.coruscant.db,f.clock().toISOString()),client=await publicClient(f);
    assert.equal((await f.staff.post('/api/orbital-assessments',{generation:1,brief:fixture.brief})).statusCode,403);
    const bad=await client.post('/api/orbital-assessments',{generation:1,brief:fixture.brief,role:'OWNER'});assert.equal(bad.statusCode,422);
    const context=await client.post('/api/orbital-assessments',{generation:1,brief:fixture.brief,contextGeneration:client.context!.contextGeneration+1});assert.equal(context.statusCode,409);
    const origin=await f.app.inject({method:'POST',url:'/api/orbital-assessments',headers:{...client.headers(),origin:'http://untrusted.example'},payload:{generation:1,brief:fixture.brief}});assert.equal(origin.statusCode,403);
    const malformed=await client.post('/api/orbital-assessments',{generation:1,brief:fixture.brief,request:'not a request'});assert.equal(malformed.statusCode,422);
    const missing=await client.post('/api/orbital-assessments/handoff',{handle:{assessmentId:'not present'}});assert.ok([404,422].includes(missing.statusCode),missing.body);
    assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM service_requests').get()!.n,0);
  }finally{await f.close();}
});
test('partial contact work cannot block a physical assessment or bypass its separately reviewed save validation',async()=>{
  const f=await apiFixture();try{
    const fixture=installTechnicalPlanning(f.app.coruscant.db,f.clock().toISOString());
    const brief={...fixture.brief,contact:{name:'Unsent planning contact',email:'partial@',organization:''}};
    const begun=await f.owner.post('/api/orbital-assessments',{generation:1,brief});assert.equal(begun.statusCode,200,begun.body);
    const page=await complete(f.owner,begun.json<AssessmentPage>().handle),option=page.options.find(row=>row.outcome==='PROVISIONAL')!;assert.ok(option);
    const invalid=await f.owner.post('/api/command-reviews/saveProposedPlan',{target:{organizationId:'org-a'},expected:{},payload:{brief,selection:{handle:page.handle,attachmentReference:page.attachmentReference,optionId:option.id,proposedAtUtc:option.proposedAtUtc,acknowledgedUnknownIds:option.unknowns.map(row=>row.id),assumptions:[]}}});
    assert.equal(invalid.statusCode,422,invalid.body);assert.ok(invalid.json().fieldErrors['contact.email']);
    assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM service_requests').get()!.n,0);
  }finally{await f.close();}
});
