import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { EvidenceSnapshot, NormalizedBrief, RequestStatus } from '../shared/contracts.js';
import type { NormalizedQuote, NormalizedSchedule, WorkflowCommandEnvelope, WorkflowCommandName, WorkflowConfirmation,
  WorkflowOutcome, WorkflowReview } from '../shared/workflow.js';
import { customerReplyAllowed, revisionAllowed, statusAfterMessage, statusAfterRevision, validateBriefRevision,
  validateDecline, validateMessage, validateQuoteDraft, validateQuoteForPublication, validateSchedule } from '../shared/workflow.js';
import type { Database } from './db/database.js';
import { transaction } from './db/database.js';
import { ApiError, invalid, unavailable } from './errors.js';
import { areaSignature } from '../shared/validation.js';
import { rebindPlaceSource, resolvePlaceSource } from './place-lookup.js';
import { freezeAcceptedPlan, invalidateProposedPlanForRevision } from './plan-records.js';
import { makeEvidence, discoveryDictionaryForBrief, withReviewedEvidenceMatch, type TestHooks } from './commands.js';
import { bodyObject, guardContext, hash, nowIso, randomToken, requireOrganization, requireSession, requireStaff, type Clock, type Session } from './security.js';
import { projectDraft, projectQuote, projectRequest, quoteRow, requestRow, type QuoteRow, type RequestRow } from './projections.js';

export const workflowCommandNames:WorkflowCommandName[]=['startReview','reviseBrief','askCustomer','replyToTeam','staffReply','saveQuoteDraft','publishQuote','acceptQuote','declineQuote','recordInitialSchedule'];
const staffCommands=new Set<WorkflowCommandName>(['startReview','askCustomer','staffReply','saveQuoteDraft','publishQuote','recordInitialSchedule']);
const confirmationCommands=new Set<WorkflowCommandName>(['reviseBrief','askCustomer','replyToTeam','staffReply','publishQuote','acceptQuote','declineQuote','recordInitialSchedule']);
type Input=WorkflowCommandEnvelope;
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,entry])=>`${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function shape(request:FastifyRequest,name:WorkflowCommandName,command:boolean):Input {
  const row=bodyObject(request);
  if(!object(row.target)||typeof row.target.requestId!=='string'||!row.target.requestId||row.target.requestId.length>200||
    Object.keys(row.target).some(key=>!['requestId','quoteId'].includes(key))||
    (row.target.quoteId!==undefined&&(typeof row.target.quoteId!=='string'||!row.target.quoteId||row.target.quoteId.length>200))||!object(row.expected)||!object(row.payload)){
    throw new ApiError(400,'MALFORMED','Use an existing request target, reviewed versions and a JSON payload.');
  }
  if(['publishQuote','acceptQuote','declineQuote'].includes(name)&&typeof row.target.quoteId!=='string')throw new ApiError(400,'MALFORMED','Name the exact reviewed quote.');
  if(!['saveQuoteDraft','publishQuote','acceptQuote','declineQuote'].includes(name)&&row.target.quoteId!==undefined)throw new ApiError(400,'MALFORMED','This action targets the request, not a quote.');
  if(command&&(typeof row.commandId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.commandId)))throw new ApiError(400,'MALFORMED','Retain one logical action UUID for this attempt.');
  if(row.reviewToken!==undefined&&(typeof row.reviewToken!=='string'||row.reviewToken.length>200))throw new ApiError(400,'MALFORMED','The confirmation token is malformed.');
  return row as unknown as Input;
}
function digest(name:WorkflowCommandName,input:Input):string {
  return hash(canonical({command:name,target:input.target,expected:input.expected,payload:input.payload,contextGeneration:input.contextGeneration,contextToken:input.contextToken}));
}
function authority(db:Database,request:FastifyRequest,clock:Clock,name:WorkflowCommandName,input:Input):{session:Session;row:RequestRow}{
  const session=requireSession(db,request,clock);guardContext(session,request);
  // A customer cannot probe a staff target before the audience check.
  if(staffCommands.has(name))requireStaff(db,session);
  const row=requestRow(db,input.target.requestId);if(!row)unavailable();
  if(!staffCommands.has(name)){
    const member=requireOrganization(db,session,row.organization_id,true);
    if((name==='acceptQuote'||name==='declineQuote')&&(member.role!=='OWNER'||!member.canSelectOffers)){
      throw new ApiError(403,'OFFER_AUTHORITY_REQUIRED','Offer decisions require your current workspace Owner and explicit offer-selection authority. Ask your workspace owner.');
    }
  }
  return {session,row};
}
function replay(db:Database,name:WorkflowCommandName,input:Input,session:Session,row:RequestRow,fingerprint:string):WorkflowOutcome|null{
  const saved=db.prepare('SELECT * FROM action_receipts WHERE command_id=?').get(input.commandId) as {command_name:string;actor_id:string;audience:string;organization_id:string;context_generation:number;context_token_hash:string;fingerprint:string;outcome_json:string}|undefined;
  if(!saved)return null;
  if(saved.command_name!==name||saved.actor_id!==session.actor_id||saved.audience!==session.audience||saved.organization_id!==row.organization_id||saved.context_generation!==session.context_generation||saved.context_token_hash!==hash(session.context_token)||saved.fingerprint!==fingerprint){
    throw new ApiError(409,'ACTION_CONFLICT','This action identity belongs to different reviewed work. Review changes as a new action.');
  }
  return {...JSON.parse(saved.outcome_json),outcome:'replayed',contextGeneration:session.context_generation} as WorkflowOutcome;
}
function versions(row:RequestRow,input:Input):void{
  const expected=input.expected as unknown as Record<string,unknown>;
  if(Object.keys(expected).some(key=>!['requestVersion','briefRevision','quoteContentVersion'].includes(key))||!Number.isSafeInteger(expected.requestVersion)||!Number.isSafeInteger(expected.briefRevision)||Number(expected.requestVersion)<1||Number(expected.briefRevision)<1||
    (expected.quoteContentVersion!==undefined&&(!Number.isSafeInteger(expected.quoteContentVersion)||Number(expected.quoteContentVersion)<1))){
    throw new ApiError(400,'MALFORMED','Provide the reviewed request, brief and applicable quote versions.');
  }
  if(input.expected.requestVersion!==row.aggregate_version||input.expected.briefRevision!==row.current_brief_revision)throw new ApiError(409,'STALE_REVIEW','The request changed. Keep your input and review its latest saved version.');
}
function exactQuote(db:Database,row:RequestRow,input:Input):QuoteRow{
  const quote=input.target.quoteId?quoteRow(db,input.target.quoteId):undefined;
  if(!quote||quote.request_id!==row.id||quote.organization_id!==row.organization_id)unavailable();
  if(input.expected.quoteContentVersion!==quote.content_version)throw new ApiError(409,'STALE_QUOTE','The quote changed. Review its current saved terms.');
  return quote;
}
function preAcceptance(row:RequestRow):void{if(!revisionAllowed(row.status)||row.accepted_quote_id)throw new ApiError(409,'ACCEPTED_WORK_LOCKED','Accepted work is read-only. Discuss a proposed change through Clarifications.');}
interface RevisionCandidate {brief:NormalizedBrief;evidence:EvidenceSnapshot[];matchingState:RequestRow['matching_state']}
function prepareRevision(db:Database,row:RequestRow,input:Input,hooks?:TestHooks):RevisionCandidate{
  preAcceptance(row);
  const raw=input.payload as {brief?:unknown};const saved=JSON.parse(row.brief_json) as NormalizedBrief;
  const original=row.original_contact_json===null?saved.contact:JSON.parse(row.original_contact_json) as NormalizedBrief['contact'];
  const old={...saved,contact:original};
  const hasDiscovery=object(raw.brief)&&(raw.brief.discovery!=null||raw.brief.catalogContext!==undefined);
  const result=validateBriefRevision(raw.brief,old,hasDiscovery?discoveryDictionaryForBrief(db,raw.brief):undefined,{preparation:row.status==='Planning',requireAreaPurposeReview:row.status==='Planning'||!!old.areaPurposeDigest,resolveAreaSource:(ref,area,purpose)=>resolvePlaceSource(db,ref,area,purpose)});if(!result.value)invalid('Review the revised brief fields.',result.fieldErrors);
  const rawBrief=raw.brief as Record<string,unknown>;
  if(rawBrief.areaSource===undefined&&old.areaSource)result.value.areaSource=rebindPlaceSource(old.areaSource,result.value.area,result.value.purpose);
  if(rawBrief.areaReviewedPurpose===result.value.purpose)result.value.areaPurposeDigest=hash(JSON.stringify([result.value.purpose,areaSignature(result.value.area)]));
  const previous=JSON.parse(row.evidence_json) as EvidenceSnapshot[];
  const additions=result.value.selectedEvidence.filter(selected=>!previous.some(saved=>saved.itemId===selected.itemId&&saved.evidenceVersion===selected.evidenceVersion));
  const checked=additions.length?makeEvidence(db,{...result.value,selectedEvidence:additions},hooks):null;
  const evidence=result.value.selectedEvidence.map(selected=>{const saved=previous.find(saved=>saved.itemId===selected.itemId&&saved.evidenceVersion===selected.evidenceVersion);return saved?withReviewedEvidenceMatch(result.value!,saved):checked!.evidence.find(saved=>saved.itemId===selected.itemId&&saved.evidenceVersion===selected.evidenceVersion)!;});
  return {brief:result.value,evidence,matchingState:checked?.state??row.matching_state};
}
interface Prepared {
  confirmation:WorkflowConfirmation;revision?:RevisionCandidate;quote?:QuoteRow;terms?:NormalizedQuote;
  schedule?:NormalizedSchedule;message?:string;reason?:string;
}
function prepare(db:Database,name:WorkflowCommandName,input:Input,row:RequestRow,clock:Clock,revision?:RevisionCandidate):Prepared{
  if(row.status==='Planning'&&name!=='reviseBrief')throw new ApiError(409,'NOT_SUBMITTED','Planning is read-only for staff. The customer must explicitly submit it before review.');
  const confirmation:WorkflowConfirmation={request:projectRequest(db,row)};
  const value:Prepared={confirmation};const payload=input.payload as unknown as Record<string,unknown>;
  if(name==='startReview'){
    if(row.status!=='Submitted')throw new ApiError(409,'STATE_CONFLICT','Only a Submitted request can start review.');
  }else if(name==='reviseBrief'){
    preAcceptance(row);if(!revision)throw new Error('Revision evidence must be prepared outside the write transaction.');
    value.revision=revision;confirmation.brief=revision.brief;confirmation.evidence=revision.evidence;
  }else if(['askCustomer','replyToTeam','staffReply'].includes(name)){
    if(name==='askCustomer'&&!['In review','Needs information'].includes(row.status))throw new ApiError(409,'STATE_CONFLICT','Ask a customer while the request is In review or Needs information.');
    if(name!=='askCustomer'&&!customerReplyAllowed(row.status))throw new ApiError(409,'STATE_CONFLICT','Clarification replies are available after review has started.');
    const parsed=validateMessage(payload);if(!parsed.value)invalid('Review the clarification message.',parsed.fieldErrors);
    value.message=parsed.value.message;confirmation.message=value.message;
  }else if(name==='saveQuoteDraft'){
    preAcceptance(row);const parsed=validateQuoteDraft(payload.quote);if(!parsed.value)invalid('Review the named quote fields.',parsed.fieldErrors);
    const brief=JSON.parse(row.brief_json) as NormalizedBrief;
    const refs=new Set(brief.selectedEvidence.map(ref=>JSON.stringify([ref.itemId,ref.evidenceVersion])));
    if(parsed.value.recommendedEvidence.some(ref=>!refs.has(JSON.stringify([ref.itemId,ref.evidenceVersion]))))invalid('Recommendations must use evidence saved with this brief.',{recommendedEvidence:'Choose only this brief’s saved evidence identities and versions.'});
    value.terms=parsed.value;
    if(input.target.quoteId){
      const quote=exactQuote(db,row,input);if(quote.state!=='DRAFT')throw new ApiError(409,'QUOTE_READ_ONLY','Published quote terms are read-only. Start a fresh private draft.');
      if(quote.brief_revision!==row.current_brief_revision)throw new ApiError(409,'STALE_BRIEF','This draft prices an earlier brief. Review the current brief and start a fresh draft.');
      value.quote=quote;confirmation.quoteDraft=projectDraft(quote);
    }
  }else if(name==='publishQuote'){
    preAcceptance(row);if(!['In review','Quote ready'].includes(row.status))throw new ApiError(409,'STATE_CONFLICT','Start review and resolve missing information before publishing a quote.');
    const quote=exactQuote(db,row,input);if(quote.state!=='DRAFT')throw new ApiError(409,'QUOTE_READ_ONLY','Review a saved private draft before publication.');
    if(quote.brief_revision!==row.current_brief_revision)throw new ApiError(409,'STALE_BRIEF','This draft prices an earlier brief. Resolve the current brief and prepare a fresh quote.');
    if(payload.replacesQuoteId!==row.current_published_quote_id)throw new ApiError(409,'REPLACEMENT_CHANGED','The current offer changed. Review the exact offer that this publication will replace.');
    const parsed=validateQuoteForPublication(JSON.parse(quote.terms_json) as NormalizedQuote,JSON.parse(quote.priced_brief_json) as NormalizedBrief,clock());
    if(!parsed.value)invalid('Resolve the named publication fields and request context.',parsed.fieldErrors);
    value.quote=quote;value.terms=parsed.value;confirmation.quoteDraft=projectDraft(quote);
    confirmation.replacesQuote=row.current_published_quote_id?projectQuote(quoteRow(db,row.current_published_quote_id)!):null;
  }else if(name==='acceptQuote'||name==='declineQuote'){
    const quote=exactQuote(db,row,input);
    if(row.status!=='Quote ready'||row.current_published_quote_id!==quote.id||quote.state!=='PUBLISHED')throw new ApiError(409,'OFFER_NOT_CURRENT','This quote is no longer the current actionable offer. Review the latest saved request.');
    if(quote.brief_revision!==row.current_brief_revision)throw new ApiError(409,'STALE_BRIEF','This offer does not price the current brief.');
    const terms=JSON.parse(quote.terms_json) as NormalizedQuote;
    if(!terms.validUntil||terms.validUntil<=nowIso(clock))throw new ApiError(409,'QUOTE_EXPIRED','This quote expired. Ask the team for an updated quote.');
    value.quote=quote;confirmation.quote=projectQuote(quote);
    if(name==='declineQuote'){const parsed=validateDecline(payload);if(!parsed.value)invalid('Enter a reason for declining.',parsed.fieldErrors);value.reason=parsed.value.reason;confirmation.reason=value.reason;}
  }else if(name==='recordInitialSchedule'){
    if(row.status!=='Accepted'||!row.accepted_quote_id)throw new ApiError(409,'STATE_CONFLICT','Only accepted work without a recorded schedule can be scheduled.');
    if(db.prepare('SELECT id FROM schedules WHERE request_id=?').get(row.id))throw new ApiError(409,'SCHEDULE_EXISTS','This mission already has its initial schedule. Discuss proposed changes in Clarifications.');
    if(payload.acceptedQuoteId!==row.accepted_quote_id)throw new ApiError(409,'ACCEPTED_TERMS_CHANGED','Review the exact accepted quote before scheduling.');
    const quote=quoteRow(db,row.accepted_quote_id)!;
    const known=new Set((db.prepare('SELECT id FROM discovery_items').all() as {id:string}[]).map(item=>item.id));
    // A known real identity is not a claim of mission geometry or provider taskability.
    const savedEvidence=JSON.parse(row.evidence_json) as EvidenceSnapshot[];
    for(const item of savedEvidence) if(item.verified && 'sourceKind' in item && item.sourceKind === 'PUBLIC_REAL') known.add(item.itemId);
    const parsed=validateSchedule(payload.schedule,JSON.parse(quote.priced_brief_json) as NormalizedBrief,known);if(!parsed.value)invalid('Review the named schedule fields.',parsed.fieldErrors);
    value.schedule=parsed.value;value.quote=quote;confirmation.schedule=parsed.value;confirmation.acceptedQuote=projectQuote(quote);
  }
  return value;
}
function verifyConfirmation(db:Database,name:WorkflowCommandName,input:Input,session:Session,row:RequestRow,fingerprint:string,clock:Clock):void{
  if(!confirmationCommands.has(name))return;
  if(!input.reviewToken)throw new ApiError(409,'REVIEW_REQUIRED','Preview the exact current values before confirming.');
  const saved=db.prepare('SELECT * FROM command_reviews WHERE token_hash=?').get(hash(input.reviewToken)) as {command_name:string;actor_id:string;audience:string;organization_id:string;context_generation:number;context_token_hash:string;fingerprint:string;expires_at:string;consumed_at:string|null}|undefined;
  if(!saved||saved.command_name!==name||saved.actor_id!==session.actor_id||saved.audience!==session.audience||saved.organization_id!==row.organization_id||saved.context_generation!==session.context_generation||saved.context_token_hash!==hash(session.context_token)||saved.fingerprint!==fingerprint||saved.expires_at<=nowIso(clock)||saved.consumed_at)throw new ApiError(409,'REVIEW_EXPIRED','The confirmation changed or expired. Keep your input and review the latest saved values.');
}
export function reviewWorkflow(db:Database,request:FastifyRequest,clock:Clock,name:WorkflowCommandName,hooks?:TestHooks):WorkflowReview{
  const input=shape(request,name,false);
  const initial=transaction(db,()=>{const current=authority(db,request,clock,name,input);versions(current.row,input);return current.row;});
  const revision=name==='reviseBrief'?prepareRevision(db,initial,input,hooks):undefined;
  return transaction(db,()=>{
    const {session,row}=authority(db,request,clock,name,input);versions(row,input);const prepared=prepare(db,name,input,row,clock,revision);
    const token=randomToken();const expiresAt=new Date(clock().getTime()+5*60*1000).toISOString();
    db.prepare(`INSERT INTO command_reviews(token_hash,command_name,actor_id,audience,organization_id,context_generation,context_token_hash,fingerprint,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(hash(token),name,session.actor_id!,session.audience,row.organization_id,session.context_generation,hash(session.context_token),digest(name,input),expiresAt);
    return {commandName:name,reviewToken:token,expiresAt,contextGeneration:session.context_generation,requestId:row.id,requestVersion:row.aggregate_version,briefRevision:row.current_brief_revision,confirmation:prepared.confirmation};
  });
}
function advance(db:Database,row:RequestRow,status:RequestStatus,changes:{title?:string;briefRevision?:number;matchingState?:RequestRow['matching_state'];currentQuote?:string|null;acceptedQuote?:string|null}={}):void{
  const result=db.prepare(`UPDATE service_requests SET status=?,aggregate_version=aggregate_version+1,title=?,current_brief_revision=?,matching_state=?,current_published_quote_id=?,accepted_quote_id=? WHERE id=? AND aggregate_version=?`)
    .run(status,changes.title??row.title,changes.briefRevision??row.current_brief_revision,changes.matchingState??row.matching_state,
      Object.hasOwn(changes,'currentQuote')?changes.currentQuote!:row.current_published_quote_id,Object.hasOwn(changes,'acceptedQuote')?changes.acceptedQuote!:row.accepted_quote_id,row.id,row.aggregate_version);
  if(result.changes!==1)throw new ApiError(409,'STALE_REVIEW','The request changed before saving. Review its current values.');
}
function event(db:Database,row:RequestRow,session:Session,name:string,message:string,now:string):void{
  db.prepare('INSERT INTO request_events(id,request_id,organization_id,actor_id,type,occurred_at,message) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),row.id,row.organization_id,session.actor_id!,name,now,message);
}
function mutate(db:Database,name:WorkflowCommandName,input:Input,row:RequestRow,session:Session,prepared:Prepared,clock:Clock):WorkflowOutcome{
  const now=nowIso(clock);const outcome:WorkflowOutcome={outcome:'saved',requestId:row.id,requestVersion:row.aggregate_version,briefRevision:row.current_brief_revision,contextGeneration:session.context_generation,message:'Saved. The latest request is shown below.'};
  let history='';let status=row.status;
  if(name==='startReview'){status='In review';history='Our team started reviewing the request.';}
  else if(name==='reviseBrief'){
    const revision=prepared.revision!;const next=row.current_brief_revision+1;
    db.prepare('INSERT INTO brief_revisions(request_id,organization_id,revision,brief_json,evidence_json,created_at,actor_id) VALUES(?,?,?,?,?,?,?)').run(row.id,row.organization_id,next,JSON.stringify(revision.brief),JSON.stringify(revision.evidence),now,session.actor_id!);
    invalidateProposedPlanForRevision(db,row,revision.brief,next,session.actor_id!,now);
    if(row.current_published_quote_id)db.prepare("UPDATE quotes SET state='SUPERSEDED',updated_at=? WHERE id=? AND state='PUBLISHED'").run(now,row.current_published_quote_id);
    const first=revision.brief.purpose.split(/\r?\n/).find(line=>line.trim())!.trim();
    advance(db,row,statusAfterRevision(row.status),{title:first.length>120?`${first.slice(0,119)}…`:first,briefRevision:next,matchingState:revision.matchingState,currentQuote:null});
    outcome.briefRevision=next;history=`Brief revision ${next} saved${row.current_published_quote_id?'; the previous offer is no longer actionable':''}.`;
  }else if(['askCustomer','replyToTeam','staffReply'].includes(name)){
    const id=randomUUID();const kind=name==='askCustomer'?'STAFF_QUESTION':name==='replyToTeam'?'CUSTOMER_REPLY':'STAFF_REPLY';
    db.prepare('INSERT INTO clarifications(id,request_id,organization_id,actor_id,audience,kind,text,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,row.id,row.organization_id,session.actor_id!,session.audience,kind,prepared.message!,now);
    outcome.clarificationId=id;status=name==='askCustomer'?'Needs information':statusAfterMessage(row.status,session.audience);history=name==='askCustomer'?'Our team asked for more information.':session.audience==='CUSTOMER'?'Customer reply saved.':'Team reply saved.';
  }else if(name==='saveQuoteDraft'){
    const quote=prepared.quote;const id=quote?.id??randomUUID();const version=(quote?.content_version??0)+1;
    if(quote){const result=db.prepare("UPDATE quotes SET terms_json=?,content_version=?,updated_at=? WHERE id=? AND content_version=? AND state='DRAFT'").run(JSON.stringify(prepared.terms),version,now,id,quote.content_version);if(result.changes!==1)throw new ApiError(409,'STALE_QUOTE','The private draft changed. Review it again.');}
    else db.prepare(`INSERT INTO quotes(id,request_id,organization_id,brief_revision,content_version,state,terms_json,priced_brief_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,'DRAFT',?,?,?,?,?)`)
      .run(id,row.id,row.organization_id,row.current_brief_revision,version,JSON.stringify(prepared.terms),row.brief_json,session.actor_id!,now,now);
    outcome.quoteId=id;outcome.quoteContentVersion=version;outcome.message='Saved as draft';return outcome;
  }else if(name==='publishQuote'){
    const quote=prepared.quote!;
    if(row.current_published_quote_id)db.prepare("UPDATE quotes SET state='SUPERSEDED',updated_at=? WHERE id=? AND state='PUBLISHED'").run(now,row.current_published_quote_id);
    const published=db.prepare("UPDATE quotes SET state='PUBLISHED',published_at=?,updated_at=? WHERE id=? AND content_version=? AND state='DRAFT'").run(now,now,quote.id,quote.content_version);if(published.changes!==1)throw new ApiError(409,'STALE_QUOTE','The saved draft changed before publication.');
    advance(db,row,'Quote ready',{currentQuote:quote.id});outcome.quoteId=quote.id;outcome.quoteContentVersion=quote.content_version;history=row.current_published_quote_id?'Quote published; the earlier offer was superseded.':'Quote published for customer review.';
  }else if(name==='acceptQuote'||name==='declineQuote'){
    const quote=prepared.quote!;const accept=name==='acceptQuote';
    db.prepare('INSERT INTO quote_decisions(id,quote_id,request_id,organization_id,decision,actor_id,decided_at,reason) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),quote.id,row.id,row.organization_id,accept?'ACCEPT':'DECLINE',session.actor_id!,now,prepared.reason??'');
    const changed=db.prepare("UPDATE quotes SET state=?,updated_at=? WHERE id=? AND state='PUBLISHED'").run(accept?'ACCEPTED':'DECLINED',now,quote.id);if(changed.changes!==1)throw new ApiError(409,'OFFER_NOT_CURRENT','The offer changed before the decision.');
    advance(db,row,accept?'Accepted':'In review',{currentQuote:null,...(accept?{acceptedQuote:quote.id}:{})});
    if(accept)freezeAcceptedPlan(db,row,quote.id,now);
    outcome.quoteId=quote.id;outcome.quoteContentVersion=quote.content_version;history=accept?'Quote accepted on behalf of the organization.':'Quote declined; the request returned to team review.';
    outcome.message=accept?'Quote accepted. Our team will schedule the mission.':'Quote declined. Our team can review your request and prepare another quote.';
  }else if(name==='recordInitialSchedule'){
    const id=randomUUID();const plan=prepared.schedule!;
    db.prepare('INSERT INTO schedules(id,request_id,organization_id,accepted_quote_id,version,plan_json,start_utc,end_utc,created_by,created_at) VALUES(?,?,?,?,1,?,?,?,?,?)')
      .run(id,row.id,row.organization_id,row.accepted_quote_id!,JSON.stringify(plan),plan.startUtc,plan.endUtc,session.actor_id!,now);
    advance(db,row,'Scheduled');outcome.scheduleId=id;history='Initial mission schedule recorded. This is a plan, not confirmation of operator execution.';
  }
  if(!['reviseBrief','publishQuote','acceptQuote','declineQuote','recordInitialSchedule'].includes(name))advance(db,row,status);
  outcome.requestVersion=row.aggregate_version+1;event(db,row,session,name,history,now);return outcome;
}
export async function executeWorkflow(db:Database,request:FastifyRequest,clock:Clock,name:WorkflowCommandName,hooks?:TestHooks):Promise<WorkflowOutcome>{
  const input=shape(request,name,true);const fingerprint=digest(name,input);
  const initial=transaction(db,()=>{const {session,row}=authority(db,request,clock,name,input);return {row,saved:replay(db,name,input,session,row,fingerprint)};});
  if(initial.saved)return initial.saved;
  versions(initial.row,input);
  // Only an unsaved revision assembles evidence outside the mutation transaction.
  const revision=name==='reviseBrief'?prepareRevision(db,initial.row,input,hooks):undefined;
  const result=transaction(db,()=>{
    const {session,row}=authority(db,request,clock,name,input);const existing=replay(db,name,input,session,row,fingerprint);if(existing)return existing;
    versions(row,input);verifyConfirmation(db,name,input,session,row,fingerprint,clock);const prepared=prepare(db,name,input,row,clock,revision);
    const outcome=mutate(db,name,input,row,session,prepared,clock);
    db.prepare('INSERT INTO action_receipts(command_id,command_name,actor_id,audience,organization_id,context_generation,context_token_hash,fingerprint,outcome_json,committed_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(input.commandId,name,session.actor_id!,session.audience,row.organization_id,session.context_generation,hash(session.context_token),fingerprint,JSON.stringify(outcome),nowIso(clock));
    if(confirmationCommands.has(name))db.prepare('UPDATE command_reviews SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(nowIso(clock),hash(input.reviewToken!));
    return outcome;
  });
  if(result.outcome==='saved')await hooks?.afterWorkflowCommit?.(name,result);
  return result;
}
