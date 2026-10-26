import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AssessmentPage } from '../../shared/plan-contracts.js';
import { createConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { migrate } from '../../server/db/migrate.js';
import { initialize } from '../../server/db/initialize.js';
import { ApiClient } from './support.js';
import { installTechnicalPlanning } from '../helpers/technical-planning.js';
import { planningToInput } from '../../shared/workflow.js';

test('exact selected plan, private manifest, receipt and originating brief survive two real OS-process restarts',{timeout:30000},async()=>{
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const address=socket.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>((yes,no)=>socket.close(error=>error?no(error):yes()));assert.ok(port!==3000&&port!==3100);
  const dataRoot=mkdtempSync(join(tmpdir(),'coruscant-proposed-plan-process-')),otherCwd=mkdtempSync(join(tmpdir(),'coruscant-proposed-plan-cwd-')),config=createConfig({dataRoot,port});
  const db=openDatabase(config);migrate(db);initialize(db,config);const fixture=installTechnicalPlanning(db,new Date().toISOString());db.close();
  let child:ChildProcess|undefined,stderr='';const entry=fileURLToPath(new URL('../../server/index.js',import.meta.url));
  async function start(cwd:string){
    stderr='';child=spawn(process.execPath,[entry],{cwd,env:{...process.env,CORUSCANT_MODE:'test',CORUSCANT_TEST_DATA_ROOT:dataRoot,CORUSCANT_PORT:String(port),PORT:String(port)},stdio:['ignore','pipe','pipe']});
    child.stdout?.on('data',()=>{});child.stderr?.on('data',part=>{stderr=(stderr+String(part)).slice(-8000);});
    for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(`Plan process exited: ${stderr}`);try{if((await fetch(config.origin+'/api/context',{signal:AbortSignal.timeout(300)})).ok)return;}catch{}await pause(30);}
    throw new Error(`Plan process unavailable: ${stderr}`);
  }
  async function stop(){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');let timeout:ReturnType<typeof setTimeout>|undefined;
    try{const [code,signal]=await Promise.race([exited,new Promise<never>((_yes,no)=>{timeout=setTimeout(()=>{child?.kill('SIGKILL');no(new Error('Plan process did not stop gracefully'));},5000);})]);assert.equal(code,0);assert.equal(signal,null);}finally{if(timeout)clearTimeout(timeout);}
    child=undefined;
  }
  // Reuse only this project's fresh HTTP test client. Rewrite its isolated host
  // to the chosen free port; no recording cookie or database enters this test.
  const adapter={async inject(input:{method:string;url:string;headers?:Record<string,string>;payload?:unknown}){
    const response=await fetch(config.origin+input.url,{method:input.method,headers:{...input.headers,host:config.allowedHost,origin:config.origin},...(input.method==='GET'?{}:{body:JSON.stringify(input.payload??{})}),signal:AbortSignal.timeout(5000)}),body=await response.text();
    return {statusCode:response.status,headers:Object.fromEntries(response.headers),body,json:()=>JSON.parse(body)};
  }} as unknown as FastifyInstance;
  try{
    await start(otherCwd);const owner=new ApiClient(adapter),staff=new ApiClient(adapter);await owner.enter();await staff.enter('staff-admin');
    const begun=await owner.post('/api/orbital-assessments',{generation:1,brief:fixture.brief});assert.equal(begun.statusCode,200,begun.body);let page=begun.json<AssessmentPage>();
    for(let i=0;i<200&&['QUEUED','RUNNING'].includes(page.state);i++){await pause(10);const status=await owner.post('/api/orbital-assessments/status',{...page.handle});assert.equal(status.statusCode,200,status.body);page=status.json<AssessmentPage>();}
    assert.equal(page.state,'COMPLETE');assert.ok(page.manifest);assert.ok(page.attachmentReference);const option=page.options.find(value=>value.outcome==='PROVISIONAL')!;assert.ok(option);
    const raw={target:{organizationId:'org-a'},expected:{},payload:{brief:fixture.brief,selection:{handle:page.handle,attachmentReference:page.attachmentReference,optionId:option.id,proposedAtUtc:option.proposedAtUtc,acknowledgedUnknownIds:option.unknowns.map(value=>value.id),assumptions:[]}}};
    const review=await owner.post('/api/command-reviews/saveProposedPlan',raw);assert.equal(review.statusCode,200,review.body);
    const command={...raw,commandId:randomUUID(),reviewToken:review.json().reviewToken},saved=await owner.post('/api/commands/saveProposedPlan',command);assert.equal(saved.statusCode,201,saved.body);
    const id=saved.json().requestId as string,before=await owner.state(id),plan=before.currentProposedPlan!;assert.equal(plan.briefRevision,1);assert.equal(before.history.length,1);
    const manifest=JSON.parse(readFileSync(join(dataRoot,'orbital/assessments',`${page.manifest!.assessmentId}-${page.manifest!.manifestDigest}.json`),'utf8')) as {requirements:{purpose:string};criteria:unknown;exclusions:unknown[];population:unknown[]};
    assert.equal(manifest.requirements.purpose,fixture.brief.purpose);assert.ok(Object.hasOwn(manifest,'criteria'));assert.deepEqual(manifest.exclusions,[]);assert.equal(manifest.population.length,1);
    const keyBefore=readFileSync(join(dataRoot,'orbital/assessment-hmac.key'));
    const firstPid=child!.pid;await stop();await start(otherCwd);assert.notEqual(child!.pid,firstPid);
    assert.deepEqual(readFileSync(join(dataRoot,'orbital/assessment-hmac.key')),keyBefore,'Restart reuses the exact private signing key.');
    assert.deepEqual((await owner.state(id)).currentProposedPlan,plan);assert.deepEqual((await staff.state(id)).currentProposedPlan,plan);
    const evidence=await owner.post(`/api/customer/org-a/requests/${id}/plan-evidence`,{planId:plan.id});assert.equal(evidence.statusCode,200,evidence.body);assert.equal(evidence.json().manifest.manifestDigest,page.manifest!.manifestDigest);
    const recovered=await owner.post('/api/commands/saveProposedPlan',command);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().outcome,'replayed');assert.equal(recovered.json().requestId,id);
    const row=await owner.state(id),brief={...planningToInput(row.brief),acknowledged:true,contact:{name:'Generated process planner',email:'proposed-plan-process@coruscant.example',organization:'Generated test research'}};
    const submit={target:{requestId:id},expected:{requestVersion:row.requestVersion,briefRevision:row.briefRevision},payload:{brief}},submitReview=await owner.post('/api/command-reviews/submitPlanningRequest',submit);assert.equal(submitReview.statusCode,200,submitReview.body);
    const submitCommand={...submit,commandId:randomUUID(),reviewToken:submitReview.json().reviewToken};assert.equal((await owner.post('/api/commands/submitPlanningRequest',submitCommand)).statusCode,200);
    const submitted=await owner.state(id);assert.equal(submitted.status,'Submitted');assert.equal(submitted.briefRevision,2);assert.deepEqual(submitted.currentProposedPlan,plan,'Contact-only revision preserves exact originating plan revision1.');
    const secondPid=child!.pid;await stop();await start(otherCwd);assert.notEqual(child!.pid,secondPid);
    assert.deepEqual((await owner.state(id)).currentProposedPlan,plan);assert.deepEqual((await staff.state(id)).currentProposedPlan,plan);assert.equal((await owner.state(id)).reference,before.reference);
    assert.equal((await owner.post('/api/commands/saveProposedPlan',command)).json().outcome,'replayed');assert.equal((await owner.post('/api/commands/submitPlanningRequest',submitCommand)).json().outcome,'replayed');
    await stop();const final=openDatabase(config);try{
      for(const [table,count]of [['service_requests',1],['brief_revisions',2],['proposed_plan_versions',1],['orbital_assessment_attachments',1],['request_events',2],['action_receipts',2],['quotes',0],['schedules',0],['result_sets',0]] as const)assert.equal(final.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,count,table);
      assert.deepEqual(final.prepare('PRAGMA foreign_key_check').all(),[]);
    }finally{final.close();}
  }finally{await stop();rmSync(dataRoot,{recursive:true,force:true});rmSync(otherCwd,{recursive:true,force:true});}
});
