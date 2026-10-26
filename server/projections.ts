import type { EvidenceSnapshot, NormalizedBrief, RequestProjection } from '../shared/contracts.js';
import type { BriefRevisionProjection, ClarificationMessage, NormalizedQuote, NormalizedSchedule, QuoteDecision,
  QuoteDraftProjection, QuoteProjection, ScheduleProjection, StaffRequestProjection } from '../shared/workflow.js';
import type { Database } from './db/database.js';
import { unavailable } from './errors.js';
import { requireOrganization, requireStaff, type Session } from './security.js';
import { deliveryForRequest } from './delivery-records.js';
import type { MissionsSnapshot, RequestListPage, TrackingRequest } from '../shared/tracking.js';
import type { ResultLink } from '../shared/material.js';
import type { Clock } from './security.js';
import { Temporal } from '@js-temporal/polyfill';
import { validateQuoteDraft } from '../shared/workflow.js';
import { proposedPlansForRequest } from './plan-records.js';

export interface RequestRow {
  id:string;reference:string;organization_id:string;organization_name:string;original_actor_id:string;
  actor_name:string;submitted_at:string|null;submitted_actor_id:string|null;submitted_actor_name:string|null;first_saved_at:string;title:string;status:RequestProjection['status'];aggregate_version:number;current_brief_revision:number;
  matching_state:RequestProjection['matchingState'];brief_json:string;evidence_json:string;original_contact_json:string|null;
  current_published_quote_id:string|null;accepted_quote_id:string|null;
}
export interface QuoteRow {
  id:string;request_id:string;organization_id:string;brief_revision:number;content_version:number;
  state:'DRAFT'|'PUBLISHED'|'ACCEPTED'|'DECLINED'|'SUPERSEDED';terms_json:string;priced_brief_json:string;
  created_by:string;created_at:string;updated_at:string;published_at:string|null;actor_name:string;
}
export function quoteRow(db:Database,id:string):QuoteRow|undefined {
  return db.prepare('SELECT q.*,a.name AS actor_name FROM quotes q JOIN actors a ON a.id=q.created_by WHERE q.id=?').get(id) as unknown as QuoteRow|undefined;
}
export function projectDraft(row:QuoteRow):QuoteDraftProjection {
  return {id:row.id,requestId:row.request_id,organizationId:row.organization_id,state:'DRAFT',briefRevision:row.brief_revision,
    contentVersion:row.content_version,terms:JSON.parse(row.terms_json) as NormalizedQuote,createdAt:row.created_at,updatedAt:row.updated_at,actorId:row.created_by,actorName:row.actor_name};
}
function storedUtc(value:unknown):boolean{
  if(typeof value!=='string'||!value.endsWith('Z'))return false;
  try{return Temporal.Instant.from(value).toString({smallestUnit:'millisecond'})===value;}catch{return false;}
}
function pricedBriefShape(brief:NormalizedBrief):boolean{
  const area=brief.area,window=brief.requestedWindow,deadline=brief.deadline;
  return typeof brief.purpose==='string'&&brief.family==='EO'&&['OPEN','SAR','VISIBLE','SWIR','THERMAL'].includes(brief.sensor)&&
    Array.isArray(brief.outputs)&&brief.outputs.length===1&&brief.outputs[0]==='Imagery'&&
    !!area&&typeof area==='object'&&Number.isFinite(area.latitude)&&Number.isFinite(area.longitude)&&Number.isFinite(area.radiusKm)&&
    ['coordinates','globe'].includes(area.method)&&Number.isSafeInteger(area.generation)&&area.generation>0&&typeof brief.areaConfirmation==='string'&&
    typeof brief.baselineDate==='string'&&typeof brief.recentDate==='string'&&typeof brief.timezone==='string'&&
    !!window&&typeof window==='object'&&storedUtc(window.startUtc)&&storedUtc(window.endUtc)&&
    typeof window.localStart==='string'&&typeof window.localEnd==='string'&&typeof window.timezone==='string'&&
    (deadline===null||!!deadline&&typeof deadline==='object'&&storedUtc(deadline.utc)&&typeof deadline.local==='string'&&typeof deadline.timezone==='string')&&
    Array.isArray(brief.unknowns)&&brief.unknowns.every(value=>typeof value==='string')&&Array.isArray(brief.selectedEvidence)&&
    typeof brief.spectralRequirements==='string'&&typeof brief.timingNotes==='string'&&
    !!brief.contact&&typeof brief.contact.name==='string'&&typeof brief.contact.email==='string'&&typeof brief.contact.organization==='string';
}
export function projectQuote(row:QuoteRow):QuoteProjection {
  if(row.state==='DRAFT'||!row.published_at)throw new Error('A private draft cannot be projected as a published quote.');
  const terms=JSON.parse(row.terms_json) as NormalizedQuote,pricedBrief=JSON.parse(row.priced_brief_json) as NormalizedBrief;
  if(!terms||typeof terms!=='object'||Array.isArray(terms)||!pricedBrief||typeof pricedBrief!=='object'||Array.isArray(pricedBrief))throw new Error('Saved quote details could not be read.');
  const checked=validateQuoteDraft({...terms,priceType:terms.priceType??'',amount:terms.amount??'',minimum:terms.minimum??'',maximum:terms.maximum??'',validUntil:terms.validUntil??''}).value;
  // This checks stored shape only. An expired historical quote is still readable;
  // current expiry remains a separate guard on a genuinely new decision.
  if(!checked||!checked.priceType||!checked.currency||!checked.scope.trim()||!checked.licence.trim()||!storedUtc(terms.validUntil)||
    (checked.priceType==='FIXED'&&checked.amount===null)||(checked.priceType==='RANGE'&&(checked.minimum===null||checked.maximum===null))||
    (['priceType','amount','minimum','maximum','currency','scope','licence','validUntil','recommendation'] as const).some(key=>terms[key]!==checked[key])||
    JSON.stringify(terms.recommendedEvidence)!==JSON.stringify(checked.recommendedEvidence)||!pricedBriefShape(pricedBrief))throw new Error('Saved quote details could not be read.');
  return {id:row.id,requestId:row.request_id,organizationId:row.organization_id,state:row.state,briefRevision:row.brief_revision,
    contentVersion:row.content_version,terms,pricedBrief,
    createdAt:row.created_at,publishedAt:row.published_at,actorId:row.created_by,actorName:row.actor_name};
}
const selection = `SELECT r.*,o.name AS organization_name,a.name AS actor_name,sa.name AS submitted_actor_name,b.brief_json,b.evidence_json
  FROM service_requests r JOIN organizations o ON o.id=r.organization_id JOIN actors a ON a.id=r.original_actor_id
  LEFT JOIN actors sa ON sa.id=r.submitted_actor_id
  JOIN brief_revisions b ON b.request_id=r.id AND b.revision=r.current_brief_revision`;
export function requestRow(db:Database,id:string):RequestRow|undefined {
  return db.prepare(`${selection} WHERE r.id=?`).get(id) as unknown as RequestRow|undefined;
}
export function authorizeRequest(db:Database,session:Session,row:RequestRow):void {
  if(session.audience==='STAFF')requireStaff(db,session);else requireOrganization(db,session,row.organization_id);
}
function quoteFacts(db:Database,row:RequestRow){
  const visible=(db.prepare("SELECT q.*,a.name AS actor_name FROM quotes q JOIN actors a ON a.id=q.created_by WHERE q.request_id=? AND q.state<>'DRAFT' ORDER BY q.published_at DESC,q.id").all(row.id) as unknown as QuoteRow[]).map(projectQuote);
  const currentQuote=visible.find(q=>q.id===row.current_published_quote_id)??null;
  const acceptedQuote=visible.find(q=>q.id===row.accepted_quote_id)??null;
  if((row.current_published_quote_id&&!currentQuote)||(row.accepted_quote_id&&!acceptedQuote)||
    (row.status==='Quote ready'&&!currentQuote)||(['Accepted','Scheduled','Delivered'].includes(row.status)&&!acceptedQuote))throw new Error('Saved quote details could not be read.');
  return {currentQuote,acceptedQuote,earlierQuotes:visible.filter(q=>q.id!==currentQuote?.id&&q.id!==acceptedQuote?.id)};
}
function scheduleFacts(db:Database,row:RequestRow):ScheduleProjection|null{
  const plan=db.prepare(`SELECT s.*,a.name AS actor_name,q.brief_revision FROM schedules s JOIN actors a ON a.id=s.created_by JOIN quotes q ON q.id=s.accepted_quote_id WHERE s.request_id=?`).get(row.id) as {id:string;organization_id:string;accepted_quote_id:string;brief_revision:number;version:number;created_at:string;created_by:string;actor_name:string;plan_json:string;start_utc:string;end_utc:string}|undefined;
  if(!plan){if(['Scheduled','Delivered'].includes(row.status))throw new Error('The saved window could not be read.');return null;}
  const value=JSON.parse(plan.plan_json) as NormalizedSchedule;
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.provider!=='string'||!value.provider.trim()||
    !Number.isFinite(Date.parse(value.startUtc))||!Number.isFinite(Date.parse(value.endUtc))||value.startUtc>=value.endUtc||
    value.startUtc!==plan.start_utc||value.endUtc!==plan.end_utc||typeof value.timezone!=='string'||
    !Array.isArray(value.trackedItemIds)||value.trackedItemIds.some(id=>typeof id!=='string')||typeof value.notes!=='string')throw new Error('The saved window could not be read.');
  return {...value,id:plan.id,requestId:row.id,organizationId:plan.organization_id,acceptedQuoteId:plan.accepted_quote_id,
    briefRevision:plan.brief_revision,version:plan.version,createdAt:plan.created_at,actorId:plan.created_by,actorName:plan.actor_name};
}
export function projectRequest(db:Database,row:RequestRow,availability?:TrackingRequest['detailAvailability']):RequestProjection {
  const brief=JSON.parse(row.brief_json) as NormalizedBrief,evidence=JSON.parse(row.evidence_json) as EvidenceSnapshot[];
  if(!brief||typeof brief!=='object'||Array.isArray(brief)||!Array.isArray(evidence))throw new Error('The saved request brief could not be read.');
  const history=db.prepare(`SELECT e.id,e.type,a.name AS actorName,e.occurred_at AS occurredAt,e.message
    FROM request_events e JOIN actors a ON a.id=e.actor_id WHERE e.request_id=? ORDER BY e.occurred_at,e.rowid`).all(row.id) as unknown as RequestProjection['history'];
  const messages=db.prepare(`SELECT c.id,c.kind,c.audience,c.actor_id AS actorId,a.name AS actorName,c.created_at AS occurredAt,c.text AS message
    FROM clarifications c JOIN actors a ON a.id=c.actor_id WHERE c.request_id=? ORDER BY c.created_at,c.rowid`).all(row.id) as unknown as ClarificationMessage[];
  const revisions=(db.prepare(`SELECT b.revision,b.created_at,b.actor_id,a.name AS actor_name,b.brief_json,b.evidence_json
    FROM brief_revisions b JOIN actors a ON a.id=b.actor_id WHERE b.request_id=? ORDER BY b.revision`).all(row.id) as {revision:number;created_at:string;actor_id:string;actor_name:string;brief_json:string;evidence_json:string}[])
    .map(b=>({revision:b.revision,createdAt:b.created_at,actorId:b.actor_id,actorName:b.actor_name,brief:JSON.parse(b.brief_json) as NormalizedBrief,evidence:JSON.parse(b.evidence_json) as EvidenceSnapshot[]} satisfies BriefRevisionProjection));
  let quotes:Pick<RequestProjection,'currentQuote'|'acceptedQuote'|'earlierQuotes'>={currentQuote:null,acceptedQuote:null,earlierQuotes:[]};
  try{quotes=quoteFacts(db,row);}catch(error){if(!availability)throw error;availability.quote='UNAVAILABLE';}
  const decisions=db.prepare(`SELECT d.id,d.quote_id AS quoteId,d.decision,d.actor_id AS actorId,a.name AS actorName,d.decided_at AS occurredAt,
    CASE WHEN d.decision='ACCEPT' THEN NULL ELSE d.reason END AS reason FROM quote_decisions d JOIN actors a ON a.id=d.actor_id WHERE d.request_id=? ORDER BY d.decided_at,d.rowid`).all(row.id) as unknown as QuoteDecision[];
  let schedule:ScheduleProjection|null=null;
  try{schedule=scheduleFacts(db,row);}catch(error){if(!availability)throw error;availability.window='UNAVAILABLE';}
  return {id:row.id,reference:row.reference,organizationId:row.organization_id,organizationName:row.organization_name,
    title:row.title,status:row.status,requestVersion:row.aggregate_version,briefRevision:row.current_brief_revision,
    firstSavedAt:row.first_saved_at,submittedAt:row.submitted_at,submittedBy:row.submitted_actor_name,
    originalSubmittedContact:row.original_contact_json===null?null:JSON.parse(row.original_contact_json),brief,evidence,history,matchingState:row.matching_state,
    humanReview:row.status==='Planning'?'Not submitted':'Manual review required',responseTarget:null,messages,revisions,...quotes,decisions,schedule,delivery:deliveryForRequest(db,row.id),...proposedPlansForRequest(db,row)};
}
export function projectStaffRequest(db:Database,row:RequestRow):StaffRequestProjection {
  const quoteDrafts=(db.prepare("SELECT q.*,a.name AS actor_name FROM quotes q JOIN actors a ON a.id=q.created_by WHERE q.request_id=? AND q.state='DRAFT' ORDER BY q.updated_at DESC,q.id").all(row.id) as unknown as QuoteRow[]).map(projectDraft);
  return {...projectRequest(db,row),quoteDrafts};
}
export function detail(db:Database,session:Session,id:string):RequestProjection|StaffRequestProjection {
  const row=requestRow(db,id);if(!row)unavailable();authorizeRequest(db,session,row);return session.audience==='STAFF'?projectStaffRequest(db,row):projectRequest(db,row);
}
export function normalizeReference(value:string):string { return value.toUpperCase().replace(/O/g,'0').replace(/[IL]/g,'1').replace(/[^A-Z0-9]/g,''); }
export function requestList(db:Database,session:Session,organizationId:string|null,query:Record<string,unknown>):Omit<RequestListPage,'contextGeneration'|'serverNow'> {
  if(organizationId)requireOrganization(db,session,organizationId);else requireStaff(db,session);
  const search=typeof query.search==='string'?query.search:'';const status=typeof query.status==='string'?query.status:'';
  const where:string[]=[],values:(string|number)[]=[];
  if(organizationId){where.push('r.organization_id=?');values.push(organizationId);}
  else where.push("r.status<>'Planning'");
  if(status){where.push('r.status=?');values.push(status);}
  if(search){
    // Escape SQL pattern syntax: a literal percent or underscore is not a wildcard.
    const pattern=`%${search.replace(/!/g,'!!').replace(/%/g,'!%').replace(/_/g,'!_')}%`;
    const parts=["r.title LIKE ? ESCAPE '!'","'Earth observation' LIKE ? ESCAPE '!'","COALESCE(json_extract(b.brief_json,'$.discovery.effective.place'),'') LIKE ? ESCAPE '!'"];
    values.push(pattern,pattern,pattern);
    const normalized=normalizeReference(search);
    if(normalized&&/^[A-Za-z0-9\s-]+$/.test(search)){
      parts.push("replace(replace(replace(replace(upper(r.reference),'-',''),'O','0'),'I','1'),'L','1') LIKE ? ESCAPE '!'");values.push(`%${normalized}%`);
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  const from=selection.slice(selection.indexOf(' FROM '));const conditions=where.length?` WHERE ${where.join(' AND ')}`:'';
  const total=(db.prepare(`SELECT count(*) AS total${from}${conditions}`).get(...values) as {total:number}).total;
  const page=Number(query.page??1),pageSize=20,offset=(page-1)*pageSize;
  const rows=db.prepare(`${selection}${conditions} ORDER BY COALESCE(r.submitted_at,r.first_saved_at) DESC,r.id ASC LIMIT ? OFFSET ?`).all(...values,pageSize,offset) as unknown as RequestRow[];
  const hasNext=offset+rows.length<total;
  return {requests:rows.map(row=>projectRequest(db,row)),total,page,pageSize,hasNext,nextPage:hasNext?page+1:null};
}

/** Caller holds one read transaction. Only child-detail reads may degrade to unknown. */
export function missionsSnapshot(db:Database,session:Session,organizationId:string,clock:Clock,readResult:(requestId:string)=>ResultLink|null):MissionsSnapshot{
  requireOrganization(db,session,organizationId);
  const total=(db.prepare('SELECT count(*) AS total FROM service_requests WHERE organization_id=?').get(organizationId) as {total:number}).total;
  const rows=db.prepare(`${selection} WHERE r.organization_id=? ORDER BY COALESCE(r.submitted_at,r.first_saved_at) DESC,r.id ASC`).all(organizationId) as unknown as RequestRow[];
  if(rows.length!==total)throw new Error('The saved workspace request records could not all be read.');
  const requests=rows.map(row=>{
    const detailAvailability:TrackingRequest['detailAvailability']={quote:'KNOWN',window:'KNOWN',result:'KNOWN'};
    const base=projectRequest(db,row,detailAvailability);let result:ResultLink|null=null;
    try{result=readResult(row.id);}catch{detailAvailability.result='UNAVAILABLE';}
    return {...base,result,detailAvailability} satisfies TrackingRequest;
  });
  return {requests,contextGeneration:session.context_generation,serverNow:clock().toISOString(),
    scope:{kind:'ALL_AUTHORIZED_WORKSPACE_REQUESTS',organizationId,loaded:requests.length,total},
    completeness:requests.some(row=>Object.values(row.detailAvailability).includes('UNAVAILABLE'))?'PARTIAL':'COMPLETE'};
}
