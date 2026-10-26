import { createHmac,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,linkSync,lstatSync,unlinkSync } from 'node:fs';
import { readFile,open,rename,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Audience,NormalizedBrief } from '../../shared/contracts.js';
import type { DiscoveryExclusion,DiscoveryValues } from '../../shared/discovery-contracts.js';
import type { CapabilityFact } from '../../shared/orbital-contracts.js';
import type { AssessmentHandle,AssessmentHandoffContinuation,AssessmentHandoffInput,AssessmentHandoffResult,AssessmentManifestRef,AssessmentPage,AssessmentPageKind,AssessmentReadInput,AssessmentRecheckInput,AssessmentRecheckResult,AssessmentStartInput,PlanOption,PlanSelectionInput,PlanUserAssumption } from '../../shared/plan-contracts.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { transaction } from '../db/database.js';
import { ApiError,unavailable } from '../errors.js';
import { constantEqual,hash,randomToken,type Clock,type Session } from '../security.js';
import { canonicalJson,digest } from './catalog.js';
import { currentCatalogVersion,orbitalRoot } from './repository.js';
import { prepareAssessmentInput,calculationInputDigest,requireAssessmentWindow,assessmentCriteria,type PreparedAssessmentInput } from './plan-input.js';
import { calculateAssessment,ASSESSMENT_LIMITS,type AssessmentCalculation,type CalculationHooks } from './plan.js';
import { applicableModes,fixedChecks,instantaneousChecks,intervalCoverageChecks,groundCenterDistanceKm,nominalCorridor,optionOutcome,requiredUnknowns,solarElevationDeg,PLAN_METHOD_VERSION,PLAN_POLICY_VERSION,SOLAR_PACKAGE_SHA256 } from './constraints.js';
import { canonicalInstant,createPropagator,lookAngles,observerAt } from './propagation.js';
import { orbitalFreshness } from '../../shared/orbital-policy.js';

export interface AssessmentOwner {sessionHash:string;contextGeneration:number;audience:Audience;actorId:string|null;organizationId:string|null;requestId:string|null}
export function assessmentOwner(session:Session,requestId:string|null=null):AssessmentOwner{return {sessionHash:session.cookie_hash,contextGeneration:session.context_generation,audience:session.audience,actorId:session.actor_id,organizationId:session.organization_id,requestId};}
export interface SelectionBinding {organizationId:string;requestId:string|null;requestVersion:number|null;briefRevision:number|null;currentPlanId:string|null;brief:NormalizedBrief}
export interface PreparedSelection {owner:AssessmentOwner;bindingDigest:string;normalizedBriefDigest:string;calculationDigest:string;selectionDigest:string;seal:string;manifest:AssessmentManifestRef;input:AssessmentPage['input'];option:PlanOption;selectedAtUtc:string|null;acknowledgedUnknownIds:string[];assumptions:PlanUserAssumption[];facts:CapabilityFact[];expiresAt:string}
interface AssessmentRow {id:string;generation:number;owner_cookie_hash:string;owner_generation:number;audience:Audience;actor_id:string|null;organization_id:string|null;request_id:string|null;input_digest:string;brief_digest:string;snapshot_version:string;fact_version:string;state:AssessmentPage['state'];created_at:string;started_at:string|null;completed_at:string|null;attachment_expires_at:string|null;read_capability_hash:string;manifest_digest:string|null;manifest_bytes:number|null;manifest_filename:string|null;summary_json:string|null}
interface Manifest {schemaVersion:'coruscant-assessment-v1';assessmentId:string;generation:number;inputDigest:string;calculationDigest:string;briefDigest:string;input:AssessmentPage['input'];requirements:PreparedAssessmentInput['requirements'];criteria:DiscoveryValues;exclusions:DiscoveryExclusion[];snapshotVersion:string;factVersion:string;validation:AssessmentPage['validation'];sources:AssessmentPage['sources'];createdAt:string;startedAt:string|null;completedAt:string;method:Record<string,unknown>;population:PreparedAssessmentInput['catalog']['matching'];result:AssessmentCalculation}
interface Job {owner:AssessmentOwner;handle:AssessmentHandle;prepared:PreparedAssessmentInput;controller:AbortController;createdAt:string;startedAt:string|null;result:AssessmentCalculation;done:Promise<void>|null;resolveDone:()=>void}
const terminalStates=new Set(['COMPLETE','INCOMPLETE','CANCELED','INTERRUPTED','FAILED']);
const clean=(value:unknown)=>JSON.parse(JSON.stringify(value)) as unknown;
const canonical=(value:unknown)=>canonicalJson(clean(value));
const ownerKey=(owner:AssessmentOwner)=>`${owner.sessionHash}:${owner.contextGeneration}`;
const bindingDigest=(binding:SelectionBinding)=>digest(canonical(binding));
const unchangedOwner=(a:AssessmentOwner,b:AssessmentOwner)=>a.sessionHash===b.sessionHash&&a.contextGeneration===b.contextGeneration&&a.audience===b.audience&&a.actorId===b.actorId&&a.organizationId===b.organizationId;
function safeEqual(left:string,right:string):boolean {const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
function validHandle(handle:unknown):handle is AssessmentHandle {if(!handle||typeof handle!=='object'||Array.isArray(handle))return false;const h=handle as AssessmentHandle;return typeof h.assessmentId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(h.assessmentId)&&typeof h.readCapability==='string'&&/^[A-Za-z0-9_-]{43}$/.test(h.readCapability)&&Number.isSafeInteger(h.generation)&&h.generation>0;}
/** Read input adds paging/view fields; none become part of the reusable handle. */
const canonicalHandle=(handle:AssessmentHandle):AssessmentHandle=>({assessmentId:handle.assessmentId,generation:handle.generation,readCapability:handle.readCapability});
function manifestReference(row:AssessmentRow):AssessmentManifestRef|null{return row.manifest_digest&&row.completed_at&&row.attachment_expires_at?{assessmentId:row.id,manifestDigest:row.manifest_digest,inputDigest:row.input_digest,snapshotVersion:row.snapshot_version,factVersion:row.fact_version,completedAt:row.completed_at,attachmentExpiresAt:row.attachment_expires_at}:null;}
function initialResult(prepared:PreparedAssessmentInput):AssessmentCalculation{return {state:'QUEUED',reason:null,counts:{catalogUnique:prepared.catalog.items.length,matching:prepared.catalog.matching.length,ready:0,completed:0,positive:0,checkedNegative:0,stale:0,insufficient:0,incomplete:0,notAssessed:0,remaining:prepared.catalog.matching.length,evaluations:0},options:[],outcomes:[],views:{},coverageWarnings:[],preferredOptionId:null};}

/** One local process, one bounded job, a four-context FIFO, immutable private files.
 * All async file/calculation work occurs outside SQLite write transactions. */
export function createAssessmentService({db,config,clock,calculationHooks={},beforeManifestWrite}:{db:Database;config:AppConfig;clock:Clock;calculationHooks?:CalculationHooks;beforeManifestWrite?:()=>Promise<unknown>}) {
  if((beforeManifestWrite||Object.keys(calculationHooks).length)&&config.mode!=='test')throw new Error('Calculation test hooks require an isolated test data root.');
  const root=orbitalRoot(config),manifestRoot=resolve(root,'assessments'),keyPath=resolve(root,'assessment-hmac.key');
  mkdirSync(root,{recursive:true,mode:0o700});mkdirSync(manifestRoot,{recursive:true,mode:0o700});
  let key:Buffer|null=null,keyIssue:string|null=null;
  try{
    let existing=false;try{const info=lstatSync(keyPath);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('Private key permissions or type are invalid.');existing=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!existing){const previous=db.prepare('SELECT id FROM orbital_assessments WHERE manifest_digest IS NOT NULL LIMIT 1').get();if(previous)throw new Error('The existing assessment signing key is missing; historical artifacts were not overwritten.');
      const temporary=resolve(root,`.assessment-key-${randomUUID()}.tmp`),bytes=randomBytes(32),fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}try{linkSync(temporary,keyPath);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}finally{try{unlinkSync(temporary);}catch{}}
    }
    key=readFileSync(keyPath);if(key.length!==32)throw new Error('The assessment signing key is malformed.');
  }catch(error){keyIssue=error instanceof Error?error.message:'The private assessment signing key is unavailable.';}
  const jobs=new Map<string,Job>(),queue:Job[]=[];let active:Job|null=null,closed=false;
  transaction(db,()=>{db.prepare("UPDATE orbital_assessments SET state='INTERRUPTED' WHERE state IN ('QUEUED','RUNNING')").run();});
  const rowFor=(id:string)=>db.prepare('SELECT * FROM orbital_assessments WHERE id=?').get(id) as unknown as AssessmentRow|undefined;
  const keyReady=(checkFile=false):Buffer=>{if(!key||keyIssue)throw new ApiError(503,'ASSESSMENT_KEY_UNAVAILABLE',keyIssue??'The private assessment signing key is unavailable. Your input is retained.');
    if(checkFile){try{const info=lstatSync(keyPath),bytes=readFileSync(keyPath);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||bytes.length!==32||!timingSafeEqual(bytes,key))throw new Error();}catch{throw new ApiError(503,'ASSESSMENT_KEY_UNAVAILABLE','The private assessment signing key is missing or changed. Keep your input; no historical artifact was replaced.');}}return key;};
  const sign=(value:unknown)=>createHmac('sha256',keyReady()).update(canonical(value)).digest('base64url');
  const checkOwner=(owner:AssessmentOwner,requireWrite=false)=>{
    const session=db.prepare('SELECT s.active,s.expires_at,s.audience,s.actor_id,s.organization_id,s.context_generation,a.active AS actor_active,a.audience AS actor_audience FROM sessions s LEFT JOIN actors a ON a.id=s.actor_id WHERE cookie_hash=?').get(owner.sessionHash) as {active:number;expires_at:string;audience:Audience;actor_id:string|null;organization_id:string|null;context_generation:number;actor_active:number|null;actor_audience:Audience|null}|undefined;
    if(!session||session.active!==1||session.expires_at<=clock().toISOString()||session.audience!==owner.audience||session.actor_id!==owner.actorId||session.organization_id!==owner.organizationId||session.context_generation!==owner.contextGeneration||owner.actorId&&(session.actor_active!==1||session.actor_audience!==owner.audience))throw new ApiError(409,'CONTEXT_CHANGED','The originating access context changed. This calculation cannot be inherited by another context.');
    if(owner.audience==='STAFF')throw new ApiError(403,'CUSTOMER_REQUIRED','Technical calculation belongs to public discovery or a permitted customer request.');
    if(owner.audience==='CUSTOMER'&&owner.organizationId){const member=db.prepare('SELECT role FROM memberships WHERE actor_id=? AND organization_id=? AND active=1').get(owner.actorId!,owner.organizationId) as {role:string}|undefined;if(!member||requireWrite&&member.role==='VIEWER')unavailable();}
    if(owner.requestId){const request=db.prepare('SELECT organization_id,accepted_quote_id FROM service_requests WHERE id=?').get(owner.requestId) as {organization_id:string;accepted_quote_id:string|null}|undefined;if(!request||owner.audience!=='CUSTOMER'||request.organization_id!==owner.organizationId)unavailable();if(requireWrite&&request.accepted_quote_id)throw new ApiError(409,'ACCEPTED_WORK','Accepted work is immutable; use Clarifications.');}
  };
  const authorize=(owner:AssessmentOwner,handle:AssessmentHandle):AssessmentRow=>{
    checkOwner(owner);if(!validHandle(handle))unavailable();
    const row=rowFor(handle.assessmentId);if(!row||row.generation!==handle.generation||row.owner_cookie_hash!==owner.sessionHash||row.owner_generation!==owner.contextGeneration||row.audience!==owner.audience||row.actor_id!==owner.actorId||row.organization_id!==owner.organizationId||owner.requestId!==null&&owner.requestId!==row.request_id||!safeEqual(hash(handle.readCapability),row.read_capability_hash))unavailable();
    if(row.request_id)checkOwner({...owner,requestId:row.request_id});
    if(db.prepare("SELECT nonce_hash FROM orbital_assessment_handoffs WHERE assessment_id=? AND phase='ENTERED' LIMIT 1").get(row.id))unavailable();
    return row;
  };
  const freshReference=(row:AssessmentRow):AssessmentManifestRef=>{const ref=manifestReference(row);if(!ref||!['COMPLETE','INCOMPLETE'].includes(row.state))throw new ApiError(409,'ASSESSMENT_NOT_ATTACHABLE','This calculation is not a completed attachable artifact.');
    const latest=db.prepare('SELECT id FROM orbital_assessments WHERE owner_cookie_hash=? AND owner_generation=? ORDER BY rowid DESC LIMIT 1').get(row.owner_cookie_hash,row.owner_generation) as {id:string}|undefined;if(latest?.id!==row.id)throw new ApiError(409,'ASSESSMENT_SUPERSEDED','A newer input calculation superseded this attachment. Historical evidence remains inspectable.');
    if(ref.attachmentExpiresAt<=clock().toISOString())throw new ApiError(409,'ASSESSMENT_EXPIRED','The15-minute new-attachment reference expired. Keep your inputs and calculate again.');if(row.snapshot_version!==currentCatalogVersion(db))throw new ApiError(409,'CATALOG_VERSION_CHANGED','The real source changed. Historical evidence is retained; calculate current evidence for a new selection.');return ref;};
  const attachment=(ref:AssessmentManifestRef)=>{const fields={...ref,completionPolicy:PLAN_POLICY_VERSION};return `${Buffer.from(canonical(fields)).toString('base64url')}.${sign(fields)}`;};
  const verifyAttachment=(token:string,ref:AssessmentManifestRef)=>{if(typeof token!=='string'||token.length>3000||!safeEqual(token,attachment(ref)))throw new ApiError(409,'ASSESSMENT_REFERENCE_INVALID','The assessment reference changed or is not authentic. Keep your input and review current evidence.');};
  const summary=(job:Job)=>({input:job.prepared.input,validation:job.prepared.catalog.validation,sources:job.prepared.catalog.sources,counts:job.result.counts,reason:job.result.reason,coverageWarnings:job.result.coverageWarnings,
    reservedOutcomes:job.prepared.catalog.matching.map(value=>({itemId:value.item.id,name:value.item.name,state:'NOT_ASSESSED' as const,reason:'Calculation interrupted before durable completion — retry.',evaluations:0,opportunityIds:[],epoch:value.item.orbit.epoch,retrievedAt:value.item.orbit.retrievedAt}))});
  const cancelQueued=(job:Job,reason:string)=>{job.result.state='CANCELED';job.result.reason=reason;job.result.preferredOptionId=null;job.result.outcomes=job.prepared.catalog.matching.map(value=>({itemId:value.item.id,name:value.item.name,state:'NOT_ASSESSED',reason,evaluations:0,opportunityIds:[],epoch:value.item.orbit.epoch,retrievedAt:value.item.orbit.retrievedAt}));job.result.counts.notAssessed=job.result.counts.matching;job.result.counts.remaining=0;job.done=finalize(job).catch(error=>{if(!closed){job.result.state='FAILED';job.result.reason=error instanceof Error?error.message:'The canceled artifact could not be saved.';recordProgress(job);}}).finally(()=>{job.resolveDone();jobs.delete(job.handle.assessmentId);});};
  const recordProgress=(job:Job)=>{if(closed)return;db.prepare('UPDATE orbital_assessments SET state=?,started_at=?,summary_json=? WHERE id=? AND manifest_digest IS NULL').run(job.result.state,job.startedAt,JSON.stringify(summary(job)),job.handle.assessmentId);};
  const currentCapture=(job:Job)=>{checkOwner(job.owner,true);if(currentCatalogVersion(db)!==job.prepared.catalog.snapshotVersion)throw new ApiError(409,'CATALOG_VERSION_CHANGED','The captured source changed during calculation.');if(job.prepared.request){const current=db.prepare('SELECT aggregate_version,current_brief_revision,accepted_quote_id FROM service_requests WHERE id=?').get(job.prepared.request.requestId) as {aggregate_version:number;current_brief_revision:number;accepted_quote_id:string|null}|undefined;if(!current||current.aggregate_version!==job.prepared.request.requestVersion||current.current_brief_revision!==job.prepared.request.briefRevision||current.accepted_quote_id)throw new ApiError(409,'STALE_REVIEW','The request changed during calculation.');}};
  const finalize=async(job:Job)=>{
    if(beforeManifestWrite)await beforeManifestWrite();
    if(job.controller.signal.aborted&&job.result.state!=='CANCELED'){job.result.state='CANCELED';job.result.reason='Calculation canceled before its immutable result was published.';job.result.preferredOptionId=null;}
    const completedAt=clock().toISOString(),expires=new Date(Date.parse(completedAt)+15*60000).toISOString();
    const manifest:Manifest={schemaVersion:'coruscant-assessment-v1',assessmentId:job.handle.assessmentId,generation:job.handle.generation,inputDigest:job.prepared.inputDigest,calculationDigest:job.prepared.calculationDigest,briefDigest:job.prepared.briefDigest,input:job.prepared.input,requirements:structuredClone(job.prepared.requirements),criteria:structuredClone(assessmentCriteria(job.prepared.brief,job.prepared.input)),exclusions:structuredClone(job.prepared.brief.discovery?.exclusions??[]),snapshotVersion:job.prepared.catalog.snapshotVersion,factVersion:job.prepared.catalog.factVersion,validation:job.prepared.catalog.validation,sources:job.prepared.catalog.sources,createdAt:job.createdAt,startedAt:job.startedAt,completedAt,
      method:{version:PLAN_METHOD_VERSION,policyVersion:PLAN_POLICY_VERSION,dependency:'satellite.js@7.1.0',propagation:'WGS72 improved SGP4; TEME km and km/s',earthFixed:'UTC≈UT1; GMST rotation; zero EOP; WGS84 geodetic observer height0km',distance:'atan2 cross/dot shortest mean-sphere distance;6371.0088km',losThresholdDeg:10,sampling:'exact window endpoints plus10s grid; detected entry/exit/peak/closest brackets≤1s; no extrapolation',solar:'sunPos equatorial AU direction; GMST horizon projection,1950–2050; no refraction/terrain/cloud',solarPackageSha256:SOLAR_PACKAGE_SHA256,solarBoundaryUncertaintyDeg:.1,illuminationSources:['https://sentiwiki.copernicus.eu/web/s2-products','https://www.usgs.gov/landsat-missions/landsat-acquisitions','https://aa.usno.navy.mil/faq/sun_approx'],evaluationAccounting:'one propagation+LOS base evaluation; each added corridor/solar computation and refined sample charged; cached physical samples shared across bands',limits:ASSESSMENT_LIMITS},population:job.prepared.catalog.matching,result:job.result};
    const body=canonical(manifest),bytes=Buffer.byteLength(body);if(bytes>ASSESSMENT_LIMITS.maxManifestBytes)throw new ApiError(503,'ASSESSMENT_MANIFEST_LIMIT','The full artifact exceeded its32MiB bound; no truncated file was saved.');
    const manifestDigest=digest(body),filename=`${job.handle.assessmentId}-${manifestDigest}.json`,path=resolve(manifestRoot,filename),temporary=resolve(manifestRoot,`.${randomUUID()}.tmp`);
    const file=await open(temporary,'wx',0o600);try{await file.writeFile(body);await file.sync();}finally{await file.close();}try{await rename(temporary,path);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
    if(closed)return;
    if(job.result.state!=='CANCELED')try{currentCapture(job);}catch{job.result.state='CANCELED';job.result.reason='The source or originating context changed before result publication.';job.result.preferredOptionId=null;await finalize(job);return;}
    transaction(db,()=>{db.prepare('UPDATE orbital_assessments SET state=?,started_at=?,completed_at=?,attachment_expires_at=?,manifest_digest=?,manifest_bytes=?,manifest_filename=?,summary_json=? WHERE id=? AND manifest_digest IS NULL').run(job.result.state,job.startedAt,completedAt,expires,manifestDigest,bytes,filename,JSON.stringify(summary(job)),job.handle.assessmentId);});
  };
  const drain=()=>{if(active||closed)return;const job=queue.shift();if(!job)return;active=job;job.done=(async()=>{
    try{
      currentCapture(job);requireAssessmentWindow(job.prepared.input,clock().toISOString());job.startedAt=clock().toISOString();job.result.state='RUNNING';recordProgress(job);
      job.result=await calculateAssessment(job.prepared,job.startedAt,{...calculationHooks,signal:job.controller.signal,assertCurrent:()=>{currentCapture(job);calculationHooks.assertCurrent?.();},onProgress:progress=>{job.result=progress;calculationHooks.onProgress?.(progress);}});
    }catch(error){job.result.state=job.controller.signal.aborted?'CANCELED':'INCOMPLETE';job.result.reason=error instanceof Error?error.message:'Calculation unavailable; keep inputs and retry.';const existing=new Set(job.result.outcomes.map(o=>o.itemId));for(const row of job.prepared.catalog.matching){if(!existing.has(row.item.id)){job.result.outcomes.push({itemId:row.item.id,name:row.item.name,state:'NOT_ASSESSED',reason:job.result.reason,evaluations:0,opportunityIds:[],epoch:row.item.orbit.epoch,retrievedAt:row.item.orbit.retrievedAt});job.result.counts.notAssessed++;job.result.counts.remaining--;}}job.result.preferredOptionId=null;
    }
    try{if(!closed)await finalize(job);}catch(error){if(!closed){job.result.state='FAILED';job.result.reason=error instanceof Error?error.message:'The private calculation artifact could not be saved.';recordProgress(job);}}
    finally{job.resolveDone();jobs.delete(job.handle.assessmentId);active=null;if(!closed)drain();}
  })();};
  const loadManifest=async(row:AssessmentRow):Promise<Manifest>=>{
    if(!row.manifest_digest||!row.manifest_filename||!row.manifest_bytes||!new RegExp(`^${row.id}-[a-f0-9]{64}\\.json$`).test(row.manifest_filename))throw new ApiError(503,'ASSESSMENT_UNAVAILABLE','The exact private assessment artifact is unavailable.');
    let bytes:Buffer;try{const file=await open(resolve(manifestRoot,row.manifest_filename),'r');try{const info=await file.stat();if(!info.isFile()||info.size!==row.manifest_bytes||info.size>ASSESSMENT_LIMITS.maxManifestBytes)throw new Error();bytes=await file.readFile();}finally{await file.close();}}catch{throw new ApiError(503,'ASSESSMENT_UNAVAILABLE','The private assessment manifest is missing or has an invalid size; no evidence was fabricated.');}
    if(bytes.length!==row.manifest_bytes||bytes.length>ASSESSMENT_LIMITS.maxManifestBytes||digest(bytes)!==row.manifest_digest)throw new ApiError(503,'ASSESSMENT_CORRUPT','The exact assessment manifest failed its integrity check.');
    let manifest:Manifest;try{manifest=JSON.parse(bytes.toString('utf8')) as Manifest;}catch{throw new ApiError(503,'ASSESSMENT_CORRUPT','The immutable assessment manifest is unreadable.');}
    if(manifest.schemaVersion!=='coruscant-assessment-v1'||manifest.assessmentId!==row.id||manifest.inputDigest!==row.input_digest||manifest.snapshotVersion!==row.snapshot_version||manifest.factVersion!==row.fact_version||manifest.completedAt!==row.completed_at)throw new ApiError(503,'ASSESSMENT_CORRUPT','The manifest identity does not match its immutable index.');return manifest;
  };
  /** Both preview and final preparation use the same immutable inputs and exact
   * fixed/dynamic predicates. This never changes the manifest or grants a save. */
  const checkedOption=(manifest:Manifest,optionId:string,proposedAtUtc:string|null)=>{
    if(typeof optionId!=='string'||!optionId||optionId.length>200)throw new ApiError(422,'ASSESSMENT_INPUT_INVALID','Choose the exact option to check.');
    const original=manifest.result.options.find(value=>value.id===optionId);if(!original)throw new ApiError(409,'ASSESSMENT_OPTION_UNAVAILABLE','The selected opportunity does not belong to this immutable assessment.');
    const option=structuredClone(original),source=manifest.population.find(value=>value.item.id===option.itemId);
    if(!source?.omm)throw new ApiError(409,'ASSESSMENT_OPTION_UNAVAILABLE','The exact selected orbital evidence is unavailable.');
    const fresh=orbitalFreshness(source.item.orbit.epoch,source.item.orbit.retrievedAt,clock().toISOString(),[manifest.input.window.startUtc,manifest.input.window.endUtc]);if(fresh)throw new ApiError(409,'ASSESSMENT_STALE',fresh);
    requireAssessmentWindow(manifest.input,clock().toISOString());
    if(proposedAtUtc===null){
      if(original.proposedAtUtc!==null)throw new ApiError(422,'PLAN_TIME_REQUIRED','Retain or explicitly review the checked proposed instant for this option.');
      option.checks=[...option.checks.filter(check=>check.id!=='interval-incomplete'),...intervalCoverageChecks(option.coverage)];option.unknowns=requiredUnknowns(option.checks);option.outcome=optionOutcome(option.checks,option.coverage);
      return {option,source};
    }
    const at=canonicalInstant(proposedAtUtc);if(!at||at<manifest.input.window.startUtc||at>manifest.input.window.endUtc)throw new ApiError(422,'PLAN_TIME_OUTSIDE_WINDOW','A proposed instant must be within the captured window; changing the window starts a new assessment.');
    if(at<option.los.startUtc||at>option.los.endUtc)throw new ApiError(422,'PLAN_TIME_OTHER_OPPORTUNITY','Choose the matching opportunity for this instant.');
    const predicted=createPropagator(source.omm).at(at),mode=applicableModes(source.item,manifest.input).find(value=>value.instrument===option.instrument&&value.mode===option.mode&&value.sensor===option.sensor&&value.bands.join(',')===option.bands.join(','));
    if(!predicted.ok||!mode)throw new ApiError(409,'PLAN_PREFLIGHT_UNAVAILABLE','The exact proposed instant could not be checked.');
    const angles=lookAngles(predicted.ecfKm,observerAt(manifest.input.area.latitude,manifest.input.area.longitude));if(!angles)throw new ApiError(409,'PLAN_PREFLIGHT_UNAVAILABLE','The proposed local horizon check is unavailable.');
    if(!manifest.requirements)throw new ApiError(503,'ASSESSMENT_CORRUPT','The immutable assessment requirements are unavailable.');
    const prepared={input:manifest.input,requirements:manifest.requirements} as PreparedAssessmentInput;
    const dynamic=instantaneousChecks(mode,prepared,predicted,angles.elevationDeg,groundCenterDistanceKm(manifest.input.area.latitude,manifest.input.area.longitude,predicted.geodetic.latitude,predicted.geodetic.longitude),solarElevationDeg(at,manifest.input.area.latitude,manifest.input.area.longitude));
    option.checks=[...fixedChecks(source.item,mode,prepared,source.unknowns),...dynamic.checks,...intervalCoverageChecks(option.coverage)];option.assumptions=dynamic.assumptions;option.proposedAtUtc=at;option.unknowns=requiredUnknowns(option.checks);option.outcome=optionOutcome(option.checks,option.coverage);
    return {option,source};
  };
  const page=(row:AssessmentRow,handle:AssessmentHandle,manifest:Manifest|null,job:Job|undefined,input:AssessmentReadInput,saved=false):AssessmentPage=>{
    const summaryValue=row.summary_json?JSON.parse(row.summary_json) as ReturnType<typeof summary>:null;
    const calculated=manifest?.result??job?.result,kind=input.kind??'OPTIONS';if(!['OPTIONS','OUTCOMES'].includes(kind))throw new ApiError(422,'ASSESSMENT_INPUT_INVALID','Choose an options or object-outcomes page.');
    const ref=manifestReference(row);let attachmentReference:string|null=null;
    if(!saved&&ref&&['COMPLETE','INCOMPLETE'].includes(row.state))try{attachmentReference=attachment(freshReference(row));}catch{/* Historical inspection remains available when a new attachment is stale/superseded. */}
    const result:AssessmentPage={handle:canonicalHandle(handle),state:row.state,queuePosition:row.state==='QUEUED'?Math.max(1,queue.findIndex(value=>value.handle.assessmentId===row.id)+1):null,serverNow:clock().toISOString(),startedAt:row.started_at,completedAt:row.completed_at,snapshotVersion:row.snapshot_version,factVersion:row.fact_version,inputDigest:row.input_digest,input:manifest?.input??job?.prepared.input??summaryValue!.input,validation:manifest?.validation??job?.prepared.catalog.validation??summaryValue!.validation,sources:manifest?.sources??job?.prepared.catalog.sources??summaryValue!.sources,counts:calculated?.counts??summaryValue!.counts,limits:ASSESSMENT_LIMITS,reason:calculated?.reason??summaryValue?.reason??(row.state==='INTERRUPTED'?'Calculation interrupted — retry.':null),coverageWarnings:calculated?.coverageWarnings??summaryValue?.coverageWarnings??[],kind,options:[],outcomes:[],totalOptions:calculated?.options.length??0,totalOutcomes:calculated?.outcomes.length??0,nextCursor:null,preferredOptionId:row.state==='COMPLETE'?calculated?.preferredOptionId??null:null,manifest:ref,attachmentReference,facts:[]};
    if(input.optionId){const view=calculated?.views[input.optionId];if(!view)throw new ApiError(404,'ASSESSMENT_OPTION_UNAVAILABLE','That exact option view is unavailable in this assessment.');result.selectedView=view;}
    const cursorKey=row.input_digest,pageCode=kind==='OPTIONS'?'P':'R';let offset=0;
    if(input.cursor){try{const [body,signature]=input.cursor.split('.');if(!body||!signature)throw new Error();const parsed=JSON.parse(Buffer.from(body,'base64url').toString()) as {i:string;d:string;k:string;o:number};if(parsed.i!==row.id||parsed.d!==cursorKey.slice(0,16)||parsed.k!==pageCode||!Number.isSafeInteger(parsed.o)||parsed.o<0||!safeEqual(digest(canonical(parsed)).slice(0,32),signature))throw new Error();offset=parsed.o;}catch{throw new ApiError(422,'ASSESSMENT_CURSOR_INVALID','This evidence page does not belong to the current assessment.');}}
    const rows=kind==='OPTIONS'?calculated?.options??[]:calculated?.outcomes??summaryValue?.reservedOutcomes??[],population=manifest?.population??job?.prepared.catalog.matching??[];
    if(row.state==='INTERRUPTED'&&!calculated){result.counts={...result.counts,completed:0,positive:0,checkedNegative:0,stale:0,insufficient:0,incomplete:0,notAssessed:result.counts.matching,remaining:0};result.totalOutcomes=rows.length;}
    for(let index=offset;index<rows.length&&index<offset+100;index++){
      if(kind==='OPTIONS'){result.options.push(rows[index] as PlanOption);const ids=new Set(result.options.flatMap(option=>option.capabilityFactIds));result.facts=population.flatMap(p=>p.item.capabilityFacts).filter((fact,i,all)=>ids.has(fact.id)&&all.findIndex(v=>v.id===fact.id&&v.version===fact.version)===i);}
      else result.outcomes.push(rows[index] as AssessmentPage['outcomes'][number]);
      if(Buffer.byteLength(JSON.stringify(result))>256*1024-1024){if(kind==='OPTIONS')result.options.pop();else result.outcomes.pop();break;}
    }
    const loaded=kind==='OPTIONS'?result.options.length:result.outcomes.length,ids=new Set(result.options.flatMap(option=>option.capabilityFactIds));result.facts=population.flatMap(p=>p.item.capabilityFacts).filter((fact,i,all)=>ids.has(fact.id)&&all.findIndex(v=>v.id===fact.id&&v.version===fact.version)===i);
    if(offset+loaded<rows.length){if(!loaded)throw new ApiError(503,'ASSESSMENT_PAGE_LIMIT','One evidence row exceeds the bounded page size.');const cursor={i:row.id,d:cursorKey.slice(0,16),k:pageCode,o:offset+loaded};result.nextCursor=`${Buffer.from(JSON.stringify(cursor)).toString('base64url')}.${digest(canonical(cursor)).slice(0,32)}`;}
    if(row.state==='INTERRUPTED'){result.reason='Calculation interrupted — retry.';result.attachmentReference=null;}
    return structuredClone(result);
  };
  const service={
    async start(owner:AssessmentOwner,input:AssessmentStartInput):Promise<AssessmentPage>{
      if(closed)throw new ApiError(503,'ASSESSMENT_UNAVAILABLE','The calculation service is closing.');keyReady(true);checkOwner(owner,true);
      if(owner.audience==='CUSTOMER'&&!owner.organizationId)throw new ApiError(422,'WORKSPACE_REQUIRED','Choose a permitted workspace before preparing a private calculation.');
      if((input.request?.requestId??null)!==owner.requestId)unavailable();
      const prepared=prepareAssessmentInput(db,input,clock().toISOString());
      const same=[...jobs.values()].find(job=>ownerKey(job.owner)===ownerKey(owner)&&job.owner.requestId===owner.requestId&&job.handle.generation===input.generation&&job.prepared.inputDigest===prepared.inputDigest&&job.result.state!=='CANCELED'&&job.result.state!=='FAILED');
      if(same){const row=rowFor(same.handle.assessmentId)!;return page(row,same.handle,row.manifest_digest?await loadManifest(row):null,same,same.handle);}
      const previous=[...jobs.values()].filter(job=>ownerKey(job.owner)===ownerKey(owner)&&!terminalStates.has(job.result.state));
      for(const job of previous){job.controller.abort();const index=queue.indexOf(job);if(index>=0){queue.splice(index,1);cancelQueued(job,'Superseded by a newer input generation.');}}
      if(active&&queue.length>=4)throw new ApiError(429,'ASSESSMENT_QUEUE_FULL','Four contexts are already waiting. Your input is retained; use Retry assessment when a slot is free.',undefined,true);
      const createdAt=clock().toISOString(),handle={assessmentId:randomUUID(),generation:input.generation,readCapability:randomToken()},job:Job={owner:{...owner},handle,prepared,controller:new AbortController(),createdAt,startedAt:null,result:initialResult(prepared),done:null,resolveDone:()=>{}};
      transaction(db,()=>{db.prepare('INSERT INTO orbital_assessments(id,generation,owner_cookie_hash,owner_generation,audience,actor_id,organization_id,request_id,input_digest,brief_digest,snapshot_version,fact_version,state,created_at,read_capability_hash,summary_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(handle.assessmentId,handle.generation,owner.sessionHash,owner.contextGeneration,owner.audience,owner.actorId,owner.organizationId,owner.requestId,prepared.inputDigest,prepared.briefDigest,prepared.catalog.snapshotVersion,prepared.catalog.factVersion,'QUEUED',createdAt,hash(handle.readCapability),JSON.stringify(summary(job)));});
      jobs.set(handle.assessmentId,job);queue.push(job);void setImmediate().then(drain);return page(rowFor(handle.assessmentId)!,handle,null,job,handle);
    },
    async status(owner:AssessmentOwner,input:AssessmentReadInput):Promise<AssessmentPage>{const row=authorize(owner,input),job=jobs.get(row.id),manifest=row.manifest_digest?await loadManifest(row):null;const latest=authorize(owner,input);return page(latest,input,manifest,job,input);},
    async recheck(owner:AssessmentOwner,input:AssessmentRecheckInput):Promise<AssessmentRecheckResult>{
      let row=authorize(owner,input);freshReference(row);
      if(typeof input.proposedAtUtc!=='string')throw new ApiError(422,'ASSESSMENT_INPUT_INVALID','Enter the exact proposed UTC instant to check.');
      const manifest=await loadManifest(row);row=authorize(owner,input);freshReference(row);
      const {option}=checkedOption(manifest,input.optionId,input.proposedAtUtc);
      row=authorize(owner,input);freshReference(row);
      const originalView=manifest.result.views[option.id];
      const selectedView=originalView&&originalView.optionId===option.id&&originalView.itemId===option.itemId?{...structuredClone(originalView),atUtc:option.proposedAtUtc!}:null;
      return {handle:canonicalHandle(input),option,selectedView};
    },
    async cancel(owner:AssessmentOwner,handle:AssessmentHandle):Promise<AssessmentPage>{let row=authorize(owner,handle);const job=jobs.get(row.id);if(job&&!terminalStates.has(row.state)){job.controller.abort();const index=queue.indexOf(job);if(index>=0){queue.splice(index,1);cancelQueued(job,'Calculation canceled; inputs retained.');}if(job.done)await job.done;row=authorize(owner,handle);}return page(row,handle,row.manifest_digest?await loadManifest(row):null,job,handle);},
    invalidateContext(owner:AssessmentOwner):void{for(const job of jobs.values())if(unchangedOwner(job.owner,owner)&&!terminalStates.has(job.result.state)){job.controller.abort();const index=queue.indexOf(job);if(index>=0){queue.splice(index,1);cancelQueued(job,'The originating access context changed.');}}},
    async prepareSelection(owner:AssessmentOwner,selection:PlanSelectionInput,binding:SelectionBinding):Promise<PreparedSelection>{
      keyReady(true);checkOwner(owner,true);if(owner.audience!=='CUSTOMER'||owner.organizationId!==binding.organizationId||owner.requestId!==null&&owner.requestId!==binding.requestId)unavailable();
      let row=authorize(owner,selection.handle),ref=freshReference(row);verifyAttachment(selection.attachmentReference,ref);
      const manifest=await loadManifest(row);row=authorize(owner,selection.handle);freshReference(row);
      if(calculationInputDigest(binding.brief)!==manifest.calculationDigest)throw new ApiError(409,'ASSESSMENT_INPUT_CHANGED','The current brief inputs differ from this exact assessment. Keep input and calculate again.');
      const {option,source}=checkedOption(manifest,selection.optionId,selection.proposedAtUtc);
      if(!Array.isArray(selection.assumptions)||selection.assumptions.length>1||selection.assumptions.some(value=>!value||value.id!=='processing-hours'||typeof value.hours!=='number'||!Number.isFinite(value.hours)||value.hours<0||value.hours>8760||typeof value.explanation!=='string'||!value.explanation.trim()||value.explanation.length>4000||Object.keys(value).some(k=>!['id','hours','explanation'].includes(k))))throw new ApiError(422,'PLAN_ASSUMPTION_INVALID','Review the explicitly entered processing assumption.');
      if(!Array.isArray(selection.acknowledgedUnknownIds)||selection.acknowledgedUnknownIds.length>100||selection.acknowledgedUnknownIds.some(id=>typeof id!=='string')||new Set(selection.acknowledgedUnknownIds).size!==selection.acknowledgedUnknownIds.length)throw new ApiError(422,'PLAN_ACKNOWLEDGEMENT_REQUIRED','Acknowledge the exact named unresolved requirements.');
      if(option.outcome==='INELIGIBLE')throw new ApiError(422,'PLAN_KNOWN_MISMATCH','A known failed required check cannot be saved as a compatible or provisional plan.');
      const unknownIds=option.unknowns.map(value=>value.id);if(unknownIds.some(id=>!selection.acknowledgedUnknownIds.includes(id))||selection.acknowledgedUnknownIds.some(id=>!unknownIds.includes(id)))throw new ApiError(422,'PLAN_ACKNOWLEDGEMENT_REQUIRED','Review and acknowledge each exact current unknown; old acknowledgements cannot authorize changed checks.');
      const factIds=new Set(option.capabilityFactIds),facts=source.item.capabilityFacts.filter(f=>factIds.has(f.id));
      const content={owner:{...owner,requestId:binding.requestId},bindingDigest:bindingDigest(binding),normalizedBriefDigest:digest(canonical(binding.brief)),calculationDigest:manifest.calculationDigest,manifest:ref,input:manifest.input,option,selectedAtUtc:selection.proposedAtUtc,acknowledgedUnknownIds:[...selection.acknowledgedUnknownIds].sort(),assumptions:structuredClone(selection.assumptions),facts,expiresAt:ref.attachmentExpiresAt};
      const selectionDigest=digest(canonical(content)),prepared={...content,selectionDigest,seal:sign({...content,selectionDigest})};service.assertPreparedSelection(prepared,owner,binding);return prepared;
    },
    assertPreparedSelection(prepared:PreparedSelection,owner:AssessmentOwner,binding:SelectionBinding):void{
      checkOwner(owner,true);keyReady();const {seal,...content}=prepared;if(!safeEqual(sign(content),seal)||!unchangedOwner(prepared.owner,owner)||prepared.owner.requestId!==binding.requestId||prepared.bindingDigest!==bindingDigest(binding)||prepared.normalizedBriefDigest!==digest(canonical(binding.brief))||prepared.calculationDigest!==calculationInputDigest(binding.brief))throw new ApiError(409,'PLAN_REVIEW_CHANGED','The exact reviewed plan or request binding changed. Preserve input and review again.');
      const row=rowFor(prepared.manifest.assessmentId);if(!row||row.manifest_digest!==prepared.manifest.manifestDigest||row.owner_cookie_hash!==owner.sessionHash||row.owner_generation!==owner.contextGeneration)unavailable();freshReference(row);
      const freshness=orbitalFreshness(prepared.option.sourceOrbit.epoch,prepared.option.sourceOrbit.retrievedAt,clock().toISOString(),[prepared.input.window.startUtc,prepared.input.window.endUtc]);if(freshness)throw new ApiError(409,'ASSESSMENT_STALE',freshness);requireAssessmentWindow(prepared.input,clock().toISOString());
    },
    markAttached(prepared:PreparedSelection,binding:{requestId:string;organizationId:string;briefRevision:number;planVersionId:string}):void{if(!db.isTransaction)throw new Error('Assessment association must commit in the workflow transaction.');if(binding.organizationId!==prepared.owner.organizationId)unavailable();db.prepare('INSERT INTO orbital_assessment_attachments(assessment_id,manifest_digest,request_id,organization_id,brief_revision,plan_version_id,attached_at) VALUES(?,?,?,?,?,?,?)').run(prepared.manifest.assessmentId,prepared.manifest.manifestDigest,binding.requestId,binding.organizationId,binding.briefRevision,binding.planVersionId,clock().toISOString());},
    async readSavedManifest(ref:AssessmentManifestRef,authorizeSaved:()=>void,cursor?:string,kind:AssessmentPageKind='OPTIONS',optionId?:string):Promise<AssessmentPage>{authorizeSaved();const row=rowFor(ref.assessmentId);if(!row||row.manifest_digest!==ref.manifestDigest||row.input_digest!==ref.inputDigest||row.snapshot_version!==ref.snapshotVersion||row.fact_version!==ref.factVersion)unavailable();const manifest=await loadManifest(row);authorizeSaved();return page(row,{assessmentId:row.id,generation:row.generation,readCapability:''},manifest,undefined,{assessmentId:row.id,generation:row.generation,readCapability:'',cursor,kind,optionId},true);},
    beginHandoff(owner:AssessmentOwner,handle:AssessmentHandle):AssessmentHandoffInput{if(owner.audience!=='PUBLIC'||owner.actorId||owner.organizationId||owner.requestId)unavailable();const row=authorize(owner,handle),ref=freshReference(row),nonce=randomToken();db.prepare('INSERT INTO orbital_assessment_handoffs(nonce_hash,assessment_id,phase,from_cookie_hash,from_generation,expires_at) VALUES(?,?,?,?,?,?)').run(hash(nonce),row.id,'PREPARED',owner.sessionHash,owner.contextGeneration,ref.attachmentExpiresAt);return {handle:canonicalHandle(handle),nonce};},
    linkHandoffEntry(previous:Session,next:Session,input:AssessmentHandoffInput):AssessmentHandoffContinuation{
      if(!db.isTransaction)throw new Error('Handoff must share the session-rotation transaction.');if(previous.audience!=='PUBLIC'||previous.actor_id||previous.organization_id||next.audience!=='CUSTOMER'||!next.actor_id||next.organization_id||!validHandle(input?.handle)||typeof input.nonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.nonce))unavailable();
      const row=rowFor(input.handle.assessmentId),handoff=db.prepare("SELECT * FROM orbital_assessment_handoffs WHERE nonce_hash=? AND phase='PREPARED'").get(hash(input.nonce)) as {assessment_id:string;from_cookie_hash:string;from_generation:number;expires_at:string}|undefined;
      if(!row||!handoff||handoff.assessment_id!==row.id||handoff.from_cookie_hash!==previous.cookie_hash||handoff.from_generation!==previous.context_generation||row.owner_cookie_hash!==previous.cookie_hash||row.owner_generation!==previous.context_generation||row.generation!==input.handle.generation||!safeEqual(hash(input.handle.readCapability),row.read_capability_hash)||handoff.expires_at<=clock().toISOString())unavailable();freshReference(row);
      const continuationNonce=randomToken(),readCapability=randomToken();db.prepare("UPDATE orbital_assessment_handoffs SET phase='ENTERED',entered_cookie_hash=?,entered_generation=?,actor_id=?,continuation_hash=? WHERE nonce_hash=? AND phase='PREPARED'").run(next.cookie_hash,next.context_generation,next.actor_id,hash(continuationNonce),hash(input.nonce));
      db.prepare('UPDATE orbital_assessments SET owner_cookie_hash=?,owner_generation=?,audience=?,actor_id=?,organization_id=NULL,read_capability_hash=? WHERE id=?').run(next.cookie_hash,next.context_generation,'CUSTOMER',next.actor_id,hash(readCapability),row.id);
      return {handle:{assessmentId:row.id,generation:row.generation,readCapability},continuationNonce};
    },
    linkHandoffWorkspace(previous:Session,next:Session,input:AssessmentHandoffContinuation):AssessmentHandoffResult{
      if(!db.isTransaction)throw new Error('Handoff must share the workspace-rotation transaction.');if(previous.audience!=='CUSTOMER'||previous.organization_id||!previous.actor_id||next.audience!=='CUSTOMER'||next.actor_id!==previous.actor_id||!next.organization_id||!validHandle(input?.handle)||typeof input.continuationNonce!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.continuationNonce))unavailable();
      const row=rowFor(input.handle.assessmentId),handoff=db.prepare("SELECT * FROM orbital_assessment_handoffs WHERE continuation_hash=? AND phase='ENTERED'").get(hash(input.continuationNonce)) as {nonce_hash:string;assessment_id:string;entered_cookie_hash:string;entered_generation:number;actor_id:string;expires_at:string}|undefined;
      const member=db.prepare('SELECT role FROM memberships WHERE actor_id=? AND organization_id=? AND active=1').get(next.actor_id,next.organization_id) as {role:string}|undefined;
      if(!row||!handoff||!member||handoff.assessment_id!==row.id||handoff.entered_cookie_hash!==previous.cookie_hash||handoff.entered_generation!==previous.context_generation||handoff.actor_id!==next.actor_id||row.owner_cookie_hash!==previous.cookie_hash||row.owner_generation!==previous.context_generation||row.generation!==input.handle.generation||!safeEqual(hash(input.handle.readCapability),row.read_capability_hash)||handoff.expires_at<=clock().toISOString())unavailable();const ref=freshReference(row),readCapability=randomToken();
      db.prepare("UPDATE orbital_assessment_handoffs SET phase='CONSUMED' WHERE nonce_hash=? AND phase='ENTERED'").run(handoff.nonce_hash);
      db.prepare('UPDATE orbital_assessments SET owner_cookie_hash=?,owner_generation=?,organization_id=?,read_capability_hash=? WHERE id=?').run(next.cookie_hash,next.context_generation,next.organization_id,hash(readCapability),row.id);
      return {handle:{assessmentId:row.id,generation:row.generation,readCapability},manifest:ref,attachmentReference:attachment(ref)};
    },
    close():void{closed=true;for(const job of jobs.values())job.controller.abort();queue.length=0;},
  };
  return service;
}
