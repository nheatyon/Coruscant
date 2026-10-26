import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import type { BriefInput } from '../../shared/contracts.js';
import type { AssessmentPage, AssessmentRecheckResult, PlanOption } from '../../shared/plan-contracts.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { canonicalJson, digest, normalizeSourceRow, parseSourceBytes } from '../../server/orbital/catalog.js';
import { captureCatalog, ingestSources } from '../../server/orbital/repository.js';
import { createPropagator } from '../../server/orbital/propagation.js';
import { solarElevationDeg } from '../../server/orbital/constraints.js';
import { createAssessmentService, type AssessmentOwner } from '../../server/orbital/assessment-service.js';
import { hash } from '../../server/security.js';
import { installTechnicalPlanning } from '../helpers/technical-planning.js';
import { ApiClient, apiFixture, type ApiFixture } from './support.js';

const centerAt='2026-10-21T13:00:00.000Z';
/** Original generated optical elements. Solve a sunrise longitude, then rotate
 * this synthetic orbit's node so its physical future subpoint meets that target.
 * This is a numerical boundary test, not provider data or actual taskability. */
async function optical(f:ApiFixture,sunAtCenter:number,changes:Partial<BriefInput>={},platform:'S2B'|'LANDSAT9'='S2B'){
  const row={NORAD_CAT_ID:platform==='LANDSAT9'?49260:42063,OBJECT_NAME:'Original optical recheck boundary double',OBJECT_ID:platform==='LANDSAT9'?'2021-088A':'2017-013A',EPOCH:'2026-10-21T11:00:00.000Z',MEAN_MOTION:14.5,ECCENTRICITY:.002,INCLINATION:67,RA_OF_ASC_NODE:32,ARG_OF_PERICENTER:55,MEAN_ANOMALY:80,BSTAR:.00003,MEAN_MOTION_DOT:.000001,MEAN_MOTION_DDOT:0};
  const first=normalizeSourceRow(row);assert.ok(first?.omm);const original=createPropagator(first.omm).at(centerAt);assert.ok(original.ok);
  const latitude=original.geodetic.latitude,later=new Date(Date.parse(centerAt)+15000).toISOString();let longitude:number|null=null;
  for(let degree=-180;degree<180;degree++){
    if((solarElevationDeg(centerAt,latitude,degree)!-sunAtCenter)*(solarElevationDeg(centerAt,latitude,degree+1)!-sunAtCenter)>0)continue;
    let left=degree,right=degree+1;for(let step=0;step<50;step++){const mid=(left+right)/2;if((solarElevationDeg(centerAt,latitude,left)!-sunAtCenter)*(solarElevationDeg(centerAt,latitude,mid)!-sunAtCenter)<=0)right=mid;else left=mid;}
    const candidate=(left+right)/2;if(solarElevationDeg(later,latitude,candidate)!>solarElevationDeg(centerAt,latitude,candidate)!){longitude=candidate;break;}
  }
  assert.notEqual(longitude,null);row.RA_OF_ASC_NODE=(row.RA_OF_ASC_NODE+longitude!-original.geodetic.longitude+720)%360;
  const normalized=normalizeSourceRow(row);assert.ok(normalized?.omm);const position=createPropagator(normalized.omm).at(centerAt);assert.ok(position.ok);
  const seed=(name=row.OBJECT_NAME)=>{const now=f.clock().toISOString();ingestSources(f.app.coruscant.db,(['sar','resource'] as const).map(group=>{const source=parseSourceBytes(group,Buffer.from(JSON.stringify(group==='resource'?[{...row,OBJECT_NAME:name}]:[])),now);return {source,rawFilename:`${source.responseHash}.json`};}),now);};seed();
  const catalog=captureCatalog(f.app.coruscant.db)!,area={latitude:position.geodetic.latitude,longitude:position.geodetic.longitude,radiusKm:25,method:'coordinates' as const,generation:1},purpose='Original isolated exact-instant recheck at a deliberately chosen optical test center.';
  const brief:BriefInput={...createEmptyBrief(),purpose,areaReviewedPurpose:purpose,areaSource:null,observationIntent:'single-observation',sensor:'VISIBLE',latitude:String(area.latitude),longitude:String(area.longitude),radiusKm:'25',areaChoice:area,areaConfirmation:areaSignature(area),timingToDiscuss:false,windowStart:'2026-10-21T12:02',windowEnd:'2026-10-21T14:00',catalogContext:{sourceKind:'PUBLIC_REAL',snapshotVersion:catalog.snapshotVersion,factVersion:catalog.factVersion},...changes};
  let response=await f.owner.post('/api/orbital-assessments',{generation:1,brief});assert.equal(response.statusCode,200,response.body);let page=response.json<AssessmentPage>();
  for(let attempt=0;['QUEUED','RUNNING'].includes(page.state)&&attempt<500;attempt++){await yieldLoop();response=await f.owner.post('/api/orbital-assessments/status',{...page.handle});assert.equal(response.statusCode,200,response.body);page=response.json<AssessmentPage>();}
  assert.equal(page.state,'COMPLETE',JSON.stringify(page));const option=page.options.find(value=>value.los.startUtc<=centerAt&&value.los.endUtc>=centerAt);assert.ok(option,JSON.stringify(page));
  return {brief,page,option,seed};
}
function request(page:AssessmentPage,option:PlanOption,at:string){return {...page.handle,optionId:option.id,proposedAtUtc:at};}
function tableCounts(f:ApiFixture){const db=f.app.coruscant.db;return ['service_requests','brief_revisions','request_events','action_receipts','proposed_plan_versions','orbital_assessment_attachments','command_reviews'].map(table=>[table,db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n]);}
async function review(f:ApiFixture,value:Awaited<ReturnType<typeof optical>>,option:PlanOption,at:string,acknowledgedUnknownIds=option.unknowns.map(item=>item.id)){
  const selection={handle:value.page.handle,attachmentReference:value.page.attachmentReference!,optionId:option.id,proposedAtUtc:at,acknowledgedUnknownIds,assumptions:[]};
  const input={target:{organizationId:'org-a'},expected:{},payload:{brief:value.brief,selection}};return {input,response:await f.owner.post('/api/command-reviews/saveProposedPlan',input)};
}

test('edited illumination uncertainty becomes PASS without obsolete acknowledgements; readonly preview and final save use identical checks',async()=>{
  const f=await apiFixture();try{
    const value=await optical(f,.08),at='2026-10-21T13:00:15.000Z';assert.equal(value.option.checks.find(item=>item.id==='illumination')!.state,'BOUNDARY_UNCERTAIN');assert.deepEqual(value.option.unknowns.map(item=>item.id),['illumination']);
    const viewResponse=await f.owner.post('/api/orbital-assessments/status',{...value.page.handle,optionId:value.option.id});assert.equal(viewResponse.statusCode,200,viewResponse.body);const originalView=viewResponse.json<AssessmentPage>().selectedView!;assert.ok(originalView);
    const before=tableCounts(f),manifest=f.app.coruscant.db.prepare('SELECT manifest_digest,manifest_filename,manifest_bytes,summary_json FROM orbital_assessments WHERE id=?').get(value.page.handle.assessmentId);
    const response=await f.owner.post('/api/orbital-assessments/recheck',request(value.page,value.option,at));assert.equal(response.statusCode,200,response.body);const checked=response.json<AssessmentRecheckResult>();
    assert.deepEqual(checked.handle,value.page.handle);assert.equal(checked.option.id,value.option.id);assert.equal(checked.option.proposedAtUtc,at);assert.equal(checked.option.checks.find(item=>item.id==='illumination')!.state,'PASS');assert.deepEqual(checked.option.unknowns,[]);assert.equal(checked.option.outcome,'READY');
    assert.ok(checked.selectedView);assert.equal(checked.selectedView.atUtc,at);assert.equal(checked.selectedView.optionId,value.option.id);assert.equal(checked.selectedView.itemId,value.option.itemId);assert.equal(JSON.stringify(checked.selectedView.arc),JSON.stringify(originalView.arc));
    assert.deepEqual(tableCounts(f),before);assert.deepEqual(f.app.coruscant.db.prepare('SELECT manifest_digest,manifest_filename,manifest_bytes,summary_json FROM orbital_assessments WHERE id=?').get(value.page.handle.assessmentId),manifest);
    const unchanged=await f.owner.post('/api/orbital-assessments/status',{...value.page.handle});assert.equal(unchanged.statusCode,200);assert.deepEqual(unchanged.json<AssessmentPage>().options.find(item=>item.id===value.option.id),value.option);
    const oldView=await f.owner.post('/api/orbital-assessments/status',{...value.page.handle,optionId:value.option.id});assert.equal(oldView.statusCode,200,oldView.body);assert.deepEqual(oldView.json<AssessmentPage>().selectedView,originalView);
    const old=await review(f,value,checked.option,at,['illumination']);assert.equal(old.response.statusCode,422,old.response.body);assert.equal(old.response.json().code,'PLAN_ACKNOWLEDGEMENT_REQUIRED');
    const fresh=await review(f,value,checked.option,at);assert.equal(fresh.response.statusCode,200,fresh.response.body);assert.deepEqual(fresh.response.json().proposedPlan.option,checked.option);
    const saved=await f.owner.post('/api/commands/saveProposedPlan',{...fresh.input,commandId:randomUUID(),reviewToken:fresh.response.json().reviewToken});assert.equal(saved.statusCode,201,saved.body);assert.deepEqual((await f.owner.state(saved.json().requestId)).currentProposedPlan!.option,checked.option);
  }finally{await f.close();}
});
test('edited dynamic FAIL becomes uncertainty and requires its newly displayed named acknowledgement',async()=>{
  const f=await apiFixture();try{
    const value=await optical(f,-.11),at='2026-10-21T13:00:05.000Z';assert.equal(value.option.outcome,'INELIGIBLE');assert.deepEqual(value.option.unknowns,[]);
    const response=await f.owner.post('/api/orbital-assessments/recheck',request(value.page,value.option,at));assert.equal(response.statusCode,200,response.body);const checked=response.json<AssessmentRecheckResult>().option;
    assert.equal(checked.outcome,'PROVISIONAL');assert.equal(checked.checks.find(item=>item.id==='illumination')!.state,'BOUNDARY_UNCERTAIN');assert.deepEqual(checked.unknowns.map(item=>item.id),['illumination']);
    const missing=await review(f,value,checked,at,[]);assert.equal(missing.response.statusCode,422,missing.response.body);assert.equal(missing.response.json().code,'PLAN_ACKNOWLEDGEMENT_REQUIRED');
    const fresh=await review(f,value,checked,at);assert.equal(fresh.response.statusCode,200,fresh.response.body);assert.deepEqual(fresh.response.json().proposedPlan.option,checked);assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM service_requests').get()!.n,0);
  }finally{await f.close();}
});
test('edited PASS to FAIL remains inspectable but unsaveable, and fixed band incompatibility never clears with a new time',async()=>{
  for(const fixed of [false,true]){
    const f=await apiFixture();try{
      const value=await optical(f,.12,fixed?{spectralRequirements:'bands B11'}:{}),at=fixed?'2026-10-21T13:00:05.000Z':'2026-10-21T12:59:00.000Z';
      if(!fixed)assert.equal(value.option.outcome,'READY');else assert.equal(value.option.checks.find(item=>item.id==='spectral')!.state,'FAIL');
      const response=await f.owner.post('/api/orbital-assessments/recheck',request(value.page,value.option,at));assert.equal(response.statusCode,200,response.body);const checked=response.json<AssessmentRecheckResult>().option;assert.equal(checked.outcome,'INELIGIBLE');
      if(fixed)assert.equal(checked.checks.find(item=>item.id==='spectral')!.state,'FAIL');else assert.equal(checked.checks.find(item=>item.id==='corridor')!.state,'FAIL');
      const rejected=await review(f,value,checked,at);assert.equal(rejected.response.statusCode,422,rejected.response.body);assert.equal(rejected.response.json().code,'PLAN_KNOWN_MISMATCH');assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM action_receipts').get()!.n,0);
    }finally{await f.close();}
  }
});
test('recheck refuses foreign/altered/stale handles, context and source changes, and times outside the exact opportunity/window',async()=>{
  const f=await apiFixture();try{
    const value=await optical(f,.08),valid=request(value.page,value.option,'2026-10-21T13:00:15.000Z'),before=tableCounts(f);
    for(const [at,code] of [['2026-10-21T12:01:00.000Z','PLAN_TIME_OUTSIDE_WINDOW'],['2026-10-21T12:30:00.000Z','PLAN_TIME_OTHER_OPPORTUNITY']] as const){const result=await f.owner.post('/api/orbital-assessments/recheck',{...valid,proposedAtUtc:at});assert.equal(result.statusCode,422,result.body);assert.equal(result.json().code,code);}
    assert.equal((await f.owner.post('/api/orbital-assessments/recheck',{...valid,readCapability:value.page.handle.readCapability+'x'})).statusCode,404);
    assert.equal((await f.owner.post('/api/orbital-assessments/recheck',{...valid,optionId:'foreign-option'})).statusCode,409);
    assert.equal((await f.owner.post('/api/orbital-assessments/recheck',{...valid,contextGeneration:f.owner.context!.contextGeneration+1})).statusCode,409);
    assert.equal((await f.staff.post('/api/orbital-assessments/recheck',valid)).statusCode,403);
    const other=new ApiClient(f.app);await other.enter('b-owner','org-b');const denied=await other.post('/api/orbital-assessments/recheck',valid);assert.equal(denied.statusCode,404);assert.ok(!denied.body.includes(value.option.name));
    value.seed('Original changed-source numerical double');const changed=await f.owner.post('/api/orbital-assessments/recheck',valid);assert.equal(changed.statusCode,409,changed.body);assert.equal(changed.json().code,'CATALOG_VERSION_CHANGED');assert.deepEqual(tableCounts(f),before);
  }finally{await f.close();}
});
test('expired readonly recheck cannot grant fresh selection and revoking current authority reveals no checked option',async()=>{
  const f=await apiFixture();try{
    const value=await optical(f,.08),input=request(value.page,value.option,'2026-10-21T13:00:15.000Z'),before=tableCounts(f);f.advance(16*60000);
    const expired=await f.owner.post('/api/orbital-assessments/recheck',input);assert.equal(expired.statusCode,409,expired.body);assert.equal(expired.json().code,'ASSESSMENT_EXPIRED');
    f.app.coruscant.db.prepare("UPDATE memberships SET active=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();const denied=await f.owner.post('/api/orbital-assessments/recheck',input);assert.equal(denied.statusCode,404);assert.ok(!denied.body.includes(value.option.name));assert.deepEqual(tableCounts(f),before);
  }finally{await f.close();}
});
test('recheck repeats current organization authority after awaited manifest IO before releasing an option',async()=>{
  const f=await apiFixture();let service:ReturnType<typeof createAssessmentService>|undefined;
  try{
    const value=await optical(f,.08),before=tableCounts(f),context=f.owner.context!;
    service=createAssessmentService({db:f.app.coruscant.db,config:f.config,clock:f.clock});
    const owner:AssessmentOwner={sessionHash:hash(f.owner.cookie.slice(f.owner.cookie.indexOf('=')+1)),contextGeneration:context.contextGeneration,audience:'CUSTOMER',actorId:context.actor!.id,organizationId:context.organization!.id,requestId:null};
    // The async method reaches its first filesystem await after its initial
    // authority gate. Revoke before that IO continuation can release any facts.
    const pending=service.recheck(owner,request(value.page,value.option,'2026-10-21T13:00:15.000Z'));
    f.app.coruscant.db.prepare("UPDATE memberships SET active=0 WHERE actor_id='a-owner' AND organization_id='org-a'").run();
    await assert.rejects(pending,error=>(error as {code?:string}).code==='UNAVAILABLE');
    assert.deepEqual(tableCounts(f),before);
  }finally{service?.close();await f.close();}
});
test('status paging/view input never leaks into the exact reusable handle and its returned handle works with strict recheck',async()=>{
  const f=await apiFixture();try{
    const value=await optical(f,.08),before=tableCounts(f),keys=['assessmentId','generation','readCapability'];
    for(const kind of ['OPTIONS','OUTCOMES'] as const){
      // Offset zero is a valid first-page cursor. It explicitly exercises the
      // cursor field even for this deliberately small numerical population.
      const cursorFields={i:value.page.handle.assessmentId,d:value.page.inputDigest.slice(0,16),k:kind==='OPTIONS'?'P':'R',o:0};
      const cursor=`${Buffer.from(JSON.stringify(cursorFields)).toString('base64url')}.${digest(canonicalJson(cursorFields)).slice(0,32)}`;
      const response=await f.owner.post('/api/orbital-assessments/status',{...value.page.handle,kind,cursor,optionId:value.option.id});assert.equal(response.statusCode,200,response.body);
      const page=response.json<AssessmentPage>();assert.deepEqual(Object.keys(page.handle).sort(),keys);assert.deepEqual(page.handle,value.page.handle);assert.equal(page.selectedView!.optionId,value.option.id);
      const rechecked=await f.owner.post('/api/orbital-assessments/recheck',{...page.handle,optionId:value.option.id,proposedAtUtc:'2026-10-21T13:00:15.000Z'});assert.equal(rechecked.statusCode,200,rechecked.body);assert.deepEqual(Object.keys(rechecked.json<AssessmentRecheckResult>().handle).sort(),keys);
    }
    assert.deepEqual(tableCounts(f),before);
  }finally{await f.close();}
});
test('actual Thermal night policy remains unknown with or without night wording, including fresh edited checks',async()=>{
  for(const purpose of ['Thermal infrared imagery','Night thermal infrared imagery']){
    const f=await apiFixture();try{
      const value=await optical(f,-5,{purpose,areaReviewedPurpose:purpose,sensor:'THERMAL'},'LANDSAT9');
      assert.equal(value.option.measurement,'emitted-thermal');assert.equal(value.option.outcome,'PROVISIONAL');
      const illumination=value.option.checks.find(check=>check.id==='illumination')!,policy=value.option.checks.find(check=>check.id==='night-policy')!;
      assert.equal(illumination.state,'NOT_APPLICABLE');assert.equal(illumination.applicability,'NOT_APPLICABLE');assert.ok(Number(illumination.actualValue)<-.1);assert.equal(policy.state,'UNKNOWN');assert.equal(policy.applicability,'REQUIRED');assert.ok(value.option.unknowns.some(item=>item.id==='night-policy'));
      if(purpose.startsWith('Night'))assert.equal(value.option.checks.find(check=>check.id==='night')!.state,'PASS');
      const at='2026-10-21T13:00:05.000Z',response=await f.owner.post('/api/orbital-assessments/recheck',request(value.page,value.option,at));assert.equal(response.statusCode,200,response.body);const checked=response.json<AssessmentRecheckResult>().option;
      assert.equal(checked.checks.find(check=>check.id==='night-policy')!.state,'UNKNOWN');assert.equal(checked.checks.find(check=>check.id==='illumination')!.state,'NOT_APPLICABLE');assert.equal(checked.outcome,'PROVISIONAL');
      const missing=await review(f,value,checked,at,checked.unknowns.filter(item=>item.id!=='night-policy').map(item=>item.id));assert.equal(missing.response.statusCode,422,missing.response.body);assert.equal(missing.response.json().code,'PLAN_ACKNOWLEDGEMENT_REQUIRED');
      const complete=await review(f,value,checked,at);assert.equal(complete.response.statusCode,200,complete.response.body);assert.deepEqual(complete.response.json().proposedPlan.option,checked);
    }finally{await f.close();}
  }
});
test('daylight Thermal has no night policy fiction and reflected-light mission thresholds stay mode-specific',async()=>{
  const f=await apiFixture();try{
    const thermal=await optical(f,20,{sensor:'THERMAL'},'LANDSAT9');assert.equal(thermal.option.checks.find(check=>check.id==='illumination')!.state,'NOT_APPLICABLE');assert.ok(Number(thermal.option.checks.find(check=>check.id==='illumination')!.actualValue)>19);assert.equal(thermal.option.checks.some(check=>check.id==='night-policy'),false);assert.equal(thermal.option.outcome,'READY');
    const uncertain=await optical(f,.05,{sensor:'THERMAL'},'LANDSAT9');assert.equal(uncertain.option.checks.find(check=>check.id==='illumination')!.state,'NOT_APPLICABLE');assert.equal(uncertain.option.checks.find(check=>check.id==='night-policy')!.state,'UNKNOWN');assert.ok(Math.abs(Number(uncertain.option.checks.find(check=>check.id==='night-policy')!.actualValue))<.1);
    const msi=await optical(f,2);assert.equal(msi.option.checks.find(check=>check.id==='illumination')!.requiredValue,0);assert.equal(msi.option.checks.find(check=>check.id==='illumination')!.state,'PASS');
    const oli=await optical(f,2,{},'LANDSAT9');assert.equal(oli.option.checks.find(check=>check.id==='illumination')!.requiredValue,5);assert.equal(oli.option.checks.find(check=>check.id==='illumination')!.state,'FAIL');assert.equal(oli.option.outcome,'INELIGIBLE');
  }finally{await f.close();}
});
test('partial LOS interval acknowledgement survives edited recheck, final preparation, atomic save, replay and historical read',async()=>{
  const f=await apiFixture();let calculation:ReturnType<typeof createAssessmentService>|undefined;
  try{
    const fixture=installTechnicalPlanning(f.app.coruscant.db,f.clock().toISOString()),failureAt=new Date(Date.parse(fixture.instant)+60000).toISOString(),context=f.owner.context!;
    const owner:AssessmentOwner={sessionHash:hash(f.owner.cookie.slice(f.owner.cookie.indexOf('=')+1)),contextGeneration:context.contextGeneration,audience:'CUSTOMER',actorId:context.actor!.id,organizationId:context.organization!.id,requestId:null};
    calculation=createAssessmentService({db:f.app.coruscant.db,config:f.config,clock:f.clock,calculationHooks:{propagator:omm=>{
      const actual=createPropagator(omm);return {...actual,at(utc){return utc===failureAt?{ok:false,at:utc,reason:'Original isolated unavailable interior propagation sample.'}:actual.at(utc);}};
    }}});
    const started=await calculation.start(owner,{generation:1,brief:fixture.brief});let page=started;
    for(let attempt=0;['QUEUED','RUNNING'].includes(page.state)&&attempt<500;attempt++){await yieldLoop();page=await calculation.status(owner,started.handle);}
    assert.equal(page.state,'INCOMPLETE',JSON.stringify(page));const option=page.options.find(value=>value.coverage==='PARTIAL');assert.ok(option,JSON.stringify(page));assert.equal(option.checks.find(check=>check.id==='interval-incomplete')!.state,'UNKNOWN');assert.ok(option.unknowns.some(item=>item.id==='interval-incomplete'));assert.ok(page.attachmentReference);
    const immutable=f.app.coruscant.db.prepare('SELECT manifest_digest,manifest_bytes,manifest_filename FROM orbital_assessments WHERE id=?').get(page.handle.assessmentId),at=option.los.peakUtc;
    const response=await f.owner.post('/api/orbital-assessments/recheck',request(page,option,at));assert.equal(response.statusCode,200,response.body);const checked=response.json<AssessmentRecheckResult>().option;
    const interval=checked.checks.find(check=>check.id==='interval-incomplete')!;assert.equal(interval.applicability,'REQUIRED');assert.equal(interval.state,'UNKNOWN');assert.equal(checked.coverage,'PARTIAL');assert.equal(checked.outcome,'PROVISIONAL');assert.ok(checked.unknowns.some(item=>item.id==='interval-incomplete'));
    const selection={handle:page.handle,attachmentReference:page.attachmentReference,optionId:option.id,proposedAtUtc:at,acknowledgedUnknownIds:checked.unknowns.filter(item=>item.id!=='interval-incomplete').map(item=>item.id),assumptions:[]};
    const raw={target:{organizationId:'org-a'},expected:{},payload:{brief:fixture.brief,selection}},denied=await f.owner.post('/api/command-reviews/saveProposedPlan',raw);assert.equal(denied.statusCode,422,denied.body);assert.equal(denied.json().code,'PLAN_ACKNOWLEDGEMENT_REQUIRED');assert.equal(f.app.coruscant.db.prepare('SELECT count(*) n FROM service_requests').get()!.n,0);
    raw.payload.selection.acknowledgedUnknownIds=checked.unknowns.map(item=>item.id);const preview=await f.owner.post('/api/command-reviews/saveProposedPlan',raw);assert.equal(preview.statusCode,200,preview.body);assert.deepEqual(preview.json().proposedPlan.option,checked);
    const command={...raw,commandId:randomUUID(),reviewToken:preview.json().reviewToken},saved=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(saved.statusCode,201,saved.body);const id=saved.json().requestId as string,before=await f.owner.state(id),plan=before.currentProposedPlan!;
    assert.equal(plan.option.coverage,'PARTIAL');assert.deepEqual(plan.option,checked);assert.ok(plan.acknowledgedUnknownIds.includes('interval-incomplete'));assert.equal(before.status,'Planning');
    calculation.close();calculation=undefined;await f.restart();f.advance(16*60000);const replay=await f.owner.post('/api/commands/saveProposedPlan',command);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().outcome,'replayed');assert.deepEqual((await f.owner.state(id)).currentProposedPlan,plan);
    const history=await f.owner.post(`/api/customer/org-a/requests/${id}/plan-evidence`,{planId:plan.id});assert.equal(history.statusCode,200,history.body);const historical=history.json<AssessmentPage>().options.find(value=>value.id===option.id)!;assert.equal(historical.coverage,'PARTIAL');assert.ok(historical.unknowns.some(item=>item.id==='interval-incomplete'));
    assert.deepEqual(f.app.coruscant.db.prepare('SELECT manifest_digest,manifest_bytes,manifest_filename FROM orbital_assessments WHERE id=?').get(page.handle.assessmentId),immutable);
    for(const table of ['service_requests','brief_revisions','proposed_plan_versions','orbital_assessment_attachments','request_events','action_receipts'])assert.equal(f.app.coruscant.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,1,table);
  }finally{calculation?.close();await f.close();}
});
