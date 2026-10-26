import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { WorkflowCommandEnvelope, WorkflowConfirmation, WorkflowOutcome, WorkflowReview } from '../shared/workflow.js';
import type { FindingDraftInput, FindingReviewInput, ImageApproveInput, ImageMetadataInput, ImageVersionSnapshot, MaterialCommandName, NormalizedResultDraft } from '../shared/material.js';
import { createEmptyResultDraft, validateResultDraft, validateResultForPublication, validateImageMetadata, validateFindingDraft, validateImageApprove, validateFindingReview, validateReason } from '../shared/material.js';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { transaction } from './db/database.js';
import { ApiError, invalid, unavailable } from './errors.js';
import { bodyObject, guardContext, hash, nowIso, randomToken, requireSession, requireStaff, type Clock, type Session } from './security.js';
import type { TestHooks } from './commands.js';
import { projectRequest, quoteRow, requestRow, type RequestRow } from './projections.js';
import { observationIntent } from '../shared/validation.js';
import type { NormalizedBrief } from '../shared/contracts.js';
import { acceptedContext, assetRow, assets, canonical, currentImages, dateComparison, digest, entitlement, findingFacts, findingReview, findingReviewValid, findingRow, findingSnapshot, imageApprovalValid, imageFacts, imageFile, imageKey, imageReview, imageSnapshot, projectStaffResult, requestResult, resultRow, type Availability, type AssetRow, type FindingRow, type ResultRow } from './material-records.js';
import { prepareSources, readPrivateFile, type PreparedSource } from './material-files.js';

export const materialCommandNames:MaterialCommandName[]=['createResultSet','saveResultDraft','prepareDemoPair','saveImageMetadata','approveImage','publishImage','saveFindingDraft','reviewFinding','publishFinding','withdrawFinding','grantResultAccess'];
const previewed=new Set<MaterialCommandName>(['approveImage','publishImage','reviewFinding','publishFinding','withdrawFinding','grantResultAccess']);
type Input=WorkflowCommandEnvelope<MaterialCommandName>;
interface Authorized {session:Session;request:RequestRow;result?:ResultRow}
interface IO {availability:Availability;sources?:PreparedSource[]}
interface Prepared {confirmation:WorkflowConfirmation;resultMetadata?:NormalizedResultDraft;imageMetadata?:ImageMetadataInput;image?:AssetRow;finding?:FindingRow;findingDraft?:FindingDraftInput;imageApproval?:ImageApproveInput;findingApproval?:FindingReviewInput;reason?:string}
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function shape(request:FastifyRequest,name:MaterialCommandName,command:boolean):Input{
  const row=bodyObject(request);if(!object(row.target)||typeof row.target.requestId!=='string'||!row.target.requestId||!object(row.expected)||!object(row.payload)||Object.keys(row.target).some(key=>!['requestId','resultId','assetId','findingId'].includes(key))||Object.values(row.target).some(value=>typeof value!=='string'||!value||value.length>200))throw new ApiError(400,'MALFORMED','Use the saved request/result target, current versions and a JSON payload.');
  if(name==='createResultSet'&&Object.keys(row.target).length!==1)throw new ApiError(400,'MALFORMED','Result creation targets its accepted request; the server creates the result identifier.');
  if(name!=='createResultSet'&&typeof row.target.resultId!=='string')throw new ApiError(400,'MALFORMED','Name the same saved result.');
  if(['saveImageMetadata','approveImage','publishImage'].includes(name)&&typeof row.target.assetId!=='string')throw new ApiError(400,'MALFORMED','Name the exact supplied image.');
  if(['reviewFinding','publishFinding','withdrawFinding'].includes(name)&&typeof row.target.findingId!=='string')throw new ApiError(400,'MALFORMED','Name the exact saved finding.');
  if(command&&(typeof row.commandId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.commandId)))throw new ApiError(400,'MALFORMED','Retain a logical action UUID.');
  if(row.reviewToken!==undefined&&(typeof row.reviewToken!=='string'||row.reviewToken.length>200))throw new ApiError(400,'MALFORMED','The confirmation token is malformed.');return row as unknown as Input;
}
function fingerprint(name:MaterialCommandName,input:Input){return digest({command:name,target:input.target,expected:input.expected,payload:input.payload,contextGeneration:input.contextGeneration,contextToken:input.contextToken});}
function authorize(db:Database,request:FastifyRequest,clock:Clock,name:MaterialCommandName,input:Input):Authorized{
  const session=requireSession(db,request,clock);guardContext(session,request);requireStaff(db,session);const row=requestRow(db,input.target.requestId);if(!row)unavailable();
  const result=input.target.resultId?resultRow(db,input.target.resultId):undefined;if(input.target.resultId&&(!result||result.request_id!==row.id||result.organization_id!==row.organization_id))unavailable();
  return {session,request:row,result};
}
function replay(db:Database,name:MaterialCommandName,input:Input,auth:Authorized,fp:string):WorkflowOutcome|null{
  const previous=db.prepare('SELECT * FROM action_receipts WHERE command_id=?').get(input.commandId) as {command_name:string;actor_id:string;audience:string;organization_id:string;context_generation:number;context_token_hash:string;fingerprint:string;outcome_json:string}|undefined;
  if(!previous)return null;const session=auth.session;
  if(previous.command_name!==name||previous.actor_id!==session.actor_id||previous.audience!==session.audience||previous.organization_id!==auth.request.organization_id||previous.context_generation!==session.context_generation||previous.context_token_hash!==hash(session.context_token)||previous.fingerprint!==fp)throw new ApiError(409,'ACTION_CONFLICT','This action identity belongs to different reviewed work.');
  return {...JSON.parse(previous.outcome_json),outcome:'replayed',contextGeneration:session.context_generation} as WorkflowOutcome;
}
function versions(input:Input,auth:Authorized,name:MaterialCommandName){
  const expected=input.expected as unknown as Record<string,unknown>;if(Object.keys(expected).some(key=>!['requestVersion','briefRevision','materialVersion','imageContentVersion','findingContentVersion','accessVersion'].includes(key))||!Number.isSafeInteger(expected.requestVersion)||!Number.isSafeInteger(expected.briefRevision))throw new ApiError(400,'MALFORMED','Provide the reviewed request, brief and material versions.');
  if(expected.requestVersion!==auth.request.aggregate_version||expected.briefRevision!==auth.request.current_brief_revision)throw new ApiError(409,'STALE_REVIEW','The request changed. Keep your input and review current work.');
  if(name!=='createResultSet'&&expected.materialVersion!==auth.result!.material_version)throw new ApiError(409,'STALE_MATERIAL','The preparation changed. Review its current saved material.');
}
function ownImage(db:Database,input:Input,auth:Authorized):AssetRow{const image=input.target.assetId?assetRow(db,input.target.assetId):undefined;if(!image||image.result_id!==auth.result!.id||image.organization_id!==auth.request.organization_id)unavailable();if(input.expected.imageContentVersion!==image.current_version)throw new ApiError(409,'STALE_IMAGE','The image metadata changed. Review its exact current version.');return image;}
function ownFinding(db:Database,input:Input,auth:Authorized):FindingRow{const finding=findingRow(db,auth.result!.id);if(!finding||finding.id!==input.target.findingId)unavailable();if(input.expected.findingContentVersion!==finding.current_version)throw new ApiError(409,'STALE_FINDING','The finding changed. Review its exact current version.');return finding;}
function metadataReady(result:ResultRow,clock:Clock){const valid=validateResultForPublication(JSON.parse(result.metadata_json),clock());if(!valid.value)invalid('Complete the named result and rights fields before review, publication or access.',valid.fieldErrors);}
async function preflight(db:Database,config:AppConfig,name:MaterialCommandName,auth:Authorized,input:Input):Promise<IO>{
  const availability:Availability=new Map();if(name==='prepareDemoPair'){
    if(assets(db,auth.result!.id).length)throw new ApiError(409,'PAIR_ALREADY_PREPARED','The bounded pair is already prepared; replacement is outside this prototype.');
    return {availability,sources:await prepareSources(db,config)};
  }
  if(!['approveImage','publishImage','reviewFinding','publishFinding'].includes(name))return {availability};
  const required=['approveImage','publishImage'].includes(name)?[ownImage(db,input,auth)].map(asset=>imageSnapshot(db,asset.id,asset.current_version)!):currentImages(db,auth.result!);
  for(const image of required){const file=imageFile(db,image.assetId,image.contentVersion);if(!file)throw new ApiError(404,'MATERIAL_UNAVAILABLE','The exact supplied image file is unavailable.');await readPrivateFile(config,file);availability.set(imageKey(image),'AVAILABLE');}return {availability};
}
function prepare(db:Database,name:MaterialCommandName,input:Input,auth:Authorized,clock:Clock,io:IO):Prepared{
  const {request,result}=auth;const payload=input.payload as unknown as Record<string,unknown>;const confirmation:WorkflowConfirmation={request:projectRequest(db,request),...(result?{result:projectStaffResult(db,result,io.availability,clock)}:{})};const value:Prepared={confirmation};
  if(!request.accepted_quote_id||!['Accepted','Scheduled','Delivered'].includes(request.status))throw new ApiError(409,'ACCEPTED_WORK_REQUIRED','Prepare supplied material against the same accepted request.');
  if(name==='createResultSet'||name==='prepareDemoPair') {
    const quote=quoteRow(db,request.accepted_quote_id),brief=quote?JSON.parse(quote.priced_brief_json) as NormalizedBrief:null;
    if(!brief||observationIntent(brief)!=='comparison'||!['OPEN','SAR'].includes(brief.sensor))throw new ApiError(409,'RECIPE_UNSUPPORTED','The illustrative SAR comparison recipe cannot fulfill a single-observation or non-SAR request.');
  }
  if(name==='createResultSet'){if(requestResult(db,request.id))throw new ApiError(409,'RESULT_EXISTS','This request already has its bounded result set. Open that same preparation.');return value;}
  const table=dateComparison(acceptedContext(db,result!),currentImages(db,result!));confirmation.dateComparison=table;
  if(name==='saveResultDraft'){
    if(assets(db,result!.id).some(asset=>asset.published_version!==null)||findingRow(db,result!.id)?.published_version)throw new ApiError(409,'PUBLISHED_METADATA_READ_ONLY','Referenced result metadata is read-only after publication.');
    const normalized=validateResultDraft(payload.result);if(!normalized.value)invalid('Review the result metadata fields.',normalized.fieldErrors);value.resultMetadata=normalized.value;
  }else if(name==='prepareDemoPair'){
    if(assets(db,result!.id).length)throw new ApiError(409,'PAIR_ALREADY_PREPARED','The bounded pair is already prepared. Reopen its exact versions; replacement is outside this prototype.');
    if(!io.sources||io.sources.length!==2)throw new Error('The exact private source pair has not completed preparation.');
  }else if(['saveImageMetadata','approveImage','publishImage'].includes(name)){
    const image=ownImage(db,input,auth);value.image=image;confirmation.image=imageSnapshot(db,image.id,image.current_version)!;
    if(image.published_version!==null)throw new ApiError(409,'PUBLISHED_IMAGE_READ_ONLY','Published image versions are immutable.');
    if(name==='saveImageMetadata'){const normalized=validateImageMetadata(payload.metadata);if(!normalized.value)invalid('Review descriptive image metadata.',normalized.fieldErrors);value.imageMetadata=normalized.value;}
    else{
      metadataReady(result!,clock);
      if(name==='approveImage'){const approved=validateImageApprove(payload,table);if(!approved.value)invalid('Inspect and confirm the exact image/date context.',approved.fieldErrors);value.imageApproval=approved.value;}
      else{const reason=validateReason(payload);if(!reason.value)invalid('Record the publication reason.',reason.fieldErrors);value.reason=reason.value.reason;
        if(payload.imageReviewId!==image.current_review_id||!imageApprovalValid(db,result!,image))throw new ApiError(409,'IMAGE_REVIEW_REQUIRED','Approve this exact current image and relevant rights before publication.');confirmation.imageReview=imageReview(db,image.current_review_id!)!;}
    }
  }else if(name==='saveFindingDraft'){
    const existing=findingRow(db,result!.id);if(existing){if(existing.id!==input.target.findingId)throw new ApiError(409,'FINDING_EXISTS','Open the existing finding draft.');if(input.expected.findingContentVersion!==existing.current_version)throw new ApiError(409,'STALE_FINDING','Review the latest finding version.');if(existing.published_version!==null)throw new ApiError(409,'PUBLISHED_FINDING_READ_ONLY','Published or withdrawn findings cannot reopen as editable drafts.');value.finding=existing;}
    else if(input.target.findingId)unavailable();
    const parsed=validateFindingDraft(payload.finding,result!.id,currentImages(db,result!));if(!parsed.value)invalid('Review the finding, limitations and exact pair citations.',parsed.fieldErrors);value.findingDraft=parsed.value;
  }else if(['reviewFinding','publishFinding','withdrawFinding'].includes(name)){
    const finding=ownFinding(db,input,auth);value.finding=finding;const snapshot=findingSnapshot(db,finding.id,finding.current_version);confirmation.finding=snapshot;
    if(name==='withdrawFinding'){if(finding.state!=='PUBLISHED')throw new ApiError(409,'FINDING_NOT_PUBLISHED','Only the current Published finding can be withdrawn.');const parsed=validateReason(payload);if(!parsed.value)invalid('Record the withdrawal reason.',parsed.fieldErrors);value.reason=parsed.value.reason;}
    else{
      if(finding.published_version!==null)throw new ApiError(409,'PUBLISHED_FINDING_READ_ONLY','The published finding is read-only.');metadataReady(result!,clock);
      const validPair=validateFindingDraft(snapshot,result!.id,currentImages(db,result!));if(!validPair.value)invalid('The finding must cite the exact current pair.',validPair.fieldErrors);
      if(name==='reviewFinding'){const parsed=validateFindingReview(payload,table);if(!parsed.value)invalid('Inspect and confirm the finding review checklist.',parsed.fieldErrors);value.findingApproval=parsed.value;}
      else{if(payload.findingReviewId!==finding.current_review_id||!findingReviewValid(db,result!,finding))throw new ApiError(409,'FINDING_REVIEW_REQUIRED','Review the exact finding, complete current pair and rights before publication.');
        if(snapshot.citations.some(ref=>assetRow(db,ref.assetId)?.published_version!==ref.contentVersion))invalid('Publish both exact cited image versions before publishing the finding.',{citations:'Every cited Baseline and Recent image version must be Published.'});confirmation.findingReview=findingReview(db,finding.current_review_id!)!;}
    }
  }else if(name==='grantResultAccess'){
    metadataReady(result!,clock);const previous=entitlement(db,result!);if(input.expected.accessVersion!==(previous?.version??0))throw new ApiError(409,'STALE_ACCESS','Organization access changed. Review the current grant.');
    if(previous)throw new ApiError(409,'ACCESS_ALREADY_RECORDED','The initial organization grant is already recorded; broader rights management is outside this prototype.');
    const parsed=validateReason(payload);if(!parsed.value)invalid('Record the access reason.',parsed.fieldErrors);value.reason=parsed.value.reason;confirmation.access={organizationId:request.organization_id,organizationName:request.organization_name,reason:value.reason};
  }
  return value;
}
function verifyReview(db:Database,name:MaterialCommandName,input:Input,auth:Authorized,fp:string,clock:Clock){
  if(!previewed.has(name))return;if(!input.reviewToken)throw new ApiError(409,'REVIEW_REQUIRED','Preview the exact current action before confirming.');
  const row=db.prepare('SELECT * FROM command_reviews WHERE token_hash=?').get(hash(input.reviewToken)) as {command_name:string;actor_id:string;audience:string;organization_id:string;context_generation:number;context_token_hash:string;fingerprint:string;expires_at:string;consumed_at:string|null}|undefined;const s=auth.session;
  if(!row||row.command_name!==name||row.actor_id!==s.actor_id||row.audience!==s.audience||row.organization_id!==auth.request.organization_id||row.context_generation!==s.context_generation||row.context_token_hash!==hash(s.context_token)||row.fingerprint!==fp||row.expires_at<=nowIso(clock)||row.consumed_at)throw new ApiError(409,'REVIEW_EXPIRED','The confirmation changed or expired. Keep your input and review current material.');
}
function event(db:Database,result:ResultRow,session:Session,name:MaterialCommandName,reason:string,now:string){db.prepare('INSERT INTO material_events(id,result_id,organization_id,actor_id,occurred_at,kind,reason) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),result.id,result.organization_id,session.actor_id!,now,name,reason);}
function advance(db:Database,result:ResultRow,now:string){const changed=db.prepare('UPDATE result_sets SET material_version=material_version+1,updated_at=? WHERE id=? AND material_version=?').run(now,result.id,result.material_version);if(changed.changes!==1)throw new ApiError(409,'STALE_MATERIAL','The material changed before saving.');}
function mutate(db:Database,name:MaterialCommandName,input:Input,auth:Authorized,prepared:Prepared,io:IO,clock:Clock):WorkflowOutcome{
  const {session,request}=auth;let result=auth.result;const now=nowIso(clock);const outcome:WorkflowOutcome={outcome:'saved',requestId:request.id,requestVersion:request.aggregate_version,briefRevision:request.current_brief_revision,contextGeneration:session.context_generation,message:'Saved. The latest material is shown below.'};
  if(name==='createResultSet'){
    const id=randomUUID();const empty=validateResultDraft(createEmptyResultDraft()).value!;
    db.prepare('INSERT INTO result_sets(id,request_id,organization_id,accepted_quote_id,brief_revision,material_version,metadata_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?,?)').run(id,request.id,request.organization_id,request.accepted_quote_id!,request.current_brief_revision,JSON.stringify(empty),session.actor_id!,now,now);
    result=resultRow(db,id)!;outcome.resultId=id;outcome.materialVersion=1;event(db,result,session,name,'Result preparation created against accepted work.',now);return outcome;
  }
  outcome.resultId=result!.id;outcome.materialVersion=result!.material_version+1;let reason=prepared.reason??'Saved private material preparation.';
  if(name==='saveResultDraft'){
    db.prepare('UPDATE result_sets SET metadata_json=? WHERE id=?').run(JSON.stringify(prepared.resultMetadata),result!.id);
    db.prepare('UPDATE image_assets SET current_review_id=NULL WHERE result_id=? AND published_version IS NULL').run(result!.id);
    db.prepare("UPDATE findings SET current_review_id=NULL,state='DRAFT' WHERE result_id=? AND published_version IS NULL").run(result!.id);
  }else if(name==='prepareDemoPair'){
    for(const item of io.sources!){
      const file=item.file;db.prepare('INSERT INTO material_files(id,relative_path,sha256,mime_type,byte_size,width,height,created_at) VALUES(?,?,?,?,?,?,?,?)').run(file.id,file.relative_path,file.sha256,file.mime_type,file.byte_size,file.width,file.height,now);
      db.prepare("INSERT INTO image_assets(id,result_id,organization_id,role,state,current_version) VALUES(?,?,?,?,'REVIEW',1)").run(item.assetId,result!.id,result!.organization_id,item.role);
      const snapshot:ImageVersionSnapshot={assetId:item.assetId,contentVersion:1,resultId:result!.id,role:item.role,metadata:{name:item.source.name,source:item.source.source,provider:item.source.provider,sensorContext:item.source.sensorContext,permittedUse:item.source.permittedUse},
        origin:{sourceAssetId:item.source.id,recipeVersion:item.source.recipeVersion,illustrativeDate:item.source.illustrativeDate,dateBasis:'D0_UTC_CALENDAR',actualCollection:null,demonstration:true,source:item.source.source,provider:item.source.provider,sensorContext:item.source.sensorContext},width:file.width,height:file.height,contentHash:file.sha256,createdAt:now};
      db.prepare('INSERT INTO image_versions(asset_id,content_version,result_id,organization_id,material_file_id,metadata_json,created_by,created_at) VALUES(?,1,?,?,?,?,?,?)').run(item.assetId,result!.id,result!.organization_id,file.id,JSON.stringify(snapshot),session.actor_id!,now);
    }reason='The original synthetic pair was prepared privately in Review; no human approval was recorded.';
  }else if(name==='saveImageMetadata'){
    const asset=prepared.image!;const image=imageSnapshot(db,asset.id,asset.current_version)!;const next=asset.current_version+1;const file=imageFile(db,asset.id,asset.current_version)!;
    const snapshot={...image,contentVersion:next,metadata:prepared.imageMetadata!,createdAt:now};
    db.prepare('INSERT INTO image_versions(asset_id,content_version,result_id,organization_id,material_file_id,metadata_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)').run(asset.id,next,result!.id,result!.organization_id,file.id,JSON.stringify(snapshot),session.actor_id!,now);
    db.prepare('UPDATE image_assets SET current_version=?,current_review_id=NULL WHERE id=?').run(next,asset.id);
    db.prepare("UPDATE findings SET current_review_id=NULL,state='DRAFT' WHERE result_id=? AND published_version IS NULL").run(result!.id);
    outcome.assetId=asset.id;outcome.imageContentVersion=next;
  }else if(name==='approveImage'){
    const asset=prepared.image!;const id=randomUUID();const review=prepared.imageApproval!;const facts=imageFacts(db,result!,imageSnapshot(db,asset.id,asset.current_version)!);const table=dateComparison(acceptedContext(db,result!),currentImages(db,result!));
    db.prepare('INSERT INTO image_reviews(id,asset_id,content_version,result_id,organization_id,reviewer_id,reviewed_at,reason,validity_digest,facts_json,date_snapshot_json,discrepancy_acknowledged) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,asset.id,asset.current_version,result!.id,result!.organization_id,session.actor_id!,now,review.reason,digest(facts),JSON.stringify(facts),JSON.stringify(table),Number(review.discrepancyAcknowledged));
    db.prepare('UPDATE image_assets SET current_review_id=? WHERE id=?').run(id,asset.id);outcome.assetId=asset.id;outcome.imageContentVersion=asset.current_version;reason=review.reason;
  }else if(name==='publishImage'){
    const asset=prepared.image!;db.prepare("UPDATE image_assets SET state='PUBLISHED',published_version=current_version,published_at=?,publish_reason=? WHERE id=?").run(now,prepared.reason!,asset.id);outcome.assetId=asset.id;outcome.imageContentVersion=asset.current_version;
  }else if(name==='saveFindingDraft'){
    const old=prepared.finding;const id=old?.id??randomUUID();const version=(old?.current_version??0)+1;const draft=prepared.findingDraft!;
    if(!old)db.prepare("INSERT INTO findings(id,result_id,organization_id,state,current_version,created_by,created_at,updated_at) VALUES(?,?,?,'DRAFT',1,?,?,?)").run(id,result!.id,result!.organization_id,session.actor_id!,now,now);
    db.prepare('INSERT INTO finding_versions(finding_id,content_version,result_id,organization_id,answer,limitations,additional_sources,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,version,result!.id,result!.organization_id,draft.answer,draft.limitations,draft.additionalSources,session.actor_id!,now);
    for(const [index,ref] of draft.citations.entries())db.prepare('INSERT INTO finding_citations(finding_id,finding_version,ordinal,result_id,organization_id,asset_id,image_version) VALUES(?,?,?,?,?,?,?)').run(id,version,index+1,result!.id,result!.organization_id,ref.assetId,ref.contentVersion);
    if(old)db.prepare("UPDATE findings SET state='DRAFT',current_version=?,current_review_id=NULL,updated_at=? WHERE id=?").run(version,now,id);outcome.findingId=id;outcome.findingContentVersion=version;
  }else if(name==='reviewFinding'){
    const finding=prepared.finding!;const id=randomUUID();const review=prepared.findingApproval!;const facts=findingFacts(db,result!,findingSnapshot(db,finding.id,finding.current_version));const table=dateComparison(acceptedContext(db,result!),currentImages(db,result!));
    db.prepare('INSERT INTO finding_reviews(id,finding_id,content_version,result_id,organization_id,reviewer_id,reviewed_at,reason,validity_digest,facts_json,date_snapshot_json,checklist_json,discrepancy_acknowledged,limitations_explain_date_discrepancy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,finding.id,finding.current_version,result!.id,result!.organization_id,session.actor_id!,now,review.reason,digest(facts),JSON.stringify(facts),JSON.stringify(table),JSON.stringify(review.checklist),Number(review.discrepancyAcknowledged),Number(review.limitationsExplainDateDiscrepancy));
    db.prepare("UPDATE findings SET state='REVIEW',current_review_id=?,updated_at=? WHERE id=?").run(id,now,finding.id);outcome.findingId=finding.id;outcome.findingContentVersion=finding.current_version;reason=review.reason||'The exact finding and pair were actually reviewed.';
  }else if(name==='publishFinding'){
    const finding=prepared.finding!;db.prepare("UPDATE findings SET state='PUBLISHED',published_version=current_version,published_at=?,updated_at=? WHERE id=?").run(now,now,finding.id);outcome.findingId=finding.id;outcome.findingContentVersion=finding.current_version;reason='Reviewed finding published separately from organization access.';
  }else if(name==='withdrawFinding'){
    const finding=prepared.finding!;db.prepare("UPDATE findings SET state='WITHDRAWN',withdrawn_at=?,withdrawal_reason=?,updated_at=? WHERE id=?").run(now,prepared.reason!,now,finding.id);outcome.findingId=finding.id;outcome.findingContentVersion=finding.current_version;
  }else if(name==='grantResultAccess'){
    db.prepare('INSERT INTO result_entitlements(result_id,organization_id,active,version,reason,granted_by,granted_at) VALUES(?,?,1,1,?,?,?)').run(result!.id,result!.organization_id,prepared.reason!,session.actor_id!,now);
    db.prepare('INSERT INTO access_events(id,result_id,organization_id,access_version,actor_id,occurred_at,reason) VALUES(?,?,?,1,?,?,?)').run(randomUUID(),result!.id,result!.organization_id,session.actor_id!,now,prepared.reason!);
    outcome.accessVersion=1;outcome.materialVersion=result!.material_version;event(db,result!,session,name,reason,now);return outcome;
  }
  advance(db,result!,now);event(db,result!,session,name,reason,now);return outcome;
}
export async function reviewMaterial(db:Database,config:AppConfig,request:FastifyRequest,clock:Clock,name:MaterialCommandName):Promise<WorkflowReview>{
  const input=shape(request,name,false);const initial=transaction(db,()=>{const auth=authorize(db,request,clock,name,input);versions(input,auth,name);return auth;});
  if(!previewed.has(name))throw new ApiError(409,'REVIEW_NOT_REQUIRED','This direct save or preparation action does not use a confirmation preview.');
  let io:IO={availability:new Map()};let failure:unknown;
  try{io=await preflight(db,config,name,initial,input);}catch(error){failure=error;}
  return transaction(db,()=>{const auth=authorize(db,request,clock,name,input);versions(input,auth,name);if(failure)throw failure;const prepared=prepare(db,name,input,auth,clock,io);const token=randomToken();const expiresAt=new Date(clock().getTime()+5*60*1000).toISOString();const s=auth.session;
    db.prepare('INSERT INTO command_reviews(token_hash,command_name,actor_id,audience,organization_id,context_generation,context_token_hash,fingerprint,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(hash(token),name,s.actor_id!,s.audience,auth.request.organization_id,s.context_generation,hash(s.context_token),fingerprint(name,input),expiresAt);
    return {commandName:name,reviewToken:token,expiresAt,contextGeneration:s.context_generation,requestId:auth.request.id,requestVersion:auth.request.aggregate_version,briefRevision:auth.request.current_brief_revision,confirmation:prepared.confirmation};});
}
export async function executeMaterial(db:Database,config:AppConfig,request:FastifyRequest,clock:Clock,name:MaterialCommandName,hooks?:TestHooks):Promise<WorkflowOutcome>{
  const input=shape(request,name,true);const fp=fingerprint(name,input);const initial=transaction(db,()=>{const auth=authorize(db,request,clock,name,input);return {auth,saved:replay(db,name,input,auth,fp)};});if(initial.saved)return initial.saved;
  versions(input,initial.auth,name);let io:IO={availability:new Map()};let failure:unknown;try{io=await preflight(db,config,name,initial.auth,input);}catch(error){failure=error;}
  const outcome=transaction(db,()=>{const auth=authorize(db,request,clock,name,input);const prior=replay(db,name,input,auth,fp);if(prior)return prior;versions(input,auth,name);verifyReview(db,name,input,auth,fp,clock);if(failure)throw failure;const prepared=prepare(db,name,input,auth,clock,io);const result=mutate(db,name,input,auth,prepared,io,clock);const s=auth.session;
    db.prepare('INSERT INTO action_receipts(command_id,command_name,actor_id,audience,organization_id,context_generation,context_token_hash,fingerprint,outcome_json,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(input.commandId,name,s.actor_id!,s.audience,auth.request.organization_id,s.context_generation,hash(s.context_token),fp,JSON.stringify(result),nowIso(clock));
    if(previewed.has(name))db.prepare('UPDATE command_reviews SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(nowIso(clock),hash(input.reviewToken!));return result;});
  if(outcome.outcome==='saved')await hooks?.afterWorkflowCommit?.(name,outcome);return outcome;
}
