import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { CatalogItem, CommandEnvelope, EvidenceSnapshot, NormalizedBrief, SubmissionOutcome, SubmissionReview } from '../shared/contracts.js';
import { areaSignature, validateBrief } from '../shared/validation.js';
import { resolvePlaceSource } from './place-lookup.js';
import { makeDiscoveryDictionary, matchEvidence } from '../shared/discovery.js';
import type { DiscoveryDictionary, DiscoveryEvidence, DiscoveryValues } from '../shared/discovery-contracts.js';
import type { WorkflowCommandName, WorkflowOutcome } from '../shared/workflow.js';
import type { Database } from './db/database.js';
import { transaction } from './db/database.js';
import { ApiError, invalid } from './errors.js';
import { captureCatalog, resolveRealEvidence } from './orbital/repository.js';
import { bodyObject, guardContext, hash, nowIso, randomToken, requireOrganization, requireSession, type Clock, type Session } from './security.js';

export interface TestHooks {
  preliminaryCheck?: () => void;
  afterSubmitCommit?: (outcome: SubmissionOutcome) => void | Promise<void>;
  afterWorkflowCommit?: (name:WorkflowCommandName,outcome:WorkflowOutcome) => void | Promise<void>;
  beforeMaterialRead?: (image:{assetId:string;contentVersion:number;variant:'thumbnail'|'preview'})=>void|Promise<void>;
  afterMaterialRead?: (image:{assetId:string;contentVersion:number;variant:'thumbnail'|'preview'})=>void|Promise<void>;
  beforeDeliveryPreflight?: (attempt:{commandId:string;requestId:string;resultId:string})=>void|Promise<void>;
  afterDeliveryPreflight?: (attempt:{commandId:string;requestId:string;resultId:string;failed:boolean})=>void|Promise<void>;
  beforeProposedPlanPreflight?: (attempt:{commandId:string;requestId:string|null})=>void|Promise<void>;
  afterProposedPlanPreflight?: (attempt:{commandId:string;requestId:string|null;failed:boolean})=>void|Promise<void>;
}
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([key,entry])=>`${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
function shape(request:FastifyRequest,needsCommand:boolean):CommandEnvelope {
  const input=bodyObject(request);
  if(typeof input.target!=='object'||input.target===null||Array.isArray(input.target)||typeof input.expected!=='object'||input.expected===null||Array.isArray(input.expected)||typeof input.payload!=='object'||input.payload===null||Array.isArray(input.payload))throw new ApiError(400,'MALFORMED','The reviewed command target, expected versions and payload are required.');
  const target=input.target as Record<string,unknown>;
  if(typeof target.organizationId!=='string'||Object.keys(target).length!==1)throw new ApiError(400,'MALFORMED','Submission names one organization, without a request ID.');
  if(needsCommand&&(typeof input.commandId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.commandId)||typeof input.reviewToken!=='string'||input.reviewToken.length>200))throw new ApiError(400,'MALFORMED','A logical action UUID and reviewed confirmation are required.');
  return input as unknown as CommandEnvelope;
}
type FirstSaveName = 'submitRequest' | 'savePlanningRequest' | 'saveProposedPlan';
function fingerprint(input:CommandEnvelope,name:FirstSaveName='submitRequest'):string {
  return hash(canonical({command:name,target:input.target,expected:input.expected,payload:input.payload,
    contextGeneration:input.contextGeneration,contextToken:input.contextToken}));
}
function authority(db:Database,request:FastifyRequest,clock:Clock,input:CommandEnvelope):Session {
  const session=requireSession(db,request,clock);guardContext(session,request);
  requireOrganization(db,session,input.target.organizationId!,true);return session;
}
function receipt(db:Database,session:Session,input:CommandEnvelope,digest:string,name:FirstSaveName='submitRequest'):SubmissionOutcome|null {
  const previous=db.prepare('SELECT * FROM action_receipts WHERE command_id=?').get(input.commandId) as {command_name:string;actor_id:string;audience:string;organization_id:string;context_generation:number;context_token_hash:string;fingerprint:string;outcome_json:string}|undefined;
  if(!previous)return null;
  if(previous.command_name!==name||previous.actor_id!==session.actor_id||previous.audience!==session.audience||previous.organization_id!==input.target.organizationId||previous.context_generation!==session.context_generation||previous.context_token_hash!==hash(session.context_token)||previous.fingerprint!==digest)throw new ApiError(409,'ACTION_CONFLICT','This action identity belongs to different reviewed work. Review changed work as a new action.');
  return {...JSON.parse(previous.outcome_json),outcome:'replayed',contextGeneration:session.context_generation} as SubmissionOutcome;
}
export function publicDiscoveryDictionary(db:Database) {
  const items=(db.prepare('SELECT definition_json FROM discovery_items ORDER BY id').all() as {definition_json:string}[]).map(row=>JSON.parse(row.definition_json) as CatalogItem);
  return makeDiscoveryDictionary(items);
}
/** A captured real dictionary is independent of the optional shortlist and current list page. */
export function discoveryDictionaryForBrief(db:Database,raw:unknown):DiscoveryDictionary {
  const context = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as {catalogContext?:unknown}).catalogContext : undefined;
  if(context && typeof context === 'object' && !Array.isArray(context) && (context as {sourceKind?:unknown}).sourceKind === 'PUBLIC_REAL') {
    const ref = context as {snapshotVersion?:unknown;factVersion?:unknown};
    if(ref.snapshotVersion === null && ref.factVersion === null) return {operators:[],countries:[],places:[]};
    if(typeof ref.snapshotVersion !== 'string' || typeof ref.factVersion !== 'string') invalid('Review the real catalog context.',{catalogContext:'Capture an available catalog version or retain the explicitly unavailable manual path.'});
    const captured=captureCatalog(db,ref.snapshotVersion);
    if(!captured || captured.factVersion !== ref.factVersion) throw new ApiError(409,'CATALOG_VERSION_CHANGED','The catalog context is unavailable or changed. Your brief is retained; review its source version.');
    return captured.dictionary;
  }
  return publicDiscoveryDictionary(db);
}
export function normalizeSavedBrief(db:Database,input:CommandEnvelope,preparation=false,requireAreaReview=preparation):NormalizedBrief {
  const raw=input.payload.brief;
  const result=validateBrief(raw,{...(raw&&(raw.discovery!=null||raw.catalogContext!==undefined)?{discoveryDictionary:discoveryDictionaryForBrief(db,raw)}:{}),preparation,requireAcknowledgement:!preparation,requireAreaPurposeReview:requireAreaReview,resolveAreaSource:(reference,area,purpose)=>resolvePlaceSource(db,reference,area,purpose)});
  if(!result.value)invalid('Review the named brief fields before continuing.',result.fieldErrors);
  if(raw.areaReviewedPurpose===result.value.purpose)result.value.areaPurposeDigest=hash(JSON.stringify([result.value.purpose,areaSignature(result.value.area)]));
  return result.value;
}
export function reviewSubmission(db:Database,request:FastifyRequest,clock:Clock):SubmissionReview {return reviewFirstSave(db,request,clock,'submitRequest');}
export function reviewFirstSave(db:Database,request:FastifyRequest,clock:Clock,name:FirstSaveName):SubmissionReview {
  const input=shape(request,false);
  transaction(db,()=>{ authority(db,request,clock,input); if(Object.keys(input.expected).length)throw new ApiError(409,'STALE_REVIEW','A new submission does not use an existing request version.'); });
  const value=normalizeSavedBrief(db,input,name==='savePlanningRequest'); // Full immutable source matching occurs outside a SQL write lock.
  return transaction(db,()=>{
    const session=authority(db,request,clock,input);
    const token=randomToken();
    const expiresAt=new Date(clock().getTime()+5*60*1000).toISOString();
    db.prepare(`INSERT INTO command_reviews(token_hash,command_name,actor_id,audience,organization_id,context_generation,context_token_hash,fingerprint,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(hash(token),name,session.actor_id!,session.audience,input.target.organizationId!,session.context_generation,hash(session.context_token),fingerprint(input,name),expiresAt);
    const org=db.prepare('SELECT id,name FROM organizations WHERE id=?').get(input.target.organizationId!) as {id:string;name:string};
    return {reviewToken:token,brief:value,organization:org,expiresAt,contextGeneration:session.context_generation};
  });
}
/** Evaluate a NEW brief revision against frozen canonical facts, never rewrite old snapshot JSON. */
export function withReviewedEvidenceMatch(value:NormalizedBrief,snapshot:EvidenceSnapshot):EvidenceSnapshot {
  if(!snapshot.verified)return snapshot;
  const effective:DiscoveryValues=value.discovery?.effective??{family:value.family,sensor:value.sensor,outputs:value.outputs,maxResolutionM:value.maxResolutionM,cloudCover:value.cloudCover,revisitHours:value.revisitHours,
    keyword:null,operator:null,ownerCountry:null,place:null,timezone:value.timezone,window:value.requestedWindow?{startUtc:value.requestedWindow.startUtc,endUtc:value.requestedWindow.endUtc}:null,deadline:value.deadline?.utc??null,delivery:null,documentedOnly:false};
  // Real snapshots retain exact independently sourced matching facts; legacy demo JSON stays legacy.
  const item:DiscoveryEvidence = 'sourceKind' in snapshot && snapshot.sourceKind === 'PUBLIC_REAL' ? snapshot.matchingFacts : {id:snapshot.itemId,name:snapshot.name,family:'EO',type:'catalog',operator:snapshot.operator,ownerCountry:snapshot.ownerCountry,sensors:snapshot.sensors,resolutionM:snapshot.resolutionM,
    evidenceVersion:snapshot.evidenceVersion,source:snapshot.source??'',checkedAt:snapshot.checkedAt??'',demonstration:true,caveats:[...snapshot.caveats],status:'unknown',launchDate:null};
  const checked=matchEvidence([item],effective,value.discovery?.exclusions??[]),match=checked.matches[0];
  return {...snapshot,matchReasons:[...(match?.reasons??checked.excluded[0]?.reasons??[])],uncertainties:[...(match?.unknowns??[])],matchesReviewedCriteria:!!match};
}
export function makeEvidence(db:Database,value:NormalizedBrief,hooks?:TestHooks):{evidence:EvidenceSnapshot[];state:'Preliminary check ready'|'Automatic check unavailable'} {
  try {
    hooks?.preliminaryCheck?.();
    // This reads exact local immutable evidence, never a provider availability check.
    if(value.catalogContext?.sourceKind === 'PUBLIC_REAL' && !value.catalogContext.snapshotVersion) throw new Error('Real source is unavailable.');
    db.prepare('SELECT count(*) AS count FROM evidence_versions').get();
    const evidence=value.selectedEvidence.map(selection=>{
      if(selection.itemId.startsWith('norad:') && value.catalogContext?.sourceKind === 'PUBLIC_REAL') {
        const real=resolveRealEvidence(db,selection.itemId,selection.evidenceVersion,value);
        if(real) return real;
        return {itemId:selection.itemId,evidenceVersion:selection.evidenceVersion,name:selection.itemId,verified:false,operator:null,ownerCountry:null,sensors:null,resolutionM:null,source:null,checkedAt:null,caveats:['The exact real evidence version is unavailable. Selection is retained as an unverified intention for staff review.']};
      }
      const stored=db.prepare('SELECT snapshot_json FROM evidence_versions WHERE item_id=? AND evidence_version=?').get(selection.itemId,selection.evidenceVersion) as {snapshot_json:string}|undefined;
      if(!stored)return {itemId:selection.itemId,evidenceVersion:selection.evidenceVersion,name:selection.itemId,verified:false,operator:null,ownerCountry:null,sensors:null,resolutionM:null,source:null,checkedAt:null,caveats:['Selected evidence could not be verified. This selection is retained as an intention for manual review.']};
      const item=JSON.parse(stored.snapshot_json) as CatalogItem;
      return withReviewedEvidenceMatch(value,{itemId:item.id,evidenceVersion:item.evidenceVersion,name:item.name,verified:true,operator:item.operator,ownerCountry:item.ownerCountry,sensors:item.sensors,resolutionM:item.resolutionM,source:item.source,checkedAt:item.checkedAt,caveats:[...item.caveats]});
    });
    return {evidence,state:'Preliminary check ready'};
  }catch{
    return {state:'Automatic check unavailable',evidence:value.selectedEvidence.map(item=>({...item,name:item.itemId,verified:false,operator:null,ownerCountry:null,sensors:null,resolutionM:null,source:null,checkedAt:null,caveats:['The local preliminary check is unavailable. This selection is retained as an unverified intention. Staff review must be explicitly requested.']}))};
  }
}
function reference():string {
  const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes=randomBytes(10);const text=Array.from(bytes,value=>alphabet[value&31]).join('');
  return `SRS-${text.slice(0,5)}-${text.slice(5)}`;
}
export async function submitRequest(db:Database,request:FastifyRequest,clock:Clock,hooks?:TestHooks):Promise<SubmissionOutcome> {return saveFirstRequest(db,request,clock,'submitRequest',hooks);}
/** SQL-only insertion, called inside the caller's one atomic command transaction. */
export function insertFirstRequest(db:Database,session:Session,input:CommandEnvelope,value:NormalizedBrief,preliminary:ReturnType<typeof makeEvidence>,clock:Clock,name:FirstSaveName):SubmissionOutcome {
  const id=randomUUID(),now=nowIso(clock),planning=name!=='submitRequest';let humanReference='';
  for(let attempt=0;attempt<8;attempt++){
    humanReference=reference();
    if(!db.prepare('SELECT 1 FROM service_requests WHERE reference=?').get(humanReference))break;
    humanReference='';
  }
  if(!humanReference)throw new ApiError(503,'RETRY_LATER','A reference could not be allocated. Retry this unchanged action.',undefined,true);
  const firstLine=value.purpose.split(/\r?\n/).find(line=>line.trim())?.trim()??'Earth observation request';
  const title=firstLine.length>120?`${firstLine.slice(0,119)}…`:firstLine;
  db.prepare(`INSERT INTO service_requests(id,reference,organization_id,original_actor_id,original_contact_json,submitted_at,submitted_actor_id,first_saved_at,title,status,aggregate_version,current_brief_revision,matching_state)
    VALUES(?,?,?,?,?,?,?,?,?,?,1,1,?)`).run(id,humanReference,input.target.organizationId!,session.actor_id!,planning?null:JSON.stringify(value.contact),planning?null:now,planning?null:session.actor_id!,now,title,planning?'Planning':'Submitted',preliminary.state);
  db.prepare('INSERT INTO brief_revisions(request_id,organization_id,revision,brief_json,evidence_json,created_at,actor_id) VALUES(?,?,1,?,?,?,?)').run(id,input.target.organizationId!,JSON.stringify(value),JSON.stringify(preliminary.evidence),now,session.actor_id!);
  db.prepare('INSERT INTO request_events(id,request_id,organization_id,actor_id,type,occurred_at,message) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,input.target.organizationId!,session.actor_id!,planning?'Planning saved':'Submitted',now,planning?'Planning request saved; not submitted for staff review.':'Request submitted for manual review.');
  return {outcome:'saved',requestId:id,reference:humanReference,requestVersion:1,contextGeneration:session.context_generation};
}
export async function saveFirstRequest(db:Database,request:FastifyRequest,clock:Clock,name:FirstSaveName,hooks?:TestHooks):Promise<SubmissionOutcome> {
  const input=shape(request,true);const digest=fingerprint(input,name);
  const previous=transaction(db,()=>{const session=authority(db,request,clock,input);return receipt(db,session,input,digest,name);});
  if(previous)return previous;
  if(Object.keys(input.expected).length)throw new ApiError(409,'STALE_REVIEW','A new submission does not use an existing request version.');
  const value=normalizeSavedBrief(db,input,name==='savePlanningRequest');const preliminary=makeEvidence(db,value,hooks);
  const result=transaction(db,()=>{
    const session=authority(db,request,clock,input);const again=receipt(db,session,input,digest,name);if(again)return again;
    const review=db.prepare('SELECT * FROM command_reviews WHERE token_hash=?').get(hash(input.reviewToken)) as {actor_id:string;audience:string;organization_id:string;context_generation:number;context_token_hash:string;fingerprint:string;expires_at:string;consumed_at:string|null;command_name:string}|undefined;
    if(!review||review.actor_id!==session.actor_id||review.audience!==session.audience||review.organization_id!==input.target.organizationId||review.context_generation!==session.context_generation||review.context_token_hash!==hash(session.context_token)||review.fingerprint!==digest||review.command_name!==name||review.consumed_at||review.expires_at<=nowIso(clock))throw new ApiError(409,'REVIEW_EXPIRED','The confirmation changed or expired. Review the current brief again; your input is retained.');
    const outcome=insertFirstRequest(db,session,input,value,preliminary,clock,name),now=nowIso(clock);
    db.prepare(`INSERT INTO action_receipts(command_id,command_name,actor_id,audience,organization_id,context_generation,context_token_hash,fingerprint,outcome_json,committed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.commandId,name,session.actor_id!,session.audience,input.target.organizationId!,session.context_generation,hash(session.context_token),digest,JSON.stringify(outcome),now);
    db.prepare('UPDATE command_reviews SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(now,hash(input.reviewToken));
    return outcome;
  });
  if(result.outcome==='saved')await hooks?.afterSubmitCommit?.(result);
  return result;
}
