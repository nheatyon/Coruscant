import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createConfig } from '../../server/config.js';
import { openDatabase } from '../../server/db/database.js';
import { initialize } from '../../server/db/initialize.js';
import { migrate } from '../../server/db/migrate.js';
import { createEmptyBrief, areaSignature } from '../../shared/validation.js';
import type { Context, SubmissionOutcome } from '../../shared/contracts.js';

async function freePort():Promise<number>{
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const address=socket.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>((resolve,reject)=>socket.close(error=>error?reject(error):resolve()));return port;
}
async function stop(child:ChildProcess):Promise<void>{
  if(child.exitCode!==null||child.signalCode!==null)return;
  const ended=once(child,'exit');child.kill('SIGTERM');
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([ended,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Child server failed to stop cleanly.'));},5000);})]);}
  finally{if(timer)clearTimeout(timer);}
}

test('a real HTTP process reopens the same database and authorized receipt from another cwd',{timeout:20_000},async()=>{
  const port=await freePort();
  const dataRoot=mkdtempSync(join(tmpdir(),'coruscant-process-'));const otherCwd=mkdtempSync(join(tmpdir(),'coruscant-other-cwd-'));
  const config=createConfig({dataRoot,port});const origin=config.origin;
  const db=openDatabase(config);migrate(db);initialize(db,config,()=>new Date('2026-10-21T13:42:16.123Z'));db.close();
  let child:ChildProcess|undefined;let stderr='';let cookie='';let context:Context|undefined;
  async function start(cwd:string){
    stderr='';child=spawn(process.execPath,[join(config.projectRoot,'dist/node/server/index.js')],{cwd,env:{...process.env,
      CORUSCANT_MODE:'test',CORUSCANT_TEST_DATA_ROOT:dataRoot,CORUSCANT_PORT:String(port),PORT:String(port)},stdio:['ignore','pipe','pipe']});
    child.stdout?.on('data',()=>{});child.stderr?.on('data',chunk=>{stderr+=String(chunk);});
    let startupError:Error|undefined;child.once('error',error=>{startupError=error;});
    for(let attempt=0;attempt<100;attempt++){
      if(startupError)throw startupError;if(child.exitCode!==null)throw new Error(`HTTP process exited during startup: ${stderr}`);
      try{const response=await fetch(`${origin}/api/context`,{signal:AbortSignal.timeout(300)});if(response.ok)return;}catch{}
      await pause(30);
    }
    throw new Error(`HTTP server did not become ready: ${stderr}`);
  }
  async function post(path:string,payload:unknown){
    return fetch(`${origin}${path}`,{method:'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{}),
      ...(context?.csrfToken?{'x-coruscant-csrf':context.csrfToken}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(3000)});
  }
  async function enter(path:string,values:Record<string,unknown>={},bootstrap=false){
    const response=await post(path,bootstrap?{}:{contextGeneration:context?.contextGeneration,contextToken:context?.contextToken,...values});
    assert.equal(response.status,200,await response.clone().text());const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0]!;context=await response.json() as Context;
  }
  try{
    await start(config.projectRoot);
    await enter('/api/demo/bootstrap',{},true);await enter('/api/demo/customer/enter',{personaId:'a-owner'});await enter('/api/context/workspace',{organizationId:'org-a'});
    const area={latitude:52.6,longitude:-9.7,radiusKm:25,method:'coordinates' as const,generation:1};
    const brief={...createEmptyBrief(),purpose:'Inspect a saved river-comparison request across a real server restart.',sensor:'SAR',
      latitude:'52.6',longitude:'-9.7',radiusKm:'25',areaChoice:area,areaConfirmation:areaSignature(area),baselineDate:'2026-10-07',recentDate:'2026-10-14',
      maxResolution:'10',contact:{name:'Demonstration contact',email:'process@coruscant.example',organization:'Demonstration research'},acknowledged:true};
    const reviewed={contextGeneration:context!.contextGeneration,contextToken:context!.contextToken,target:{organizationId:'org-a'},expected:{},payload:{brief}};
    const review=await post('/api/command-reviews/submitRequest',reviewed);assert.equal(review.status,200,await review.clone().text());
    const token=await review.json() as {reviewToken:string};const command={...reviewed,commandId:randomUUID(),reviewToken:token.reviewToken};
    const first=await post('/api/commands/submitRequest',command);assert.equal(first.status,201,await first.clone().text());const original=await first.json() as SubmissionOutcome;
    const originalCookie=cookie;await stop(child!);child=undefined;
    // A new OS process, with a different cwd, must resolve the same explicit data root and session.
    await start(otherCwd);
    const current=await fetch(`${origin}/api/context`,{headers:{cookie},signal:AbortSignal.timeout(3000)});const restored=await current.json() as Context;
    assert.equal(restored.actor?.id,'a-owner');assert.equal(restored.organization?.id,'org-a');assert.equal(restored.contextToken,context!.contextToken);assert.equal(cookie,originalCookie);
    const replay=await post('/api/commands/submitRequest',command);assert.equal(replay.status,200,await replay.clone().text());const recovered=await replay.json() as SubmissionOutcome;
    assert.equal(recovered.outcome,'replayed');assert.equal(recovered.requestId,original.requestId);assert.equal(recovered.reference,original.reference);assert.equal(recovered.requestVersion,1);
    const detail=await fetch(`${origin}/api/customer/org-a/requests/${original.requestId}`,{headers:{cookie},signal:AbortSignal.timeout(3000)});assert.equal(detail.status,200);const saved=await detail.json() as {id:string;history:unknown[];brief:{baselineDate:string}};
    assert.equal(saved.id,original.requestId);assert.equal(saved.history.length,1);assert.equal(saved.brief.baselineDate,'2026-10-07');
    await stop(child!);child=undefined;
    const reopened=openDatabase(config);try{
      for(const table of ['service_requests','brief_revisions','request_events','action_receipts'])assert.equal((reopened.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,1);
    }finally{reopened.close();}
  }finally{if(child)await stop(child);rmSync(dataRoot,{recursive:true,force:true});rmSync(otherCwd,{recursive:true,force:true});}
});
