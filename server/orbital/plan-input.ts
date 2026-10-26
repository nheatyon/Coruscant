import type { BriefInput, CommandEnvelope, NormalizedBrief } from '../../shared/contracts.js';
import type { DiscoveryValues } from '../../shared/discovery-contracts.js';
import type { AssessmentStartInput, PlanInputSummary } from '../../shared/plan-contracts.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { normalizeSavedBrief } from '../commands.js';
import { rebindPlaceSource } from '../place-lookup.js';
import { resolvePlaceSource } from '../place-lookup.js';
import { validateBriefRevision } from '../../shared/workflow.js';
import { areaSignature } from '../../shared/validation.js';
import { canonicalJson,digest } from './catalog.js';
import { canonicalInstant } from './propagation.js';
import { captureAssessmentCatalog,captureCatalog,currentCatalogVersion,type AssessmentCatalogCapture } from './repository.js';

export interface PreparedAssessmentInput {
  generation:number; input:PlanInputSummary; briefDigest:string; inputDigest:string;calculationDigest:string;
  catalog:AssessmentCatalogCapture; brief:NormalizedBrief;
  request:AssessmentStartInput['request']|null;
  requirements:{purpose:string;deadlineUtc:string|null;delivery:string|null;operator:string|null;ownerCountry:string|null};
}
/** The same semantic digest governs calculation, plan invalidation and attachment.
 * Contact, shortlist order, raw-reading generation and area-control generation are not physics. */
export function calculationInputDigest(brief:NormalizedBrief):string {
  const effective=brief.discovery?.effective??null,source=brief.areaSource;
  const areaSource=source?{lookupVersion:source.lookupVersion,candidateId:source.candidateId,sourcePhrase:source.sourcePhrase,phraseOrigin:source.phraseOrigin,query:source.query,provider:source.provider,sourceCenter:source.sourceCenter,appliedCenter:source.appliedCenter,appliedRadiusKm:source.appliedRadiusKm,adjusted:source.adjusted}:null;
  return digest(canonicalJson({purpose:brief.purpose,intent:brief.observationIntent??'comparison',family:brief.family,sensor:brief.sensor,outputs:brief.outputs,
    area:{latitude:brief.area.latitude,longitude:brief.area.longitude,radiusKm:brief.area.radiusKm},areaConfirmed:!!brief.areaConfirmation,areaSource,
    baselineDate:brief.baselineDate,recentDate:brief.recentDate,timezone:brief.timezone,maxResolutionM:brief.maxResolutionM,cloudCover:brief.cloudCover,revisitHours:brief.revisitHours,spectralRequirements:brief.spectralRequirements,
    timingToDiscuss:brief.timingToDiscuss,window:brief.requestedWindow?{startUtc:brief.requestedWindow.startUtc,endUtc:brief.requestedWindow.endUtc}:null,deadline:brief.deadline?.utc??null,timingNotes:brief.timingNotes,unknowns:brief.unknowns,
    effective,exclusions:(brief.discovery?.exclusions??[]).map(e=>({field:e.field,value:e.value,active:e.active!==false})),catalogKind:brief.catalogContext?.sourceKind??'DEMONSTRATION'}));
}
export function technicalSummary(brief:NormalizedBrief):PlanInputSummary {
  if(!brief.requestedWindow)throw new ApiError(422,'ASSESSMENT_NOT_READY','Supply an explicit planning window; timing to be discussed cannot produce timed options.',{windowStart:'Enter a future planning start.',windowEnd:'Enter a planning end.'});
  return {purposeDigest:digest(brief.purpose),observationIntent:brief.observationIntent??'comparison',area:structuredClone(brief.area),areaSource:brief.areaSource??null,
    timezone:brief.timezone,baselineDate:brief.baselineDate,recentDate:brief.recentDate,window:{startUtc:brief.requestedWindow.startUtc,endUtc:brief.requestedWindow.endUtc},
    sensor:brief.sensor,maxResolutionM:brief.maxResolutionM,cloudCover:brief.cloudCover,revisitHours:brief.revisitHours,spectralRequirements:brief.spectralRequirements,
    outputs:[...brief.outputs],timingNotes:brief.timingNotes,unknowns:[...brief.unknowns]};
}
export function requireAssessmentWindow(input:PlanInputSummary,now:string):void {
  const start=canonicalInstant(input.window.startUtc),end=canonicalInstant(input.window.endUtc);
  if(!start||!end||Date.parse(start)<=Date.parse(now)||Date.parse(end)<=Date.parse(start)||Date.parse(end)-Date.parse(start)>86400000)
    throw new ApiError(422,'ASSESSMENT_NOT_READY','Use an explicitly future, positive UTC planning window of at most24 hours.',{windowStart:'The planning window must start in the future.',windowEnd:'Use a positive window no longer than24 hours.'});
}
/** Exact matching inputs are retained alongside the immutable source versions. */
export function assessmentCriteria(brief:NormalizedBrief,input:PlanInputSummary):DiscoveryValues {
  return brief.discovery?.effective??{family:'EO',sensor:brief.sensor,outputs:brief.outputs,maxResolutionM:brief.maxResolutionM,cloudCover:brief.cloudCover,revisitHours:brief.revisitHours,keyword:null,operator:null,ownerCountry:null,place:null,timezone:brief.timezone,window:input.window,deadline:brief.deadline?.utc??null,delivery:null,documentedOnly:false};
}
/** Reuse actual brief validation and cached source lineage; no network or workflow write. */
export function prepareAssessmentInput(db:Database,raw:AssessmentStartInput,now:string):PreparedAssessmentInput {
  if(!raw||typeof raw!=='object'||Object.keys(raw).some(key=>!['generation','brief','request'].includes(key))||!Number.isSafeInteger(raw.generation)||raw.generation<1)
    throw new ApiError(422,'ASSESSMENT_NOT_READY','Use the current planning-input generation.');
  if(raw.request&&(!raw.request.requestId||!Number.isSafeInteger(raw.request.requestVersion)||raw.request.requestVersion<1||!Number.isSafeInteger(raw.request.briefRevision)||raw.request.briefRevision<1||Object.keys(raw.request).some(key=>!['requestId','requestVersion','briefRevision'].includes(key))))throw new ApiError(422,'ASSESSMENT_NOT_READY','Use the current request and brief revision.');
  let brief:NormalizedBrief;
  if(raw.request){
    const old=db.prepare('SELECT brief_json FROM brief_revisions WHERE request_id=? AND revision=?').get(raw.request.requestId,raw.request.briefRevision) as {brief_json:string}|undefined;
    if(!old)throw new ApiError(409,'STALE_REVIEW','The saved brief revision is unavailable.');const prior=JSON.parse(old.brief_json) as NormalizedBrief;
    const oldContext=prior.catalogContext,oldCapture=oldContext?.sourceKind==='PUBLIC_REAL'&&oldContext.snapshotVersion?captureCatalog(db,oldContext.snapshotVersion):null;
    const validated=validateBriefRevision(raw.brief,prior,oldCapture?.dictionary,{preparation:true,requireAreaPurposeReview:true,resolveAreaSource:(reference,area,purpose)=>resolvePlaceSource(db,reference,area,purpose)});
    if(!validated.value)throw new ApiError(422,'ASSESSMENT_NOT_READY','Review the named planning fields before calculating.',validated.fieldErrors);brief=validated.value;
    if(raw.brief.areaSource===undefined&&Object.hasOwn(prior,'areaSource'))brief.areaSource=prior.areaSource?rebindPlaceSource(prior.areaSource,brief.area,brief.purpose):null;
    if(raw.brief.areaReviewedPurpose===brief.purpose)brief.areaPurposeDigest=digest(JSON.stringify([brief.purpose,areaSignature(brief.area)]));
  }else{
    // Contact is not a physical input. Partial unsent contact work stays in its
    // original draft and is validated by the separate reviewed save/submission.
    const technicalBrief={...raw.brief,contact:{name:'',email:'',organization:''}};
    brief=normalizeSavedBrief(db,{payload:{brief:technicalBrief}} as CommandEnvelope,true,true);
  }
  const context=brief.catalogContext;
  if(context?.sourceKind!=='PUBLIC_REAL'||!context.snapshotVersion||!context.factVersion)throw new ApiError(422,'ASSESSMENT_NOT_READY','Automatic prediction needs the real catalog and its current source/fact versions. Manual preparation remains available.');
  const input=technicalSummary(brief);requireAssessmentWindow(input,now);
  const effective=assessmentCriteria(brief,input);
  // A saved brief's old evidence remains historical. New private calculations capture
  // the current source without rewriting that brief or its priced requirements.
  const current=raw.request?captureCatalog(db,currentCatalogVersion(db)??undefined):null;
  const catalog=captureAssessmentCatalog(db,current?.snapshotVersion??context.snapshotVersion,current?.factVersion??context.factVersion,effective,brief.discovery?.exclusions??[]);
  const requirements={purpose:brief.purpose,deadlineUtc:brief.deadline?.utc??null,delivery:effective.delivery,operator:effective.operator,ownerCountry:effective.ownerCountry};
  const calculationDigest=calculationInputDigest(brief),inputDigest=digest(canonicalJson({calculationDigest,snapshotVersion:catalog.snapshotVersion,factVersion:catalog.factVersion}));
  return {generation:raw.generation,input,briefDigest:digest(canonicalJson(brief)),inputDigest,calculationDigest,catalog,brief,request:raw.request??null,requirements};
}
export function assessmentInputFromBrief(db:Database,brief:BriefInput,generation:number,now:string,request?:AssessmentStartInput['request']) {return prepareAssessmentInput(db,{brief,generation,...(request?{request}:{})},now);}
