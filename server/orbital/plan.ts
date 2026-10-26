import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { AssessmentCounts,AssessmentLimits,AssessmentObjectOutcome,AssessmentSelectedView,AssessmentState,PlanOption } from '../../shared/plan-contracts.js';
import type { OrbitalPathPoint } from '../../shared/orbital-contracts.js';
import { compareCatalogIds,orbitalFreshness } from '../../shared/orbital-policy.js';
import { canonicalJson,digest } from './catalog.js';
import { applicableModes,fixedChecks,groundCenterDistanceKm,instantaneousChecks,intervalCoverageChecks,measurementRequirements,nominalCorridor,optionOutcome,requiredUnknowns,type ModeEvidence } from './constraints.js';
import { createPropagator,lookAngles,observerAt,type PropagatedPosition,type OrbitPropagator } from './propagation.js';
import { solarElevationDeg } from './constraints.js';
import type { PreparedAssessmentInput } from './plan-input.js';

export const ASSESSMENT_LIMITS:AssessmentLimits=Object.freeze({coarseSeconds:10,refinementSeconds:1,maxObjectEvaluations:20000,maxEvaluations:2000000,maxExecutionMs:60000,maxOpportunitiesPerObject:200,maxManifestBytes:33554432});
export interface AssessmentCalculation {
  state:AssessmentState;reason:string|null;counts:AssessmentCounts;options:PlanOption[];outcomes:AssessmentObjectOutcome[];
  views:Record<string,AssessmentSelectedView>;coverageWarnings:string[];preferredOptionId:string|null;
}
export interface CalculationHooks {
  signal?:AbortSignal;now?:()=>number;yieldControl?:()=>Promise<unknown>;assertCurrent?:()=>void;
  propagator?:typeof createPropagator;onProgress?:(result:AssessmentCalculation)=>void;
  /** Internal deterministic-test work limits; HTTP input cannot set these. */
  limits?:Partial<{[K in keyof AssessmentLimits]:number}>;
}
export class CalculationStop extends Error {constructor(public reason:string,public scope:'OBJECT'|'JOB'|'CANCELED'='JOB'){super(reason);}}
interface Sample {at:number;position:PropagatedPosition;elevation:number;range:number;distance:number|null;solar?:number|null}
export function rankPlanOptions(a:PlanOption,b:PlanOption):number {
  const order={READY:0,PROVISIONAL:1,INELIGIBLE:2};
  return order[a.outcome]-order[b.outcome]||b.checks.filter(c=>c.applicability==='REQUIRED'&&c.state==='PASS').length-a.checks.filter(c=>c.applicability==='REQUIRED'&&c.state==='PASS').length||
    (a.proposedAtUtc??a.los.startUtc).localeCompare(b.proposedAtUtc??b.los.startUtc)||compareCatalogIds(a.itemId,b.itemId)||(a.instrument??'').localeCompare(b.instrument??'')||(a.mode??'').localeCompare(b.mode??'')||a.bands.join(',').localeCompare(b.bands.join(','))||a.id.localeCompare(b.id);
}
function blankCounts(prepared:PreparedAssessmentInput):AssessmentCounts{return {catalogUnique:prepared.catalog.items.length,matching:prepared.catalog.matching.length,ready:0,completed:0,positive:0,checkedNegative:0,stale:0,insufficient:0,incomplete:0,notAssessed:0,remaining:prepared.catalog.matching.length,evaluations:0};}
function outcome(item:PreparedAssessmentInput['catalog']['matching'][number]['item'],state:AssessmentObjectOutcome['state'],reason:string,evaluations=0,opportunityIds:string[]=[]):AssessmentObjectOutcome{return {itemId:item.id,name:item.name,state,reason,evaluations,opportunityIds,epoch:item.orbit.epoch,retrievedAt:item.orbit.retrievedAt};}
/** Physical samples are shared across all applicable bands. A base evaluation is one
 * propagation+LOS sample; corridor, solar and refinement work are charged explicitly. */
export async function calculateAssessment(prepared:PreparedAssessmentInput,calculatedAt:string,hooks:CalculationHooks={}):Promise<AssessmentCalculation> {
  const limits={...ASSESSMENT_LIMITS,...hooks.limits},now=hooks.now??(()=>performance.now()),started=now(),yieldControl=hooks.yieldControl??(()=>setImmediate()),counts=blankCounts(prepared);
  const result:AssessmentCalculation={state:'RUNNING',reason:null,counts,options:[],outcomes:[],views:{},coverageWarnings:[],preferredOptionId:null};
  if(prepared.catalog.validation!=='COMPLETE')result.coverageWarnings.push('Captured source coverage is partial; no global negative or automatic preferred-option claim is available.');
  const shortlist=new Set(prepared.brief.selectedEvidence.map(ref=>ref.itemId)),ordered=[...prepared.catalog.matching].sort((a,b)=>Number(shortlist.has(b.item.id))-Number(shortlist.has(a.item.id))||compareCatalogIds(a.item.id,b.item.id));
  const eligibility=new Map<string,string|null>();
  for(const row of ordered){const reason=row.item.orbit.state!=='VALID'||!row.omm?row.item.orbit.reason??'Missing, invalid or conflicting orbital inputs.':orbitalFreshness(row.item.orbit.epoch,row.item.orbit.retrievedAt,calculatedAt,[prepared.input.window.startUtc,prepared.input.window.endUtc]);eligibility.set(row.item.id,reason);if(!reason)counts.ready++;}
  let sinceYield=0,objectEvaluations=0,objectIndex=0;
  const stopCheck=()=>{if(hooks.signal?.aborted)throw new CalculationStop('Calculation canceled. Partial evidence is inspectable but cannot be newly attached.','CANCELED');if(now()-started>=limits.maxExecutionMs)throw new CalculationStop('Execution deadline reached; remaining work was not assessed.');};
  const charge=()=>{stopCheck();if(counts.evaluations>=limits.maxEvaluations)throw new CalculationStop('Job evaluation budget reached; remaining work was not assessed.');if(objectEvaluations>=limits.maxObjectEvaluations)throw new CalculationStop('Per-object evaluation budget reached; this object is incomplete.','OBJECT');counts.evaluations++;objectEvaluations++;sinceYield++;};
  const checkpoint=async(force=false)=>{stopCheck();if(force||sinceYield>=508){hooks.onProgress?.(result);await yieldControl();sinceYield=0;stopCheck();hooks.assertCurrent?.();}};
  const terminal=(entry:AssessmentObjectOutcome)=>{result.outcomes.push(entry);counts.remaining--;if(entry.state==='POSITIVE'){counts.positive++;counts.completed++;}else if(entry.state==='CHECKED_NEGATIVE'){counts.checkedNegative++;counts.completed++;}else if(entry.state==='STALE')counts.stale++;else if(entry.state==='INSUFFICIENT')counts.insufficient++;else if(entry.state==='INCOMPLETE')counts.incomplete++;else counts.notAssessed++;};
  // Reserve every identity, exact source/fact snapshot, element and terminal reason before options.
  let serializedBytes=Buffer.byteLength(canonicalJson({input:prepared.input,population:ordered.map(row=>({item:row.item,omm:row.omm})),outcomes:ordered.map(row=>outcome(row.item,'NOT_ASSESSED','Not assessed; output/work accounting reserved.'))}))+1024*1024;
  let globalStop:CalculationStop|null=null;
  if(serializedBytes>=limits.maxManifestBytes)globalStop=new CalculationStop('The captured full-population provenance exceeds the bounded manifest space; no population was silently removed.');
  for(;objectIndex<ordered.length;objectIndex++){
    const row=ordered[objectIndex]!,reason=eligibility.get(row.item.id)!;objectEvaluations=0;
    if(globalStop)break;
    try{await checkpoint(true);}catch(error){globalStop=error instanceof CalculationStop?error:new CalculationStop('Current source or access context changed.','CANCELED');break;}
    if(reason){terminal(outcome(row.item,/old|age|stale|retriev/i.test(reason)?'STALE':'INSUFFICIENT',reason));continue;}
    let orbit:OrbitPropagator;try{orbit=(hooks.propagator??createPropagator)(row.omm!);}catch{terminal(outcome(row.item,'INSUFFICIENT','The captured element set could not initialize the declared propagator.'));continue;}
    const modes=applicableModes(row.item,prepared.input),corridor=modes.some(mode=>nominalCorridor(mode)!==null),observer=observerAt(prepared.input.area.latitude,prepared.input.area.longitude),samples=new Map<number,Sample|null>(),required=measurementRequirements(prepared);
    const sample=(time:number,solar=false):Sample|null=>{
      let value=samples.get(time);
      if(value===undefined){charge();const predicted=orbit.at(new Date(time).toISOString()),angles=predicted.ok?lookAngles(predicted.ecfKm,observer):null;
        if(!predicted.ok||!angles){samples.set(time,null);return null;}
        let distance:number|null=null;if(corridor){charge();distance=groundCenterDistanceKm(prepared.input.area.latitude,prepared.input.area.longitude,predicted.geodetic.latitude,predicted.geodetic.longitude);}
        value={at:time,position:predicted,elevation:angles.elevationDeg,range:angles.slantRangeKm,distance};samples.set(time,value);
      }
      if(value&&solar&&value.solar===undefined){charge();value.solar=solarElevationDeg(value.position.at,prepared.input.area.latitude,prepared.input.area.longitude);}
      return value;
    };
    const refineBoundary=async(left:number,right:number,entering:boolean):Promise<number>=>{while(right-left>1000){await checkpoint();const middle=Math.floor((left+right)/2),value=sample(middle);if(!value)throw new CalculationStop('Propagation failed in a refined LOS boundary.','OBJECT');if((value.elevation>=10)===entering)right=middle;else left=middle;}return entering?right:left;};
    const refineExtremum=async(left:number,right:number,metric:'elevation'|'distance',maximize:boolean):Promise<Sample>=>{let best:Sample|null=null;const consider=(value:Sample|null)=>{if(!value||value[metric]===null)throw new CalculationStop('A refined physical sample is unavailable.','OBJECT');if(!best||(maximize?value[metric]!>best[metric]!:value[metric]!<best[metric]!))best=value;return value[metric]!;};
      consider(sample(left));consider(sample(right));while(right-left>1000){await checkpoint();const a=Math.floor(left+(right-left)/3),b=Math.ceil(right-(right-left)/3),av=consider(sample(a)),bv=consider(sample(b));if(maximize?av<bv:av>bv)left=a;else right=b;}consider(sample(Math.floor((left+right)/2)));return best!;};
    const objectOptions:PlanOption[]=[],objectViews:Record<string,AssessmentSelectedView>={};let segment:Sample[]=[],leftOutside:Sample|null=null,hadFailure=false,hadPositive=false;
    const emit=async(rightOutside:Sample|null,clippedEnd:boolean,partial=false)=>{
      if(!segment.length)return;hadPositive=true;
      const first=segment[0]!,last=segment[segment.length-1]!,start=leftOutside?await refineBoundary(leftOutside.at,first.at,true):first.at,end=rightOutside?await refineBoundary(last.at,rightOutside.at,false):last.at;
      const peakIndex=segment.reduce((best,current,index)=>current.elevation>segment[best]!.elevation?index:best,0),peak=await refineExtremum(peakIndex>0?segment[peakIndex-1]!.at:start,peakIndex+1<segment.length?segment[peakIndex+1]!.at:end,'elevation',true);
      let closest:Sample|null=null;
      if(corridor){const index=segment.reduce((best,current,i)=>current.distance!==null&&(segment[best]!.distance===null||current.distance<segment[best]!.distance!)?i:best,0);closest=await refineExtremum(index>0?segment[index-1]!.at:start,index+1<segment.length?segment[index+1]!.at:end,'distance',false);}
      const chosen=closest??peak,needsSolar=modes.some(mode=>mode.measurement==='reflected-light'||mode.sensor==='THERMAL')||required.night||required.day;
      if(needsSolar)sample(chosen.at,true);
      const sourcePoints=[sample(start),...segment,sample(end)].filter((v):v is Sample=>!!v).sort((a,b)=>a.at-b.at).filter((v,i,list)=>!i||v.at!==list[i-1]!.at),stride=Math.max(1,Math.ceil((sourcePoints.length-2)/254));
      const drawn=sourcePoints.filter((_v,index)=>index===0||index===sourcePoints.length-1||index%stride===0).slice(0,256);
      if(drawn.at(-1)?.at!==sourcePoints.at(-1)?.at)drawn[drawn.length-1]=sourcePoints.at(-1)!;
      for(const mode of modes){
        const coverage=partial?'PARTIAL' as const:'COMPLETE' as const;
        const dynamic=instantaneousChecks(mode,prepared,chosen.position,chosen.elevation,chosen.distance,chosen.solar??null),checks=[...fixedChecks(row.item,mode,prepared,row.unknowns),...dynamic.checks,...intervalCoverageChecks(coverage)];
        const status=optionOutcome(checks,coverage),id=digest(canonicalJson({inputDigest:prepared.inputDigest,itemId:row.item.id,instrument:mode.instrument,mode:mode.mode,sensor:mode.sensor,bands:mode.bands,start,end}));
        const timedChecks=dynamic.checks.filter(c=>c.applicability==='REQUIRED');
        const proposedAtUtc=closest&&coverage==='COMPLETE'&&timedChecks.every(c=>c.state==='PASS')?chosen.position.at:null;
        const option:PlanOption={id,itemId:row.item.id,catalogNumber:row.item.catalogNumber,name:row.item.name,evidenceVersion:row.item.evidenceVersion,instrument:mode.instrument,mode:mode.mode,product:mode.product,sensor:mode.sensor,bands:mode.bands,spatialResolutionM:mode.resolutionM,measurement:mode.measurement,sourceOrbit:row.item.orbit,capabilityFactIds:mode.factIds,
          los:{startUtc:new Date(start).toISOString(),endUtc:new Date(end).toISOString(),peakUtc:peak.position.at,peakElevationDeg:peak.elevation,slantRangeKm:peak.range,clippedStart:leftOutside===null,clippedEnd},nominalClosest:closest&&nominalCorridor(mode)!==null?{atUtc:closest.position.at,distanceKm:closest.distance!,thresholdKm:nominalCorridor(mode)!}:null,proposedAtUtc,coverage,outcome:status,checks,unknowns:requiredUnknowns(checks),assumptions:dynamic.assumptions,reasons:[...row.reasons,'10-second sampled center-point screen with≤1-second detected-bracket refinement; sub-sample opportunities may be missed.']};
        const points:OrbitalPathPoint[]=drawn.map(point=>({at:point.position.at,latitude:point.position.geodetic.latitude,longitude:point.position.geodetic.longitude,heightKm:point.position.geodetic.heightKm,x:point.position.display.x,y:point.position.display.y,z:point.position.display.z}));
        const view:AssessmentSelectedView={optionId:id,itemId:row.item.id,atUtc:proposedAtUtc??peak.position.at,arc:{points,sourceCadenceSeconds:10,displayStepSeconds:10*stride,startUtc:option.los.startUtc,endUtc:option.los.endUtc,clippedStart:option.los.clippedStart,clippedEnd:option.los.clippedEnd}};
        const bytes=Buffer.byteLength(canonicalJson({option,view}));if(serializedBytes+bytes>=limits.maxManifestBytes)throw new CalculationStop('Manifest output limit reached; remaining opportunities and objects were not assessed.');serializedBytes+=bytes;objectOptions.push(option);objectViews[id]=view;
      }
      segment=[];
    };
    try{
      const start=Date.parse(prepared.input.window.startUtc),end=Date.parse(prepared.input.window.endUtc);let previous:Sample|null=null,opportunities=0;
      for(let at=start;;at=Math.min(end,at+10000)){
        await checkpoint();const value=sample(at);
        if(!value){hadFailure=true;if(segment.length){await emit(null,true,true);opportunities++;}previous=null;leftOutside=null;}
        else if(value.elevation>=10){if(!segment.length)leftOutside=previous;segment.push(value);}
        else{if(segment.length){await emit(value,false);opportunities++;}previous=value;}
        if(opportunities>=limits.maxOpportunitiesPerObject&&at<end)throw new CalculationStop('Per-object opportunity output limit reached; remaining intervals are incomplete.','OBJECT');
        if(at===end)break;
      }
      if(segment.length)await emit(null,true);
      result.options.push(...objectOptions);Object.assign(result.views,objectViews);
      terminal(outcome(row.item,hadFailure?'INCOMPLETE':hadPositive?'POSITIVE':'CHECKED_NEGATIVE',hadFailure?'One or more required propagation intervals were unavailable.':hadPositive?'Detected LOS intervals completed under the declared sampled bounds.':'No sampled center-point LOS reached10° in the checked requested window; between-sample opportunities may be missed.',objectEvaluations,objectOptions.map(o=>o.id)));
    }catch(error){
      const stop=error instanceof CalculationStop?error:new CalculationStop('A required physical calculation failed; no completed claim was made.','OBJECT');
      // Previously completed opportunities survive; unfinished active intervals are not fabricated.
      result.options.push(...objectOptions);Object.assign(result.views,objectViews);terminal(outcome(row.item,'INCOMPLETE',stop.reason,objectEvaluations,objectOptions.map(o=>o.id)));
      if(stop.scope!=='OBJECT'){globalStop=stop;objectIndex++;break;}
    }
    if(objectIndex%10===9)try{await checkpoint(true);}catch(error){globalStop=error instanceof CalculationStop?error:new CalculationStop('Current source or access context changed.','CANCELED');objectIndex++;break;}
  }
  for(;objectIndex<ordered.length;objectIndex++)terminal(outcome(ordered[objectIndex]!.item,'NOT_ASSESSED',globalStop?.reason??'Calculation ended before this identity was assessed.'));
  result.options.sort(rankPlanOptions);
  result.state=globalStop?.scope==='CANCELED'?'CANCELED':globalStop||counts.incomplete||counts.notAssessed||counts.stale||counts.insufficient||prepared.catalog.validation!=='COMPLETE'?'INCOMPLETE':'COMPLETE';
  result.reason=globalStop?.reason??(counts.ready===0?'No eligible candidates.':result.state==='INCOMPLETE'?`None can be claimed globally complete: ${counts.completed} completed, ${counts.stale+counts.insufficient+counts.incomplete+counts.notAssessed} unavailable or not assessed.`:null);
  if(result.state==='INCOMPLETE')result.coverageWarnings.push('Calculation coverage is incomplete; completed options remain inspectable, with no automatic best-option or global sampled-negative claim.');
  result.preferredOptionId=result.state==='COMPLETE'?result.options.find(option=>option.outcome!=='INELIGIBLE')?.id??null:null;
  hooks.onProgress?.(result);return result;
}
