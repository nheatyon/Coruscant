import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { BriefInput, CommandEnvelope, EvidenceSnapshot, NormalizedBrief, SubmissionOutcome, SubmissionReview } from '../shared/contracts.js';
import type { PlanSelectionInput } from '../shared/plan-contracts.js';
import { validateBriefRevision, type ProposedPlanReview, type WorkflowCommandEnvelope, type WorkflowOutcome, type WorkflowReview } from '../shared/workflow.js';
import { areaSignature } from '../shared/validation.js';
import type { Database } from './db/database.js';
import { transaction } from './db/database.js';
import { ApiError, invalid, unavailable } from './errors.js';
import { actionFingerprint, actionShape, recoverAction, saveActionReceipt, verifyActionReview } from './guarded-actions.js';
import { discoveryDictionaryForBrief, insertFirstRequest, makeEvidence, normalizeSavedBrief, type TestHooks } from './commands.js';
import { projectRequest, requestRow, type RequestRow } from './projections.js';
import { currentProposedPlanId, currentProposedPlanVersion, insertProposedPlan } from './plan-records.js';
import { rebindPlaceSource, resolvePlaceSource } from './place-lookup.js';
import { bodyObject, guardContext, hash, nowIso, randomToken, requireCustomer, requireOrganization, requireSession, type Clock, type Session } from './security.js';
import type { AssessmentOwner, PreparedSelection, SelectionBinding } from './orbital/assessment-service.js';
export { planProjectionForId } from './plan-records.js';

export interface PlanAssessmentService {
  prepareSelection(owner:AssessmentOwner,selection:PlanSelectionInput,binding:SelectionBinding):Promise<PreparedSelection>;
  assertPreparedSelection(prepared:PreparedSelection,owner:AssessmentOwner,binding:SelectionBinding):void;
  markAttached(prepared:PreparedSelection,target:{requestId:string;organizationId:string;briefRevision:number;planVersionId:string}):void;
}
interface PlanInput {
  commandId:string;contextGeneration:number;contextToken:string;reviewToken?:string;
  target:{organizationId?:string;requestId?:string};
  expected:{requestVersion?:number;briefRevision?:number;proposedPlanVersion?:number|null};
  payload:{brief:BriefInput;selection:PlanSelectionInput};
}
interface Authorized {session:Session;row:RequestRow|null;organizationId:string}
interface Candidate {brief:NormalizedBrief;evidence:EvidenceSnapshot[];matchingState:RequestProjectionMatching}
type RequestProjectionMatching=RequestRow['matching_state'];
const commandName='saveProposedPlan' as const;
const envelope=(input:PlanInput)=>input as unknown as WorkflowCommandEnvelope<typeof commandName>;
function shape(request:FastifyRequest,command:boolean):PlanInput {
  const raw=actionShape(request,['organizationId','requestId'],command) as unknown as PlanInput;
  if((typeof raw.target.organizationId==='string')===(typeof raw.target.requestId==='string')||
    Object.keys(raw.payload).some(key=>!['brief','selection'].includes(key))||!raw.payload.brief||!raw.payload.selection)
    throw new ApiError(400,'MALFORMED','Review an exact brief and chosen proposed plan for one destination.');
  return raw;
}
function authorize(db:Database,request:FastifyRequest,clock:Clock,input:PlanInput):Authorized {
  const session=requireSession(db,request,clock);guardContext(session,request);requireCustomer(db,session);
  const row=input.target.requestId?requestRow(db,input.target.requestId):null;
  if(input.target.requestId&&!row)unavailable();
  const organizationId=row?.organization_id??input.target.organizationId!;
  requireOrganization(db,session,organizationId,true);
  return {session,row:row??null,organizationId};
}
function versions(db:Database,auth:Authorized,input:PlanInput):void {
  const expected=input.expected;
  if(!auth.row) {
    if(Object.keys(expected).length)throw new ApiError(409,'STALE_REVIEW','A first Planning save has no existing request or plan version.');
    return;
  }
  if(Object.keys(expected).some(key=>!['requestVersion','briefRevision','proposedPlanVersion'].includes(key))||
    !Number.isSafeInteger(expected.requestVersion)||!Number.isSafeInteger(expected.briefRevision)||
    expected.requestVersion!<1||expected.briefRevision!<1||
    !Object.hasOwn(expected,'proposedPlanVersion')||expected.proposedPlanVersion!==null&&(!Number.isSafeInteger(expected.proposedPlanVersion)||expected.proposedPlanVersion!<1))
    throw new ApiError(400,'MALFORMED','Review the exact request, brief and selected plan version, including No selected plan.');
  if(auth.row.aggregate_version!==expected.requestVersion||auth.row.current_brief_revision!==expected.briefRevision||
    currentProposedPlanVersion(db,auth.row.id)!==expected.proposedPlanVersion)
    throw new ApiError(409,'STALE_PLAN','The saved request or selected plan changed. Keep your choice and review its current version.');
  if(auth.row.accepted_quote_id||!['Planning','Submitted','In review','Needs information','Quote ready'].includes(auth.row.status))
    throw new ApiError(409,'ACCEPTED_WORK_LOCKED','Accepted work is read-only. Discuss a proposed change through Clarifications.');
}
function owner(auth:Authorized):AssessmentOwner {
  return {sessionHash:auth.session.cookie_hash,contextGeneration:auth.session.context_generation,audience:auth.session.audience,
    actorId:auth.session.actor_id,organizationId:auth.session.organization_id,requestId:auth.row?.id??null};
}
function binding(db:Database,auth:Authorized,brief:NormalizedBrief):SelectionBinding {
  return {organizationId:auth.organizationId,requestId:auth.row?.id??null,requestVersion:auth.row?.aggregate_version??null,
    briefRevision:auth.row?.current_brief_revision??null,currentPlanId:auth.row?currentProposedPlanId(db,auth.row.id):null,brief};
}
function candidate(db:Database,auth:Authorized,input:PlanInput,hooks?:TestHooks):Candidate {
  if(!auth.row) {
    const brief=normalizeSavedBrief(db,input as unknown as CommandEnvelope,true,true),checked=makeEvidence(db,brief,hooks);
    return {brief,evidence:checked.evidence,matchingState:checked.state};
  }
  const old=JSON.parse(auth.row.brief_json) as NormalizedBrief,raw=input.payload.brief;
  const checked=validateBriefRevision(raw,old,discoveryDictionaryForBrief(db,raw),{preparation:true,requireAreaPurposeReview:true,resolveAreaSource:(ref,area,purpose)=>resolvePlaceSource(db,ref,area,purpose)});
  if(!checked.value)invalid('Review the named Planning brief fields.',checked.fieldErrors);
  const value=checked.value;
  if(raw.areaSource===undefined&&Object.hasOwn(old,'areaSource'))value.areaSource=old.areaSource?rebindPlaceSource(old.areaSource,value.area,value.purpose):null;
  // The existing record owns the reviewed target acknowledgement; plan selection
  // never writes a changed brief or silently replaces contact/evidence/requirements.
  if(raw.areaReviewedPurpose===value.purpose&&old.areaPurposeDigest)value.areaPurposeDigest=hash(JSON.stringify([value.purpose,areaSignature(value.area)]));
  const comparable=(brief:NormalizedBrief)=>{const {areaPurposeDigest:_ack,...rest}=brief;return rest;};
  if(!isDeepStrictEqual(comparable(value),comparable(old)))
    throw new ApiError(409,'BRIEF_REVISION_REQUIRED','Save an explicit revised brief before selecting a plan for changed inputs. Your choice and input are retained.');
  return {brief:old,evidence:JSON.parse(auth.row.evidence_json) as EvidenceSnapshot[],matchingState:auth.row.matching_state};
}
function preview(prepared:PreparedSelection):ProposedPlanReview {
  return {assessment:prepared.manifest,input:prepared.input,option:prepared.option,selectedAtUtc:prepared.selectedAtUtc,
    acknowledgedUnknownIds:[...prepared.acknowledgedUnknownIds],assumptions:structuredClone(prepared.assumptions),facts:structuredClone(prepared.facts),digest:prepared.selectionDigest};
}
interface StoredReview {prepared:PreparedSelection;candidate:Candidate}
function storedReview(db:Database,token:string|undefined):StoredReview {
  const row=token?db.prepare('SELECT * FROM proposed_plan_reviews WHERE token_hash=?').get(hash(token)) as {prepared_json:string;brief_json:string;evidence_json:string;matching_state:RequestProjectionMatching}|undefined:undefined;
  if(!row)throw new ApiError(409,'REVIEW_REQUIRED','Review the exact proposed plan before saving.');
  return {prepared:JSON.parse(row.prepared_json) as PreparedSelection,candidate:{brief:JSON.parse(row.brief_json) as NormalizedBrief,evidence:JSON.parse(row.evidence_json) as EvidenceSnapshot[],matchingState:row.matching_state}};
}
export async function reviewProposedPlan(db:Database,request:FastifyRequest,clock:Clock,service:PlanAssessmentService,hooks?:TestHooks):Promise<SubmissionReview|WorkflowReview> {
  const input=shape(request,false),initial=transaction(db,()=>{const auth=authorize(db,request,clock,input);versions(db,auth,input);return auth;});
  const selected=candidate(db,initial,input,hooks),prepared=await service.prepareSelection(owner(initial),input.payload.selection,binding(db,initial,selected.brief));
  return transaction(db,()=>{
    const auth=authorize(db,request,clock,input);versions(db,auth,input);
    service.assertPreparedSelection(prepared,owner(auth),binding(db,auth,selected.brief));
    const reviewToken=randomToken(),expiresAt=new Date(Math.min(clock().getTime()+300000,Date.parse(prepared.expiresAt))).toISOString();
    db.prepare('INSERT INTO command_reviews(token_hash,command_name,actor_id,audience,organization_id,context_generation,context_token_hash,fingerprint,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(hash(reviewToken),commandName,auth.session.actor_id!,auth.session.audience,auth.organizationId,auth.session.context_generation,hash(auth.session.context_token),actionFingerprint(commandName,envelope(input)),expiresAt);
    db.prepare('INSERT INTO proposed_plan_reviews(token_hash,prepared_json,brief_json,evidence_json,matching_state) VALUES(?,?,?,?,?)')
      .run(hash(reviewToken),JSON.stringify(prepared),JSON.stringify(selected.brief),JSON.stringify(selected.evidence),selected.matchingState);
    if(!auth.row) {
      const organization=db.prepare('SELECT id,name FROM organizations WHERE id=?').get(auth.organizationId) as {id:string;name:string};
      return {reviewToken,brief:selected.brief,organization,expiresAt,contextGeneration:auth.session.context_generation,proposedPlan:preview(prepared)};
    }
    return {commandName,reviewToken,expiresAt,contextGeneration:auth.session.context_generation,requestId:auth.row.id,requestVersion:auth.row.aggregate_version,
      briefRevision:auth.row.current_brief_revision,confirmation:{request:projectRequest(db,auth.row),brief:selected.brief,proposedPlan:preview(prepared)}};
  });
}
export async function saveProposedPlan(db:Database,request:FastifyRequest,clock:Clock,service:PlanAssessmentService,hooks?:TestHooks):Promise<WorkflowOutcome&SubmissionOutcome> {
  const input=shape(request,true),fp=actionFingerprint(commandName,envelope(input));
  const initial=transaction(db,()=>{const auth=authorize(db,request,clock,input);return {...auth,receipt:recoverAction(db,commandName,envelope(input),auth.session,auth.organizationId,fp)};});
  if(initial.receipt)return initial.receipt as WorkflowOutcome&SubmissionOutcome;
  let prepared:PreparedSelection|undefined,selected:Candidate|undefined,failure:unknown;
  try {
    await hooks?.beforeProposedPlanPreflight?.({commandId:input.commandId,requestId:initial.row?.id??null});
    versions(db,initial,input);selected=candidate(db,initial,input,hooks);
    const reviewed=storedReview(db,input.reviewToken);
    if(!isDeepStrictEqual(selected.brief,reviewed.candidate.brief))throw new ApiError(409,'REVIEW_CHANGED','The brief changed after the plan review. Keep your input and review again.');
    prepared=await service.prepareSelection(owner(initial),input.payload.selection,binding(db,initial,selected.brief));
    if(prepared.selectionDigest!==reviewed.prepared.selectionDigest||!isDeepStrictEqual(preview(prepared),preview(reviewed.prepared)))
      throw new ApiError(409,'PLAN_REVIEW_CHANGED','The proposed plan changed after review. Inspect the exact current checks before saving.');
  } catch(error) {failure=error;}
  try {await hooks?.afterProposedPlanPreflight?.({commandId:input.commandId,requestId:initial.row?.id??null,failed:failure!==undefined});}
  catch(error) {failure??=error;}
  const result=transaction(db,()=>{
    const auth=authorize(db,request,clock,input),prior=recoverAction(db,commandName,envelope(input),auth.session,auth.organizationId,fp);
    if(prior)return prior as WorkflowOutcome&SubmissionOutcome;
    if(failure)throw failure;
    versions(db,auth,input);verifyActionReview(db,commandName,envelope(input),auth.session,auth.organizationId,fp,clock);
    service.assertPreparedSelection(prepared!,owner(auth),binding(db,auth,selected!.brief));
    let row=auth.row,first:SubmissionOutcome|undefined;
    if(!row) {
      first=insertFirstRequest(db,auth.session,input as unknown as CommandEnvelope,selected!.brief,{evidence:selected!.evidence,state:selected!.matchingState},clock,commandName);
      row=requestRow(db,first.requestId)!;
    }
    const now=nowIso(clock),plan=insertProposedPlan(db,row,selected!.brief,preview(prepared!),auth.session.actor_id!,now);
    service.markAttached(prepared!,{requestId:row.id,organizationId:row.organization_id,briefRevision:row.current_brief_revision,planVersionId:plan.id});
    if(!first) {
      const changed=db.prepare('UPDATE service_requests SET aggregate_version=aggregate_version+1 WHERE id=? AND aggregate_version=? AND accepted_quote_id IS NULL').run(row.id,row.aggregate_version);
      if(changed.changes!==1)throw new ApiError(409,'STALE_PLAN','The request changed before saving this plan.');
      db.prepare('INSERT INTO request_events(id,request_id,organization_id,actor_id,type,occurred_at,message) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(),row.id,row.organization_id,auth.session.actor_id!,commandName,now,`Proposed plan version ${plan.version} saved. Tentative only; no booking or schedule is created.`);
    }
    const outcome:WorkflowOutcome&SubmissionOutcome={outcome:'saved',requestId:row.id,reference:row.reference,requestVersion:first?1:row.aggregate_version+1,
      briefRevision:row.current_brief_revision,contextGeneration:auth.session.context_generation,message:'Proposed plan saved. Tentative only; staff review and scheduling remain separate.',proposedPlanId:plan.id,proposedPlanVersion:plan.version};
    saveActionReceipt(db,commandName,envelope(input),auth.session,auth.organizationId,fp,outcome,clock,true);return outcome;
  });
  if(result.outcome==='saved')await hooks?.afterWorkflowCommit?.(commandName,result);
  return result;
}
