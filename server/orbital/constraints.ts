import { eciToEcf,gstime,jday,sunPos } from 'satellite.js';
import type { EOBandCapability } from '../../shared/eo-capabilities.js';
import type { RealCatalogItem } from '../../shared/orbital-contracts.js';
import type { PlanCheck,PlanInputSummary,PlanModelAssumption,PlanUnknown } from '../../shared/plan-contracts.js';
import type { PreparedAssessmentInput } from './plan-input.js';
import { observerAt,canonicalInstant,type PropagatedPosition } from './propagation.js';
import { canonicalJson,digest } from './catalog.js';

export const PLAN_METHOD_VERSION='coruscant-center-los-nadir-solar-v1';
export const PLAN_POLICY_VERSION='coruscant-checked-plan-v1';
export const SOLAR_PACKAGE_SHA256='0246943cf46aee78e47950493aafeee4a043119f4660d8a637f9c29cbeae820d';
export const MEAN_EARTH_RADIUS_KM=6371.0088;
const RAD=Math.PI/180;
export interface ModeEvidence { capability:EOBandCapability|null; instrument:string|null;mode:string|null;product:string|null;sensor:PlanInputSummary['sensor'];bands:string[];resolutionM:number|null;measurement:string|null;factIds:string[] }
export type SpectralRequirement={kind:'NONE'}|{kind:'BANDS';bands:string[]}|{kind:'INTERVAL';minimumUm:number;maximumUm:number;relation:'CONTINUOUS'|'OVERLAP'}|{kind:'UNRESOLVED';reason:string};
export interface MeasurementRequirements { spectral:SpectralRequirement;quantitativeL2A:boolean;night:boolean;day:boolean;ambiguous:string[];recordingDuration:boolean }
export function groundCenterDistanceKm(latitude:number,longitude:number,otherLatitude:number,otherLongitude:number):number|null {
  if(![latitude,longitude,otherLatitude,otherLongitude].every(Number.isFinite)||Math.abs(latitude)>90||Math.abs(otherLatitude)>90||Math.abs(longitude)>180||Math.abs(otherLongitude)>180)return null;
  const unit=(lat:number,lon:number)=>({x:Math.cos(lat*RAD)*Math.cos(lon*RAD),y:Math.cos(lat*RAD)*Math.sin(lon*RAD),z:Math.sin(lat*RAD)}),a=unit(latitude,longitude),b=unit(otherLatitude,otherLongitude);
  const cross=Math.hypot(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x),dot=a.x*b.x+a.y*b.y+a.z*b.z;
  return MEAN_EARTH_RADIUS_KM*Math.atan2(cross,Math.max(-1,Math.min(1,dot)));
}
/** The equatorial Sun direction is AU-valued; only its direction enters horizon projection. */
export function solarElevationDeg(atUtc:string,latitude:number,longitude:number):number|null {
  if(!canonicalInstant(atUtc))return null;const date=new Date(atUtc),year=date.getUTCFullYear();if(year<1950||year>2050)return null;
  try{const sun=sunPos(jday(date)).rsun,ecf=eciToEcf(sun,gstime(date)),observer=observerAt(latitude,longitude),length=Math.hypot(ecf.x,ecf.y,ecf.z);
    if(!Number.isFinite(length)||length<=0)return null;const vertical=(ecf.x*observer.up.x+ecf.y*observer.up.y+ecf.z*observer.up.z)/length;
    return Math.asin(Math.max(-1,Math.min(1,vertical)))/RAD;
  }catch{return null;}
}
export function parseSpectralRequirement(text:string):SpectralRequirement {
  const source=text.trim();if(!source)return {kind:'NONE'};
  const bandGrammar=source.replace(/^bands?\s*:?\s*/i,'');
  if(/^B\d{1,2}[A]?\s*(?:(?:[,/+]|\band\b)\s*B\d{1,2}[A]?\s*)*$/i.test(bandGrammar))return {kind:'BANDS',bands:[...new Set([...bandGrammar.matchAll(/B(\d{1,2})(A?)/gi)].map(m=>`B${m[1]!.padStart(2,'0')}${m[2]!.toUpperCase()}`))]};
  const interval=/^(continuous(?:\s+coverage)?|cover(?:age)?|overlap(?:ping)?)\s*:?\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*(nm|um|µm|μm)$/i.exec(source);
  if(interval){const unit=interval[4]!.toLowerCase()==='nm'?1000:1,min=Number(interval[2])/unit,max=Number(interval[3])/unit;if(min>0&&max>=min&&max<=10000)return {kind:'INTERVAL',minimumUm:min,maximumUm:max,relation:/^overlap/i.test(interval[1]!)?'OVERLAP':'CONTINUOUS'};}
  return {kind:'UNRESOLVED',reason:'This wavelength/band wording is outside the supported explicit band-list or continuous/overlap numeric-interval grammar; it has not established spectral compatibility.'};
}
function positiveAndNegated(text:string,pattern:RegExp):{positive:boolean;negative:boolean}{let positive=false,negative=false;for(const match of text.matchAll(pattern)){const prefix=text.slice(Math.max(0,match.index!-35),match.index).toLowerCase();if(/(?:\bno\b|\bnot\b|\bwithout\b|\bdon't\b|\bdo not\b)[^.!?;]{0,25}$/.test(prefix))negative=true;else positive=true;}return {positive,negative};}
export function measurementRequirements(prepared:Pick<PreparedAssessmentInput,'requirements'|'input'>):MeasurementRequirements {
  const text=prepared.requirements.purpose,night=positiveAndNegated(text,/\b(?:night(?:time)?|after dark)\b/gi),day=positiveAndNegated(text,/\b(?:daylight|daytime)\b/gi),l2a=positiveAndNegated(text,/\b(?:L2A|level[ -]?2A)\b/gi),quantitative=positiveAndNegated(text,/\b(?:quantitative|scientific|surface reflectance)\b/gi);
  const ambiguous:string[]=[];
  if((night.positive&&day.positive)||(night.positive&&night.negative)||(day.positive&&day.negative))ambiguous.push('The day/night requirement is contradictory or negated; review its intended measurement.');
  if(l2a.positive&&(!quantitative.positive||l2a.negative||quantitative.negative))ambiguous.push('The requested L2A/product wording needs explicit review; no quantitative-product assumption was made.');
  return {spectral:parseSpectralRequirement(prepared.input.spectralRequirements),quantitativeL2A:l2a.positive&&quantitative.positive&&!l2a.negative&&!quantitative.negative,night:night.positive&&!night.negative&&!day.positive,day:day.positive&&!day.negative&&!night.positive,ambiguous,
    recordingDuration:/\b(?:record(?:ing)?|collect(?:ion)?)\b[^.!?\n]{0,50}\b\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?)\b/i.test(text)};
}
export function applicableModes(item:RealCatalogItem,input:PlanInputSummary):ModeEvidence[] {
  const rows=(item.bandCapabilities??[]).filter(cap=>input.sensor==='OPEN'||cap.sensor===input.sensor);
  if(rows.length)return rows.map(cap=>({capability:cap,instrument:cap.instrument,mode:cap.mode,product:null,sensor:cap.sensor,bands:[...cap.bands],resolutionM:cap.spatialResolutionM,measurement:cap.measurement,factIds:item.capabilityFacts.filter(f=>f.mode===cap.mode||f.field==='family'||f.field==='instrument').map(f=>f.id)}));
  return [{capability:null,instrument:null,mode:null,product:null,sensor:input.sensor==='OPEN'&&item.sensors?.length===1?item.sensors[0] as PlanInputSummary['sensor']:input.sensor,bands:[],resolutionM:item.resolutionM,measurement:null,factIds:item.capabilityFacts.map(f=>f.id)}];
}
const check=(id:string,label:string,state:PlanCheck['state'],reason:string,actualValue:PlanCheck['actualValue']=null,requiredValue:PlanCheck['requiredValue']=null,unit:string|null=null,sourceFactIds:string[]=[],applicability:PlanCheck['applicability']='REQUIRED'):PlanCheck=>({id,label,state,reason,actualValue,requiredValue,unit,sourceFactIds,applicability});
export function spectralCheck(requirement:SpectralRequirement,mode:ModeEvidence):PlanCheck {
  const ids=mode.factIds;
  if(requirement.kind==='NONE')return check('spectral','Requested spectral compatibility','NOT_APPLICABLE','No explicit spectral constraint was supplied.',null,null,null,ids,'NOT_APPLICABLE');
  if(requirement.kind==='UNRESOLVED')return check('spectral','Requested spectral compatibility','UNKNOWN',requirement.reason,null,null,null,ids);
  if(!mode.capability)return check('spectral','Requested spectral compatibility','UNKNOWN','No compatible band/mode spectral facts are documented for this option.',null,requirement.kind==='BANDS'?requirement.bands.join(', '):`${requirement.minimumUm}–${requirement.maximumUm} µm`,null,ids);
  if(requirement.kind==='BANDS'){const missing=requirement.bands.filter(b=>!mode.bands.includes(b));return check('spectral','Requested band set',missing.length?'FAIL':'PASS',missing.length?`This exact mode does not document all requested bands: ${missing.join(', ')}.`:'The same proposed instrument/mode documents every requested band.',mode.bands.join(', '),requirement.bands.join(', '),null,ids);}
  const ranges=[...mode.capability.wavelengthRangesUm].sort((a,b)=>a.minimum-b.minimum);
  if(!ranges.length)return check('spectral','Requested spectral interval','UNKNOWN','Equivalent band centers/widths do not prove measured passband overlap or continuous coverage.',null,`${requirement.relation} ${requirement.minimumUm}–${requirement.maximumUm}`,'µm',ids);
  let end=requirement.minimumUm;for(const range of ranges){if(range.minimum<=end&&range.maximum>=end)end=Math.max(end,range.maximum);}
  const pass=requirement.relation==='CONTINUOUS'?end>=requirement.maximumUm:ranges.some(r=>r.maximum>=requirement.minimumUm&&r.minimum<=requirement.maximumUm);
  return check('spectral',requirement.relation==='CONTINUOUS'?'Requested continuous spectral coverage':'Requested spectral overlap',pass?'PASS':'FAIL',pass?'The cited applicable band ranges meet the explicit interval relation.':'Documented spectral ranges do not meet the explicit interval relation; mere overlap cannot pass continuous coverage.',ranges.map(r=>`${r.minimum}–${r.maximum}`).join(', '),`${requirement.minimumUm}–${requirement.maximumUm}`,'µm',ids);
}
export function fixedChecks(item:RealCatalogItem,mode:ModeEvidence,prepared:PreparedAssessmentInput,matchingUnknowns:string[]):PlanCheck[] {
  const input=prepared.input,requirements=measurementRequirements(prepared),checks:PlanCheck[]=[];
  const knownSensors=item.sensors;
  checks.push(check('sensor','Applicable sensor/mode',mode.capability||input.sensor!=='OPEN'&&knownSensors?.includes(input.sensor)?'PASS':knownSensors&&input.sensor!=='OPEN'?'FAIL':'UNKNOWN',mode.capability?'A cited band/mode supports this sensor category.':knownSensors?.includes(input.sensor)?'The cited mission sensor category matches; instrument geometry is separately unresolved.':'The requested applicable sensor/mode is not documented.',mode.sensor,input.sensor,null,mode.factIds));
  if(input.maxResolutionM!==null)checks.push(check('resolution','Requested native spatial resolution',mode.resolutionM===null?'UNKNOWN':mode.resolutionM<=input.maxResolutionM?'PASS':'FAIL',mode.resolutionM===null?'Applicable native spatial resolution is not documented.':'Compare the selected applicable native band resolution; distributed pixel spacing is not improved native resolution.',mode.resolutionM,input.maxResolutionM,'m',mode.factIds));
  checks.push(spectralCheck(requirements.spectral,mode));
  matchingUnknowns.forEach((reason,index)=>checks.push(check(`evidence-${digest(reason).slice(0,16)}`,'Requested catalog evidence','UNKNOWN',reason,null,null,null,mode.factIds)));
  if(input.cloudCover!==null)checks.push(check('cloud','Requested cloud bound','UNKNOWN','There is no authoritative cloud forecast or supplied-image cloud measurement for this future option.',null,input.cloudCover,'%',[]));
  if(input.revisitHours!==null)checks.push(check('revisit','Requested revisit bound','UNKNOWN','A single bounded opportunity does not establish repeat-acquisition cadence or provider scheduling.',null,input.revisitHours,'h',[]));
  if(prepared.requirements.deadlineUtc)checks.push(check('deadline','Requested deadline','UNKNOWN','Delivery/processing completion is not established by the predicted collection instant.',null,prepared.requirements.deadlineUtc,'UTC',[]));
  if(prepared.requirements.delivery)checks.push(check('delivery-request','Requested delivery condition','UNKNOWN','There is no cited provider turnaround or delivery commitment for this request.',null,prepared.requirements.delivery,null,[]));
  if(input.observationIntent==='comparison')checks.push(check('comparison-acquisitions','Baseline/recent acquisition availability','UNKNOWN','One future planning window does not establish either requested historical acquisition or an archive pair.',null,`${input.baselineDate||'Baseline missing'} / ${input.recentDate||'Recent missing'}`,null,[]));
  requirements.ambiguous.forEach(reason=>checks.push(check(`measurement-${digest(reason).slice(0,12)}`,'Measurement wording needs review','UNKNOWN',reason)));
  if(requirements.recordingDuration)checks.push(check('recording-duration','Requested recording duration','UNKNOWN','This bounded kernel proposes a checked instant, not a supported recording duration or interval footprint.'));
  if(input.unknowns.length)input.unknowns.forEach(reason=>checks.push(check(`authored-${digest(reason).slice(0,12)}`,'Authored unresolved requirement','UNKNOWN',reason)));
  if(input.timingNotes.trim())checks.push(check('timing-notes','Authored timing conditions','UNKNOWN','Freeform timing notes are retained for review and have not been proven by this bounded check set.',null,input.timingNotes,null,[]));
  checks.push(check('actual-pointing','Actual attitude and pointing','UNKNOWN','Actual instrument pointing and SAR incidence/side are not verified.',null,null,null,[],'CONTEXT'),check('whole-circle','Whole-circle imageability','UNKNOWN','Center-point LOS and nominal center proximity do not establish full-circle image coverage.',input.area.radiusKm,null,'km',[],'CONTEXT'),check('operator','Operator capacity and confirmation','UNKNOWN','No operator availability, capacity, agreement or tasking is established.',null,null,null,[],'CONTEXT'),check('delivery-timing','Delivery timing not established','UNKNOWN','No provider ETA or processing assumption has been supplied.',null,null,null,[],'CONTEXT'));
  // These are required only when actually asked for, rather than universal fake-pass conditions.
  const purpose=prepared.requirements.purpose;
  if(/\b(?:whole|entire|full)\s+(?:area|circle|region|target)\b/i.test(purpose))checks.push(check('requested-whole-area','Requested whole-area imageability','UNKNOWN','The requested whole-area requirement is not implemented by the center-only checks.'));
  if(/\b(?:guaranteed?|confirmed|available)\s+(?:capacity|operator|tasking|booking)\b/i.test(purpose))checks.push(check('requested-operator','Requested operator commitment','UNKNOWN','No authoritative operator/capacity integration is implemented.'));
  return checks;
}
export function nominalCorridor(mode:ModeEvidence):number|null {return mode.capability?.mode==='nominal nadir pushbroom'&&mode.capability.nominalSwathKm>0?mode.capability.nominalSwathKm/2:null;}
/** Coverage uncertainty is independent of a successfully rechecked instant. */
export function intervalCoverageChecks(coverage:'COMPLETE'|'PARTIAL'):PlanCheck[]{
  return coverage==='PARTIAL'?[check('interval-incomplete','LOS interval coverage','UNKNOWN','This LOS interval is clipped by unfinished calculation work, not a completed sensor-access interval.')]:[];
}
export function instantaneousChecks(mode:ModeEvidence,prepared:PreparedAssessmentInput,position:PropagatedPosition,elevationDeg:number,distanceKm:number|null,solarDeg:number|null):{checks:PlanCheck[];assumptions:PlanModelAssumption[]} {
  const requirements=measurementRequirements(prepared),threshold=nominalCorridor(mode),checks:PlanCheck[]=[check('los','Predicted center-point LOS',elevationDeg>=10?'PASS':'FAIL','Sampled geometric center-point elevation; not actual instrument access.',elevationDeg,10,'deg',[])],assumptions:PlanModelAssumption[]=[];
  if(threshold===null){checks.push(check('corridor','Nominal nadir swath-center check','NOT_APPLICABLE','The optical nadir proxy is not applicable to SAR or undocumented mode geometry.',null,null,'km',mode.factIds,'NOT_APPLICABLE'),check('sensor-geometry','Applicable sensor-center geometry','UNKNOWN','No implemented applicable sensor geometry exists for this mode; SAR incidence/side cannot be established by optical swath logic.',null,null,null,mode.factIds));}
  else checks.push(check('corridor','Nominal swath-center check',distanceKm===null?'UNKNOWN':distanceKm<=threshold?'PASS':'FAIL','Mean-sphere center-to-ground-track distance versus half the cited nominal swath; radius is independent and whole-circle coverage is unverified.',distanceKm,threshold,'km',mode.factIds));
  const landsat=mode.instrument?.startsWith('OLI')||mode.instrument?.startsWith('TIRS'),reflected=mode.measurement==='reflected-light';
  if(requirements.night){checks.push(check('illumination','General reflected-light daylight screen','NOT_APPLICABLE','An explicitly requested night measurement is not silently evaluated as ordinary reflected-light daytime collection.',solarDeg,null,'deg',mode.factIds,'NOT_APPLICABLE'));checks.push(check('night-policy','Night collection policy','UNKNOWN','Night detection physics does not establish routine taskability for this instrument/measurement.',solarDeg,null,'deg',mode.factIds));checks.push(check('night','Requested night condition',solarDeg===null?'UNKNOWN':Math.abs(solarDeg)<=.1?'BOUNDARY_UNCERTAIN':solarDeg<0?'PASS':'FAIL','Approximate target-center solar elevation; values within0.1° of zero are uncertain.',solarDeg,0,'deg',[]));}
  else if(reflected){const limit=requirements.quantitativeL2A&&mode.instrument==='MSI'?20:landsat?5:0,strict=limit===0;
    const state=solarDeg===null?'UNKNOWN':Math.abs(solarDeg-limit)<=.1?'BOUNDARY_UNCERTAIN':(strict?solarDeg>limit:solarDeg>=limit)?'PASS':'FAIL';
    checks.push(check('illumination',limit===20?'Requested quantitative L2A solar screen':landsat?'Landsat routine daylight screen':'Minimal reflected-light daylight screen',state,limit===20?'Requested quantitative L2A surface-reflectance use retains the documented solar-zenith≤70° caution.':landsat?'Routine USGS scene-center≥5° policy, approximated at the requested target center; special low-sun requests are not physical impossibility.':'Explicit minimal target-center Sun>0° model; it is not an operator quality or acceptance requirement.',solarDeg,limit,'deg',mode.factIds));
    assumptions.push({id:limit===20?'s2-l2a-sza70':landsat?'landsat-routine-solar5':'s2-minimal-daylight',label:limit===20?'Quantitative L2A uses solar elevation≥20°, with0.1° uncertainty guard.':landsat?'Routine scene-center policy is approximated at target center; no authoritative scene assignment.':'Minimal reflected-light daylight assumption: Sun>0°, with0.1° uncertainty guard.',sourceFactIds:mode.factIds});
  }else checks.push(check('illumination','Reflected-light daylight screen','NOT_APPLICABLE','Thermal or unresolved measurements are not silently made daylight-only.',solarDeg,null,'deg',mode.factIds,'NOT_APPLICABLE'));
  if(!requirements.night&&mode.sensor==='THERMAL'&&(solarDeg===null||solarDeg<=.1))checks.push(check('night-policy','Night collection policy','UNKNOWN',solarDeg===null?'Target-center illumination is unavailable; thermal detection physics does not establish routine nighttime taskability.':'The actual target-center opportunity is nighttime or within the existing0.1° solar-boundary uncertainty. Thermal detection physics does not establish routine nighttime taskability.',solarDeg,0,'deg',mode.factIds));
  if(requirements.day&&!reflected)checks.push(check('explicit-day','Requested daylight condition',solarDeg===null?'UNKNOWN':Math.abs(solarDeg)<=.1?'BOUNDARY_UNCERTAIN':solarDeg>0?'PASS':'FAIL','The actual requested day condition is evaluated separately from sensor physics.',solarDeg,0,'deg',[]));
  if(requirements.quantitativeL2A&&mode.instrument!=='MSI')checks.push(check('l2a-product','Requested L2A product compatibility','FAIL','The requested Sentinel-2 quantitative L2A product is not supplied by this proposed instrument.',mode.instrument,'MSI L2A',null,mode.factIds));
  return {checks,assumptions};
}
export function optionOutcome(checks:PlanCheck[],coverage:'COMPLETE'|'PARTIAL'):'READY'|'PROVISIONAL'|'INELIGIBLE' {const required=checks.filter(c=>c.applicability==='REQUIRED');return required.some(c=>c.state==='FAIL')?'INELIGIBLE':coverage==='PARTIAL'||required.some(c=>c.state==='UNKNOWN'||c.state==='BOUNDARY_UNCERTAIN')?'PROVISIONAL':'READY';}
export function requiredUnknowns(checks:PlanCheck[]):PlanUnknown[]{return checks.filter(c=>c.applicability==='REQUIRED'&&(c.state==='UNKNOWN'||c.state==='BOUNDARY_UNCERTAIN')).map(c=>({id:c.id,label:c.label,reason:c.reason}));}
export function constraintDigest(checks:PlanCheck[]):string{return digest(canonicalJson(checks));}
