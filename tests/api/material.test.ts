import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { unlinkSync, readFileSync, writeFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { CustomerResultProjection } from '../../shared/material.js';
import { apiFixture, ApiClient, scheduledRequest, preparedResult, approveAndPublishImages, findingDraft, publishFinding, grant, resultInput } from './support.js';
import type { ApiFixture } from './support.js';
const reviewChecks={answersQuestion:true,correctPairRolesDatesVersions:true,matchesVisibleMaterial:true,rightsPermitUse:true,accurateDisclosures:true};
function files(f:ApiFixture){return f.app.coruscant.db.prepare('SELECT id,relative_path FROM material_files ORDER BY rowid').all() as {id:string;relative_path:string}[];}
function count(f:ApiFixture,table:string){return (f.app.coruscant.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n;}

test('actual preparation is unapproved; explicit publication and entitlement independently gate the same saved result',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f);let result=await preparedResult(f,id);assert.equal(result.images.length,2);assert.ok(result.images.every(image=>image.state==='REVIEW'&&image.approval===null));assert.equal(result.finding,null);assert.notEqual(result.images[0]!.currentVersion!.contentHash,result.images[1]!.currentVersion!.contentHash);assert.ok(result.images.every(image=>image.currentVersion!.width===1600&&image.currentVersion!.height===1000));
    assert.deepEqual((await f.owner.get('/api/customer/org-a/results')).json().results,[]);assert.equal((await f.owner.get(`/api/customer/org-a/results/${result.id}`)).statusCode,404);
    await grant(f,id);assert.deepEqual((await f.owner.get('/api/customer/org-a/results')).json().results,[],'entitlement cannot publish a draft');
    await approveAndPublishImages(f,id);const beforeFinding=await f.owner.get(`/api/customer/org-a/results/${result.id}`);assert.equal(beforeFinding.statusCode,200,beforeFinding.body);assert.equal(beforeFinding.json().finding,null);assert.equal(beforeFinding.json().images.length,2);
    await publishFinding(f,id);result=(await f.staff.state(id)).result!;const response=await f.owner.get(`/api/customer/org-a/results/${result.id}`);const customer=response.json<CustomerResultProjection>();assert.equal(response.statusCode,200,response.body);assert.equal(customer.finding!.review.actorId,'staff-admin');assert.equal(customer.dateComparison.status,'ALIGNED');assert.equal(customer.acceptedContext.baselineReferenceDate,'2026-10-07');assert.equal(customer.images[0]!.origin.actualCollection,null);assert.equal(customer.images[0]!.origin.illustrativeDate,'2026-10-07');assert.equal(customer.images[1]!.origin.illustrativeDate,'2026-10-14');assert.equal(customer.finding!.citations[0]!.assetId,customer.images[0]!.assetId);
    const bytes=await f.owner.get(customer.images[0]!.previewUrl);assert.equal(bytes.statusCode,200,bytes.body);assert.match(bytes.body,/<svg/);assert.equal(bytes.headers['cache-control'],'private, no-store');assert.equal(bytes.headers.vary,'Cookie');assert.equal(bytes.headers.etag,undefined);assert.equal(bytes.headers['cross-origin-resource-policy'],'same-origin');assert.equal(bytes.headers['x-content-type-options'],'nosniff');
    assert.equal((await f.owner.state(id)).status,'Scheduled');assert.equal(result.readiness.ready,true);assert.equal((await f.owner.state(id)).result!.id,result.id);const lineage=JSON.stringify(customer);await f.restart();const restored=(await f.owner.get(`/api/customer/org-a/results/${result.id}`)).json<CustomerResultProjection>();assert.equal(JSON.stringify(restored),lineage);
  }finally{await f.close();}
});

test('publication alone reveals no result and foreign identities cannot obtain metadata, finding or either byte variant',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f);let result=await preparedResult(f,id);await approveAndPublishImages(f,id);await publishFinding(f,id);result=(await f.staff.state(id)).result!;
    assert.equal((await f.owner.get(`/api/customer/org-a/results/${result.id}`)).statusCode,404);assert.equal((await f.owner.state(id)).result,null);assert.deepEqual((await f.owner.get('/api/customer/org-a/results')).json().results,[]);
    for(const image of result.images)assert.equal((await f.owner.get(image.previewUrl!)).statusCode,404);
    await grant(f,id);const b=new ApiClient(f.app);await b.enter('b-owner','org-b');
    for(const path of [`/api/customer/org-a/results/${result.id}`,`/api/customer/org-b/results/${result.id}`,`/api/customer/org-b/requests/${id}`,`/api/findings/${result.finding!.id}`,...result.images.flatMap(image=>[image.publishedVersion!.thumbnailUrl,image.publishedVersion!.previewUrl])]){const response=await b.get(path);assert.equal(response.statusCode,404,response.body);assert.ok(!response.body.includes(result.metadata.title));assert.ok(!response.body.includes('<svg'));}
    const direct=f.owner.envelope(await f.owner.state(id),{reason:'Forged customer staff action'},{resultId:result.id},{materialVersion:result.materialVersion,accessVersion:1});assert.equal((await f.owner.post('/api/commands/grantResultAccess',direct)).statusCode,403);
    const viewer=new ApiClient(f.app);await viewer.enter('a-viewer');assert.equal((await viewer.get(`/api/customer/org-a/results/${result.id}`)).statusCode,200,'Viewer may read entitled published material');
  }finally{await f.close();}
});

test('unpublished Recent descriptive correction invalidates its approval and full-pair finding review while published Baseline approval remains valid',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f);await preparedResult(f,id);
    let result=(await f.staff.state(id)).result!;let baseline=result.images[0]!;let recent=result.images[1]!;
    for(const image of [baseline,recent])await f.staff.action('approveImage',id,{reason:'Inspected this exact synthetic image and date context.',dateContextInspected:true,discrepancyAcknowledged:false},{resultId:result.id,assetId:image.id},{imageContentVersion:1});
    result=(await f.staff.state(id)).result!;baseline=result.images[0]!;await f.staff.action('publishImage',id,{reason:'Publish reviewed Baseline.',imageReviewId:baseline.approval!.id},{resultId:result.id,assetId:baseline.id},{imageContentVersion:1});
    await findingDraft(f,id);result=(await f.staff.state(id)).result!;await f.staff.action('reviewFinding',id,{checklist:{answersQuestion:true,correctPairRolesDatesVersions:true,matchesVisibleMaterial:true,rightsPermitUse:true,accurateDisclosures:true},discrepancyAcknowledged:false,limitationsExplainDateDiscrepancy:false,reason:''},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:1});
    result=(await f.staff.state(id)).result!;assert.equal(result.finding!.reviewValid,true);const oldBaselineReview=result.images[0]!.approval!.id;recent=result.images[1]!;
    const raw=f.staff.envelope(await f.staff.state(id),{metadata:{...recent.currentVersion!.metadata,provider:'Coruscant demonstration provider — descriptive correction'}},{resultId:result.id,assetId:recent.id},{imageContentVersion:1});
    const saved=await f.staff.post('/api/commands/saveImageMetadata',raw);assert.equal(saved.statusCode,200,saved.body);result=(await f.staff.state(id)).result!;
    assert.equal(result.images[1]!.currentVersion!.contentVersion,2);assert.equal(result.images[1]!.approval,null);assert.equal(result.finding!.review,null);assert.equal(result.finding!.reviewValid,false);assert.equal(result.images[0]!.approval!.id,oldBaselineReview);assert.equal(result.images[0]!.approvalValid,true);assert.equal(result.images[0]!.state,'PUBLISHED');assert.equal(result.images[1]!.currentVersion!.origin.illustrativeDate,'2026-10-14');
    const immutable=f.staff.envelope(await f.staff.state(id),{metadata:{...result.images[1]!.currentVersion!.metadata,illustrativeDate:'2026-10-15'}},{resultId:result.id,assetId:recent.id},{imageContentVersion:2});const denied=await f.staff.post('/api/commands/saveImageMetadata',immutable);assert.equal(denied.statusCode,422);assert.ok(denied.json().fieldErrors.illustrativeDate);
    assert.throws(()=>f.app.coruscant.db.prepare('UPDATE image_versions SET metadata_json=? WHERE asset_id=? AND content_version=1').run('{}',baseline.id),/immutable/);
    assert.throws(()=>f.app.coruscant.db.prepare('UPDATE result_sets SET metadata_json=? WHERE id=?').run('{}',result.id),/immutable/);
  }finally{await f.close();}
});

test('actual review is explicit, exact same-result citations are required, and finding publication waits for both cited images',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f);let result=await preparedResult(f,id);const image=result.images[0]!;
    assert.equal(count(f,'image_reviews'),0);assert.equal(count(f,'finding_reviews'),0);
    const incomplete=f.staff.envelope(await f.staff.state(id),{reason:'Inspected picture only',dateContextInspected:false,discrepancyAcknowledged:false},{resultId:result.id,assetId:image.id},{imageContentVersion:1});assert.equal((await f.staff.post('/api/command-reviews/approveImage',incomplete)).statusCode,422);assert.equal(count(f,'image_reviews'),0);
    const unpublished=f.staff.envelope(await f.staff.state(id),{reason:'Not approved',imageReviewId:randomUUID()},{resultId:result.id,assetId:image.id},{imageContentVersion:1});assert.equal((await f.staff.post('/api/command-reviews/publishImage',unpublished)).statusCode,409);
    const otherId=await scheduledRequest(f);const other=await preparedResult(f,otherId);const cross=f.staff.envelope(await f.staff.state(id),{finding:{answer:'A proposed finding.',limitations:'Synthetic material, no flood proof.',additionalSources:'',citations:[{assetId:result.images[0]!.id,contentVersion:1},{assetId:other.images[1]!.id,contentVersion:1}]}},{resultId:result.id});assert.equal((await f.staff.post('/api/commands/saveFindingDraft',cross)).statusCode,422);
    await findingDraft(f,id);result=(await f.staff.state(id)).result!;
    await f.staff.action('reviewFinding',id,{checklist:reviewChecks,discrepancyAcknowledged:false,limitationsExplainDateDiscrepancy:false,reason:''},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:1});
    result=(await f.staff.state(id)).result!;const publish=f.staff.envelope(await f.staff.state(id),{findingReviewId:result.finding!.review!.id},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:1});const blocked=await f.staff.post('/api/command-reviews/publishFinding',publish);assert.equal(blocked.statusCode,422);assert.ok(blocked.json().fieldErrors.citations);
    await f.staff.action('saveFindingDraft',id,{finding:{...result.finding!.currentVersion,answer:'A revised explicitly authored finding.'}},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:1});result=(await f.staff.state(id)).result!;assert.equal(result.finding!.currentVersion.contentVersion,2);assert.equal(result.finding!.review,null);assert.equal(result.finding!.reviewValid,false);assert.equal(count(f,'finding_reviews'),1,'old actual review remains in history');
  }finally{await f.close();}
});

test('different accepted and supplied dates require real acknowledgements and authored-limitations confirmation without changing dates or readiness',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f,'2026-10-06');let result=await preparedResult(f,id);assert.equal(result.dateComparison.status,'DIFFERENT');assert.equal(result.dateComparison.rows[0].requestedDate,'2026-10-06');assert.equal(result.dateComparison.rows[0].supplied!.illustrativeDate,'2026-10-07');
    const image=result.images[0]!;const raw=f.staff.envelope(await f.staff.state(id),{reason:'I inspected the actual date table.',dateContextInspected:true,discrepancyAcknowledged:false},{resultId:result.id,assetId:image.id},{imageContentVersion:1});const noAck=await f.staff.post('/api/command-reviews/approveImage',raw);assert.equal(noAck.statusCode,422);assert.ok(noAck.json().fieldErrors.discrepancyAcknowledged);
    await approveAndPublishImages(f,id);await findingDraft(f,id);result=(await f.staff.state(id)).result!;
    const limits=f.staff.envelope(await f.staff.state(id),{checklist:reviewChecks,discrepancyAcknowledged:true,limitationsExplainDateDiscrepancy:false,reason:'The actual supplied Baseline date is later than the accepted reference.'},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:1});const notExplained=await f.staff.post('/api/command-reviews/reviewFinding',limits);assert.equal(notExplained.statusCode,422);assert.ok(notExplained.json().fieldErrors.limitationsExplainDateDiscrepancy);
    const authored={...result.finding!.currentVersion,limitations:'Synthetic demonstration: requested Baseline 2026-10-06 differs from supplied illustrative Baseline 2026-10-07; Recent is 2026-10-14. No actual flood extent, cause, damage or calibrated area is established.'};
    await f.staff.action('saveFindingDraft',id,{finding:authored},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:1});await publishFinding(f,id);await grant(f,id);result=(await f.staff.state(id)).result!;
    assert.equal(result.finding!.review!.limitationsExplainDateDiscrepancy,true);assert.equal(result.finding!.review!.discrepancyAcknowledged,true);assert.equal(result.readiness.ready,false);assert.ok(result.readiness.blockers.includes('Delivery blocked: supplied comparison dates differ from the accepted reference dates.'));assert.equal(result.readiness.fileChecks,'AVAILABLE');
    const visible=(await f.owner.get(`/api/customer/org-a/results/${result.id}`)).json<CustomerResultProjection>();assert.equal(visible.dateComparison.status,'DIFFERENT');assert.equal(visible.images[0]!.origin.illustrativeDate,'2026-10-07');assert.equal(visible.acceptedContext.baselineReferenceDate,'2026-10-06');assert.equal((await f.owner.state(id)).status,'Scheduled');
    const delivery=f.staff.envelope(await f.staff.state(id),{note:'Retain this note while the exact date mismatch blocks delivery.'},{resultId:result.id},{materialVersion:result.materialVersion,accessVersion:result.access!.version,findingContentVersion:result.finding!.currentVersion.contentVersion});
    const deliveryReview=await f.staff.post('/api/command-reviews/recordDelivery',delivery);assert.equal(deliveryReview.statusCode,200,deliveryReview.body);
    const deliveryBlocked=await f.staff.post('/api/commands/recordDelivery',{...delivery,reviewToken:deliveryReview.json().reviewToken});assert.equal(deliveryBlocked.statusCode,409);assert.equal(deliveryBlocked.json().code,'DELIVERY_BLOCKED');assert.equal(count(f,'deliveries'),0);assert.equal(f.app.coruscant.db.prepare('SELECT command_id FROM action_receipts WHERE command_id=?').get(delivery.commandId),undefined);assert.equal((await f.owner.state(id)).status,'Scheduled');
  }finally{await f.close();}
});

test('missing exact bytes preserve entitled finding/citation metadata; withdrawal removes customer text and retains history',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f);await preparedResult(f,id);await approveAndPublishImages(f,id);await publishFinding(f,id);await grant(f,id);let result=(await f.staff.state(id)).result!;
    const initial=(await f.owner.get(`/api/customer/org-a/results/${result.id}`)).json<CustomerResultProjection>();const missing=files(f)[0]!;unlinkSync(join(f.config.materialRoot,missing.relative_path));
    const image=await f.owner.get(initial.images[0]!.previewUrl);assert.equal(image.statusCode,404);assert.equal(image.json().code,'MATERIAL_UNAVAILABLE');assert.ok(!image.body.includes(missing.relative_path));
    const still=await f.owner.get(`/api/customer/org-a/results/${result.id}`);assert.equal(still.statusCode,200);assert.equal(still.json().finding.answer,initial.finding!.answer);assert.equal(still.json().finding.citations[0].availability,'UNAVAILABLE');assert.equal(still.json().finding.citations[0].assetId,initial.finding!.citations[0]!.assetId);assert.equal(still.json().images[1].availability,'AVAILABLE');
    result=(await f.staff.state(id)).result!;assert.equal(result.readiness.ready,false);assert.equal(result.readiness.fileChecks,'UNAVAILABLE');
    f.app.coruscant.db.prepare('UPDATE result_entitlements SET active=0 WHERE result_id=?').run(result.id);assert.equal((await f.owner.get(`/api/customer/org-a/results/${result.id}`)).json().code,'UNAVAILABLE');assert.equal((await f.owner.get(initial.images[1]!.previewUrl)).json().code,'UNAVAILABLE');f.app.coruscant.db.prepare('UPDATE result_entitlements SET active=1 WHERE result_id=?').run(result.id);
    await f.staff.action('withdrawFinding',id,{reason:'Withdraw this illustrative conclusion for review.'},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:result.finding!.currentVersion.contentVersion});
    const withdrawn=await f.owner.get(`/api/customer/org-a/results/${result.id}`);assert.equal(withdrawn.statusCode,200);assert.equal(withdrawn.json().finding,null);assert.ok(!withdrawn.body.includes(initial.finding!.answer));result=(await f.staff.state(id)).result!;assert.equal(result.finding!.state,'WITHDRAWN');assert.equal(result.finding!.currentVersion.answer,initial.finding!.answer);assert.equal(result.history.at(-1)!.type,'withdrawFinding');assert.equal((await f.owner.state(id)).status,'Scheduled');
    assert.throws(()=>f.app.coruscant.db.prepare("UPDATE findings SET state='DRAFT' WHERE id=?").run(result.finding!.id),/cannot reopen/);
  }finally{await f.close();}
});

test('actual protected reads reauthorize after an awaited read, including when bytes already entered the server buffer',async()=>{
  for(const phase of ['before','after'] as const){
    let armed=false;let signal!:()=>void;let release!:()=>void;const paused=new Promise<void>(resolve=>{signal=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});let f!:ApiFixture;
    const pause=async()=>{if(armed){armed=false;assert.equal(f.app.coruscant.db.isTransaction,false,'a file wait must not hold a database transaction');signal();await gate;}};
    f=await apiFixture(phase==='before'?{beforeMaterialRead:pause}:{afterMaterialRead:pause});try{
      const id=await scheduledRequest(f);await preparedResult(f,id);await approveAndPublishImages(f,id);await publishFinding(f,id);await grant(f,id);const result=(await f.owner.get(`/api/customer/org-a/results/${(await f.staff.state(id)).result!.id}`)).json<CustomerResultProjection>();
      armed=true;const pending=f.owner.get(result.images[0]!.previewUrl);await paused;
      if(phase==='before')f.owner.takeContext(await f.owner.post('/api/demo/leave',{}));else f.app.coruscant.db.prepare('UPDATE result_entitlements SET active=0 WHERE result_id=?').run(result.id);
      release();const denied=await pending;assert.equal(denied.statusCode,phase==='before'?401:404,denied.body);assert.equal(denied.json().code,phase==='before'?'ACCESS_REQUIRED':'UNAVAILABLE');assert.ok(!denied.body.includes('<svg'));
    }finally{release();await f.close();}
  }
});

test('lost preparation response recovers its global receipt before missing-file validation and never invents a second pair',async()=>{
  let lose=true;const f=await apiFixture({afterWorkflowCommit:name=>{if(name==='prepareDemoPair'&&lose){lose=false;throw new Error('Test-only lost preparation response after commit');}}});try{
    const id=await scheduledRequest(f);const created=await f.staff.action('createResultSet',id);await f.staff.action('saveResultDraft',id,{result:resultInput()},{resultId:created.resultId!});
    const input=f.staff.envelope(await f.staff.state(id),{},{resultId:created.resultId!});const lost=await f.staff.post('/api/commands/prepareDemoPair',input);assert.equal(lost.statusCode,503);let result=(await f.staff.state(id)).result!;assert.equal(result.images.length,2);assert.equal(count(f,'image_reviews'),0);
    const missing=files(f)[0]!;const path=join(f.config.materialRoot,missing.relative_path);unlinkSync(path);const recovered=await f.staff.post('/api/commands/prepareDemoPair',input);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().outcome,'replayed');assert.equal(existsSync(path),false);assert.equal(count(f,'material_files'),2);assert.equal(count(f,'image_assets'),2);assert.equal(result.history.filter(item=>item.type==='prepareDemoPair').length,1);
    const changed=await f.staff.post('/api/commands/prepareDemoPair',{...input,payload:{changed:true}});assert.equal(changed.statusCode,409);f.app.coruscant.db.prepare("UPDATE actors SET active=0 WHERE id='staff-admin'").run();const denied=await f.staff.post('/api/commands/prepareDemoPair',input);assert.equal(denied.statusCode,401);assert.ok(!denied.body.includes(result.id));
  }finally{await f.close();}
});

test('concurrent identical preparations register one pair and no human review; unavailable source leaves no partial records',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f);const created=await f.staff.action('createResultSet',id);await f.staff.action('saveResultDraft',id,{result:resultInput()},{resultId:created.resultId!});const input=f.staff.envelope(await f.staff.state(id),{},{resultId:created.resultId!});
    const replies=await Promise.all([f.staff.post('/api/commands/prepareDemoPair',input),f.staff.post('/api/commands/prepareDemoPair',input)]);assert.ok(replies.every(item=>item.statusCode===200),replies.map(item=>item.body).join('\n'));assert.deepEqual(replies.map(item=>item.json().outcome).sort(),['replayed','saved']);assert.equal(count(f,'material_files'),2);assert.equal(count(f,'image_assets'),2);assert.equal(count(f,'image_reviews'),0);assert.equal(count(f,'finding_reviews'),0);
    const next=await scheduledRequest(f);const nextCreated=await f.staff.action('createResultSet',next);const current=await f.staff.state(next);const nextInput=f.staff.envelope(current,{},{resultId:nextCreated.resultId!});
    const source=f.app.coruscant.db.prepare("SELECT filename FROM demo_source_assets WHERE role='RECENT'").get() as {filename:string};const sourcePath=join(f.config.sourceRoot,source.filename);const backup=readFileSync(sourcePath);unlinkSync(sourcePath);
    const failed=await f.staff.post('/api/commands/prepareDemoPair',nextInput);assert.equal(failed.statusCode,404);assert.equal(failed.json().code,'MATERIAL_UNAVAILABLE');assert.equal((await f.staff.state(next)).result!.images.length,0);assert.equal((await f.staff.state(next)).result!.materialVersion,current.result!.materialVersion);assert.equal(count(f,'image_assets'),2);
    writeFileSync(sourcePath,backup,{mode:0o600});assert.equal((await f.staff.post('/api/commands/prepareDemoPair',nextInput)).statusCode,200);assert.equal((await f.staff.state(next)).result!.images.length,2);
  }finally{await f.close();}
});

test('current rights, membership and actor loss refuse reads; private symlink/tampered bytes are never a static bypass',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f);let result=await preparedResult(f,id);await f.staff.action('saveResultDraft',id,{result:{...resultInput(),rightsExpiresAt:'2026-10-21T13:00'}},{resultId:result.id});await approveAndPublishImages(f,id);await publishFinding(f,id);await grant(f,id);result=(await f.staff.state(id)).result!;
    const image=result.images[0]!.publishedVersion!;const record=files(f)[0]!;const path=join(f.config.materialRoot,record.relative_path);const original=readFileSync(path);writeFileSync(path,'<svg xmlns="http://www.w3.org/2000/svg">tampered bytes</svg>');assert.equal((await f.owner.get(image.previewUrl)).json().code,'MATERIAL_UNAVAILABLE');unlinkSync(path);const outside=join(f.dataRoot,'outside.svg');writeFileSync(outside,original);symlinkSync(outside,path);assert.equal((await f.owner.get(image.previewUrl)).json().code,'MATERIAL_UNAVAILABLE');unlinkSync(path);writeFileSync(path,original,{mode:0o600});
    for(const privatePath of [`/.local/coruscant/material/${record.relative_path}`,`/material/${record.relative_path}`,`/demo-source/estuary-baseline-v1.svg`]){const response=await f.owner.get(privatePath);assert.ok(!response.body.includes('<svg'));}
    f.app.coruscant.db.prepare("UPDATE memberships SET active=0 WHERE organization_id='org-a'").run();assert.equal((await f.owner.get(image.previewUrl)).json().code,'UNAVAILABLE');const noReader=(await f.staff.state(id)).result!;assert.equal(noReader.readiness.ready,false);assert.ok(noReader.readiness.blockers.some(blocker=>blocker.includes('active customer membership')));f.app.coruscant.db.prepare("UPDATE memberships SET active=1 WHERE organization_id='org-a'").run();
    f.advance(2*60*60*1000);const expired=await f.owner.get(`/api/customer/org-a/results/${result.id}`);assert.equal(expired.statusCode,404);assert.equal(expired.json().code,'UNAVAILABLE');assert.equal((await f.owner.get(image.previewUrl)).statusCode,404);assert.equal((await f.staff.state(id)).result!.images[0]!.approvalValid,true,'rights expiry does not rewrite historical actual review');
  }finally{await f.close();}
});
