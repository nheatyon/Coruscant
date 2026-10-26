import { lstat, realpath, readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { Database } from './db/database.js';
import { transaction } from './db/database.js';
import { ApiError, unavailable } from './errors.js';
import type { TestHooks } from './commands.js';
import { requireOrganization, requireSession, requireStaff, type Clock } from './security.js';
import { assetRow, assets, customerMaterialAllowed, imageFile, imageKey, resultRow, type Availability, type FileRow, type ResultRow } from './material-records.js';
import { sceneAssets } from '../demo/index.js';
import { getD0 } from './db/initialize.js';

export const MAX_MATERIAL_BYTES=8*1024*1024;
export const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export function fileUnavailable():never{throw new ApiError(404,'MATERIAL_UNAVAILABLE','The exact supplied image file is unavailable. Permitted metadata remains available.');}
/** Only registered, regular, bounded files beneath the intended private child root are read. */
export async function readPrivateFile(config:AppConfig,file:FileRow,rootName:'material'|'demo-source'='material'):Promise<Buffer>{
  try{
    if(basename(file.relative_path)!==file.relative_path||!file.relative_path.endsWith('.svg')||file.mime_type!=='image/svg+xml'||file.byte_size<1||file.byte_size>MAX_MATERIAL_BYTES)fileUnavailable();
    const root=resolve(config.dataRoot,rootName);const canonicalParent=await realpath(config.dataRoot);const canonicalRoot=await realpath(root);
    if(canonicalRoot!==resolve(canonicalParent,rootName))fileUnavailable();
    const path=resolve(root,file.relative_path);const entry=await lstat(path);if(!entry.isFile()||entry.isSymbolicLink()||entry.size!==file.byte_size||entry.size>MAX_MATERIAL_BYTES)fileUnavailable();
    const canonicalPath=await realpath(path);if(!canonicalPath.startsWith(`${canonicalRoot}${sep}`))fileUnavailable();
    const bytes=await readFile(canonicalPath);if(bytes.length!==file.byte_size||sha256(bytes)!==file.sha256||!bytes.toString('utf8').includes('<svg'))fileUnavailable();return bytes;
  }catch(error){if(error instanceof ApiError)throw error;fileUnavailable();}
}
export function authorizeMaterial(db:Database,request:FastifyRequest,clock:Clock,assetId:string,version:number){
  const session=requireSession(db,request,clock);const asset=assetRow(db,assetId);if(!asset)unavailable();const result=resultRow(db,asset.result_id);if(!result)unavailable();
  if(session.audience==='STAFF')requireStaff(db,session);
  else{requireOrganization(db,session,result.organization_id);if(!customerMaterialAllowed(db,result,clock)||asset.published_version!==version)unavailable();}
  const file=imageFile(db,assetId,version);if(!file)unavailable();return {session,asset,result,file};
}
export async function protectedBytes(db:Database,config:AppConfig,request:FastifyRequest,clock:Clock,assetId:string,version:number,variant:'thumbnail'|'preview',hooks?:TestHooks):Promise<Buffer>{
  const initial=transaction(db,()=>authorizeMaterial(db,request,clock,assetId,version));
  await hooks?.beforeMaterialRead?.({assetId,contentVersion:version,variant});
  let bytes:Buffer|undefined;let failure:unknown;
  try{bytes=await readPrivateFile(config,initial.file);}catch(error){failure=error;}
  await hooks?.afterMaterialRead?.({assetId,contentVersion:version,variant});
  transaction(db,()=>{
    const current=authorizeMaterial(db,request,clock,assetId,version);
    if(current.session.cookie_hash!==initial.session.cookie_hash||current.session.context_generation!==initial.session.context_generation||current.session.context_token!==initial.session.context_token)unavailable();
    if(current.file.id!==initial.file.id||current.file.sha256!==initial.file.sha256)unavailable();
  });
  if(failure)throw failure;return bytes!;
}
/** Availability is descriptive; every subsequent byte request independently reauthorizes. */
export async function inspectFiles(db:Database,config:AppConfig,result:ResultRow,staff:boolean):Promise<Availability>{
  const checks=assets(db,result.id).map(asset=>({assetId:asset.id,contentVersion:staff?asset.current_version:asset.published_version})).filter((ref):ref is {assetId:string;contentVersion:number}=>ref.contentVersion!==null);
  const values=await Promise.all(checks.map(async ref=>{const file=imageFile(db,ref.assetId,ref.contentVersion);try{if(!file)fileUnavailable();await readPrivateFile(config,file);return [imageKey(ref),'AVAILABLE'] as const;}catch{return [imageKey(ref),'UNAVAILABLE'] as const;}}));return new Map(values);
}
export interface PreparedSource {assetId:string;file:FileRow;role:'BASELINE'|'RECENT';source:ReturnType<typeof sceneAssets>[number]}
/** Work completes before the command transaction; generated paths are never browser-controlled. */
export async function prepareSources(db:Database,config:AppConfig):Promise<PreparedSource[]>{
  await mkdir(config.materialRoot,{recursive:true,mode:0o700});const prepared:PreparedSource[]=[];
  for(const source of sceneAssets(getD0(db))){
    const registered=db.prepare('SELECT * FROM demo_source_assets WHERE id=?').get(source.id) as {filename:string;content_hash:string;recipe_version:string;width:number;height:number}|undefined;
    if(!registered||registered.content_hash!==source.sha256||registered.recipe_version!==source.recipeVersion)fileUnavailable();
    const sourceFile:FileRow={id:source.id,relative_path:registered.filename,sha256:registered.content_hash,mime_type:'image/svg+xml',byte_size:Buffer.byteLength(source.content),width:source.width,height:source.height};
    const bytes=await readPrivateFile(config,sourceFile,'demo-source');const id=randomUUID();const filename=`${id}.svg`;const temporary=`${id}.staging.svg`;
    await writeFile(resolve(config.materialRoot,temporary),bytes,{flag:'wx',mode:0o600});const temporaryFile={...sourceFile,id,relative_path:temporary};await readPrivateFile(config,temporaryFile);
    await rename(resolve(config.materialRoot,temporary),resolve(config.materialRoot,filename));const file={...sourceFile,id,relative_path:filename};await readPrivateFile(config,file);
    prepared.push({assetId:randomUUID(),file,role:source.role,source});
  }
  return prepared;
}
