import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { ObservationCommandName, ObservationInput, ObservationProjection } from '../shared/observations.js';
import { validateObservation } from '../shared/observations.js';
import type { WorkflowCommandEnvelope, WorkflowOutcome } from '../shared/workflow.js';
import type { Database } from './db/database.js';
import { transaction } from './db/database.js';
import { ApiError, invalid, unavailable } from './errors.js';
import { guardContext, nowIso, requireOrganization, requireSession, type Clock, type Session } from './security.js';
import { requestRow, type RequestRow } from './projections.js';
import { assetRow, customerMaterialAllowed, resultRow, type ResultRow } from './material-records.js';
import { actionFingerprint, actionShape, recoverAction, saveActionReceipt } from './guarded-actions.js';
import type { TestHooks } from './commands.js';

export const observationCommandNames:ObservationCommandName[]=['createObservation','updateObservation','deleteObservation'];
interface ObservationRow {id:string;result_id:string;organization_id:string;asset_id:string;content_version:number;author_id:string;x:number;y:number;text:string;version:number;created_at:string;updated_at:string;deleted_at:string|null}
interface Authorized {session:Session;request:RequestRow;result:ResultRow;observation?:ObservationRow}
function observationRow(db:Database,id:string):ObservationRow|undefined{return db.prepare('SELECT * FROM observations WHERE id=?').get(id) as unknown as ObservationRow|undefined;}
function shape(request:FastifyRequest,name:ObservationCommandName) {
  const input=actionShape(request,['requestId','resultId','assetId','observationId'],true);
  if(!input.target.requestId||!input.target.resultId||!input.target.assetId||name==='createObservation'&&input.target.observationId||name!=='createObservation'&&!input.target.observationId)throw new ApiError(400,'MALFORMED','Name the same request, result and exact image; changes name the existing observation.');
  return input;
}
function authorize(db:Database,request:FastifyRequest,input:WorkflowCommandEnvelope,name:ObservationCommandName,clock:Clock):Authorized {
  const session=requireSession(db,request,clock);guardContext(session,request);
  const row=requestRow(db,input.target.requestId),result=resultRow(db,input.target.resultId!),asset=assetRow(db,input.target.assetId!);
  if(!row||!result||result.request_id!==row.id||result.organization_id!==row.organization_id||!asset||asset.result_id!==result.id||asset.organization_id!==result.organization_id)unavailable();
  requireOrganization(db,session,result.organization_id,true);
  // Permission for these exact bytes is checked even when a successful historical receipt exists.
  if(!customerMaterialAllowed(db,result,clock)||asset.published_version===null||asset.published_version!==input.expected.imageContentVersion)unavailable();
  let observation:ObservationRow|undefined;
  if(name!=='createObservation') {
    observation=observationRow(db,input.target.observationId!);
    if(!observation||observation.result_id!==result.id||observation.organization_id!==result.organization_id||observation.asset_id!==asset.id||observation.content_version!==asset.published_version)unavailable();
    if(observation.author_id!==session.actor_id)throw new ApiError(403,'OWN_OBSERVATION_REQUIRED','You can change only your own observations.');
    // A tombstone retains author/association authority. Deleted/version checks belong AFTER replay.
  }
  return {session,request:row,result,observation};
}
function versions(input:WorkflowCommandEnvelope,auth:Authorized,name:ObservationCommandName) {
  const expected=input.expected as unknown as Record<string,unknown>;
  if(Object.keys(expected).some(key=>!['requestVersion','briefRevision','imageContentVersion','observationVersion'].includes(key))||!Number.isSafeInteger(expected.requestVersion)||!Number.isSafeInteger(expected.briefRevision)||!Number.isSafeInteger(expected.imageContentVersion))throw new ApiError(400,'MALFORMED','Provide the current request, exact image and observation versions.');
  if(expected.requestVersion!==auth.request.aggregate_version||expected.briefRevision!==auth.request.current_brief_revision)throw new ApiError(409,'STALE_REVIEW','The saved request changed. Your point and text can be kept while you review current observations.');
  if(name!=='createObservation') {
    if(auth.observation!.deleted_at)throw new ApiError(409,'OBSERVATION_DELETED','This observation was deleted. Keep your unsent point and text while reviewing current observations.');
    if(expected.observationVersion!==auth.observation!.version)throw new ApiError(409,'STALE_OBSERVATION','This observation changed. Keep your point and text while reviewing its current saved version.');
  } else if(expected.observationVersion!==undefined)throw new ApiError(400,'MALFORMED','A new observation has no prior row version.');
}
export function projectObservations(db:Database,result:ResultRow,actorId:string,writeAllowed:boolean):ObservationProjection[] {
  const rows=db.prepare('SELECT n.*,a.name AS author_name FROM observations n JOIN actors a ON a.id=n.author_id JOIN image_assets i ON i.id=n.asset_id WHERE n.result_id=? AND n.organization_id=? AND n.deleted_at IS NULL AND i.published_version=n.content_version ORDER BY n.created_at,n.rowid').all(result.id,result.organization_id) as unknown as (ObservationRow&{author_name:string})[];
  return rows.map(row=>({id:row.id,resultId:row.result_id,organizationId:row.organization_id,assetId:row.asset_id,contentVersion:row.content_version,authorId:row.author_id,authorName:row.author_name,x:row.x,y:row.y,text:row.text,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,canEdit:writeAllowed&&row.author_id===actorId}));
}
export async function executeObservation(db:Database,request:FastifyRequest,clock:Clock,name:ObservationCommandName,hooks?:TestHooks):Promise<WorkflowOutcome> {
  const input=shape(request,name),fp=actionFingerprint(name,input);
  const outcome=transaction(db,()=>{
    const auth=authorize(db,request,input,name,clock);
    const prior=recoverAction(db,name,input,auth.session,auth.request.organization_id,fp);if(prior)return prior;
    versions(input,auth,name);
    const payload=input.payload as unknown as Record<string,unknown>;
    let point:ObservationInput|undefined;
    if(name!=='deleteObservation'){const checked=validateObservation(payload.observation);if(!checked.value)invalid('Review the point and note.',checked.fieldErrors);point=checked.value;}
    else if(Object.keys(payload).length)throw new ApiError(400,'MALFORMED','Deletion names the existing owned observation without replacement content.');
    const now=nowIso(clock),id=auth.observation?.id??randomUUID(),version=(auth.observation?.version??0)+1;
    if(name==='createObservation')db.prepare('INSERT INTO observations(id,result_id,organization_id,asset_id,content_version,author_id,x,y,text,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)').run(id,auth.result.id,auth.result.organization_id,input.target.assetId!,input.expected.imageContentVersion!,auth.session.actor_id!,point!.x,point!.y,point!.text,now,now);
    else {
      const changed=name==='updateObservation'?
        db.prepare('UPDATE observations SET x=?,y=?,text=?,version=version+1,updated_at=? WHERE id=? AND version=? AND deleted_at IS NULL').run(point!.x,point!.y,point!.text,now,id,auth.observation!.version):
        db.prepare('UPDATE observations SET version=version+1,updated_at=?,deleted_at=? WHERE id=? AND version=? AND deleted_at IS NULL').run(now,now,id,auth.observation!.version);
      if(changed.changes!==1)throw new ApiError(409,'STALE_OBSERVATION','The observation changed before saving. Keep your point and text.');
    }
    const snapshot=observationRow(db,id)!;
    db.prepare('INSERT INTO observation_events(id,observation_id,result_id,organization_id,actor_id,version,kind,snapshot_json,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,auth.result.id,auth.result.organization_id,auth.session.actor_id!,version,name==='createObservation'?'CREATE':name==='updateObservation'?'UPDATE':'DELETE',JSON.stringify({assetId:snapshot.asset_id,contentVersion:snapshot.content_version,authorId:snapshot.author_id,x:snapshot.x,y:snapshot.y,text:snapshot.text,version:snapshot.version,deletedAt:snapshot.deleted_at}),now);
    const saved:WorkflowOutcome={outcome:'saved',requestId:auth.request.id,requestVersion:auth.request.aggregate_version,briefRevision:auth.request.current_brief_revision,contextGeneration:auth.session.context_generation,resultId:auth.result.id,observationId:id,observationVersion:version,message:name==='deleteObservation'?'Your observation was deleted. Its history is retained.':'Your observation was saved on this exact image version.'};
    saveActionReceipt(db,name,input,auth.session,auth.request.organization_id,fp,saved,clock);return saved;
  });
  if(outcome.outcome==='saved')await hooks?.afterWorkflowCommit?.(name,outcome);return outcome;
}
