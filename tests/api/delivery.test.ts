import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowOutcome } from '../../shared/workflow.js';
import { DELIVERY_DATE_BLOCKER } from '../../shared/material.js';
import { openDatabase } from '../../server/db/database.js';
import { ApiClient, apiFixture, scheduledRequest, preparedResult, approveAndPublishImages, publishFinding, grant, resultInput, type ApiFixture } from './support.js';

async function ready(f:ApiFixture,baseline?:string,expiry?:string) {
  const id=await scheduledRequest(f,baseline);const prepared=await preparedResult(f,id);
  if(expiry)await f.staff.action('saveResultDraft',id,{result:{...resultInput(),rightsExpiresAt:expiry}},{resultId:prepared.id});
  await approveAndPublishImages(f,id);await publishFinding(f,id);await grant(f,id);return id;
}
async function deliveryInput(f:ApiFixture,id:string,note='The supplied synthetic pair and reviewed finding are ready for your demonstration inspection.') {
  const row=await f.staff.state(id),result=row.result!;
  const input=f.staff.envelope(row,{note},{resultId:result.id},{materialVersion:result.materialVersion,accessVersion:result.access?.version??0,findingContentVersion:result.finding?.currentVersion.contentVersion??0});
  const preview=await f.staff.post('/api/command-reviews/recordDelivery',input);assert.equal(preview.statusCode,200,preview.body);
  return {input:{...input,reviewToken:preview.json().reviewToken},preview:preview.json()};
}
const count=(f:ApiFixture,table:string)=>Number((f.app.coruscant.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n);
function removeFirstFile(f:ApiFixture) {const row=f.app.coruscant.db.prepare('SELECT relative_path FROM material_files LIMIT 1').get() as {relative_path:string};unlinkSync(join(f.config.materialRoot,row.relative_path));}

test('manual delivery commits one immutable readiness snapshot and the same durable customer-safe mission fact',async()=>{
  const f=await apiFixture();try {
    const id=await ready(f),before=await f.staff.state(id);assert.equal(before.status,'Scheduled');assert.equal(before.result!.readiness.ready,true);assert.equal(count(f,'deliveries'),0);
    const {input,preview}=await deliveryInput(f,id,'  Exact customer-visible delivery note.  ');assert.equal(preview.confirmation.deliveryNote,input.payload.note);assert.equal(preview.confirmation.result.readiness.ready,true);
    const response=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(response.statusCode,200,response.body);const outcome=response.json<WorkflowOutcome>();assert.ok(outcome.deliveryId);
    const after=await f.owner.state(id);assert.equal(after.status,'Delivered');assert.equal(after.requestVersion,before.requestVersion+1);assert.equal(after.delivery!.id,outcome.deliveryId);assert.equal(after.delivery!.note,input.payload.note);assert.equal(after.history.at(-1)!.message,input.payload.note);
    const snapshot=JSON.parse((f.app.coruscant.db.prepare('SELECT readiness_json FROM deliveries').get() as {readiness_json:string}).readiness_json);
    assert.equal(snapshot.dateComparison.status,'ALIGNED');assert.equal(snapshot.images.length,2);assert.ok(snapshot.images.every((image:{imageReviewId:string;contentHash:string})=>image.imageReviewId&&image.contentHash));assert.equal(snapshot.fileChecks,'AVAILABLE');assert.equal(snapshot.intendedMembershipConfirmed,true);assert.ok(snapshot.finding.findingReviewId);assert.ok(!JSON.stringify(snapshot).includes(f.dataRoot));
    assert.throws(()=>f.app.coruscant.db.prepare("UPDATE deliveries SET note='changed'").run(),/immutable/);assert.throws(()=>f.app.coruscant.db.prepare('DELETE FROM deliveries').run(),/immutable/);
    await f.restart();assert.equal((await f.owner.state(id)).delivery!.id,outcome.deliveryId);const replay=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(replay.json().outcome,'replayed');assert.equal(count(f,'deliveries'),1);
    f.app.coruscant.db.prepare('UPDATE result_entitlements SET active=0').run();const permitted=await f.owner.state(id);assert.equal(permitted.delivery!.id,outcome.deliveryId);assert.equal(permitted.result,null);assert.equal((await f.owner.get(`/api/customer/org-a/results/${before.result!.id}`)).statusCode,404);
    await f.staff.post('/api/demo/leave',{});const obsoleteContext=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(obsoleteContext.statusCode,401);assert.equal(count(f,'deliveries'),1);
  }finally{await f.close();}
});

test('blocked previews retain the note, and mismatch acknowledgement cannot waive a new delivery or advance Scheduled',async()=>{
  const f=await apiFixture();try {
    const id=await ready(f,'2026-10-06'),before=await f.staff.state(id),note='Keep this unsent note while inspecting the exact date blocker.';
    assert.deepEqual(before.result!.readiness.blockers,[DELIVERY_DATE_BLOCKER]);const {input,preview}=await deliveryInput(f,id,note);const receipts=count(f,'action_receipts');assert.equal(preview.confirmation.deliveryNote,note);assert.equal(preview.confirmation.result.readiness.ready,false);assert.equal(preview.confirmation.dateComparison.status,'DIFFERENT');
    const response=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(response.statusCode,409,response.body);assert.equal(response.json().message,DELIVERY_DATE_BLOCKER);assert.equal(count(f,'deliveries'),0);assert.equal(count(f,'action_receipts'),receipts);
    assert.equal(f.app.coruscant.db.prepare('SELECT command_id FROM action_receipts WHERE command_id=?').get(input.commandId),undefined);const after=await f.staff.state(id);assert.equal(after.status,'Scheduled');assert.equal(after.requestVersion,before.requestVersion);assert.equal(after.history.length,before.history.length);
    const bad=await f.staff.post('/api/command-reviews/recordDelivery',{...input,payload:{note:' '}});assert.equal(bad.statusCode,422);assert.ok(bad.json().fieldErrors.note);
  }finally{await f.close();}
});

test('a lost delivery response replays before expired confirmation, withdrawn finding and missing bytes without another preflight',async()=>{
  let drop=true,preflights=0;const f=await apiFixture({beforeDeliveryPreflight(){preflights++;},afterWorkflowCommit(name){if(name==='recordDelivery'&&drop){drop=false;throw new Error('test-only lost response after durable commit');}}});try {
    const id=await ready(f),{input}=await deliveryInput(f,id);const lost=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(lost.statusCode,503);assert.equal(count(f,'deliveries'),1);assert.equal(preflights,1);
    let result=(await f.staff.state(id)).result!;await f.staff.action('withdrawFinding',id,{reason:'Withdraw the demonstration finding while retaining historical delivery.'},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:result.finding!.currentVersion.contentVersion});removeFirstFile(f);f.advance(6*60*1000);
    const replay=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');assert.equal(preflights,1);assert.equal(count(f,'deliveries'),1);assert.equal((await f.owner.state(id)).history.filter(event=>event.type==='Delivered').length,1);
    result=(await f.staff.state(id)).result!;const customer=await f.owner.get(`/api/customer/org-a/results/${result.id}`);assert.equal(customer.statusCode,200);assert.equal(customer.json().finding,null);const missing=customer.json().images.find((image:{availability:string})=>image.availability==='UNAVAILABLE');assert.ok(missing);assert.equal((await f.owner.get(missing.previewUrl)).json().code,'MATERIAL_UNAVAILABLE');
    const changed=await f.staff.post('/api/commands/recordDelivery',{...input,payload:{note:'different'}});assert.equal(changed.statusCode,409);assert.equal(changed.json().code,'ACTION_CONFLICT');assert.equal(preflights,1);
    const fresh=await deliveryInput(f,id);const denied=await f.staff.post('/api/commands/recordDelivery',fresh.input);assert.equal(denied.statusCode,409);assert.equal(denied.json().code,'DELIVERY_BLOCKED');assert.equal(count(f,'deliveries'),1);
    f.app.coruscant.db.prepare("UPDATE actors SET active=0 WHERE id='staff-admin'").run();const revoked=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(revoked.statusCode,401);assert.equal(preflights,2);
  }finally{await f.close();}
});

test('an identical commit during another preflight failure is recovered at the final receipt gate',async()=>{
  let release!:()=>void,started!:()=>void,calls=0;const hold=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>started=resolve);let f!:ApiFixture;
  f=await apiFixture({async beforeDeliveryPreflight(){assert.equal(f.app.coruscant.db.isTransaction,false);if(++calls===1){started();await hold;}}});try {
    const id=await ready(f),{input}=await deliveryInput(f,id);const first=f.staff.post('/api/commands/recordDelivery',input);await entered;
    const second=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(second.statusCode,200,second.body);assert.equal(second.json().outcome,'saved');removeFirstFile(f);release();
    const recovered=await first;assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().outcome,'replayed');assert.equal(recovered.json().deliveryId,second.json().deliveryId);assert.equal(count(f,'deliveries'),1);assert.equal((await f.staff.state(id)).history.filter(event=>event.type==='Delivered').length,1);
  }finally{release();await f.close();}
});

test('both preflight outcomes pass current authority and context again before any receipt disclosure or new commit',async()=>{
  for(const loss of ['leave','staff','membership','rights','access'] as const){let release!:()=>void,started!:()=>void;const hold=new Promise<void>(resolve=>release=resolve),entered=new Promise<void>(resolve=>started=resolve);let active=false;let f!:ApiFixture;
    f=await apiFixture({async afterDeliveryPreflight(){if(active){assert.equal(f.app.coruscant.db.isTransaction,false);started();await hold;}}});try {
      const id=await ready(f,undefined,loss==='rights'?'2026-10-21T12:10:00Z':undefined),{input}=await deliveryInput(f,id);active=true;const pending=f.staff.post('/api/commands/recordDelivery',input);await entered;
      if(loss==='leave')await f.staff.post('/api/demo/leave',{});
      else if(loss==='staff')f.app.coruscant.db.prepare("UPDATE actors SET active=0 WHERE id='staff-admin'").run();
      else if(loss==='membership')f.app.coruscant.db.prepare("UPDATE memberships SET active=0 WHERE organization_id='org-a'").run();
      else if(loss==='access')f.app.coruscant.db.prepare('UPDATE result_entitlements SET active=0').run();
      else f.advance(11*60*1000);
      release();const denied=await pending;assert.ok([401,409].includes(denied.statusCode),denied.body);assert.equal(count(f,'deliveries'),0);assert.equal(f.app.coruscant.db.prepare('SELECT command_id FROM action_receipts WHERE command_id=?').get(input.commandId),undefined);
    }finally{release();await f.close();}
  }
});

test('new stale, expired, unauthorized and busy deliveries refuse atomically while the unchanged busy attempt can retry',async()=>{
  const f=await apiFixture();try {
    const id=await ready(f),{input}=await deliveryInput(f,id);const outsider=new ApiClient(f.app);await outsider.enter('b-owner','org-b');
    const foreign=await outsider.post('/api/commands/recordDelivery',{...input,contextGeneration:outsider.context!.contextGeneration,contextToken:outsider.context!.contextToken,commandId:randomUUID()});assert.equal(foreign.statusCode,403);
    const customer=await f.owner.post('/api/commands/recordDelivery',{...input,contextGeneration:f.owner.context!.contextGeneration,contextToken:f.owner.context!.contextToken,commandId:randomUUID()});assert.equal(customer.statusCode,403);
    const stale=await f.staff.post('/api/commands/recordDelivery',{...input,commandId:randomUUID(),expected:{...input.expected,materialVersion:0}});assert.equal(stale.statusCode,409);assert.equal(stale.json().code,'STALE_MATERIAL');
    const blocker=openDatabase(f.config);blocker.exec('BEGIN IMMEDIATE');try {const busy=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(busy.statusCode,503);assert.equal(busy.json().code,'RETRY_LATER');assert.equal(count(f,'deliveries'),0);}finally{blocker.exec('ROLLBACK');blocker.close();}
    f.advance(6*60*1000);const expired=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(expired.statusCode,409);assert.equal(expired.json().code,'REVIEW_EXPIRED');assert.equal(count(f,'deliveries'),0);
    const fresh=await deliveryInput(f,id);const saved=await f.staff.post('/api/commands/recordDelivery',fresh.input);assert.equal(saved.statusCode,200,saved.body);assert.equal(count(f,'deliveries'),1);
  }finally{await f.close();}
});

test('failure after delivery insertion rolls back delivery, Delivered state, event and receipt together',async()=>{
  const f=await apiFixture();try {
    const id=await ready(f),{input}=await deliveryInput(f,id),before=await f.staff.state(id);
    f.app.coruscant.db.exec("CREATE TRIGGER test_delivery_rollback BEFORE UPDATE ON service_requests WHEN NEW.status='Delivered' BEGIN SELECT RAISE(ABORT,'isolated rollback probe'); END");
    const failed=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(failed.statusCode,503);assert.equal(count(f,'deliveries'),0);assert.equal((await f.staff.state(id)).history.length,before.history.length);assert.equal((await f.staff.state(id)).status,'Scheduled');assert.equal(f.app.coruscant.db.prepare('SELECT command_id FROM action_receipts WHERE command_id=?').get(input.commandId),undefined);
    f.app.coruscant.db.exec('DROP TRIGGER test_delivery_rollback');const saved=await f.staff.post('/api/commands/recordDelivery',input);assert.equal(saved.statusCode,200,saved.body);assert.equal(count(f,'deliveries'),1);
  }finally{await f.close();}
});
