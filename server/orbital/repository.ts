import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { transaction } from '../db/database.js';
import { ApiError } from '../errors.js';
import type { NormalizedBrief } from '../../shared/contracts.js';
import type { DiscoveryExclusion, DiscoveryValues } from '../../shared/discovery-contracts.js';
import { emptyDiscoveryValues, makeDiscoveryDictionary, matchEvidence } from '../../shared/discovery.js';
import type { BrowseSnapshot, CatalogCapture, NormalizedOMM, OrbitalBrowseInput, OrbitalSourceKey, OrbitalSourceSummary, ParsedSource, RealCatalogDetail, RealCatalogItem, RealCatalogPage, RealEvidenceSnapshot } from '../../shared/orbital-contracts.js';
import { compareCatalogIds, ORBITAL_LIMITS, ORBITAL_SOURCE_URLS } from '../../shared/orbital-policy.js';
import { assembleCatalog, canonicalJson, CAPABILITY_FACT_VERSION, digest, normalizedInstant, parseSourceBytes, type MembershipRows } from './catalog.js';

interface State {source_key:OrbitalSourceKey;attempted_at:string|null;next_allowed_at:string|null;checked_at:string|null;error:string|null;current_view:string|null;last_source_version:string|null}
interface StoredCatalog extends CatalogCapture {elements:Record<string,NormalizedOMM>}
interface GroupView {source:ParsedSource;rows:MembershipRows['rows']}
const groups:OrbitalSourceKey[]=['sar','resource'];
const caches=new WeakMap<Database,Map<string,StoredCatalog>>();
export function orbitalRoot(config:AppConfig):string {return resolve(config.dataRoot,'orbital');}
export function currentCatalogVersion(db:Database):string|null{return (db.prepare('SELECT version FROM orbital_catalog_current WHERE singleton=1').get() as {version:string}|undefined)?.version??null;}
function sourceState(db:Database,key:OrbitalSourceKey):State|undefined{return db.prepare('SELECT * FROM orbital_source_state WHERE source_key=?').get(key) as State|undefined;}
function sourceFromState(db:Database,state:State|undefined):ParsedSource|null {
  const row=state?.last_source_version?db.prepare('SELECT parsed_json FROM orbital_source_versions WHERE version=?').get(state.last_source_version) as {parsed_json:string}|undefined:undefined;
  return row?JSON.parse(row.parsed_json) as ParsedSource:null;
}
export function sourceSummaries(db:Database):OrbitalSourceSummary[]{return groups.map(key=>{const state=sourceState(db,key),source=sourceFromState(db,state),pending=(db.prepare('SELECT outcome FROM orbital_source_attempts WHERE source_key=? ORDER BY attempted_at DESC LIMIT 1').get(key) as {outcome:string}|undefined)?.outcome==='STARTED';return {key,url:ORBITAL_SOURCE_URLS[key],version:source?.version??null,retrievedAt:source?.retrievedAt??null,checkedAt:state?.checked_at??source?.checkedAt??null,validation:source?.validation??'UNAVAILABLE',rows:source?.rowCount??0,identified:source?.rows.length??0,rejected:source?.rejected??0,invalidOrbits:source?.invalidOrbits??0,responseHash:source?.responseHash??null,attemptedAt:state?.attempted_at??null,nextAllowedAt:state?.next_allowed_at??null,error:state?.error??(pending?'Last refresh has no confirmed outcome; retained source versions are shown.':null)};});}
function currentViews(db:Database):Map<OrbitalSourceKey,GroupView>{
  const result=new Map<OrbitalSourceKey,GroupView>();
  for(const key of groups){const state=sourceState(db,key);if(!state?.current_view)continue;const row=db.prepare('SELECT view_json FROM orbital_group_views WHERE version=?').get(state.current_view) as {view_json:string}|undefined;if(row)result.set(key,JSON.parse(row.view_json) as GroupView);}
  return result;
}
function proposedView(source:ParsedSource,old?:GroupView):GroupView {
  const rows:GroupView['rows']=source.rows.map(row=>({row,confirmation:'CONFIRMED',lastSeenAt:source.retrievedAt}));
  if(source.validation==='PARTIAL'&&old){
    const valid=new Set(source.rows.filter(row=>row.omm).map(row=>row.id)),present=new Set(source.rows.map(row=>row.id));
    const carried=new Set<string>();
    for(const entry of old.rows){
      if(valid.has(entry.row.id)||(present.has(entry.row.id)&&!entry.row.omm))continue;
      const key=`${entry.row.id}:${entry.row.orbitalHash??'identity'}`;if(carried.has(key))continue;carried.add(key);
      rows.push({...entry,source:entry.source??{group:old.source.group,version:old.source.version,retrievedAt:old.source.retrievedAt,checkedAt:old.source.checkedAt},confirmation:'UNCONFIRMED'});
    }
  }
  return {source,rows};
}
export interface IngestedSource {source:ParsedSource;rawFilename:string}
/** All file/network work is completed before this short immutable promotion transaction. */
export function ingestSources(db:Database,entries:IngestedSource[],at:string):string {
  if(!normalizedInstant(at))throw new Error('Promotion timestamp is invalid.');
  const views=currentViews(db);for(const entry of entries){if(!/^[a-f0-9]{64}\.json$/.test(entry.rawFilename)||entry.rawFilename!==`${entry.source.responseHash}.json`)throw new Error('Raw cache basename/digest mismatch.');views.set(entry.source.group,proposedView(entry.source,views.get(entry.source.group)));}
  const assembled=assembleCatalog([...views.values()]),sources:OrbitalSourceSummary[]=groups.map(key=>{const view=views.get(key),s=view?.source,existing=sourceSummaries(db).find(v=>v.key===key)!;return {...existing,version:s?.version??null,retrievedAt:s?.retrievedAt??null,checkedAt:s?.checkedAt??null,validation:s?.validation??'UNAVAILABLE',rows:s?.rowCount??0,identified:s?.rows.length??0,rejected:s?.rejected??0,invalidOrbits:s?.invalidOrbits??0,responseHash:s?.responseHash??null,error:entries.some(e=>e.source.group===key)?null:existing.error};});
  const validation=sources.every(s=>s.validation==='COMPLETE'&&!s.error)?'COMPLETE' as const:'PARTIAL' as const;
  const version=digest(canonicalJson({sources:sources.map(s=>({key:s.key,version:s.version,validation:s.validation})),facts:CAPABILITY_FACT_VERSION,items:assembled.items}));
  for(const item of assembled.items){item.snapshotVersion=version;item.evidenceVersion=`real-${digest(canonicalJson({...item,evidenceVersion:''}))}`;}
  const dictionary=makeDiscoveryDictionary(assembled.items);dictionary.places=[];
  const capture:CatalogCapture={snapshotVersion:version,factVersion:CAPABILITY_FACT_VERSION,validation,sources,items:assembled.items,dictionary,rejected:sources.reduce((n,s)=>n+s.rejected,0)};
  transaction(db,()=>{
    for(const entry of entries){const {source}=entry,view=views.get(source.group)!,viewVersion=digest(canonicalJson(view));
      db.prepare('INSERT OR IGNORE INTO orbital_source_versions(version,source_key,response_hash,raw_filename,retrieved_at,parsed_json) VALUES(?,?,?,?,?,?)').run(source.version,source.group,source.responseHash,entry.rawFilename,source.retrievedAt,JSON.stringify(source));
      db.prepare('INSERT OR IGNORE INTO orbital_group_views(version,source_key,source_version,view_json) VALUES(?,?,?,?)').run(viewVersion,source.group,source.version,JSON.stringify(view));
      for(const row of source.rows)db.prepare('INSERT OR IGNORE INTO orbital_object_versions(version,item_id,orbital_hash,epoch,source_epoch,object_json) VALUES(?,?,?,?,?,?)').run(digest(canonicalJson(row)),row.id,row.orbitalHash,row.epoch,row.sourceEpoch,JSON.stringify(row));
      for(const entry of view.rows){const origin=entry.source??source;db.prepare('INSERT OR IGNORE INTO orbital_membership_versions(view_version,item_id,source_version,row_hash,confirmation,last_seen_at,identity_json) VALUES(?,?,?,?,?,?,?)').run(viewVersion,entry.row.id,origin.version,entry.row.rowHash,entry.confirmation,entry.lastSeenAt,JSON.stringify({name:entry.row.name,cosparId:entry.row.cosparId}));}
      db.prepare(`INSERT INTO orbital_source_state(source_key,checked_at,current_view,last_source_version,error) VALUES(?,?,?,?,NULL) ON CONFLICT(source_key) DO UPDATE SET checked_at=excluded.checked_at,current_view=excluded.current_view,last_source_version=excluded.last_source_version,error=NULL`).run(source.group,source.checkedAt,viewVersion,source.version);
    }
    db.prepare('INSERT OR IGNORE INTO orbital_catalog_snapshots(version,fact_version,created_at,snapshot_json,elements_json) VALUES(?,?,?,?,?)').run(version,CAPABILITY_FACT_VERSION,at,JSON.stringify(capture),JSON.stringify(Object.fromEntries(assembled.elements)));
    db.prepare('INSERT INTO orbital_catalog_current(singleton,version) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version').run(version);
    for(const item of assembled.items){db.prepare('INSERT OR IGNORE INTO orbital_evidence_versions(item_id,evidence_version,item_json) VALUES(?,?,?)').run(item.id,item.evidenceVersion,JSON.stringify(item));for(const fact of item.capabilityFacts)db.prepare('INSERT OR IGNORE INTO orbital_capability_fact_versions(fact_id,version,item_id,fact_json) VALUES(?,?,?,?)').run(fact.id,fact.version,item.id,JSON.stringify(fact));}
  });
  caches.delete(db);return version;
}
export function captureCatalog(db:Database,snapshotVersion?:string):CatalogCapture|null {
  const version=snapshotVersion??currentCatalogVersion(db);if(!version)return null;
  let cache=caches.get(db);if(!cache){cache=new Map();caches.set(db,cache);}let capture=cache.get(version);
  if(!capture){const row=db.prepare('SELECT snapshot_json,elements_json FROM orbital_catalog_snapshots WHERE version=?').get(version) as {snapshot_json:string;elements_json:string}|undefined;
    if(!row)throw new ApiError(409,'CATALOG_VERSION_CHANGED','That catalog version is unavailable. Refresh the list and review the current source.');
    capture={...JSON.parse(row.snapshot_json),elements:JSON.parse(row.elements_json)} as StoredCatalog;cache.set(version,capture);if(cache.size>4)cache.delete(cache.keys().next().value!);
  }
  const result=structuredClone(capture);
  if(version===currentCatalogVersion(db)){const live=sourceSummaries(db);result.sources=result.sources.map(source=>{const now=live.find(v=>v.key===source.key);return now?.version===source.version?{...source,attemptedAt:now.attemptedAt,nextAllowedAt:now.nextAllowedAt,error:now.error}:source;});if(result.sources.some(s=>s.error||s.validation!=='COMPLETE'))result.validation='PARTIAL';}
  return result;
}
export function realDiscoveryDictionary(db:Database,snapshotVersion?:string){return captureCatalog(db,snapshotVersion)?.dictionary??{operators:[],countries:[],places:[]};}
/** Assessment capture is deliberately independent of list pages and globe drawing caps. */
export interface AssessmentCatalogCapture extends CatalogCapture {
  matching: { item: RealCatalogItem; omm: NormalizedOMM | null; reasons: string[]; unknowns: string[] }[];
}
export function captureAssessmentCatalog(db:Database,snapshotVersion:string,factVersion:string,criteria:DiscoveryValues,exclusions:DiscoveryExclusion[]=[]):AssessmentCatalogCapture {
  if(snapshotVersion!==currentCatalogVersion(db))throw new ApiError(409,'CATALOG_VERSION_CHANGED','The real source changed. Review the current catalog before calculating.');
  const capture=captureCatalog(db,snapshotVersion) as StoredCatalog|null;
  if(!capture||capture.factVersion!==factVersion)throw new ApiError(409,'CATALOG_VERSION_CHANGED','The capability facts changed. Review the current catalog before calculating.');
  const matches=matchEvidence(capture.items,normalizeCatalogCriteria(criteria),normalizeCatalogExclusions(exclusions)).matches;
  return {...capture,matching:matches.map(match=>({item:match.item,omm:capture.elements[match.item.id]??null,reasons:match.reasons,unknowns:match.unknowns}))};
}
export function normalizeCatalogCriteria(raw:unknown):DiscoveryValues {
  const empty=emptyDiscoveryValues();if(raw===undefined)return empty;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ApiError(422,'FILTER_INVALID','Review the real catalog filters.');
  const value=raw as Record<string,unknown>;
  if(Object.keys(value).some(key=>!(key in empty)))throw new ApiError(422,'FILTER_INVALID','Unknown real catalog filter.');
  for(const [key,field]of Object.entries(value)){
    if(field===null){if(key==='documentedOnly')throw new ApiError(422,'FILTER_INVALID','Documented criteria only is a boolean.');continue;}
    if(key==='documentedOnly'){if(typeof field!=='boolean')throw new ApiError(422,'FILTER_INVALID','Documented criteria only is a boolean.');}
    else if(key==='family'){if(!['EO','SPACE','COMMUNICATIONS','SERVICING'].includes(String(field)))throw new ApiError(422,'FILTER_INVALID','Unknown service family.');}
    else if(key==='sensor'){if(!['OPEN','SAR','VISIBLE','SWIR','THERMAL'].includes(String(field)))throw new ApiError(422,'FILTER_INVALID','Unknown sensor.');}
    else if(['maxResolutionM','cloudCover','revisitHours'].includes(key)){if(typeof field!=='number'||!Number.isFinite(field)||(key==='cloudCover'?field<0||field>100:field<=0))throw new ApiError(422,'FILTER_INVALID','Review the numeric filter.');}
    else if(key==='outputs'){if(!Array.isArray(field)||field.length>3||field.some(v=>!['Imagery','Video','GIS'].includes(String(v))))throw new ApiError(422,'FILTER_INVALID','Unknown requested output.');}
    else if(key==='window'){if(typeof field!=='object'||Array.isArray(field)||field===null||Object.keys(field).some(k=>!['startUtc','endUtc'].includes(k))||!normalizedInstant((field as {startUtc?:unknown}).startUtc)||!normalizedInstant((field as {endUtc?:unknown}).endUtc)||Date.parse(String((field as {startUtc:unknown}).startUtc))>=Date.parse(String((field as {endUtc:unknown}).endUtc)))throw new ApiError(422,'FILTER_INVALID','Review the UTC window.');}
    else if(typeof field!=='string'||field.length>(key==='keyword'?200:4000))throw new ApiError(422,'FILTER_INVALID','Review the text filter.');
  }
  return {...empty,...structuredClone(value)} as DiscoveryValues;
}
export function normalizeCatalogExclusions(raw:unknown):DiscoveryExclusion[]{
  if(raw===undefined)return [];if(!Array.isArray(raw)||raw.length>50)throw new ApiError(422,'FILTER_INVALID','Review excluded criteria.');
  return raw.map(entry=>{if(!entry||typeof entry!=='object'||!['sensor','family','outputs'].includes(entry.field)||typeof entry.value!=='string'||entry.value.length>100||(entry.active!==undefined&&typeof entry.active!=='boolean'))throw new ApiError(422,'FILTER_INVALID','Review excluded criteria.');return {field:entry.field,value:entry.value,active:entry.active!==false,origin:'manual',phrase:'Reviewed exclusion',span:null,ruleId:'catalog-filter',generation:0} as DiscoveryExclusion;});
}
function cursorValue(cursor:string|undefined,version:string,queryHash:string):number {
  if(cursor===undefined)return 0;try{const data=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(data.v!==version||data.q!==queryHash||!Number.isSafeInteger(data.o)||data.o<0)throw new Error();return data.o;}catch{throw new ApiError(409,'CATALOG_VERSION_CHANGED','This page belongs to different catalog filters or source versions. Return to the first page.');}
}
export function catalogPage(db:Database,query:{snapshotVersion?:string;cursor?:string;criteria?:unknown;exclusions?:unknown},serverNow:string):RealCatalogPage {
  const criteria=normalizeCatalogCriteria(query.criteria),exclusions=normalizeCatalogExclusions(query.exclusions),capture=captureCatalog(db,query.snapshotVersion);
  if(!capture)return {sourceKind:'PUBLIC_REAL',snapshotVersion:null,factVersion:CAPABILITY_FACT_VERSION,serverNow,availability:'UNAVAILABLE',validation:'UNAVAILABLE',sources:sourceSummaries(db),counts:{unique:0,matching:0,unknown:0,excluded:0,rejected:0,invalidOrbits:0,loaded:0,sourceTotal:null},items:[],nextCursor:null,dictionary:{operators:[],countries:[],places:[]},message:'Real catalog unavailable — explicitly refresh public catalog data, or prepare a manual brief.'};
  const result=matchEvidence(capture.items,criteria,exclusions),queryHash=digest(canonicalJson({criteria,exclusions})),offset=cursorValue(query.cursor,capture.snapshotVersion,queryHash),items=result.matches.slice(offset,offset+ORBITAL_LIMITS.catalogPage);
  const liveSources=sourceSummaries(db),sources=capture.sources.map(s=>({...s,...(liveSources.find(v=>v.key===s.key)?.version===s.version?{attemptedAt:liveSources.find(v=>v.key===s.key)!.attemptedAt,nextAllowedAt:liveSources.find(v=>v.key===s.key)!.nextAllowedAt,error:liveSources.find(v=>v.key===s.key)!.error}: {})}));
  const next=offset+items.length<result.matches.length?Buffer.from(JSON.stringify({v:capture.snapshotVersion,q:queryHash,o:offset+items.length})).toString('base64url'):null;
  return {sourceKind:'PUBLIC_REAL',snapshotVersion:capture.snapshotVersion,factVersion:capture.factVersion,serverNow,availability:'READY',validation:sources.some(s=>s.error)?'PARTIAL':capture.validation,sources,counts:{unique:capture.items.length,matching:result.matches.length,unknown:result.matches.filter(m=>m.unknowns.length>0).length,excluded:result.excluded.length,rejected:capture.rejected,invalidOrbits:capture.items.filter(i=>i.orbit.state!=='VALID').length,loaded:items.length,sourceTotal:null},items,nextCursor:next,dictionary:capture.dictionary,message:sources.some(s=>s.error)?'Latest refresh failed — retained source versions and their original ages are shown.':null};
}
export function catalogDetail(db:Database,id:string,query:{snapshotVersion?:string;criteria?:unknown;exclusions?:unknown},serverNow:string):RealCatalogDetail {
  const capture=captureCatalog(db,query.snapshotVersion),item=capture?.items.find(i=>i.id===id);if(!capture||!item)throw new ApiError(404,'UNAVAILABLE','That catalog identity is unavailable in this source version.');
  const result=matchEvidence([item],normalizeCatalogCriteria(query.criteria),normalizeCatalogExclusions(query.exclusions));return {snapshotVersion:capture.snapshotVersion,factVersion:capture.factVersion,item,match:result.matches[0]??null,exclusionReasons:result.excluded[0]?.reasons??[],serverNow};
}
export function resolveRealEvidence(db:Database,itemId:string,evidenceVersion:string,brief:NormalizedBrief):RealEvidenceSnapshot|null {
  const row=db.prepare('SELECT item_json FROM orbital_evidence_versions WHERE item_id=? AND evidence_version=?').get(itemId,evidenceVersion) as {item_json:string}|undefined;if(!row)return null;
  const item=JSON.parse(row.item_json) as RealCatalogItem;
  const criteria=brief.discovery?.effective??{...emptyDiscoveryValues(),family:brief.family,sensor:brief.sensor,outputs:brief.outputs,maxResolutionM:brief.maxResolutionM,cloudCover:brief.cloudCover,revisitHours:brief.revisitHours};
  const result=matchEvidence([item],criteria,brief.discovery?.exclusions??[]),match=result.matches[0];
  return {sourceKind:'PUBLIC_REAL',itemId:item.id,evidenceVersion:item.evidenceVersion,name:item.name,verified:true,operator:item.operator,ownerCountry:item.ownerCountry,sensors:item.sensors,resolutionM:item.resolutionM,source:item.source,checkedAt:item.checkedAt,caveats:item.caveats,matchReasons:match?.reasons??result.excluded[0]?.reasons??[],uncertainties:match?.unknowns??[],matchesReviewedCriteria:!!match,snapshotVersion:item.snapshotVersion,factVersion:item.factVersion,catalogNumber:item.catalogNumber,memberships:item.memberships,orbit:item.orbit,capabilityFacts:item.capabilityFacts,matchingFacts:item};
}
export function captureBrowseSnapshot(db:Database,input:OrbitalBrowseInput):BrowseSnapshot {
  if(!input||typeof input!=='object'||typeof input.snapshotVersion!=='string'||input.snapshotVersion!==currentCatalogVersion(db)||!Number.isSafeInteger(input.generation)||input.generation<0||!normalizedInstant(input.representedAt))throw new ApiError(409,'CATALOG_VERSION_CHANGED','Review the current real source and represented UTC.');
  const capture=captureCatalog(db,input.snapshotVersion) as StoredCatalog;if(input.factVersion!==capture.factVersion)throw new ApiError(409,'CATALOG_VERSION_CHANGED','Capability facts changed. Review the real catalog again.');
  if(input.selectedId!==undefined&&input.selectedId!==null&&(typeof input.selectedId!=='string'||!/^norad:\d{1,9}$/.test(input.selectedId)))throw new ApiError(422,'FILTER_INVALID','Review the selected identity.');
  const shortlist=input.shortlistedIds??[];if(!Array.isArray(shortlist)||shortlist.length>50||shortlist.some(id=>typeof id!=='string'||!/^norad:\d{1,9}$/.test(id))||(input.visibility!==undefined&&!['ALL','MATCHES','SHORTLIST','SHORTLIST_ONLY'].includes(input.visibility)))throw new ApiError(422,'FILTER_INVALID','Review the shortlist and visibility.');
  const matches=matchEvidence(capture.items,normalizeCatalogCriteria(input.criteria),normalizeCatalogExclusions(input.exclusions)).matches;
  const shortlisted=new Set(shortlist),matched=new Set(matches.map(m=>m.item.id)),visibility=input.visibility??'MATCHES';
  const rows=capture.items.filter(item=>visibility==='ALL'||visibility==='MATCHES'&&(matched.has(item.id)||shortlisted.has(item.id))||visibility==='SHORTLIST'&&(shortlisted.has(item.id)||item.id===input.selectedId)||visibility==='SHORTLIST_ONLY'&&shortlisted.has(item.id)).map(item=>({item}));
  rows.sort((a,b)=>Number(b.item.id===input.selectedId)-Number(a.item.id===input.selectedId)||Number(shortlisted.has(b.item.id))-Number(shortlisted.has(a.item.id))||compareCatalogIds(a.item.id,b.item.id));
  const candidates=rows.map((m,index)=>({item:m.item,omm:capture.elements[m.item.id]??null,matched:matched.has(m.item.id),positionSelected:false,pathSelected:false}));
  return {snapshotVersion:capture.snapshotVersion,factVersion:capture.factVersion,validation:capture.validation,sources:capture.sources,matching:matches.length,candidates,displayLimited:0,pathsLimited:0,sourceRejected:capture.rejected};
}
export function adoptInitialAcquisition(db:Database,config:AppConfig,at=new Date().toISOString()):string|null {
  const root=orbitalRoot(config),path=resolve(root,'initial-acquisition.json');if(!existsSync(path))return currentCatalogVersion(db);
  if(statSync(path).size>64*1024)throw new Error('Initial acquisition ledger is oversized.');
  const bytes=readFileSync(path),ledgerHash=digest(bytes);if(db.prepare('SELECT 1 FROM orbital_initial_ledger WHERE digest=?').get(ledgerHash))return currentCatalogVersion(db);
  const ledger=JSON.parse(bytes.toString('utf8')) as {schema:number;groups:Record<OrbitalSourceKey,{url:string;attemptedAt:string;nextAllowedAt:string;status:string;httpStatus:number;retrievedAt:string;sha256:string;rawFile:string}>};
  if(ledger.schema!==1||!ledger.groups)throw new Error('Initial acquisition ledger is invalid.');
  for(const key of groups){const e=ledger.groups[key];if(!e||e.url!==ORBITAL_SOURCE_URLS[key]||!normalizedInstant(e.attemptedAt)||!normalizedInstant(e.nextAllowedAt)||Date.parse(e.nextAllowedAt)-Date.parse(e.attemptedAt)<ORBITAL_LIMITS.refreshMs)throw new Error('Initial attempt ledger is invalid.');}
  transaction(db,()=>{for(const key of groups){const e=ledger.groups[key];db.prepare('INSERT OR IGNORE INTO orbital_source_attempts(id,source_key,attempted_at,next_allowed_at,outcome,http_status,error,response_hash) VALUES(?,?,?,?,?,?,NULL,?)').run(`initial:${ledgerHash}:${key}`,key,e.attemptedAt,e.nextAllowedAt,'SUCCESS',200,e.sha256);db.prepare(`INSERT INTO orbital_source_state(source_key,attempted_at,next_allowed_at) VALUES(?,?,?) ON CONFLICT(source_key) DO UPDATE SET attempted_at=CASE WHEN attempted_at IS NULL OR attempted_at<excluded.attempted_at THEN excluded.attempted_at ELSE attempted_at END,next_allowed_at=CASE WHEN next_allowed_at IS NULL OR next_allowed_at<excluded.next_allowed_at THEN excluded.next_allowed_at ELSE next_allowed_at END`).run(key,e.attemptedAt,e.nextAllowedAt);}});
  const entries:IngestedSource[]=[];
  for(const key of groups){const entry=ledger.groups[key];if(!entry||entry.url!==ORBITAL_SOURCE_URLS[key]||entry.status!=='success'||entry.httpStatus!==200||!normalizedInstant(entry.attemptedAt)||!normalizedInstant(entry.nextAllowedAt)||Date.parse(entry.nextAllowedAt)-Date.parse(entry.attemptedAt)<ORBITAL_LIMITS.refreshMs||entry.rawFile!==basename(entry.rawFile)||!/^[a-f0-9]{64}\.json$/.test(entry.rawFile)||entry.rawFile!==`${entry.sha256}.json`)throw new Error('Initial source ledger does not match the approved acquisition policy.');
    const rawPath=resolve(root,entry.rawFile);if(statSync(rawPath).size>ORBITAL_LIMITS.sourceBytes)throw new Error('Initial source exceeds the reviewed limit.');const raw=readFileSync(rawPath);if(digest(raw)!==entry.sha256)throw new Error('Initial source byte hash differs from its ledger.');
    entries.push({source:parseSourceBytes(key,raw,entry.retrievedAt),rawFilename:entry.rawFile});
  }
  const version=ingestSources(db,entries,at);
  transaction(db,()=>{db.prepare('INSERT OR IGNORE INTO orbital_initial_ledger(digest,adopted_at) VALUES(?,?)').run(ledgerHash,at);});
  caches.delete(db);return version;
}

/** Re-enrich immutable cached source identities without a provider request or refreshed orbit age. */
export function ensureCapabilityVersion(db:Database,at:string):void {const capture=captureCatalog(db);if(capture&&capture.factVersion!==CAPABILITY_FACT_VERSION)ingestSources(db,[],at);}
