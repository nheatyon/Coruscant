import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createSocket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { initialize } from '../../server/db/initialize.js';
import { migrate } from '../../server/db/migrate.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { planningToInput } from '../../shared/workflow.js';
import { extractPlacePhrase } from '../../shared/place-phrase.js';
import type { Context, RequestProjection, SubmissionOutcome } from '../../shared/contracts.js';
import type { PlaceLookupResult, PlaceSourceReference } from '../../shared/place-contracts.js';
import type { WorkflowOutcome } from '../../shared/workflow.js';

async function unusedPort():Promise<number> {
  const socket=createSocket();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const address=socket.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));
  assert.ok(port!==3000&&port!==3100,'This isolated test cannot use a recording/browser-test listener.');return port;
}
async function stop(child:ChildProcess):Promise<void> {
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=once(child,'exit');child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const [code,signal]=await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Planning child did not stop gracefully.'));},5000);})]);
    assert.equal(code,0,'The application must close its own DB and exit normally.');assert.equal(signal,null);
  }finally{if(timer)clearTimeout(timer);}
}
class HttpClient {
  cookie='';context:Context|null=null;
  constructor(readonly origin:string){}
  async post(path:string,payload:Record<string,unknown>,bootstrap=false) {
    return fetch(this.origin+path,{method:'POST',redirect:'error',headers:{origin:this.origin,'content-type':'application/json',...(this.cookie?{cookie:this.cookie}:{}),...(this.context?.csrfToken?{'x-coruscant-csrf':this.context.csrfToken}:{})},
      body:JSON.stringify(bootstrap?payload:{contextGeneration:this.context?.contextGeneration,contextToken:this.context?.contextToken,...payload}),signal:AbortSignal.timeout(4000)});
  }
  get(path:string){return fetch(this.origin+path,{headers:{...(this.cookie?{cookie:this.cookie}:{})},redirect:'error',signal:AbortSignal.timeout(4000)});}
  async enter(staff=false){
    const routes:[string,Record<string,unknown>,boolean][]=[['/api/demo/bootstrap',{},true],staff?['/api/demo/staff/enter',{},false]:['/api/demo/customer/enter',{personaId:'a-owner'},false],...(!staff?[[ '/api/context/workspace',{organizationId:'org-a'},false] as [string,Record<string,unknown>,boolean]]:[])];
    for(const [path,payload,bootstrap]of routes){const response=await this.post(path,payload,bootstrap);assert.equal(response.status,200,await response.clone().text());const cookie=response.headers.get('set-cookie');if(cookie)this.cookie=cookie.split(';')[0]!;this.context=await response.json() as Context;}
  }
  async request(id:string,staff=false):Promise<RequestProjection>{const response=await this.get(staff?`/api/staff/requests/${id}`:`/api/customer/org-a/requests/${id}`);assert.equal(response.status,200,await response.clone().text());return await response.json() as RequestProjection;}
}

test('sourced Single Planning and explicit same-ID submission survive two graceful OS restarts with exact receipts and lineage',{timeout:30_000},async()=>{
  const port=await unusedPort(),dataRoot=mkdtempSync(join(tmpdir(),'coruscant-planning-process-')),otherCwd=mkdtempSync(join(tmpdir(),'coruscant-planning-other-cwd-'));
  const config=createConfig({dataRoot,port}),serverEntry=fileURLToPath(new URL('../../server/index.js',import.meta.url));
  const db=openDatabase(config);migrate(db);initialize(db,config,()=>new Date('2026-10-25T12:00:00.000Z'));db.close();
  let providerCalls=0,child:ChildProcess|undefined,stderr='';
  const provider=createHttpServer((request,response)=>{
    providerCalls++;const url=new URL(request.url??'/',`http://${request.headers.host}`);
    assert.equal(url.pathname,'/search');assert.deepEqual(Object.fromEntries(url.searchParams),{format:'jsonv2',q:'Dovetail Inlet',limit:'5',addressdetails:'1','accept-language':'en'});
    assert.equal(request.headers.cookie,undefined);assert.equal(request.headers.authorization,undefined);assert.match(request.headers['user-agent']??'',/Coruscant/);
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify([{display_name:'Generated Dovetail Inlet — isolated response double',lat:'14.72',lon:'-17.46',osm_type:'relation',osm_id:'1234567890',type:'bay',address:{region:'Generated test region'}}]));
  });
  try {
    provider.listen(0,'127.0.0.1');await once(provider,'listening');const address=provider.address();assert.ok(address&&typeof address!=='string');assert.ok(address.port!==3000&&address.port!==3100);
    const providerUrl=`http://127.0.0.1:${address.port}/search`;
    async function start(cwd:string){
      stderr='';child=spawn(process.execPath,[serverEntry],{cwd,env:{...process.env,CORUSCANT_MODE:'test',CORUSCANT_TEST_DATA_ROOT:dataRoot,CORUSCANT_PORT:String(port),PORT:String(port),CORUSCANT_PLACE_PROVIDER_URL:providerUrl,CORUSCANT_PLACE_USER_AGENT:'CoruscantPlanningProcessTest/1.0 (isolated generated provider)'},stdio:['ignore','pipe','pipe']});
      child.stdout?.on('data',()=>{});child.stderr?.on('data',part=>{stderr=(stderr+String(part)).slice(-8000);});let startup:Error|undefined;child.once('error',error=>{startup=error;});
      for(let i=0;i<100;i++){if(startup)throw startup;if(child.exitCode!==null)throw new Error(`Planning process exited during startup: ${stderr}`);try{const response=await fetch(config.origin+'/api/context',{signal:AbortSignal.timeout(300)});if(response.ok)return;}catch{}await pause(30);}
      throw new Error(`Planning process did not become ready: ${stderr}`);
    }
    await start(dirname(serverEntry));const owner=new HttpClient(config.origin);await owner.enter();const originalContext=structuredClone(owner.context!),originalCookie=owner.cookie;
    const lookupResponse=await owner.post('/api/place-lookups',{query:'Dovetail Inlet',generation:1});assert.equal(lookupResponse.status,200,await lookupResponse.clone().text());const lookup=await lookupResponse.json() as PlaceLookupResult;assert.equal(providerCalls,1);
    const purpose='Plan Visible imagery over Dovetail Inlet with 10 m resolution.',phrase=extractPlacePhrase(purpose),candidate=lookup.candidates[0]!;assert.equal(phrase.phrase,'Dovetail Inlet');
    const area={latitude:candidate.latitude,longitude:candidate.longitude,radiusKm:25,method:'coordinates' as const,generation:1};
    const source:PlaceSourceReference={lookupVersion:lookup.version,candidateId:candidate.id,sourcePhrase:phrase.phrase,phraseOrigin:'stated',phraseSpan:phrase.span,questionAtLookup:purpose,reviewedPurpose:purpose,radiusAssumptionKm:25};
    const brief={...createEmptyBrief(),observationIntent:'single-observation' as const,purpose,areaReviewedPurpose:purpose,sensor:'Visible',latitude:String(area.latitude),longitude:String(area.longitude),areaChoice:area,areaConfirmation:areaSignature(area),areaSource:source,maxResolution:'10',unknowns:'Pointing and provider availability remain unknown.'};
    const draft={target:{organizationId:'org-a'},expected:{},payload:{brief}},review=await owner.post('/api/command-reviews/savePlanningRequest',draft);assert.equal(review.status,200,await review.clone().text());
    const saveCommand={...draft,commandId:randomUUID(),reviewToken:(await review.json() as {reviewToken:string}).reviewToken};
    const saveResponse=await owner.post('/api/commands/savePlanningRequest',saveCommand);assert.equal(saveResponse.status,201,await saveResponse.clone().text());const saved=await saveResponse.json() as SubmissionOutcome;
    const planning=await owner.request(saved.requestId);assert.equal(planning.status,'Planning');assert.equal(planning.submittedAt,null);assert.equal(planning.originalSubmittedContact,null);assert.equal(planning.brief.baselineDate,'');assert.equal(planning.brief.recentDate,'');assert.equal(planning.currentQuote,null);assert.equal(planning.schedule,null);assert.equal(planning.history.length,1);assert.deepEqual(planning.brief.unknowns,['Pointing and provider availability remain unknown.']);assert.equal(planning.brief.areaSource!.lookupVersion,lookup.version);
    const firstPid=child!.pid;await stop(child!);child=undefined;await start(otherCwd);assert.notEqual(child!.pid,firstPid);
    const contextResponse=await owner.get('/api/context');assert.equal(contextResponse.status,200);const restored=await contextResponse.json() as Context;assert.equal(restored.actor?.id,originalContext.actor?.id);assert.equal(restored.organization?.id,'org-a');assert.equal(restored.contextToken,originalContext.contextToken);assert.equal(restored.contextGeneration,originalContext.contextGeneration);assert.equal(owner.cookie,originalCookie);
    const recovered=await owner.post('/api/commands/savePlanningRequest',saveCommand);assert.equal(recovered.status,200,await recovered.clone().text());const receipt=await recovered.json() as SubmissionOutcome;assert.equal(receipt.outcome,'replayed');assert.equal(receipt.requestId,saved.requestId);assert.equal(receipt.reference,saved.reference);
    const reopened=await owner.request(saved.requestId);assert.deepEqual(reopened.brief,planning.brief);assert.deepEqual(reopened.evidence,planning.evidence);assert.equal(reopened.firstSavedAt,planning.firstSavedAt);assert.equal(reopened.history.length,1);
    const cachedResponse=await owner.post('/api/place-lookups',{query:'Dovetail Inlet',generation:2});assert.equal(cachedResponse.status,200,await cachedResponse.clone().text());const cached=await cachedResponse.json() as PlaceLookupResult;assert.equal(cached.cached,true);assert.equal(cached.version,lookup.version);assert.equal(providerCalls,1);
    const staff=new HttpClient(config.origin);await staff.enter(true);const staffPlanning=await staff.request(saved.requestId,true);assert.deepEqual(staffPlanning.brief,reopened.brief);assert.equal(staffPlanning.status,'Planning');const queue=await staff.get('/api/staff/requests');assert.equal(queue.status,200);assert.equal((await queue.json() as {total:number}).total,0);
    const submitBrief={...planningToInput(reopened.brief),acknowledged:true,contact:{name:'Generated process planner',email:'planning-process@coruscant.example',organization:'Generated test research'}};
    const submitDraft={target:{requestId:saved.requestId},expected:{requestVersion:reopened.requestVersion,briefRevision:reopened.briefRevision},payload:{brief:submitBrief}},submitReview=await owner.post('/api/command-reviews/submitPlanningRequest',submitDraft);assert.equal(submitReview.status,200,await submitReview.clone().text());
    const submitCommand={...submitDraft,commandId:randomUUID(),reviewToken:(await submitReview.json() as {reviewToken:string}).reviewToken},submittedResponse=await owner.post('/api/commands/submitPlanningRequest',submitCommand);assert.equal(submittedResponse.status,200,await submittedResponse.clone().text());
    const submitted=await owner.request(saved.requestId);assert.equal(submitted.status,'Submitted');assert.equal(submitted.reference,saved.reference);assert.equal(submitted.briefRevision,2);assert.equal(submitted.requestVersion,2);assert.equal(submitted.history.length,2);assert.deepEqual(submitted.brief.areaSource,planning.brief.areaSource);assert.deepEqual(submitted.originalSubmittedContact,submitBrief.contact);assert.equal(submitted.firstSavedAt,planning.firstSavedAt);assert.ok(submitted.submittedAt);assert.equal(submitted.currentQuote,null);assert.equal(submitted.schedule,null);
    const secondPid=child!.pid;await stop(child!);child=undefined;await start(dirname(serverEntry));assert.notEqual(child!.pid,secondPid);
    const submitReplay=await owner.post('/api/commands/submitPlanningRequest',submitCommand);assert.equal(submitReplay.status,200,await submitReplay.clone().text());const submittedReceipt=await submitReplay.json() as WorkflowOutcome;assert.equal(submittedReceipt.outcome,'replayed');assert.equal(submittedReceipt.requestId,saved.requestId);assert.equal(submittedReceipt.briefRevision,2);
    const initialReplay=await owner.post('/api/commands/savePlanningRequest',saveCommand);assert.equal(initialReplay.status,200,await initialReplay.clone().text());assert.equal((await initialReplay.json() as SubmissionOutcome).requestId,saved.requestId);
    assert.deepEqual((await owner.request(saved.requestId)).brief,submitted.brief);assert.deepEqual((await staff.request(saved.requestId,true)).brief,submitted.brief);assert.equal(providerCalls,1);
    await stop(child!);child=undefined;
    const final=openDatabase(config);try{for(const [table,count]of [['service_requests',1],['brief_revisions',2],['request_events',2],['action_receipts',2],['quotes',0],['schedules',0],['result_sets',0]] as const)assert.equal((final.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,count,table);assert.deepEqual(final.prepare('PRAGMA foreign_key_check').all(),[]);}finally{final.close();}
  }finally {
    if(child)await stop(child);
    if(provider.listening)await new Promise<void>((resolve,reject)=>provider.close(error=>error?reject(error):resolve()));
    rmSync(dataRoot,{recursive:true,force:true});rmSync(otherCwd,{recursive:true,force:true});
  }
});
