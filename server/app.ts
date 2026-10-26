import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createConfig, type AppConfig, type ConfigOptions } from './config.js';
import { openDatabase, transaction, type Database } from './db/database.js';
import { verifySchema } from './db/migrate.js';
import { getD0 } from './db/initialize.js';
import { customerPersonas, comparisonDates, demonstrationTarget } from '../demo/index.js';
import type { CatalogItem, PublicCatalog } from '../shared/contracts.js';
import { ApiError } from './errors.js';
import { bodyObject, contextFor, findSession, guardContext, guardTransport, memberships, nowIso,
  publicContext, requireCustomer, requireOrganization, requireSession, requireStaff, rotateSession, touchSession, demoCookieName, type Clock } from './security.js';
import { detail, missionsSnapshot, requestList } from './projections.js';
import { reviewSubmission, submitRequest, type TestHooks } from './commands.js';
import { executeWorkflow, reviewWorkflow, workflowCommandNames } from './workflow.js';
import type { WorkflowCommandName } from '../shared/workflow.js';
import { executeMaterial, materialCommandNames, reviewMaterial } from './material-commands.js';
import type { MaterialCommandName } from '../shared/material.js';
import { customerResultLink, registerMaterialRoutes, staffRequestWithMaterial } from './material-api.js';
import { recordDelivery, reviewDelivery } from './delivery.js';
import { executeObservation, observationCommandNames } from './observations.js';
import type { ObservationCommandName } from '../shared/observations.js';
import { createGeometryReader } from './geometry.js';
import { registerOrbitalCatalogRoutes } from './orbital/routes-catalog.js';
import { registerOrbitalBrowseRoutes } from './orbital/routes-browse.js';
import { registerPlaceLookup, type PlaceLookupOptions } from './place-lookup.js';
import { reviewPlanningSave, savePlanningRequest, reviewPlanningSubmit, submitPlanningRequest } from './planning.js';
import { assessmentOwner, createAssessmentService } from './orbital/assessment-service.js';
import { registerAssessmentRoutes } from './orbital/routes-assessment.js';
import type { AssessmentHandoffInput, AssessmentHandoffContinuation } from '../shared/plan-contracts.js';
import { reviewProposedPlan, saveProposedPlan } from './plans.js';

export interface BuildOptions extends ConfigOptions { clock?:Clock; testHooks?:TestHooks; clientRoot?:string; placeLookup?:PlaceLookupOptions }
declare module 'fastify' { interface FastifyInstance { coruscant:{db:Database;config:AppConfig} } }

function queryShape(query:unknown):Record<string,unknown> {
  const value=(query??{}) as Record<string,unknown>;
  const statuses=['Planning','Submitted','In review','Needs information','Quote ready','Accepted','Scheduled','Delivered'];
  if(Object.keys(value).some(key=>!['search','status','page'].includes(key))||
    (value.search!==undefined&&(typeof value.search!=='string'||value.search.length>200))||
    (value.status!==undefined&&(typeof value.status!=='string'||(value.status!==''&&!statuses.includes(value.status))))||
    (value.page!==undefined&&(typeof value.page!=='string'||!/^\d+$/.test(value.page)||Number(value.page)<1||Number(value.page)>100000))) {
    throw new ApiError(422,'FILTER_INVALID','Clear or correct the request filters.',{filters:'Use a search of at most 200 characters, a known status and a positive page.'});
  }
  return value;
}
const isApiPath=(url:string)=>url.split('?')[0]==='/api'||url.startsWith('/api/');
export async function buildApp(options:BuildOptions={}):Promise<FastifyInstance> {
  const config=createConfig(options);const clock=options.clock??(()=>new Date());
  if((options.testHooks||options.placeLookup)&&config.mode!=='test')throw new Error('Test hooks are available only with an isolated test data root.');
  if(options.clientRoot!==undefined){
    if(config.mode!=='test'||!isAbsolute(options.clientRoot))throw new Error('A client-root fixture requires test mode and an absolute path.');
    config.clientRoot=resolve(options.clientRoot);
  }
  const db=openDatabase(config);
  try {verifySchema(db);getD0(db);}catch(error){db.close();throw error;}
  const app=Fastify({logger:false,bodyLimit:96*1024,trustProxy:false});
  const geometry=createGeometryReader(db);
  const assessments=createAssessmentService({db,config,clock});
  app.decorate('coruscant',{db,config});
  app.addHook('onClose',()=>{assessments.close();db.close();});
  app.addHook('onRequest',async(request,reply)=>{
    if(isApiPath(request.url)){
      guardTransport(request,config);
      reply.header('Cache-Control','no-store').header('Vary','Cookie').header('X-Content-Type-Options','nosniff').header('Cross-Origin-Resource-Policy','same-origin');
    }
  });
  app.setErrorHandler((error,request,reply)=>{
    let safe:ApiError;
    const failure=error as {message?:string;statusCode?:number;code?:string};
    if(error instanceof ApiError)safe=error;
    else if(/(?:database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED)/i.test(failure.message??''))safe=new ApiError(503,'RETRY_LATER','The saved store is busy. Keep this action and try again.',undefined,true);
    else if(failure.statusCode===400||failure.code==='FST_ERR_CTP_INVALID_JSON_BODY')safe=new ApiError(400,'MALFORMED','The JSON request could not be read.');
    else if(failure.statusCode===413)safe=new ApiError(413,'TOO_LARGE','This request exceeds the local input limit.');
    else if(failure.statusCode===403||failure.statusCode===404)safe=new ApiError(404,'UNAVAILABLE','This route is unavailable.');
    else safe=new ApiError(503,'SERVICE_UNAVAILABLE','The action could not be confirmed. Keep your input and retry the same action.',undefined,true);
    const correlationId=request.id;
    // No raw contact, payload, cookie, token or private text enters logs or error responses.
    reply.code(safe.status).header('Cache-Control','no-store').send({code:safe.code,message:safe.message,
      ...(safe.fieldErrors?{fieldErrors:safe.fieldErrors}:{}),retryable:safe.retryable,correlationId});
  });
  app.get('/api/context',async(request)=>transaction(db,()=>{
    const session=findSession(db,request,clock);if(session)touchSession(db,session,clock);
    return contextFor(db,session,clock);
  }));
  registerOrbitalCatalogRoutes(app,db,config,clock);
  registerOrbitalBrowseRoutes(app,{db,clock});
  registerAssessmentRoutes(app,db,clock,assessments);
  registerPlaceLookup(app,clock,options.placeLookup);
  app.get('/api/public/catalog',async()=>{
    const d0=getD0(db);const dates=comparisonDates(d0);
    const items=(db.prepare('SELECT definition_json FROM discovery_items ORDER BY id').all() as {definition_json:string}[]).map(row=>JSON.parse(row.definition_json) as CatalogItem);
    const result:PublicCatalog={items,personas:customerPersonas,demo:{d0,baselineDate:dates.baselineDate,recentDate:dates.recentDate,target:demonstrationTarget}};
    return result;
  });
  app.get('/api/public/geometry',async(_request,reply)=>reply.type('application/json').send(geometry()));
  app.post('/api/demo/bootstrap',async(request,reply)=>{
    const body=bodyObject(request);if(Object.keys(body).length)throw new ApiError(400,'MALFORMED','Bootstrap accepts an empty JSON object.');
    return transaction(db,()=>{const current=findSession(db,request,clock);return contextFor(db,current??rotateSession(db,null,reply,clock,'PUBLIC'),clock);});
  });
  app.post('/api/demo/customer/enter',async(request,reply)=>{let previousSession:ReturnType<typeof requireSession>|undefined,rotated=false;
    try{const result=transaction(db,()=>{
    const previous=requireSession(db,request,clock);guardContext(previous,request);const body=bodyObject(request);
    previousSession=previous;
    if(typeof body.personaId!=='string'||!customerPersonas.some(persona=>persona.id===body.personaId))throw new ApiError(422,'PERSONA_INVALID','Choose an existing demonstration customer.');
    const actor=db.prepare("SELECT id FROM actors WHERE id=? AND audience='CUSTOMER' AND active=1").get(body.personaId);
    if(!actor)throw new ApiError(401,'ACCESS_REQUIRED','This demonstration customer is unavailable.');
    const next=rotateSession(db,previous,reply,clock,'CUSTOMER',body.personaId),context=contextFor(db,next,clock);
    if(body.planningHandoff!==undefined)context.planningHandoff={phase:'CONTINUE',continuation:assessments.linkHandoffEntry(previous,next,body.planningHandoff as AssessmentHandoffInput)};
    return context;
  });rotated=true;return result;}catch(error){reply.removeHeader('Set-Cookie');throw error;}finally{if(rotated&&previousSession)assessments.invalidateContext(assessmentOwner(previousSession));}});
  app.post('/api/demo/staff/enter',async(request,reply)=>{let previousSession:ReturnType<typeof requireSession>|undefined;
    const result=transaction(db,()=>{
    const previous=requireSession(db,request,clock);guardContext(previous,request);
    previousSession=previous;
    const actor=db.prepare("SELECT id FROM actors WHERE id='staff-admin' AND audience='STAFF' AND active=1").get();
    if(!actor)throw new ApiError(401,'ACCESS_REQUIRED','Demonstration staff access is unavailable.');
    return contextFor(db,rotateSession(db,previous,reply,clock,'STAFF','staff-admin'),clock);
  });if(previousSession)assessments.invalidateContext(assessmentOwner(previousSession));return result;});
  app.post('/api/context/workspace',async(request,reply)=>{let previousSession:ReturnType<typeof requireSession>|undefined,rotated=false;
    try{const result=transaction(db,()=>{
    const previous=requireSession(db,request,clock);guardContext(previous,request);requireCustomer(db,previous);
    previousSession=previous;
    const body=bodyObject(request);const member=memberships(db,previous.actor_id!).find(value=>value.organizationId===body.organizationId);
    if(!member)throw new ApiError(404,'UNAVAILABLE','That workspace is unavailable in the current context.');
    const next=rotateSession(db,previous,reply,clock,'CUSTOMER',previous.actor_id,member.organizationId),context=contextFor(db,next,clock);
    if(body.planningHandoff!==undefined)context.planningHandoff={phase:'COMPLETE',result:assessments.linkHandoffWorkspace(previous,next,body.planningHandoff as AssessmentHandoffContinuation)};
    return context;
  });rotated=true;return result;}catch(error){reply.removeHeader('Set-Cookie');throw error;}finally{if(rotated&&previousSession)assessments.invalidateContext(assessmentOwner(previousSession));}});
  app.post('/api/demo/leave',async(request,reply)=>{let previousSession:ReturnType<typeof requireSession>|undefined;
    const result=transaction(db,()=>{
    const previous=requireSession(db,request,clock);guardContext(previous,request);
    previousSession=previous;
    db.prepare('UPDATE sessions SET active=0 WHERE cookie_hash=?').run(previous.cookie_hash);
    reply.header('Set-Cookie',`${demoCookieName(config)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return publicContext(clock);
  });if(previousSession)assessments.invalidateContext(assessmentOwner(previousSession));return result;});
  app.get('/api/customer/workspaces',async(request)=>transaction(db,()=>{
    const session=requireSession(db,request,clock);requireCustomer(db,session);
    return {memberships:memberships(db,session.actor_id!),contextGeneration:session.context_generation,serverNow:nowIso(clock)};
  },false));
  app.get<{Params:{org:string}}>('/api/customer/:org/requests',async(request)=>transaction(db,()=>{
    const session=requireSession(db,request,clock);const result=requestList(db,session,request.params.org,queryShape(request.query));
    return {...result,contextGeneration:session.context_generation,serverNow:nowIso(clock)};
  },false));
  app.get<{Params:{org:string}}>('/api/customer/:org/missions',async(request)=>transaction(db,()=>{
    const instant=clock(),snapshotClock=()=>instant;
    const session=requireSession(db,request,snapshotClock);
    return missionsSnapshot(db,session,request.params.org,snapshotClock,id=>customerResultLink(db,id,snapshotClock));
  },false));
  app.get<{Params:{org:string;id:string}}>('/api/customer/:org/requests/:id',async(request)=>transaction(db,()=>{
    const session=requireSession(db,request,clock);requireOrganization(db,session,request.params.org);
    const result=detail(db,session,request.params.id);
    if(result.organizationId!==request.params.org)throw new ApiError(404,'UNAVAILABLE','This record is unavailable in the current context.');
    return {...result,result:customerResultLink(db,result.id,clock),contextGeneration:session.context_generation,serverNow:nowIso(clock)};
  },false));
  app.get('/api/staff/requests',async(request)=>transaction(db,()=>{
    const session=requireSession(db,request,clock);requireStaff(db,session);
    return {...requestList(db,session,null,queryShape(request.query)),contextGeneration:session.context_generation,serverNow:nowIso(clock)};
  },false));
  app.get<{Params:{id:string}}>('/api/staff/requests/:id',async(request)=>staffRequestWithMaterial(db,config,request,request.params.id,clock));
  registerMaterialRoutes(app,db,config,clock,options.testHooks);
  app.post<{Params:{commandName:string}}>('/api/command-reviews/:commandName',async(request)=>{
    if(request.params.commandName==='saveProposedPlan')return reviewProposedPlan(db,request,clock,assessments,options.testHooks);
    if(request.params.commandName==='savePlanningRequest')return reviewPlanningSave(db,request,clock);
    if(request.params.commandName==='submitPlanningRequest')return reviewPlanningSubmit(db,request,clock);
    if(request.params.commandName==='submitRequest')return reviewSubmission(db,request,clock);
    if(request.params.commandName==='recordDelivery')return reviewDelivery(db,config,request,clock);
    if(observationCommandNames.includes(request.params.commandName as ObservationCommandName))throw new ApiError(409,'REVIEW_NOT_REQUIRED','Own observation saves and deletion do not use a separate confirmation preview.');
    if(materialCommandNames.includes(request.params.commandName as MaterialCommandName))return reviewMaterial(db,config,request,clock,request.params.commandName as MaterialCommandName);
    if(workflowCommandNames.includes(request.params.commandName as WorkflowCommandName))return reviewWorkflow(db,request,clock,request.params.commandName as WorkflowCommandName,options.testHooks);
    throw new ApiError(404,'UNAVAILABLE','That action is unavailable in this increment.');
  });
  app.post<{Params:{commandName:string}}>('/api/commands/:commandName',async(request,reply)=>{
    if(request.params.commandName==='saveProposedPlan'){
      const outcome=await saveProposedPlan(db,request,clock,assessments,options.testHooks);
      return reply.code(outcome.outcome==='saved'&&!!bodyObject(request).target&&Object.hasOwn(bodyObject(request).target as object,'organizationId')?201:200).send(outcome);
    }
    if(request.params.commandName==='savePlanningRequest'){
      const outcome=await savePlanningRequest(db,request,clock,options.testHooks);
      return reply.code(outcome.outcome==='saved'?201:200).send(outcome);
    }
    if(request.params.commandName==='submitPlanningRequest')return submitPlanningRequest(db,request,clock,options.testHooks);
    if(request.params.commandName==='submitRequest'){
      const outcome=await submitRequest(db,request,clock,options.testHooks);
      return reply.code(outcome.outcome==='saved'?201:200).send(outcome);
    }
    if(materialCommandNames.includes(request.params.commandName as MaterialCommandName))return executeMaterial(db,config,request,clock,request.params.commandName as MaterialCommandName,options.testHooks);
    if(request.params.commandName==='recordDelivery')return recordDelivery(db,config,request,clock,options.testHooks);
    if(observationCommandNames.includes(request.params.commandName as ObservationCommandName))return executeObservation(db,request,clock,request.params.commandName as ObservationCommandName,options.testHooks);
    if(workflowCommandNames.includes(request.params.commandName as WorkflowCommandName))return executeWorkflow(db,request,clock,request.params.commandName as WorkflowCommandName,options.testHooks);
    throw new ApiError(404,'UNAVAILABLE','That action is unavailable in this increment.');
  });
  if(existsSync(config.clientRoot)){
    await app.register(fastifyStatic,{root:config.clientRoot,index:['index.html'],dotfiles:'deny',redirect:false,
      setHeaders(response,path){
        response.header('X-Content-Type-Options','nosniff');
        if(path.endsWith('.html'))response.header('Cache-Control','no-store');
      }});
  }else if(config.mode!=='test'){
    await app.close();throw new Error('Client bundle is missing. Run npm run build:client before starting.');
  }
  app.setNotFoundHandler(async(request,reply)=>{
    if(isApiPath(request.url)||request.method!=='GET')return reply.code(404).header('Cache-Control','no-store').send({code:'UNAVAILABLE',message:'This route is unavailable.',retryable:false,correlationId:request.id});
    if(!existsSync(config.clientRoot))return reply.code(404).send('The client bundle is unavailable.');
    return reply.header('Cache-Control','no-store').sendFile('index.html');
  });
  await app.ready();return app;
}
