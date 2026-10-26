import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { transaction } from './db/database.js';
import { ApiError, unavailable } from './errors.js';
import { requireOrganization, requireSession, requireStaff, type Clock, type Session } from './security.js';
import { detail, requestRow } from './projections.js';
import type { TestHooks } from './commands.js';
import type { CustomerResultCard, CustomerResultList, MaterialRequestProjection, ResultLink } from '../shared/material.js';
import { assets, customerMaterialAllowed, projectCustomerResult, projectStaffResult, requestResult, resultRow, type Availability, type ResultRow } from './material-records.js';
import { inspectFiles, protectedBytes } from './material-files.js';

function sameContext(initial:Session,current:Session){if(initial.cookie_hash!==current.cookie_hash||initial.context_generation!==current.context_generation||initial.context_token!==current.context_token)throw new ApiError(409,'CONTEXT_CHANGED','Access context changed during this read.');}
function readableResult(db:Database,result:ResultRow,clock:Clock):boolean{return customerMaterialAllowed(db,result,clock)&&assets(db,result.id).some(asset=>asset.published_version!==null);}
export function customerResultLink(db:Database,requestId:string,clock:Clock):ResultLink|null{
  const result=requestResult(db,requestId);if(!result||!readableResult(db,result,clock))return null;const metadata=JSON.parse(result.metadata_json) as {title:string;provider:string};return {id:result.id,title:metadata.title,provider:metadata.provider,demonstration:true};
}
export async function staffRequestWithMaterial(db:Database,config:AppConfig,request:FastifyRequest,id:string,clock:Clock){
  const initial=transaction(db,()=>{const session=requireSession(db,request,clock);requireStaff(db,session);const row=requestRow(db,id);if(!row)unavailable();return {session,result:requestResult(db,id)};});
  const availability=initial.result?await inspectFiles(db,config,initial.result,true):new Map() as Availability;
  return transaction(db,()=>{const session=requireSession(db,request,clock);requireStaff(db,session);sameContext(initial.session,session);const result=requestResult(db,id);
    return {...detail(db,session,id),result:result?projectStaffResult(db,result,availability,clock):null,contextGeneration:session.context_generation,serverNow:clock().toISOString()};});
}
function authorizeCustomerResult(db:Database,request:FastifyRequest,org:string,id:string,clock:Clock){
  const session=requireSession(db,request,clock);requireOrganization(db,session,org);const result=resultRow(db,id);if(!result||result.organization_id!==org||!readableResult(db,result,clock))unavailable();return {session,result};
}
export function registerMaterialRoutes(app:FastifyInstance,db:Database,config:AppConfig,clock:Clock,hooks?:TestHooks){
  app.get<{Params:{org:string;id:string}}>('/api/customer/:org/results/:id',async(request)=>{
    const initial=transaction(db,()=>authorizeCustomerResult(db,request,request.params.org,request.params.id,clock));const availability=await inspectFiles(db,config,initial.result,false);
    return transaction(db,()=>{const current=authorizeCustomerResult(db,request,request.params.org,request.params.id,clock);sameContext(initial.session,current.session);return projectCustomerResult(db,current.result,availability,current.session,clock);});
  });
  app.get<{Params:{org:string}}>('/api/customer/:org/results',async(request)=>{
    const initial=transaction(db,()=>{const session=requireSession(db,request,clock);requireOrganization(db,session,request.params.org);const results=(db.prepare('SELECT * FROM result_sets WHERE organization_id=? ORDER BY created_at DESC,id').all(request.params.org) as unknown as ResultRow[]).filter(result=>readableResult(db,result,clock));return {session,results};});
    const checked=new Map(await Promise.all(initial.results.map(async result=>[result.id,await inspectFiles(db,config,result,false)] as const)));
    return transaction(db,()=>{const session=requireSession(db,request,clock);requireOrganization(db,session,request.params.org);sameContext(initial.session,session);
      const results=(db.prepare('SELECT * FROM result_sets WHERE organization_id=? ORDER BY created_at DESC,id').all(request.params.org) as unknown as ResultRow[]).filter(result=>readableResult(db,result,clock)).map(result=>{
        const full=projectCustomerResult(db,result,checked.get(result.id)??new Map(),session,clock);const first=full.images[0];
        return {id:result.id,title:full.metadata.title,provider:full.metadata.provider,demonstration:true,requestId:result.request_id,targetLabel:full.metadata.targetLabel,licence:full.metadata.licence,rightsExpiresAt:full.metadata.rightsExpiresAt,actualCollection:null,
          illustrativeBaselineDate:full.images.find(image=>image.role==='BASELINE')?.origin.illustrativeDate??null,illustrativeRecentDate:full.images.find(image=>image.role==='RECENT')?.origin.illustrativeDate??null,
          cover:first?{image:{assetId:first.assetId,contentVersion:first.contentVersion},thumbnailUrl:first.thumbnailUrl,availability:first.availability}:null} satisfies CustomerResultCard;
      });return {results,contextGeneration:session.context_generation,serverNow:clock().toISOString()} satisfies CustomerResultList;});
  });
  app.get<{Params:{assetId:string;version:string;variant:string}}>('/api/material/:assetId/versions/:version/:variant',async(request,reply)=>{
    const {assetId,variant}=request.params;const version=Number(request.params.version);if(!Number.isSafeInteger(version)||version<1||!['thumbnail','preview'].includes(variant))unavailable();
    const bytes=await protectedBytes(db,config,request,clock,assetId,version,variant as 'thumbnail'|'preview',hooks);
    return reply.header('Cache-Control','private, no-store').header('Vary','Cookie').header('Cross-Origin-Resource-Policy','same-origin').header('X-Content-Type-Options','nosniff')
      .header('Content-Security-Policy',"default-src 'none'; sandbox").type('image/svg+xml').send(bytes);
  });
}
