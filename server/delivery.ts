import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { WorkflowCommandEnvelope, WorkflowOutcome, WorkflowReview } from '../shared/workflow.js';
import type { DeliveryReadinessSnapshot } from '../shared/delivery.js';
import { validateDeliveryNote } from '../shared/delivery.js';
import { DELIVERY_DATE_BLOCKER } from '../shared/material.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { transaction } from './db/database.js';
import { ApiError, invalid, unavailable } from './errors.js';
import { guardContext, nowIso, requireSession, requireStaff, type Clock, type Session } from './security.js';
import { projectRequest, requestRow, type RequestRow } from './projections.js';
import { acceptedContext, assets, currentImages, digest, entitlement, findingRow, imageFile, imageKey, projectStaffResult, resultRow, type Availability, type FileRow, type ResultRow } from './material-records.js';
import { readPrivateFile } from './material-files.js';
import { actionFingerprint, actionShape, createActionReview, recoverAction, saveActionReceipt, verifyActionReview } from './guarded-actions.js';
import type { TestHooks } from './commands.js';

interface Authorized { session:Session; request:RequestRow; result:ResultRow }
interface FileProof { assetId:string; contentVersion:number; file:FileRow }
interface Preflight { availability:Availability; files:FileProof[]; failure?:unknown }
function shape(request:FastifyRequest,command:boolean) {
  const input=actionShape(request,['requestId','resultId'],command);
  if(!input.target.requestId||!input.target.resultId||Object.keys(input.target).length!==2)throw new ApiError(400,'MALFORMED','Name the same saved request and result.');
  return input;
}
function authorize(db:Database,request:FastifyRequest,input:WorkflowCommandEnvelope,clock:Clock):Authorized {
  const session=requireSession(db,request,clock);guardContext(session,request);requireStaff(db,session);
  const row=requestRow(db,input.target.requestId),result=resultRow(db,input.target.resultId!);
  if(!row||!result||result.request_id!==row.id||result.organization_id!==row.organization_id)unavailable();
  // Receipt recovery intentionally does not require Scheduled, current rights, publication or files.
  return {session,request:row,result};
}
function versions(db:Database,input:WorkflowCommandEnvelope,auth:Authorized) {
  const expected=input.expected as unknown as Record<string,unknown>;
  if(Object.keys(expected).some(key=>!['requestVersion','briefRevision','materialVersion','accessVersion','findingContentVersion'].includes(key))||!Number.isSafeInteger(expected.requestVersion)||!Number.isSafeInteger(expected.briefRevision))throw new ApiError(400,'MALFORMED','Provide the reviewed request, material and access versions.');
  if(expected.requestVersion!==auth.request.aggregate_version||expected.briefRevision!==auth.request.current_brief_revision)throw new ApiError(409,'STALE_REVIEW','The request changed. Keep the note and review current work.');
  if(expected.materialVersion!==auth.result.material_version)throw new ApiError(409,'STALE_MATERIAL','Material changed. Keep the note and review its current exact versions.');
  if(expected.accessVersion!==(entitlement(db,auth.result)?.version??0))throw new ApiError(409,'STALE_ACCESS','Organization access changed. Review the current access before delivery.');
  if(expected.findingContentVersion!==(findingRow(db,auth.result.id)?.current_version??0))throw new ApiError(409,'STALE_FINDING','The finding changed. Keep the note and inspect its current version.');
}
/** Capture exact required identities/hashes, then read bounded private files without any transaction. */
async function preflight(db:Database,config:AppConfig,auth:Authorized):Promise<Preflight> {
  const work:Preflight={availability:new Map(),files:[]};
  for(const image of currentImages(db,auth.result)) {
    const asset=assets(db,auth.result.id).find(item=>item.id===image.assetId);
    const file=imageFile(db,image.assetId,image.contentVersion);
    try {
      if(!asset||asset.published_version!==image.contentVersion||!file)throw new ApiError(404,'MATERIAL_UNAVAILABLE','The exact required published image is unavailable.');
      await readPrivateFile(config,file);
      work.files.push({assetId:image.assetId,contentVersion:image.contentVersion,file});work.availability.set(imageKey(image),'AVAILABLE');
    } catch(error) { work.failure??=error;work.availability.set(imageKey(image),'UNAVAILABLE'); }
  }
  return work;
}
function note(input:WorkflowCommandEnvelope):string {
  const checked=validateDeliveryNote(input.payload);if(!checked.value)invalid('Review the delivery note.',checked.fieldErrors);return checked.value.note;
}
function currentReadiness(db:Database,auth:Authorized,io:Preflight,clock:Clock) {
  return projectStaffResult(db,auth.result,io.availability,clock);
}
export async function reviewDelivery(db:Database,config:AppConfig,request:FastifyRequest,clock:Clock):Promise<WorkflowReview> {
  const input=shape(request,false);
  const initial=transaction(db,()=>{const auth=authorize(db,request,input,clock);versions(db,input,auth);note(input);return auth;});
  const io=await preflight(db,config,initial);
  return transaction(db,()=>{
    const auth=authorize(db,request,input,clock);versions(db,input,auth);
    // A blocked read-only preview still retains the entered note and names all current blockers.
    const result=currentReadiness(db,auth,io,clock);
    return createActionReview(db,'recordDelivery',input,auth.session,auth.request.organization_id,{request:projectRequest(db,auth.request),result,dateComparison:result.dateComparison,deliveryNote:note(input)},clock);
  });
}
export async function recordDelivery(db:Database,config:AppConfig,request:FastifyRequest,clock:Clock,hooks?:TestHooks):Promise<WorkflowOutcome> {
  const input=shape(request,true),fp=actionFingerprint('recordDelivery',input);
  const initial=transaction(db,()=>{const auth=authorize(db,request,input,clock);return {auth,receipt:recoverAction(db,'recordDelivery',input,auth.session,auth.request.organization_id,fp)};});
  if(initial.receipt)return initial.receipt;
  let io:Preflight={availability:new Map(),files:[]};
  try {
    await hooks?.beforeDeliveryPreflight?.({commandId:input.commandId,requestId:initial.auth.request.id,resultId:initial.auth.result.id});
    io=await preflight(db,config,initial.auth);
    await hooks?.afterDeliveryPreflight?.({commandId:input.commandId,requestId:initial.auth.request.id,resultId:initial.auth.result.id,failed:!!io.failure});
  } catch(error) { io.failure=error; }
  const outcome=transaction(db,()=>{
    const auth=authorize(db,request,input,clock);
    const receipt=recoverAction(db,'recordDelivery',input,auth.session,auth.request.organization_id,fp);
    if(receipt)return receipt; // Also runs when this preflight failed after an identical concurrent commit.
    versions(db,input,auth);verifyActionReview(db,'recordDelivery',input,auth.session,auth.request.organization_id,fp,clock);
    const enteredNote=note(input),result=currentReadiness(db,auth,io,clock);
    if(result.dateComparison.status==='DIFFERENT')throw new ApiError(409,'DELIVERY_BLOCKED',DELIVERY_DATE_BLOCKER,{readiness:result.readiness.blockers.join(' ')});
    if(!result.readiness.ready||io.failure)throw new ApiError(409,'DELIVERY_BLOCKED','Delivery is blocked by current readiness.',{readiness:result.readiness.blockers.join(' ')||'The exact private file proof is unavailable.'});
    const schedule=projectRequest(db,auth.request).schedule;
    if(!schedule||auth.request.status!=='Scheduled'||schedule.acceptedQuoteId!==auth.result.accepted_quote_id||schedule.briefRevision!==auth.result.brief_revision||auth.request.accepted_quote_id!==auth.result.accepted_quote_id||auth.request.current_brief_revision!==auth.result.brief_revision)throw new ApiError(409,'DELIVERY_BLOCKED','Delivery must use the same accepted request, initial schedule and supplied result.');
    const images=currentImages(db,auth.result);
    if(images.length!==2||io.files.length!==2||images.some(image=>{const proof=io.files.find(file=>file.assetId===image.assetId&&file.contentVersion===image.contentVersion),current=imageFile(db,image.assetId,image.contentVersion);return !proof||!current||digest(proof.file)!==digest(current)||image.contentHash!==current.sha256;}))throw new ApiError(409,'STALE_MATERIAL','The exact image file proof changed. Keep the note and review again.');
    const access=entitlement(db,auth.result)!,finding=findingRow(db,auth.result.id)!,metadata=JSON.parse(auth.result.metadata_json);
    const now=nowIso(clock),id=randomUUID(),version=auth.request.aggregate_version+1;
    const snapshot:DeliveryReadinessSnapshot={requestId:auth.request.id,organizationId:auth.request.organization_id,resultId:auth.result.id,scheduleId:schedule.id,acceptedQuoteId:auth.result.accepted_quote_id,briefRevision:auth.result.brief_revision,materialVersion:auth.result.material_version,accessVersion:access.version,checkedAt:now,acceptedContext:acceptedContext(db,auth.result),dateComparison:result.dateComparison,
      images:images.map(image=>({assetId:image.assetId,contentVersion:image.contentVersion,contentHash:image.contentHash,imageReviewId:assets(db,auth.result.id).find(asset=>asset.id===image.assetId)!.current_review_id!})),
      finding:{findingId:finding.id,contentVersion:finding.current_version,findingReviewId:finding.current_review_id!},rights:{licence:metadata.licence,permittedUse:metadata.permittedUse,rightsExpiresAt:metadata.rightsExpiresAt},fileChecks:'AVAILABLE',intendedMembershipConfirmed:true};
    db.prepare('INSERT INTO deliveries(id,request_id,organization_id,schedule_id,result_id,accepted_quote_id,brief_revision,request_version,material_version,access_version,note,readiness_json,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,auth.request.id,auth.request.organization_id,schedule.id,auth.result.id,auth.result.accepted_quote_id,auth.result.brief_revision,version,auth.result.material_version,access.version,enteredNote,JSON.stringify(snapshot),auth.session.actor_id!,now);
    const changed=db.prepare("UPDATE service_requests SET status='Delivered',aggregate_version=aggregate_version+1 WHERE id=? AND status='Scheduled' AND aggregate_version=?").run(auth.request.id,auth.request.aggregate_version);
    if(changed.changes!==1)throw new ApiError(409,'STALE_REVIEW','The request changed before delivery was recorded.');
    db.prepare('INSERT INTO request_events(id,request_id,organization_id,actor_id,type,occurred_at,message) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),auth.request.id,auth.request.organization_id,auth.session.actor_id!,'Delivered',now,enteredNote);
    const saved:WorkflowOutcome={outcome:'saved',requestId:auth.request.id,requestVersion:version,briefRevision:auth.request.current_brief_revision,contextGeneration:auth.session.context_generation,resultId:auth.result.id,deliveryId:id,message:'Delivery recorded. The same saved result is linked to this mission.'};
    saveActionReceipt(db,'recordDelivery',input,auth.session,auth.request.organization_id,fp,saved,clock,true);return saved;
  });
  if(outcome.outcome==='saved')await hooks?.afterWorkflowCommit?.('recordDelivery',outcome);return outcome;
}
