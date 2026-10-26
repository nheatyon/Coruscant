import { createHash } from 'node:crypto';
import type { CapabilityFact, NormalizedOMM, NormalizedSourceRow, OrbitalSourceKey, ParsedSource, RealCatalogItem, SourceMembership } from '../../shared/orbital-contracts.js';
import { opticalCapabilities, EO_IDENTITY_DESIGNATORS, EO_FACT_CHECKED_AT } from './eo-facts.js';
import { canonicalCatalogNumber, compareCatalogIds, ORBITAL_LIMITS, ORBITAL_PARSER_VERSION } from '../../shared/orbital-policy.js';

export function canonicalJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,entry])=>`${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function normalizedInstant(value:unknown):string|null {
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z?$/.test(value))return null;
  const raw=value.endsWith('Z')?value:`${value}Z`,time=Date.parse(raw);if(!Number.isFinite(time))return null;
  const result=new Date(time).toISOString();return result.slice(0,19)===raw.slice(0,19)?result:null;
}
export function sourceEpochKey(value:string):string {const canonical=value.endsWith('Z')?value:`${value}Z`;const [seconds,fraction='']=canonical.slice(0,-1).split('.');return `${seconds}.${fraction.padEnd(9,'0')}`;}
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function numberField(row:Record<string,unknown>,key:string,fallback?:number):number {
  const raw=row[key]??fallback;if(typeof raw!=='number'||!Number.isFinite(raw))throw new Error(`${key} must be finite.`);return raw;
}
export function normalizeSourceRow(raw:unknown):NormalizedSourceRow|null {
  if(!record(raw))return null;const catalogNumber=canonicalCatalogNumber(raw.NORAD_CAT_ID);if(!catalogNumber)return null;
  const name=typeof raw.OBJECT_NAME==='string'&&raw.OBJECT_NAME.trim()?raw.OBJECT_NAME.trim().slice(0,4000):`Catalog object ${catalogNumber}`;
  const rowHash=digest(canonicalJson(raw));const base={id:`norad:${catalogNumber}`,catalogNumber,name,aliases:[] as string[],cosparId:typeof raw.OBJECT_ID==='string'&&raw.OBJECT_ID.trim()?raw.OBJECT_ID.trim():null,rowHash};
  try {
    const epoch=normalizedInstant(raw.EPOCH);if(!epoch)throw new Error('EPOCH is missing or invalid.');
    for(const [key,expected]of Object.entries({CENTER_NAME:'EARTH',REF_FRAME:'TEME',TIME_SYSTEM:'UTC',MEAN_ELEMENT_THEORY:'SGP4'}))if(raw[key]!==undefined&&raw[key]!==expected)throw new Error(`Unsupported ${key}.`);
    const omm:NormalizedOMM={OBJECT_NAME:name,OBJECT_ID:base.cosparId??'',EPOCH:epoch,NORAD_CAT_ID:catalogNumber,CENTER_NAME:'EARTH',REF_FRAME:'TEME',TIME_SYSTEM:'UTC',MEAN_ELEMENT_THEORY:'SGP4',
      MEAN_MOTION:numberField(raw,'MEAN_MOTION'),ECCENTRICITY:numberField(raw,'ECCENTRICITY'),INCLINATION:numberField(raw,'INCLINATION'),RA_OF_ASC_NODE:numberField(raw,'RA_OF_ASC_NODE'),ARG_OF_PERICENTER:numberField(raw,'ARG_OF_PERICENTER'),MEAN_ANOMALY:numberField(raw,'MEAN_ANOMALY'),
      EPHEMERIS_TYPE:numberField(raw,'EPHEMERIS_TYPE',0),CLASSIFICATION_TYPE:typeof raw.CLASSIFICATION_TYPE==='string'?raw.CLASSIFICATION_TYPE:'U',ELEMENT_SET_NO:numberField(raw,'ELEMENT_SET_NO',0),REV_AT_EPOCH:numberField(raw,'REV_AT_EPOCH',0),BSTAR:numberField(raw,'BSTAR'),MEAN_MOTION_DOT:numberField(raw,'MEAN_MOTION_DOT'),MEAN_MOTION_DDOT:numberField(raw,'MEAN_MOTION_DDOT')};
    if(omm.MEAN_MOTION<=0||omm.ECCENTRICITY<0||omm.ECCENTRICITY>=1||omm.INCLINATION<0||omm.INCLINATION>180||[omm.RA_OF_ASC_NODE,omm.ARG_OF_PERICENTER,omm.MEAN_ANOMALY].some(v=>v<0||v>=360)||omm.EPHEMERIS_TYPE!==0||![omm.ELEMENT_SET_NO,omm.REV_AT_EPOCH].every(v=>Number.isSafeInteger(v)&&v>=0))throw new Error('Orbital values are outside supported SGP4 bounds.');
    const {OBJECT_NAME:_name,OBJECT_ID:_designator,...orbital}=omm;
    const sourceEpoch=String(raw.EPOCH).endsWith('Z')?String(raw.EPOCH):`${String(raw.EPOCH)}Z`;
    return {...base,omm,orbitalHash:digest(canonicalJson({...orbital,EPOCH:sourceEpochKey(sourceEpoch)})),epoch,sourceEpoch,error:null};
  }catch(error){return {...base,omm:null,orbitalHash:null,epoch:null,sourceEpoch:null,error:error instanceof Error?error.message:'Orbit data invalid/unsupported.'};}
}
export function parseSourceBytes(group:OrbitalSourceKey,bytes:Uint8Array,retrievedAt:string):ParsedSource {
  if(bytes.byteLength>ORBITAL_LIMITS.sourceBytes)throw new Error('Catalog refresh incomplete — source exceeds the reviewed limit');
  const instant=normalizedInstant(retrievedAt);if(!instant)throw new Error('Source retrieval time is invalid.');
  let data:unknown;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('Catalog source is not a valid JSON array.');}
  if(!Array.isArray(data))throw new Error('Catalog source is not a JSON array.');
  if(data.length>ORBITAL_LIMITS.sourceRows)throw new Error('Catalog refresh incomplete — source exceeds the reviewed limit');
  const rows:NormalizedSourceRow[]=[];let rejected=0,invalidOrbits=0;
  for(const raw of data){const row=normalizeSourceRow(raw);if(!row){rejected++;continue;}rows.push(row);if(!row.omm)invalidOrbits++;}
  const responseHash=digest(bytes),version=digest(canonicalJson({group,responseHash,retrievedAt:instant,parser:ORBITAL_PARSER_VERSION}));
  return {group,version,responseHash,retrievedAt:instant,checkedAt:instant,validation:rejected||invalidOrbits?'PARTIAL':'COMPLETE',rowCount:data.length,rejected,invalidOrbits,rows};
}

/** Original fact summaries; GP group membership never supplies sensor/operator/resolution. */
export const CAPABILITY_CHECKED_AT='2026-10-25T00:17:56.000Z';
export const CAPABILITY_FACT_VERSION='coruscant-primary-facts-v2';
const mission='https://sentiwiki.copernicus.eu/web/s1-mission';
const products='https://sentiwiki.copernicus.eu/web/s1-products';
export function initialCapabilityFacts(id:string):CapabilityFact[] {
  const optical=opticalCapabilities(id);
  if(optical.length){
    const fact=(field:CapabilityFact['field'],value:CapabilityFact['value'],cap=optical[0]!,unit:string|null=null):CapabilityFact=>{const content={id:`${id}:${field}:${cap.instrument}:${cap.sensor}`,canonicalId:id,field,value,unit,mode:cap.mode,product:cap.bands.join('/'),sourceUrl:cap.sourceUrl,section:cap.section,checkedAt:EO_FACT_CHECKED_AT,uncertainty:cap.caveat};return {...content,version:digest(canonicalJson(content))};};
    return [fact('family','EO'),...optical.flatMap(cap=>[fact('sensor',cap.sensor,cap),fact('instrument',cap.instrument,cap),fact('band',cap.bands.join('/'),cap),fact('spatialResolution',cap.spatialResolutionM,cap,'m'),fact('nominalSwath',cap.nominalSwathKm,cap,'km'),...(cap.equivalentSpectralSamples?.length?[fact('wavelength',cap.equivalentSpectralSamples.flatMap(sample=>[sample.wavelengthNm,sample.bandwidthNm]),{...cap,section:cap.section+'; equivalent center and bandwidth pairs, not continuous passbands'},'nm')]:[]),...(cap.wavelengthRangesUm.length?[fact('wavelength',cap.wavelengthRangesUm.flatMap(range=>[range.minimum,range.maximum]),cap,'µm')]:[])])];
  }
  if(id!=='norad:62261'&&id!=='norad:66315')return [];
  const fact=(field:CapabilityFact['field'],value:CapabilityFact['value'],sourceUrl:string,section:string,mode:string|null=null,product:string|null=null,uncertainty='Capability evidence does not establish current health, collection availability or taskability.',unit:string|null=null):CapabilityFact=>{const content={id:`${id}:${field}:${mode??'general'}:${product??'general'}`,canonicalId:id,field,value,unit,mode,product,sourceUrl,section,checkedAt:CAPABILITY_CHECKED_AT,uncertainty};return {...content,version:digest(canonicalJson(content))};};
  return [fact('family','EO',mission,'Mission overview'),fact('sensor','SAR',mission,'C-band synthetic aperture radar'),fact('operator','European Space Agency', 'https://www.esa.int/Enabling_Support/Operations/ESOC_Past_current_and_future_missions','Sentinel-1C / Sentinel-1D operations'),fact('operatorCode','ESA',mission,'Sentinel-1 program'),fact('program','Copernicus Sentinel-1',mission,'Mission overview'),
    fact('resolution',[5,5],mission,'Nominal acquisition-mode spatial resolution','SM',null,undefined,'m'),fact('resolution',[5,20],mission,'Nominal acquisition-mode spatial resolution','IW',null,undefined,'m'),fact('resolution',[20,40],mission,'Nominal acquisition-mode spatial resolution','EW',null,undefined,'m'),fact('resolution',[5,5],mission,'Separated ocean vignettes; not full-circle coverage','WV',null,undefined,'m'),fact('resolution',[20,22],products,'Approximate spatial resolution; 10×10 m pixel spacing is not spatial resolution','IW','GRD HR',undefined,'m')];
}
export type SourceIdentity=Pick<ParsedSource,'group'|'version'|'retrievedAt'|'checkedAt'>;
export interface MembershipRows {source:ParsedSource; rows:{row:NormalizedSourceRow;source?:SourceIdentity;confirmation:'CONFIRMED'|'UNCONFIRMED';lastSeenAt:string}[]}
export function assembleCatalog(groups:MembershipRows[]):{items:RealCatalogItem[];elements:Map<string,NormalizedOMM>} {
  const all=new Map<string,{row:NormalizedSourceRow;source:SourceIdentity;membership:SourceMembership}[]>();
  for(const group of groups)for(const entry of group.rows){const source=entry.source??group.source,list=all.get(entry.row.id)??[];list.push({row:entry.row,source,membership:{group:source.group,sourceVersion:source.version,retrievedAt:source.retrievedAt,rowHash:entry.row.rowHash,confirmation:entry.confirmation,lastSeenAt:entry.lastSeenAt}});all.set(entry.row.id,list);}
  if(all.size>ORBITAL_LIMITS.unionObjects)throw new Error('Catalog refresh incomplete — source exceeds the reviewed limit');
  const elements=new Map<string,NormalizedOMM>(),items:RealCatalogItem[]=[];
  for(const [id,entries]of all){
    const ordered=[...entries].sort((a,b)=>(b.row.sourceEpoch?sourceEpochKey(b.row.sourceEpoch):'').localeCompare(a.row.sourceEpoch?sourceEpochKey(a.row.sourceEpoch):'')||a.source.group.localeCompare(b.source.group));
    const valid=ordered.filter(e=>e.row.omm),latest=valid[0],same=latest?valid.filter(e=>sourceEpochKey(e.row.sourceEpoch!)===sourceEpochKey(latest.row.sourceEpoch!)):[];
    const conflict=new Set(same.map(e=>e.row.orbitalHash)).size>1,chosen=latest??ordered[0]!;
    const memberships=entries.map(e=>e.membership),expectedDesignator=id==='norad:62261'?'2024-235A':id==='norad:66315'?'2025-251A':EO_IDENTITY_DESIGNATORS[id]??null;
    const identityDisagreement=!!expectedDesignator&&(entries.some(e=>e.row.cosparId!==null&&e.row.cosparId!==expectedDesignator)||!!EO_IDENTITY_DESIGNATORS[id]&&!entries.some(e=>e.row.cosparId===expectedDesignator)),facts=identityDisagreement?[]:initialCapabilityFacts(id),sar=facts.some(f=>f.field==='sensor'&&f.value==='SAR'),operator=facts.find(f=>f.field==='operator')?.value;
    const orbit:RealCatalogItem['orbit']={state:conflict?'CONFLICT':latest?'VALID':'INVALID',elementVersion:!conflict&&latest?latest.row.orbitalHash:null,epoch:latest?.row.epoch??null,sourceEpoch:latest?.row.sourceEpoch??null,retrievedAt:latest?latest.source.retrievedAt:null,orbitalHash:!conflict&&latest?latest.row.orbitalHash:null,reason:conflict?'Equal-epoch element sources conflict.':latest?null:chosen.row.error??'Orbit data invalid/unsupported.',sourceVersions:[...new Set(entries.map(e=>e.source.version))]};
    if(latest&&!conflict)elements.set(id,latest.row.omm!);
    const caveats=['Source-group membership is classification, not verified instrument or service availability.','Current health/taskability and owner-country are not established by GP data.'];
    if(identityDisagreement)caveats.push('Needs review — source designator differs from the independently checked identity; capability enrichment is withheld.');
    const optical=identityDisagreement?[]:opticalCapabilities(id);
    if(optical.length)caveats.push('Band/mode-dependent native resolution; distributed pixel spacing is separate. Nominal swath is not verified pointing, whole-area coverage or an available collection.');
    if(sar)caveats.push('Mode/product required to verify requested resolution; nominal mode dimensions and pixel spacing are not a universal product resolution.');
    if(memberships.some(m=>m.confirmation==='UNCONFIRMED'))caveats.push('Membership is unconfirmed in a partial source version; prior last-seen age is retained.');
    if(orbit.reason)caveats.push(orbit.reason);
    const base:RealCatalogItem={id,name:chosen.row.name,family:'EO',type:'catalog',operator:typeof operator==='string'?operator:null,operatorCode:sar?'ESA':null,ownerCountry:null,sensors:sar?['SAR']:optical.length?[...new Set(optical.map(cap=>cap.sensor))]:null,resolutionM:null,bandCapabilities:optical.length?optical:undefined,
      evidenceVersion:'',source:entries.map(e=>`CelesTrak ${e.source.group}`).join(' + '),checkedAt:chosen.source.checkedAt,demonstration:false,sourceKind:'PUBLIC_REAL',familyDocumented:facts.some(f=>f.field==='family'&&f.value==='EO'),caveats,status:'unknown',launchDate:null,aliases:[...new Set(entries.map(e=>e.row.name))],noradId:Number(chosen.row.catalogNumber),catalogNumber:chosen.row.catalogNumber,cosparId:chosen.row.cosparId,snapshotVersion:'',factVersion:CAPABILITY_FACT_VERSION,memberships,orbit,capabilityFacts:facts,classification:[...new Set(entries.map(e=>e.source.group))],capabilityState:identityDisagreement?'NEEDS_REVIEW':facts.length?'DOCUMENTED':'UNKNOWN',identitySources:entries.map(e=>({name:e.row.name,cosparId:e.row.cosparId,sourceVersion:e.source.version,rowHash:e.row.rowHash,group:e.source.group}))};
    base.evidenceVersion=`real-${digest(canonicalJson(base))}`;items.push(base);
  }
  return {items:items.sort((a,b)=>compareCatalogIds(a.id,b.id)),elements};
}
