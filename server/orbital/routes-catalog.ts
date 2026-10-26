import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../errors.js';
import { bodyObject, guardContext, requireSession, type Clock } from '../security.js';
import { adoptInitialAcquisition, catalogDetail, catalogPage, ensureCapabilityVersion } from './repository.js';
import { refreshPublicCatalog, type SourceFetch } from './source.js';

function query(input:unknown,detail=false):{snapshotVersion?:string;cursor?:string;criteria?:unknown;exclusions?:unknown}{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ApiError(422,'FILTER_INVALID','Review the real catalog filters.');
  const raw=input as Record<string,unknown>,allowed=detail?['snapshotVersion','criteria','exclusions']:['snapshotVersion','cursor','criteria','exclusions'];
  if(Object.keys(raw).some(key=>!allowed.includes(key))||Object.values(raw).some(v=>typeof v!=='string')||(raw.snapshotVersion!==undefined&&!/^[a-f0-9]{64}$/.test(String(raw.snapshotVersion)))||(raw.cursor!==undefined&&String(raw.cursor).length>2000))throw new ApiError(422,'FILTER_INVALID','Clear or correct the real catalog filters.');
  const result:{snapshotVersion?:string;cursor?:string;criteria?:unknown;exclusions?:unknown}={};
  if(raw.snapshotVersion!==undefined)result.snapshotVersion=String(raw.snapshotVersion);if(raw.cursor!==undefined)result.cursor=String(raw.cursor);
  for(const key of ['criteria','exclusions'] as const){if(raw[key]!==undefined){if(String(raw[key]).length>24000)throw new ApiError(422,'FILTER_INVALID','The catalog filters are too large.');try{result[key]=JSON.parse(String(raw[key]));}catch{throw new ApiError(422,'FILTER_INVALID','The catalog filters could not be read.');}}}
  return result;
}
export function registerOrbitalCatalogRoutes(app:FastifyInstance,db:Database,config:AppConfig,clock:Clock,options:{fetcher?:SourceFetch;adoptInitial?:boolean}={}):void {
  if(options.adoptInitial!==false){try{adoptInitialAcquisition(db,config,clock().toISOString());}catch{for(const key of ['sar','resource'])db.prepare(`INSERT INTO orbital_source_state(source_key,error) VALUES(?,?) ON CONFLICT(source_key) DO UPDATE SET error=excluded.error`).run(key,'Initial public-source cache could not be validated; existing records are unchanged.');}}
  ensureCapabilityVersion(db,clock().toISOString());
  app.get('/api/public/real-catalog',async request=>catalogPage(db,query(request.query),clock().toISOString()));
  app.get<{Params:{id:string}}>('/api/public/real-catalog/:id',async request=>{
    if(!/^norad:[1-9]\d{0,8}$/.test(request.params.id))throw new ApiError(404,'UNAVAILABLE','That catalog identity is unavailable.');
    return catalogDetail(db,request.params.id,query(request.query,true),clock().toISOString());
  });
  app.post('/api/orbital-evidence/refresh',async request=>{
    const session=requireSession(db,request,clock);guardContext(session,request);const body=bodyObject(request);
    if(Object.keys(body).some(key=>!['contextGeneration','contextToken'].includes(key)))throw new ApiError(400,'MALFORMED','Refresh uses only the two adopted public catalog groups.');
    const result=await refreshPublicCatalog(db,config,clock,options.fetcher);
    // A late response does not authorize a context that changed during remote I/O.
    const current=requireSession(db,request,clock);guardContext(current,request);
    return {...result,contextGeneration:current.context_generation};
  });
}
