import type { FastifyRequest } from 'fastify';
import type { WorkflowCommandEnvelope, WorkflowCommandName, WorkflowOutcome, WorkflowReview, WorkflowConfirmation } from '../shared/workflow.js';
import type { Database } from './db/database.js';
import { ApiError } from './errors.js';
import { bodyObject, hash, nowIso, randomToken, type Clock, type Session } from './security.js';
import { digest } from './material-records.js';

const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
/** Envelope parsing never establishes target authority or checks new-action versions. */
export function actionShape(request:FastifyRequest,targetKeys:string[],command:boolean):WorkflowCommandEnvelope {
  const row=bodyObject(request);
  if(!object(row.target)||!object(row.expected)||!object(row.payload)||Object.keys(row.target).some(key=>!targetKeys.includes(key))||Object.values(row.target).some(value=>typeof value!=='string'||!value||value.length>200))throw new ApiError(400,'MALFORMED','Use the saved target, current versions and a JSON payload.');
  if(command&&(typeof row.commandId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.commandId)))throw new ApiError(400,'MALFORMED','Retain a logical action UUID.');
  if(row.reviewToken!==undefined&&(typeof row.reviewToken!=='string'||row.reviewToken.length>200))throw new ApiError(400,'MALFORMED','The confirmation token is malformed.');
  return row as unknown as WorkflowCommandEnvelope;
}
export const actionFingerprint=(name:WorkflowCommandName,input:WorkflowCommandEnvelope)=>digest({command:name,target:input.target,expected:input.expected,payload:input.payload,contextGeneration:input.contextGeneration,contextToken:input.contextToken});
/** Call only AFTER current session/context/target/role/ownership authorization. */
export function recoverAction(db:Database,name:WorkflowCommandName,input:WorkflowCommandEnvelope,session:Session,organizationId:string,fp:string):WorkflowOutcome|null {
  const row=db.prepare('SELECT * FROM action_receipts WHERE command_id=?').get(input.commandId) as {command_name:string;actor_id:string;audience:string;organization_id:string;context_generation:number;context_token_hash:string;fingerprint:string;outcome_json:string}|undefined;
  if(!row)return null;
  if(row.command_name!==name||row.actor_id!==session.actor_id||row.audience!==session.audience||row.organization_id!==organizationId||row.context_generation!==session.context_generation||row.context_token_hash!==hash(session.context_token)||row.fingerprint!==fp)throw new ApiError(409,'ACTION_CONFLICT','This action identity belongs to different reviewed work.');
  return {...JSON.parse(row.outcome_json),outcome:'replayed',contextGeneration:session.context_generation} as WorkflowOutcome;
}
export function verifyActionReview(db:Database,name:WorkflowCommandName,input:WorkflowCommandEnvelope,session:Session,organizationId:string,fp:string,clock:Clock) {
  if(!input.reviewToken)throw new ApiError(409,'REVIEW_REQUIRED','Preview the exact current action before confirming.');
  const row=db.prepare('SELECT * FROM command_reviews WHERE token_hash=?').get(hash(input.reviewToken)) as {command_name:string;actor_id:string;audience:string;organization_id:string;context_generation:number;context_token_hash:string;fingerprint:string;expires_at:string;consumed_at:string|null}|undefined;
  if(!row||row.command_name!==name||row.actor_id!==session.actor_id||row.audience!==session.audience||row.organization_id!==organizationId||row.context_generation!==session.context_generation||row.context_token_hash!==hash(session.context_token)||row.fingerprint!==fp||row.expires_at<=nowIso(clock)||row.consumed_at)throw new ApiError(409,'REVIEW_EXPIRED','The confirmation changed or expired. Keep your input and review current work.');
}
export function createActionReview(db:Database,name:WorkflowCommandName,input:WorkflowCommandEnvelope,session:Session,organizationId:string,confirmation:WorkflowConfirmation,clock:Clock):WorkflowReview {
  const token=randomToken(),expiresAt=new Date(clock().getTime()+5*60*1000).toISOString();
  db.prepare('INSERT INTO command_reviews(token_hash,command_name,actor_id,audience,organization_id,context_generation,context_token_hash,fingerprint,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(hash(token),name,session.actor_id!,session.audience,organizationId,session.context_generation,hash(session.context_token),actionFingerprint(name,input),expiresAt);
  return {commandName:name,reviewToken:token,expiresAt,contextGeneration:session.context_generation,requestId:confirmation.request.id,requestVersion:confirmation.request.requestVersion,briefRevision:confirmation.request.briefRevision,confirmation};
}
export function saveActionReceipt(db:Database,name:WorkflowCommandName,input:WorkflowCommandEnvelope,session:Session,organizationId:string,fp:string,outcome:WorkflowOutcome,clock:Clock,consumeReview=false) {
  db.prepare('INSERT INTO action_receipts(command_id,command_name,actor_id,audience,organization_id,context_generation,context_token_hash,fingerprint,outcome_json,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.commandId,name,session.actor_id!,session.audience,organizationId,session.context_generation,hash(session.context_token),fp,JSON.stringify(outcome),nowIso(clock));
  if(consumeReview)db.prepare('UPDATE command_reviews SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(nowIso(clock),hash(input.reviewToken!));
}
