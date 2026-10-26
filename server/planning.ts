import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { CommandEnvelope, EvidenceSnapshot, NormalizedBrief, SubmissionOutcome, SubmissionReview } from '../shared/contracts.js';
import { validateBriefRevision, type WorkflowCommandEnvelope, type WorkflowOutcome, type WorkflowReview } from '../shared/workflow.js';
import { areaSignature } from '../shared/validation.js';
import type { Database } from './db/database.js';
import { transaction } from './db/database.js';
import { ApiError, invalid, unavailable } from './errors.js';
import { actionFingerprint, actionShape, createActionReview, recoverAction, saveActionReceipt, verifyActionReview } from './guarded-actions.js';
import { discoveryDictionaryForBrief, makeEvidence, reviewFirstSave, saveFirstRequest, withReviewedEvidenceMatch, type TestHooks } from './commands.js';
import { projectRequest, requestRow, type RequestRow } from './projections.js';
import { rebindPlaceSource, resolvePlaceSource } from './place-lookup.js';
import { invalidateProposedPlanForRevision } from './plan-records.js';
import { guardContext, hash, nowIso, requireOrganization, requireSession, type Clock, type Session } from './security.js';

export const reviewPlanningSave=(db:Database,request:FastifyRequest,clock:Clock):SubmissionReview=>reviewFirstSave(db,request,clock,'savePlanningRequest');
export const savePlanningRequest=(db:Database,request:FastifyRequest,clock:Clock,hooks?:TestHooks):Promise<SubmissionOutcome>=>saveFirstRequest(db,request,clock,'savePlanningRequest',hooks);
const name='submitPlanningRequest' as const;
type Input=WorkflowCommandEnvelope<typeof name>;
function shape(request:FastifyRequest,command:boolean):Input {
  const input=actionShape(request,['requestId'],command) as Input;
  if(typeof input.target.requestId!=='string'||Object.keys(input.target).length!==1||Object.keys(input.payload).some(key=>key!=='brief'))throw new ApiError(400,'MALFORMED','Submit the same saved Planning request and its reviewed brief.');
  return input;
}
function authorize(db:Database,request:FastifyRequest,clock:Clock,input:Input):{session:Session;row:RequestRow} {
  const session=requireSession(db,request,clock);guardContext(session,request);
  const row=requestRow(db,input.target.requestId);if(!row)unavailable();
  requireOrganization(db,session,row.organization_id,true);return {session,row};
}
function current(row:RequestRow,input:Input):void {
  const expected=input.expected;
  if(Object.keys(expected).some(key=>!['requestVersion','briefRevision'].includes(key))||!Number.isSafeInteger(expected.requestVersion)||!Number.isSafeInteger(expected.briefRevision)||expected.requestVersion<1||expected.briefRevision<1)throw new ApiError(400,'MALFORMED','Use the current request and brief versions.');
  if(row.aggregate_version!==expected.requestVersion||row.current_brief_revision!==expected.briefRevision)throw new ApiError(409,'STALE_REVIEW','The Planning request changed. Keep your input and review its latest version.');
  if(row.status!=='Planning'||row.submitted_at!==null||row.accepted_quote_id)throw new ApiError(409,'STATE_CONFLICT','This request has already been submitted. Open the same saved request.');
}
interface Prepared {brief:NormalizedBrief;evidence:EvidenceSnapshot[];matchingState:RequestRow['matching_state'];changed:boolean}
function prepare(db:Database,row:RequestRow,input:Input,hooks?:TestHooks):Prepared {
  const old=JSON.parse(row.brief_json) as NormalizedBrief;
  const {contact,...raw}=input.payload.brief;
  // Contact completion is allowed only at this explicit first submission. Reuse
  // revision validation so untouched saved wall times keep their resolved UTC.
  const checked=validateBriefRevision(raw,{...old,contact},discoveryDictionaryForBrief(db,input.payload.brief),{
    requireAreaPurposeReview:true,resolveAreaSource:(reference,area,purpose)=>resolvePlaceSource(db,reference,area,purpose),
  });
  if(!checked.value)invalid('Review the named brief fields before submission.',checked.fieldErrors);
  if(input.payload.brief.acknowledged!==true)invalid('Confirm the explicit request for staff review.',{acknowledged:'Confirm this request for staff review before submission.'});
  const brief=checked.value;
  if(input.payload.brief.areaReviewedPurpose===brief.purpose)brief.areaPurposeDigest=hash(JSON.stringify([brief.purpose,areaSignature(brief.area)]));
  if(input.payload.brief.areaSource===undefined && Object.hasOwn(old,'areaSource')) brief.areaSource=old.areaSource ? rebindPlaceSource(old.areaSource,brief.area,brief.purpose) : null;
  const previous=JSON.parse(row.evidence_json) as EvidenceSnapshot[];
  const additions=brief.selectedEvidence.filter(ref=>!previous.some(item=>item.itemId===ref.itemId&&item.evidenceVersion===ref.evidenceVersion));
  const check=additions.length?makeEvidence(db,{...brief,selectedEvidence:additions},hooks):null;
  const evidence=brief.selectedEvidence.map(ref=>{const saved=previous.find(item=>item.itemId===ref.itemId&&item.evidenceVersion===ref.evidenceVersion);return saved?withReviewedEvidenceMatch(brief,saved):check!.evidence.find(item=>item.itemId===ref.itemId&&item.evidenceVersion===ref.evidenceVersion)!;});
  return {brief,evidence,matchingState:check?.state??row.matching_state,changed:!isDeepStrictEqual(brief,old)};
}
export function reviewPlanningSubmit(db:Database,request:FastifyRequest,clock:Clock,hooks?:TestHooks):WorkflowReview {
  const input=shape(request,false);
  const initial=transaction(db,()=>{const auth=authorize(db,request,clock,input);current(auth.row,input);return auth.row;});
  const prepared=prepare(db,initial,input,hooks);
  return transaction(db,()=>{const {session,row}=authorize(db,request,clock,input);current(row,input);
    return createActionReview(db,name,input,session,row.organization_id,{request:projectRequest(db,row),brief:prepared.brief,evidence:prepared.evidence},clock);
  });
}
export async function submitPlanningRequest(db:Database,request:FastifyRequest,clock:Clock,hooks?:TestHooks):Promise<WorkflowOutcome> {
  const input=shape(request,true),fp=actionFingerprint(name,input);
  const initial=transaction(db,()=>{const {session,row}=authorize(db,request,clock,input);return {row,receipt:recoverAction(db,name,input,session,row.organization_id,fp)};});
  if(initial.receipt)return initial.receipt;
  current(initial.row,input);const prepared=prepare(db,initial.row,input,hooks);
  const result=transaction(db,()=>{
    const {session,row}=authorize(db,request,clock,input),prior=recoverAction(db,name,input,session,row.organization_id,fp);if(prior)return prior;
    current(row,input);verifyActionReview(db,name,input,session,row.organization_id,fp,clock);
    const now=nowIso(clock),revision=row.current_brief_revision+(prepared.changed?1:0);
    if(prepared.changed)db.prepare('INSERT INTO brief_revisions(request_id,organization_id,revision,brief_json,evidence_json,created_at,actor_id) VALUES(?,?,?,?,?,?,?)').run(row.id,row.organization_id,revision,JSON.stringify(prepared.brief),JSON.stringify(prepared.evidence),now,session.actor_id!);
    if(prepared.changed)invalidateProposedPlanForRevision(db,row,prepared.brief,revision,session.actor_id!,now);
    const first=prepared.brief.purpose.split(/\r?\n/).find(line=>line.trim())!.trim(),title=first.length>120?`${first.slice(0,119)}…`:first;
    const changed=db.prepare("UPDATE service_requests SET status='Submitted',submitted_at=?,submitted_actor_id=?,original_contact_json=?,current_brief_revision=?,aggregate_version=aggregate_version+1,title=?,matching_state=? WHERE id=? AND status='Planning' AND aggregate_version=? AND submitted_at IS NULL")
      .run(now,session.actor_id!,JSON.stringify(prepared.brief.contact),revision,title,prepared.matchingState,row.id,row.aggregate_version);
    if(changed.changes!==1)throw new ApiError(409,'STALE_REVIEW','The Planning request changed before submission.');
    db.prepare('INSERT INTO request_events(id,request_id,organization_id,actor_id,type,occurred_at,message) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),row.id,row.organization_id,session.actor_id!,'Submitted',now,prepared.changed?`Request submitted for manual review with reviewed brief revision ${revision}.`:'Request submitted for manual review.');
    const outcome:WorkflowOutcome={outcome:'saved',requestId:row.id,requestVersion:row.aggregate_version+1,briefRevision:revision,contextGeneration:session.context_generation,message:'The same request is now Submitted for manual review.'};
    saveActionReceipt(db,name,input,session,row.organization_id,fp,outcome,clock,true);return outcome;
  });
  if(result.outcome==='saved')await hooks?.afterWorkflowCommit?.(name,result);return result;
}
