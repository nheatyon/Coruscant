import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from '../db/database.js';
import { transaction } from '../db/database.js';
import type { AppConfig } from '../config.js';
import type { Clock } from '../security.js';
import type { OrbitalSourceKey, RefreshCatalogOutcome, RefreshSourceOutcome } from '../../shared/orbital-contracts.js';
import { ORBITAL_LIMITS, ORBITAL_SOURCE_URLS } from '../../shared/orbital-policy.js';
import { digest, parseSourceBytes } from './catalog.js';
import { currentCatalogVersion, ingestSources, orbitalRoot, type IngestedSource } from './repository.js';

export type SourceFetch=(url:string,options:RequestInit)=>Promise<Response>;
const inFlight=new WeakMap<Database,Promise<RefreshCatalogOutcome>>();
function safeSourceError(error:unknown):string {
  const message=error instanceof Error?error.message:'';
  return /^(?:Public source returned HTTP \d+; the refresh batch stopped\.|Catalog refresh incomplete — source exceeds the reviewed limit|Catalog source is not a valid JSON array\.|Catalog source is not a JSON array\.|Catalog source returned no body\.|Existing private source cache does not match its digest\.)$/.test(message)?message:'Public source refresh could not be confirmed; retained source versions are unchanged.';
}
function nextTime(at:string,retryAfter:string|null):string {
  const base=Date.parse(at)+ORBITAL_LIMITS.refreshMs;
  if(!retryAfter)return new Date(base).toISOString();
  const delay=/^\d+$/.test(retryAfter)?Date.parse(at)+Number(retryAfter)*1000:Date.parse(retryAfter);
  return new Date(Number.isFinite(delay)?Math.max(base,delay):base).toISOString();
}
function reserve(db:Database,key:OrbitalSourceKey,at:string):{id:string;nextAllowedAt:string}|null {
  return transaction(db,()=>{const previous=db.prepare('SELECT next_allowed_at FROM orbital_source_state WHERE source_key=?').get(key) as {next_allowed_at:string|null}|undefined;if(previous?.next_allowed_at&&previous.next_allowed_at>at)return null;
    const id=randomUUID(),nextAllowedAt=nextTime(at,null);
    db.prepare(`INSERT INTO orbital_source_state(source_key,attempted_at,next_allowed_at,error) VALUES(?,?,?,NULL) ON CONFLICT(source_key) DO UPDATE SET attempted_at=excluded.attempted_at,next_allowed_at=excluded.next_allowed_at,error=NULL`).run(key,at,nextAllowedAt);
    db.prepare('INSERT INTO orbital_source_attempts(id,source_key,attempted_at,next_allowed_at,outcome) VALUES(?,?,?,?,?)').run(id,key,at,nextAllowedAt,'STARTED');return {id,nextAllowedAt};});
}
function finish(db:Database,key:OrbitalSourceKey,id:string,outcome:string,nextAllowedAt:string,httpStatus:number|null,error:string|null,hash:string|null):void {
  transaction(db,()=>{db.prepare('UPDATE orbital_source_attempts SET outcome=?,next_allowed_at=?,http_status=?,error=?,response_hash=? WHERE id=?').run(outcome,nextAllowedAt,httpStatus,error,hash,id);db.prepare('UPDATE orbital_source_state SET next_allowed_at=?,error=? WHERE source_key=?').run(nextAllowedAt,error,key);});
}
async function readBounded(response:Response):Promise<Uint8Array> {
  const size=response.headers.get('content-length');if(size&&/^\d+$/.test(size)&&Number(size)>ORBITAL_LIMITS.sourceBytes)throw new Error('Catalog refresh incomplete — source exceeds the reviewed limit');
  if(!response.body)throw new Error('Catalog source returned no body.');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>ORBITAL_LIMITS.sourceBytes)throw new Error('Catalog refresh incomplete — source exceeds the reviewed limit');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
  const result=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
}
async function cacheBytes(config:AppConfig,bytes:Uint8Array,hash:string):Promise<string> {
  const root=orbitalRoot(config);await mkdir(root,{recursive:true,mode:0o700});const filename=`${hash}.json`,path=resolve(root,filename);
  try {await stat(path);if(digest(await readFile(path))!==hash)throw new Error('Existing private source cache does not match its digest.');return filename;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=resolve(root,`.${randomUUID()}.tmp`);try{await writeFile(temporary,bytes,{mode:0o600,flag:'wx'});await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}return filename;
}
async function refresh(db:Database,config:AppConfig,clock:Clock,fetcher:SourceFetch):Promise<RefreshCatalogOutcome> {
  const outcomes:RefreshSourceOutcome[]=[],entries:IngestedSource[]=[];let stopped=false;
  for(const key of ['sar','resource'] as OrbitalSourceKey[]){
    if(stopped){outcomes.push({group:key,state:'NOT_ATTEMPTED',message:'The batch stopped after an earlier source error.',nextAllowedAt:null});continue;}
    const attemptedAt=clock().toISOString(),attempt=reserve(db,key,attemptedAt);
    if(!attempt){const state=db.prepare('SELECT next_allowed_at FROM orbital_source_state WHERE source_key=?').get(key) as {next_allowed_at:string};outcomes.push({group:key,state:'RATE_LIMITED',message:'The shared source refresh interval has not elapsed.',nextAllowedAt:state.next_allowed_at});continue;}
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),ORBITAL_LIMITS.sourceTimeoutMs);let status:number|null=null,nextAllowedAt=attempt.nextAllowedAt;
    try {
      const response=await fetcher(ORBITAL_SOURCE_URLS[key],{method:'GET',redirect:'manual',signal:controller.signal,headers:{'User-Agent':'CoruscantLocalDemo/0.1 (user-initiated public orbital evidence refresh)','Accept':'application/json'}});status=response.status;nextAllowedAt=nextTime(attemptedAt,response.headers.get('retry-after'));
      if(status!==200){await response.body?.cancel().catch(()=>{});throw new Error(`Public source returned HTTP ${status}; the refresh batch stopped.`);}
      const bytes=await readBounded(response),retrievedAt=clock().toISOString(),source=parseSourceBytes(key,bytes,retrievedAt),rawFilename=await cacheBytes(config,bytes,source.responseHash);
      entries.push({source,rawFilename});finish(db,key,attempt.id,'SUCCESS',nextAllowedAt,status,null,source.responseHash);
      const prior=db.prepare('SELECT response_hash FROM orbital_source_versions WHERE source_key=? ORDER BY retrieved_at DESC LIMIT 1').get(key) as {response_hash:string}|undefined;
      outcomes.push({group:key,state:prior?.response_hash===source.responseHash?'UNCHANGED':'UPDATED',message:source.validation==='PARTIAL'?'Partial source validation; rejected/invalid rows are disclosed.':'Source checked and validated.',nextAllowedAt});
    }catch(error){const message=controller.signal.aborted?'Public source timed out; the refresh batch stopped.':safeSourceError(error);finish(db,key,attempt.id,'FAILED',nextAllowedAt,status,message,null);outcomes.push({group:key,state:'FAILED',message,nextAllowedAt});stopped=true;}finally{clearTimeout(timeout);}
  }
  if(entries.length){try{ingestSources(db,entries,clock().toISOString());}catch(error){const message=safeSourceError(error);for(const entry of entries){db.prepare('UPDATE orbital_source_state SET error=? WHERE source_key=?').run(message,entry.source.group);const outcome=outcomes.find(o=>o.group===entry.source.group)!;outcome.state='FAILED';outcome.message=message;}}}
  return {snapshotVersion:currentCatalogVersion(db),sources:outcomes,serverNow:clock().toISOString()};
}
/** A single shared in-process request; persistent reservations also protect restarts/other tabs. */
export function refreshPublicCatalog(db:Database,config:AppConfig,clock:Clock,fetcher:SourceFetch=fetch):Promise<RefreshCatalogOutcome> {
  const active=inFlight.get(db);if(active)return active;const pending=refresh(db,config,clock,fetcher);inFlight.set(db,pending);void pending.finally(()=>inFlight.delete(db)).catch(()=>{});return pending;
}
