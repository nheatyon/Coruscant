import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { CustomerResultProjection, StaffMaterialRequestProjection } from '../../shared/material.js';
import { ApiClient, apiFixture, scheduledRequest, preparedResult, approveAndPublishImages, publishFinding, grant, type ApiFixture } from './support.js';

async function ready(f:ApiFixture) {const id=await scheduledRequest(f);await preparedResult(f,id);await approveAndPublishImages(f,id);await publishFinding(f,id);await grant(f,id);return id;}
async function result(client:ApiClient,id:string):Promise<CustomerResultProjection> {const row=await client.state(id);const response=await client.get(`/api/customer/${client.context!.organization!.id}/results/${row.result!.id}`);assert.equal(response.statusCode,200,response.body);return response.json();}
async function input(client:ApiClient,id:string,point={x:0.1234567890123456,y:0.9876543210987654,text:'  A chosen point in this synthetic scene.  '},observationId?:string,version?:number) {
  const view=await result(client,id);return {commandId:randomUUID(),contextGeneration:client.context!.contextGeneration,contextToken:client.context!.contextToken,target:{requestId:id,resultId:view.id,assetId:view.images[0]!.assetId,...(observationId?{observationId}:{})},expected:{requestVersion:view.requestVersion,briefRevision:view.briefRevision,imageContentVersion:view.images[0]!.contentVersion,...(version?{observationVersion:version}:{})},payload:{observation:point}};
}
const count=(f:ApiFixture,table:string)=>Number((f.app.coruscant.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n);
function lineage(row:Awaited<ReturnType<ApiClient['state']>>,view:CustomerResultProjection) {
  return {id:row.id,reference:row.reference,requestVersion:row.requestVersion,briefRevision:row.briefRevision,brief:row.brief,revisions:row.revisions,
    quote:row.acceptedQuote,decisions:row.decisions,schedule:row.schedule,resultId:view.id,images:row.result!.images.map(image=>({id:image.id,version:image.currentVersion!.contentVersion,hash:image.currentVersion!.contentHash,review:image.approval})),finding:row.result!.finding,materialVersion:row.result!.materialVersion,access:row.result!.access,delivery:row.delivery,observations:view.observations};
}

test('actual owned points retain full precision, authorship and complete delivered lineage after application restart',async()=>{
  const f=await apiFixture();try {
    const id=await ready(f),initial=await result(f.owner,id),before=await f.staff.state(id);assert.deepEqual(initial.observations,[]);assert.equal(count(f,'observations'),0);
    const raw=await input(f.owner,id),saved=await f.owner.post('/api/commands/createObservation',raw);assert.equal(saved.statusCode,200,saved.body);const note=saved.json();let view=await result(f.owner,id);
    assert.equal(view.observations.length,1);assert.equal(view.observations[0]!.x,raw.payload.observation.x);assert.equal(view.observations[0]!.y,raw.payload.observation.y);assert.equal(view.observations[0]!.text,raw.payload.observation.text);assert.equal(view.observations[0]!.authorId,'a-owner');assert.equal(view.observations[0]!.canEdit,true);assert.equal(view.observations[0]!.contentVersion,initial.images[0]!.contentVersion);
    const changed=await f.staff.state(id);assert.equal(changed.requestVersion,before.requestVersion);assert.equal(changed.result!.materialVersion,before.result!.materialVersion);assert.equal(changed.result!.readiness.ready,true);assert.equal(changed.result!.finding!.reviewValid,true);
    const delivery=await f.staff.action('recordDelivery',id,{note:'Prepared synthetic pair and reviewed finding supplied for your demonstration inspection.'},{resultId:changed.result!.id},{materialVersion:changed.result!.materialVersion,accessVersion:changed.result!.access!.version,findingContentVersion:changed.result!.finding!.currentVersion.contentVersion});assert.ok(delivery.deliveryId);
    const original=lineage(await f.staff.state(id),await result(f.owner,id));await f.restart();view=await result(f.owner,id);assert.deepEqual(lineage(await f.staff.state(id),view),original);assert.equal(view.observations[0]!.id,note.observationId);
    const replay=await f.owner.post('/api/commands/createObservation',raw);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');assert.equal(count(f,'observations'),1);assert.equal(count(f,'observation_events'),1);
  }finally{await f.close();}
});

test('a separate OS process reopens the complete delivered lineage and owned point using the same durable database',{timeout:20_000},async()=>{
  const f=await apiFixture();let child:ChildProcess|undefined;
  try {
    const id=await ready(f),raw=await input(f.owner,id);const saved=await f.owner.post('/api/commands/createObservation',raw);assert.equal(saved.statusCode,200,saved.body);
    const prepared=await f.staff.state(id);await f.staff.action('recordDelivery',id,{note:'This synthetic demonstration result and reviewed finding are supplied for inspection.'},{resultId:prepared.result!.id},{materialVersion:prepared.result!.materialVersion,accessVersion:prepared.result!.access!.version,findingContentVersion:prepared.result!.finding!.currentVersion.contentVersion});
    const view=await result(f.owner,id),original=lineage(await f.staff.state(id),view);await f.app.close();
    // Keep the same configured origin as the injected app; test cookies are isolated by port.
    const socket=createServer();socket.listen(f.config.port,'127.0.0.1');await once(socket,'listening');const address=socket.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
    const origin=`http://127.0.0.1:${port}`;
    // The child uses the real emitted app and an isolated deterministic test clock, never success seeds.
    const harness="const {buildApp}=await import(process.env.CORUSCANT_APP_URL);const app=await buildApp({dataRoot:process.env.CORUSCANT_TEST_DATA_ROOT,port:Number(process.env.CORUSCANT_PORT),clock:()=>new Date(process.env.CORUSCANT_TEST_NOW)});await app.listen({host:'127.0.0.1',port:Number(process.env.CORUSCANT_PORT)});process.once('SIGTERM',()=>{void app.close();});";
    child=spawn(process.execPath,['--input-type=module','-e',harness],{cwd:f.dataRoot,env:{...process.env,CORUSCANT_MODE:'test',CORUSCANT_TEST_DATA_ROOT:f.dataRoot,CORUSCANT_PORT:String(port),CORUSCANT_TEST_NOW:f.clock().toISOString(),CORUSCANT_APP_URL:pathToFileURL(join(f.config.projectRoot,'dist/node/server/app.js')).href},stdio:['ignore','pipe','pipe']});
    let diagnostics='';child.stderr?.on('data',chunk=>{diagnostics+=String(chunk);});child.stdout?.on('data',()=>{});let startupError:Error|undefined;child.once('error',error=>{startupError=error;});
    let online=false;for(let attempt=0;attempt<100;attempt++){if(startupError)throw startupError;if(child.exitCode!==null)throw new Error(`Child app stopped before readiness: ${diagnostics}`);try{const response=await fetch(`${origin}/api/context`,{signal:AbortSignal.timeout(300)});if(response.ok){online=true;break;}}catch{}await pause(30);}assert.ok(online,diagnostics);
    const staff=await fetch(`${origin}/api/staff/requests/${id}`,{headers:{cookie:f.staff.cookie},signal:AbortSignal.timeout(3000)});assert.equal(staff.status,200,await staff.clone().text());
    const customer=await fetch(`${origin}/api/customer/org-a/results/${view.id}`,{headers:{cookie:f.owner.cookie},signal:AbortSignal.timeout(3000)});assert.equal(customer.status,200,await customer.clone().text());const restored=await customer.json() as CustomerResultProjection;
    assert.deepEqual(lineage(await staff.json() as StaffMaterialRequestProjection,restored),original);
    const replay=await fetch(`${origin}/api/commands/createObservation`,{method:'POST',headers:{origin,'content-type':'application/json',cookie:f.owner.cookie,'x-coruscant-csrf':f.owner.context!.csrfToken!},body:JSON.stringify(raw),signal:AbortSignal.timeout(3000)});assert.equal(replay.status,200,await replay.clone().text());assert.equal((await replay.json() as {outcome:string}).outcome,'replayed');
    const pixels=await fetch(`${origin}${restored.images[0]!.previewUrl}`,{headers:{cookie:f.owner.cookie},signal:AbortSignal.timeout(3000)});assert.equal(pixels.status,200);assert.ok((await pixels.text()).includes('<svg'));
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([ended,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child!.kill('SIGKILL');reject(new Error('Child app did not stop cleanly.'));},5000);})]);}finally{if(timer)clearTimeout(timer);}}
    await f.close();
  }
});

test('Requester writes only their own notes, Viewer only reads, and foreign/staff contexts cannot mutate customer notes',async()=>{
  const f=await apiFixture();try {
    const id=await ready(f),raw=await input(f.owner,id);const own=await f.owner.post('/api/commands/createObservation',raw);const observationId=own.json().observationId as string;
    const requester=new ApiClient(f.app);await requester.enter('a-requester');let visible=await result(requester,id);assert.equal(visible.observations[0]!.canEdit,false);
    const other=await input(requester,id,{x:0.5,y:0.25,text:'Requester observation.'});assert.equal((await requester.post('/api/commands/createObservation',other)).statusCode,200);visible=await result(requester,id);assert.equal(visible.observations.filter(note=>note.canEdit).length,1);
    const cross=await input(requester,id,{x:0.25,y:0.5,text:'Cannot edit colleague.'},observationId,1);assert.equal((await requester.post('/api/commands/updateObservation',cross)).statusCode,403);assert.equal((await requester.post('/api/commands/deleteObservation',{...cross,payload:{}})).statusCode,403);
    const viewer=new ApiClient(f.app);await viewer.enter('a-viewer');const read=await result(viewer,id);assert.equal(read.observations.length,2);assert.ok(read.observations.every(note=>!note.canEdit));const viewInput=await input(viewer,id);assert.equal((await viewer.post('/api/commands/createObservation',viewInput)).statusCode,403);
    const foreign=new ApiClient(f.app);await foreign.enter('b-owner','org-b');const b=await foreign.post('/api/commands/updateObservation',{...cross,contextGeneration:foreign.context!.contextGeneration,contextToken:foreign.context!.contextToken});assert.equal(b.statusCode,404);assert.ok(!b.body.includes('chosen point'));
    const staff=await f.staff.post('/api/commands/updateObservation',{...cross,contextGeneration:f.staff.context!.contextGeneration,contextToken:f.staff.context!.contextToken});assert.equal(staff.statusCode,403);assert.equal(count(f,'observations'),2);assert.equal(count(f,'observation_events'),2);
  }finally{await f.close();}
});

test('owned edit and deletion use row versions, retain tombstone history and replay before deleted-state guards',async()=>{
  let loseDelete=true;const f=await apiFixture({afterWorkflowCommit(name){if(name==='deleteObservation'&&loseDelete){loseDelete=false;throw new Error('test-only lost delete response');}}});try {
    const id=await ready(f),created=await f.owner.post('/api/commands/createObservation',await input(f.owner,id));const noteId=created.json().observationId as string;
    const edit=await input(f.owner,id,{x:0.2222222222222222,y:0.3333333333333333,text:'Edited exact note.'},noteId,1);const saved=await f.owner.post('/api/commands/updateObservation',edit);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().observationVersion,2);
    const stale=await f.owner.post('/api/commands/updateObservation',{...edit,commandId:randomUUID(),payload:{observation:{x:0.4,y:0.6,text:'Keep this stale edit.'}}});assert.equal(stale.statusCode,409);assert.equal(stale.json().code,'STALE_OBSERVATION');assert.equal((await result(f.owner,id)).observations[0]!.text,'Edited exact note.');
    const deletion={...await input(f.owner,id,undefined,noteId,2),payload:{}};const lost=await f.owner.post('/api/commands/deleteObservation',deletion);assert.equal(lost.statusCode,503);assert.deepEqual((await result(f.owner,id)).observations,[]);assert.equal(count(f,'observations'),1);assert.equal(count(f,'observation_events'),3);
    await f.restart();const replay=await f.owner.post('/api/commands/deleteObservation',deletion);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');assert.equal(replay.json().observationVersion,3);
    const oldEdit=await f.owner.post('/api/commands/updateObservation',edit);assert.equal(oldEdit.statusCode,200);assert.equal(oldEdit.json().outcome,'replayed');assert.equal(oldEdit.json().observationVersion,2);assert.deepEqual((await result(f.owner,id)).observations,[]);
    const newEdit=await f.owner.post('/api/commands/updateObservation',{...edit,commandId:randomUUID(),expected:{...edit.expected,observationVersion:3}});assert.equal(newEdit.statusCode,409);assert.equal(newEdit.json().code,'OBSERVATION_DELETED');assert.equal(count(f,'observation_events'),3);
    assert.throws(()=>f.app.coruscant.db.prepare('DELETE FROM observations WHERE id=?').run(noteId),/tombstone/);assert.throws(()=>f.app.coruscant.db.prepare('UPDATE observations SET deleted_at=NULL,version=version+1 WHERE id=?').run(noteId),/cannot reopen/);assert.throws(()=>f.app.coruscant.db.prepare('DELETE FROM observation_events').run(),/append-only/);
  }finally{await f.close();}
});

test('coordinates/text are server validated and association/author claims cannot move a point to another image or result',async()=>{
  const f=await apiFixture();try {
    const id=await ready(f),raw=await input(f.owner,id);
    for(const point of [{x:-0.0001,y:0,text:'outside'},{x:1.00001,y:0,text:'outside'},{x:0,y:2,text:'letterbox is not an image coordinate'},{x:'0.5',y:0.5,text:'typed'},{x:0,y:0,text:' '},{x:0,y:0,text:'x'.repeat(2001)}]){const response=await f.owner.post('/api/commands/createObservation',{...raw,commandId:randomUUID(),payload:{observation:point}});assert.equal(response.statusCode,422,response.body);}assert.equal(count(f,'observations'),0);
    const edge={...raw,payload:{observation:{x:0,y:1,text:'Legitimate oriented-image edge.',authorId:'a-requester',resultId:'forged-result',assetId:'forged-image',contentVersion:99,role:'OWNER'}}};const response=await f.owner.post('/api/commands/createObservation',edge);assert.equal(response.statusCode,200,response.body);const actual=(await result(f.owner,id)).observations[0]!;assert.equal(actual.x,0);assert.equal(actual.y,1);assert.equal(actual.authorId,'a-owner');assert.equal(actual.assetId,raw.target.assetId);assert.equal(actual.resultId,raw.target.resultId);assert.equal(actual.contentVersion,raw.expected.imageContentVersion);
    const otherId=await ready(f),other=await result(f.owner,otherId);const foreign=await f.owner.post('/api/commands/createObservation',{...raw,commandId:randomUUID(),target:{...raw.target,resultId:other.id}});assert.equal(foreign.statusCode,404);
    const unknownVersion=await f.owner.post('/api/commands/createObservation',{...raw,commandId:randomUUID(),expected:{...raw.expected,imageContentVersion:99}});assert.equal(unknownVersion.statusCode,404);assert.equal(count(f,'observations'),1);
    assert.throws(()=>f.app.coruscant.db.prepare('UPDATE observations SET asset_id=?,version=version+1 WHERE id=?').run(other.images[0]!.assetId,actual.id),/exact image version/);
  }finally{await f.close();}
});

test('concurrent and lost-response create attempts produce one point/event and recover after restart',async()=>{
  let lose=true;const f=await apiFixture({afterWorkflowCommit(name){if(name==='createObservation'&&lose){lose=false;throw new Error('test-only lost create response');}}});try {
    const id=await ready(f),raw=await input(f.owner,id);const replies=await Promise.all([f.owner.post('/api/commands/createObservation',raw),f.owner.post('/api/commands/createObservation',raw)]);assert.deepEqual(replies.map(response=>response.statusCode).sort(),[200,503]);assert.equal(count(f,'observations'),1);assert.equal(count(f,'observation_events'),1);
    await f.restart();const recovered=await f.owner.post('/api/commands/createObservation',raw);assert.equal(recovered.statusCode,200);assert.equal(recovered.json().outcome,'replayed');const changed=await f.owner.post('/api/commands/createObservation',{...raw,payload:{observation:{...raw.payload.observation,text:'A distinct logical edit needs a new attempt.'}}});assert.equal(changed.statusCode,409);assert.equal(changed.json().code,'ACTION_CONFLICT');assert.equal(count(f,'observations'),1);
  }finally{await f.close();}
});

test('current membership, role, entitlement and context gate successful note receipt recovery before versions',async()=>{
  const f=await apiFixture();try {
    const id=await ready(f),raw=await input(f.owner,id);assert.equal((await f.owner.post('/api/commands/createObservation',raw)).statusCode,200);
    f.app.coruscant.db.prepare("UPDATE memberships SET role='VIEWER',can_select_offers=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();assert.equal((await f.owner.post('/api/commands/createObservation',raw)).statusCode,403);
    f.app.coruscant.db.prepare("UPDATE memberships SET role='OWNER',can_select_offers=1,active=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();assert.equal((await f.owner.post('/api/commands/createObservation',raw)).statusCode,404);
    f.app.coruscant.db.prepare("UPDATE memberships SET active=1 WHERE actor_id='a-owner' AND organization_id='org-a'").run();f.app.coruscant.db.prepare('UPDATE result_entitlements SET active=0').run();assert.equal((await f.owner.post('/api/commands/createObservation',raw)).statusCode,404);
    f.app.coruscant.db.prepare('UPDATE result_entitlements SET active=1').run();const replay=await f.owner.post('/api/commands/createObservation',raw);assert.equal(replay.statusCode,200);assert.equal(replay.json().outcome,'replayed');
    await f.owner.post('/api/demo/leave',{});assert.equal((await f.owner.post('/api/commands/createObservation',raw)).statusCode,401);assert.equal(count(f,'observations'),1);
  }finally{await f.close();}
});

test('a failed note transaction preserves saved point/text and leaves no event or receipt for the failed attempt',async()=>{
  const f=await apiFixture();try {
    const id=await ready(f),raw=await input(f.owner,id);f.app.coruscant.db.exec("CREATE TRIGGER test_note_rollback BEFORE INSERT ON observation_events BEGIN SELECT RAISE(ABORT,'isolated note rollback probe'); END");
    const failed=await f.owner.post('/api/commands/createObservation',raw);assert.equal(failed.statusCode,503);assert.equal(count(f,'observations'),0);assert.equal(count(f,'observation_events'),0);assert.equal(f.app.coruscant.db.prepare('SELECT command_id FROM action_receipts WHERE command_id=?').get(raw.commandId),undefined);
    f.app.coruscant.db.exec('DROP TRIGGER test_note_rollback');const saved=await f.owner.post('/api/commands/createObservation',raw);assert.equal(saved.statusCode,200,saved.body);assert.deepEqual((await result(f.owner,id)).observations.map(note=>({x:note.x,y:note.y,text:note.text})),[raw.payload.observation]);
  }finally{await f.close();}
});
