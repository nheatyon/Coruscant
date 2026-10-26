import { randomUUID } from 'node:crypto';
import type { NormalizedBrief, RequestProjection } from '../shared/contracts.js';
import type { AcceptedPlanSnapshot, ProposedPlanProjection } from '../shared/plan-contracts.js';
import type { ProposedPlanReview } from '../shared/workflow.js';
import type { Database } from './db/database.js';
import { ApiError, unavailable } from './errors.js';
import type { RequestRow } from './projections.js';
import { calculationInputDigest } from './orbital/plan-input.js';

interface PlanRow {
  id:string;request_id:string;organization_id:string;version:number;brief_revision:number;
  assessment_id:string;manifest_digest:string;option_id:string;input_digest:string;selection_digest:string;
  selection_json:string;created_at:string;actor_id:string;actor_name:string;
}
interface PlanState {request_id:string;organization_id:string;current_plan_id:string|null;accepted_frozen:number;accepted_plan_id:string|null;accepted_quote_id:string|null;accepted_at:string|null}
const rowsSql='SELECT p.*,a.name AS actor_name FROM proposed_plan_versions p JOIN actors a ON a.id=p.actor_id';
function stateFor(db:Database,requestId:string):PlanState|undefined {
  return db.prepare('SELECT * FROM request_proposed_plan_state WHERE request_id=?').get(requestId) as unknown as PlanState|undefined;
}
function projectPlan(db:Database,row:PlanRow,state:PlanState|undefined,accepted=false):ProposedPlanProjection {
  const value=JSON.parse(row.selection_json) as ProposedPlanReview;
  if(!value||!value.assessment||value.assessment.assessmentId!==row.assessment_id||value.assessment.manifestDigest!==row.manifest_digest||
    !value.option||value.option.id!==row.option_id||value.digest!==row.selection_digest||!Array.isArray(value.facts))throw new Error('The saved proposed plan could not be read.');
  const invalid=db.prepare('SELECT invalidated_at,reason FROM proposed_plan_invalidations WHERE plan_version_id=?').get(row.id) as {invalidated_at:string;reason:string}|undefined;
  const current=state?.current_plan_id===row.id;
  if(current&&invalid)throw new Error('The current proposed plan association could not be read.');
  return {...value,id:row.id,requestId:row.request_id,organizationId:row.organization_id,version:row.version,briefRevision:row.brief_revision,
    createdAt:row.created_at,actorId:row.actor_id,actorName:row.actor_name,
    state:accepted?'ACCEPTED_SNAPSHOT':current?'CURRENT':'INVALIDATED',invalidatedAt:invalid?.invalidated_at??null,invalidationReason:invalid?.reason??null};
}
/** Caller first authorizes this exact request; knowing either identifier grants nothing. */
export function planProjectionForId(db:Database,requestId:string,planId:string):ProposedPlanProjection {
  const row=db.prepare(`${rowsSql} WHERE p.id=? AND p.request_id=?`).get(planId,requestId) as unknown as PlanRow|undefined;
  if(!row)unavailable();
  const state=stateFor(db,requestId);
  return projectPlan(db,row,state,state?.accepted_frozen===1&&state.accepted_plan_id===row.id);
}
export function proposedPlansForRequest(db:Database,row:Pick<RequestRow,'id'|'organization_id'|'accepted_quote_id'>):Pick<RequestProjection,'currentProposedPlan'|'earlierProposedPlans'|'acceptedPlan'> {
  const state=stateFor(db,row.id),plans=db.prepare(`${rowsSql} WHERE p.request_id=? ORDER BY p.version DESC`).all(row.id) as unknown as PlanRow[];
  if(state&&state.organization_id!==row.organization_id)throw new Error('The proposed plan workspace association could not be read.');
  const current=state?.current_plan_id?plans.find(plan=>plan.id===state.current_plan_id):undefined;
  if(state?.current_plan_id&&!current)throw new Error('The selected proposed plan could not be read.');
  let acceptedPlan:AcceptedPlanSnapshot|null=null;
  if(row.accepted_quote_id) {
    // Legacy accepted work predates plan selection and truthfully has no selected plan.
    if(!state)acceptedPlan={plan:null};
    else {
      if(state.accepted_frozen!==1||state.accepted_quote_id!==row.accepted_quote_id)throw new Error('The accepted plan snapshot could not be read.');
      const accepted=state.accepted_plan_id?plans.find(plan=>plan.id===state.accepted_plan_id):undefined;
      if(state.accepted_plan_id&&!accepted)throw new Error('The accepted plan snapshot could not be read.');
      acceptedPlan={plan:accepted?projectPlan(db,accepted,state,true):null};
    }
  } else if(state?.accepted_frozen)throw new Error('The accepted plan association could not be read.');
  return {currentProposedPlan:current?projectPlan(db,current,state):null,earlierProposedPlans:plans.filter(plan=>plan.id!==current?.id).map(plan=>projectPlan(db,plan,state)),acceptedPlan};
}
function invalidate(db:Database,row:Pick<RequestRow,'id'|'organization_id'>,planId:string,briefRevision:number,actorId:string,now:string,reason:string):void {
  db.prepare('INSERT INTO proposed_plan_invalidations(plan_version_id,request_id,organization_id,brief_revision,invalidated_at,reason,actor_id) VALUES(?,?,?,?,?,?,?)')
    .run(planId,row.id,row.organization_id,briefRevision,now,reason,actorId);
  db.prepare('UPDATE request_proposed_plan_state SET current_plan_id=NULL WHERE request_id=? AND current_plan_id=? AND accepted_frozen=0').run(row.id,planId);
}
/** Contact-only completion keeps the exact plan and its originating brief FK. */
export function invalidateProposedPlanForRevision(db:Database,row:RequestRow,next:NormalizedBrief,revision:number,actorId:string,now:string):boolean {
  const state=stateFor(db,row.id);
  if(!state?.current_plan_id||calculationInputDigest(JSON.parse(row.brief_json) as NormalizedBrief)===calculationInputDigest(next))return false;
  if(row.accepted_quote_id||state.accepted_frozen)throw new ApiError(409,'ACCEPTED_WORK_LOCKED','Accepted work is read-only. Discuss a proposed change through Clarifications.');
  const reason=`Technical planning inputs changed in brief revision ${revision}; the earlier plan remains historical as calculated.`;
  invalidate(db,row,state.current_plan_id,revision,actorId,now,reason);
  db.prepare('INSERT INTO request_events(id,request_id,organization_id,actor_id,type,occurred_at,message) VALUES(?,?,?,?,?,?,?)')
    .run(randomUUID(),row.id,row.organization_id,actorId,'Proposed plan invalidated',now,reason);
  return true;
}
export function currentProposedPlanVersion(db:Database,requestId:string):number|null {
  const row=db.prepare('SELECT p.version FROM request_proposed_plan_state s JOIN proposed_plan_versions p ON p.id=s.current_plan_id WHERE s.request_id=?').get(requestId) as {version:number}|undefined;
  return row?.version??null;
}
export function currentProposedPlanId(db:Database,requestId:string):string|null {return stateFor(db,requestId)?.current_plan_id??null;}
export function insertProposedPlan(db:Database,row:RequestRow,brief:NormalizedBrief,review:ProposedPlanReview,actorId:string,now:string):{id:string;version:number} {
  if(row.accepted_quote_id||stateFor(db,row.id)?.accepted_frozen)throw new ApiError(409,'ACCEPTED_WORK_LOCKED','Accepted work is read-only. Discuss a proposed change through Clarifications.');
  const version=Number((db.prepare('SELECT COALESCE(max(version),0)+1 AS next FROM proposed_plan_versions WHERE request_id=?').get(row.id) as {next:number}).next);
  const previous=stateFor(db,row.id)?.current_plan_id;
  if(previous)invalidate(db,row,previous,row.current_brief_revision,actorId,now,`Superseded by selected plan version ${version}; its original calculation remains historical.`);
  const id=randomUUID();
  db.prepare('INSERT INTO proposed_plan_versions(id,request_id,organization_id,version,brief_revision,assessment_id,manifest_digest,option_id,input_digest,selection_digest,selection_json,created_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,row.id,row.organization_id,version,row.current_brief_revision,review.assessment.assessmentId,review.assessment.manifestDigest,review.option.id,calculationInputDigest(brief),review.digest,JSON.stringify(review),now,actorId);
  db.prepare('INSERT INTO request_proposed_plan_state(request_id,organization_id,current_plan_id) VALUES(?,?,?) ON CONFLICT(request_id) DO UPDATE SET current_plan_id=excluded.current_plan_id')
    .run(row.id,row.organization_id,id);
  return {id,version};
}
export function freezeAcceptedPlan(db:Database,row:RequestRow,quoteId:string,now:string):void {
  const state=stateFor(db,row.id),planId=state?.current_plan_id??null;
  if(state?.accepted_frozen)throw new ApiError(409,'ACCEPTED_WORK_LOCKED','The accepted plan snapshot is already immutable.');
  if(planId) {
    const plan=db.prepare('SELECT input_digest FROM proposed_plan_versions WHERE id=? AND request_id=? AND organization_id=?').get(planId,row.id,row.organization_id) as {input_digest:string}|undefined;
    if(!plan||plan.input_digest!==calculationInputDigest(JSON.parse(row.brief_json) as NormalizedBrief))throw new ApiError(409,'STALE_PLAN','Review the current brief and proposed plan before accepting.');
  }
  db.prepare('INSERT INTO request_proposed_plan_state(request_id,organization_id,current_plan_id,accepted_frozen,accepted_plan_id,accepted_quote_id,accepted_at) VALUES(?,?,?,1,?,?,?) ON CONFLICT(request_id) DO UPDATE SET accepted_frozen=1,accepted_plan_id=excluded.accepted_plan_id,accepted_quote_id=excluded.accepted_quote_id,accepted_at=excluded.accepted_at')
    .run(row.id,row.organization_id,planId,planId,quoteId,now);
}
