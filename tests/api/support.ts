import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Context, RequestProjection } from '../../shared/contracts.js';
import type { WorkflowCommandName, WorkflowOutcome } from '../../shared/workflow.js';
import type { StaffMaterialRequestProjection, StaffResultProjection } from '../../shared/material.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { createEmptyQuoteDraft } from '../../shared/workflow.js';
import { createConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { migrate } from '../../server/db/migrate.js';
import { initialize } from '../../server/db/initialize.js';
import { buildApp } from '../../server/app.js';
import type { TestHooks } from '../../server/commands.js';

export const API_TEST_PORT=3103;
const direct=new Set(['startReview','saveQuoteDraft','createResultSet','saveResultDraft','prepareDemoPair','saveImageMetadata','saveFindingDraft','createObservation','updateObservation','deleteObservation']);
export class ApiClient{
  cookie='';context:Context|null=null;
  constructor(public app:FastifyInstance){}
  headers(){return {host:`127.0.0.1:${API_TEST_PORT}`,origin:`http://127.0.0.1:${API_TEST_PORT}`,'content-type':'application/json',...(this.cookie?{cookie:this.cookie}:{}),...(this.context?.csrfToken?{'x-coruscant-csrf':this.context.csrfToken}:{})};}
  get(path:string){return this.app.inject({method:'GET',url:path,headers:this.headers()});}
  post(path:string,payload:Record<string,unknown>){return this.app.inject({method:'POST',url:path,headers:this.headers(),payload:{contextGeneration:this.context?.contextGeneration,contextToken:this.context?.contextToken,...payload}});}
  takeContext(response:Awaited<ReturnType<ApiClient['get']>>){assert.equal(response.statusCode,200,response.body);const set=response.headers['set-cookie'];if(set)this.cookie=(Array.isArray(set)?set[0]!:set).split(';')[0]!;this.context=response.json<Context>();}
  async enter(persona='a-owner',org='org-a'){
    if(!this.context)this.takeContext(await this.app.inject({method:'POST',url:'/api/demo/bootstrap',headers:this.headers(),payload:{}}));
    if(persona==='staff-admin')this.takeContext(await this.post('/api/demo/staff/enter',{}));
    else{this.takeContext(await this.post('/api/demo/customer/enter',{personaId:persona}));if(org)this.takeContext(await this.post('/api/context/workspace',{organizationId:org}));}
  }
  async state(id:string):Promise<StaffMaterialRequestProjection>{const response=await this.get(this.context?.audience==='STAFF'?`/api/staff/requests/${id}`:`/api/customer/${this.context!.organization!.id}/requests/${id}`);assert.equal(response.statusCode,200,response.body);return response.json();}
  envelope(row:RequestProjection,payload:Record<string,unknown>={},target:Record<string,string>={},extra:Record<string,number>={}){
    const material=(row as StaffMaterialRequestProjection).result;
    return {commandId:randomUUID(),contextGeneration:this.context!.contextGeneration,contextToken:this.context!.contextToken,
      target:{requestId:row.id,...target},expected:{requestVersion:row.requestVersion,briefRevision:row.briefRevision,
        ...(target.resultId&&material?{materialVersion:material.materialVersion}:{}),...extra},payload};
  }
  async action(name:WorkflowCommandName,id:string,payload:Record<string,unknown>={},target:Record<string,string>={},extra:Record<string,number>={}){
    let input:Record<string,unknown>=this.envelope(await this.state(id),payload,target,extra);
    if(!direct.has(name)){const preview=await this.post(`/api/command-reviews/${name}`,input);assert.equal(preview.statusCode,200,preview.body);input={...input,reviewToken:preview.json().reviewToken};}
    const response=await this.post(`/api/commands/${name}`,input);assert.equal(response.statusCode,200,response.body);return response.json<WorkflowOutcome>();
  }
}
export async function apiFixture(hooks?:TestHooks){
  const dataRoot=mkdtempSync(join(tmpdir(),'coruscant-material-'));const config=createConfig({dataRoot,port:API_TEST_PORT});let now=new Date('2026-10-21T12:00:00.000Z');const clock=()=>new Date(now);
  const db=openDatabase(config);migrate(db);initialize(db,config,clock);db.close();let app=await buildApp({dataRoot,port:API_TEST_PORT,clock,testHooks:hooks});
  const owner=new ApiClient(app),staff=new ApiClient(app);await owner.enter();await staff.enter('staff-admin');
  return {dataRoot,config,clock,owner,staff,get app(){return app;},advance(ms:number){now=new Date(now.getTime()+ms);},
    async restart(){await app.close();app=await buildApp({dataRoot,port:API_TEST_PORT,clock,testHooks:hooks});owner.app=app;staff.app=app;},
    async close(){await app.close();rmSync(dataRoot,{recursive:true,force:true});}};
}
export type ApiFixture=Awaited<ReturnType<typeof apiFixture>>;
export async function scheduledRequest(f:ApiFixture,baseline='2026-10-07'){
  const area={latitude:52.6,longitude:-9.7,radiusKm:25,method:'coordinates' as const,generation:1};
  const brief={...createEmptyBrief(),purpose:'Compare the estuary before and after heavy rainfall.',sensor:'SAR',latitude:'52.6',longitude:'-9.7',areaChoice:area,areaConfirmation:areaSignature(area),baselineDate:baseline,recentDate:'2026-10-14',maxResolution:'10',
    timingToDiscuss:false,windowStart:'2026-10-23T08:00',windowEnd:'2026-10-25T18:00',contact:{name:'Demonstration contact',email:'material@coruscant.example',organization:'Demonstration researchers'},selectedEvidence:[{itemId:'demo-sar-03',evidenceVersion:'demo-evidence-v1'}],acknowledged:true};
  const raw={target:{organizationId:'org-a'},expected:{},payload:{brief}};const preview=await f.owner.post('/api/command-reviews/submitRequest',raw);assert.equal(preview.statusCode,200,preview.body);
  const submitted=await f.owner.post('/api/commands/submitRequest',{...raw,commandId:randomUUID(),reviewToken:preview.json().reviewToken});assert.equal(submitted.statusCode,201,submitted.body);const id=submitted.json().requestId as string;
  await f.staff.action('startReview',id);const quote={...createEmptyQuoteDraft(),priceType:'FIXED',amount:'2400.00',scope:'Demonstration SAR/Imagery comparison for the exact saved area, reference dates and resolved requested window. No real collection.',licence:'Synthetic demonstration use.',validUntil:'2026-10-22T18:00'};
  const draft=await f.staff.action('saveQuoteDraft',id,{quote});await f.staff.action('publishQuote',id,{replacesQuoteId:null},{quoteId:draft.quoteId!},{quoteContentVersion:draft.quoteContentVersion!});
  await f.owner.action('acceptQuote',id,{},{quoteId:draft.quoteId!},{quoteContentVersion:draft.quoteContentVersion!});
  await f.staff.action('recordInitialSchedule',id,{acceptedQuoteId:draft.quoteId!,schedule:{provider:'Coruscant demonstration provider',start:'2026-10-24T10:00',end:'2026-10-24T12:00',timezone:'UTC',trackedItemIds:[],notes:'Plan only; no operator agreement.'}});return id;
}
export function resultInput(){return {title:'Fictional estuary comparison',provider:'Coruscant demonstration material',targetLabel:'Confirmed request target; the pictures are a fictional illustration.',source:'Original Coruscant synthetic scene recipes',uncertainty:'Not radar observations; no georeference or measured change.',licence:'Original synthetic demonstration material.',rightsExpiresAt:'',permittedUse:'Local demonstration and testing; no scientific flood conclusion.',demonstration:true};}
export async function preparedResult(f:ApiFixture,id:string):Promise<StaffResultProjection>{
  const created=await f.staff.action('createResultSet',id);await f.staff.action('saveResultDraft',id,{result:resultInput()},{resultId:created.resultId!});await f.staff.action('prepareDemoPair',id,{},{resultId:created.resultId!});return (await f.staff.state(id)).result!;
}
export async function findingDraft(f:ApiFixture,id:string){const result=(await f.staff.state(id)).result!;return f.staff.action('saveFindingDraft',id,{finding:{answer:'In these illustrative images the recent view shows a larger dark region contiguous with the river. This does not establish actual flooding.',limitations:'Synthetic illustrations cannot establish flood extent, rainfall causation, road passability, damage or calibrated area. Requested and supplied dates are distinct labels.',additionalSources:'',citations:result.images.map(image=>({assetId:image.id,contentVersion:image.currentVersion!.contentVersion}))}},{resultId:result.id});}
export async function approveAndPublishImages(f:ApiFixture,id:string){
  for(const role of ['BASELINE','RECENT']){
    let result=(await f.staff.state(id)).result!;let image=result.images.find(image=>image.role===role)!;
    await f.staff.action('approveImage',id,{reason:'Inspected the actual synthetic image, metadata, rights and requested-versus-supplied date table.',dateContextInspected:true,discrepancyAcknowledged:result.dateComparison.status==='DIFFERENT'},{resultId:result.id,assetId:image.id},{imageContentVersion:image.currentVersion!.contentVersion});
    result=(await f.staff.state(id)).result!;image=result.images.find(image=>image.role===role)!;await f.staff.action('publishImage',id,{reason:'Publish this exact reviewed demonstration version.',imageReviewId:image.approval!.id},{resultId:result.id,assetId:image.id},{imageContentVersion:image.currentVersion!.contentVersion});
  }
}
export async function publishFinding(f:ApiFixture,id:string){
  let result=(await f.staff.state(id)).result!;if(!result.finding)await findingDraft(f,id);result=(await f.staff.state(id)).result!;
  await f.staff.action('reviewFinding',id,{checklist:{answersQuestion:true,correctPairRolesDatesVersions:true,matchesVisibleMaterial:true,rightsPermitUse:true,accurateDisclosures:true},discrepancyAcknowledged:result.dateComparison.status==='DIFFERENT',limitationsExplainDateDiscrepancy:result.dateComparison.status==='DIFFERENT',reason:result.dateComparison.status==='DIFFERENT'?'Inspected the actual requested and illustrative dates; the authored limitations explain their discrepancy.':''},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:result.finding!.currentVersion.contentVersion});
  result=(await f.staff.state(id)).result!;await f.staff.action('publishFinding',id,{findingReviewId:result.finding!.review!.id},{resultId:result.id,findingId:result.finding!.id},{findingContentVersion:result.finding!.currentVersion.contentVersion});
}
export async function grant(f:ApiFixture,id:string){const result=(await f.staff.state(id)).result!;return f.staff.action('grantResultAccess',id,{reason:'Grant the intended request organization access to this reviewed synthetic demonstration.'},{resultId:result.id},{accessVersion:result.access?.version??0});}
