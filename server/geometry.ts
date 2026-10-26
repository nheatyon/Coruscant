import { createHash } from 'node:crypto';
import type { Database } from './db/database.js';
import { ApiError } from './errors.js';
import { GEOMETRY_RECIPE, GEOMETRY_RECIPE_VERSION, makeGeometry } from '../demo/geometry.js';
import { validateTrack } from '../shared/globe.js';

export const geometryRecipeHash=createHash('sha256').update(JSON.stringify(GEOMETRY_RECIPE)).digest('hex');
const keys=['geometry_epoch','geometry_recipe_version','geometry_recipe_hash'] as const;
export interface GeometryIdentity { epoch:string; recipeVersion:string; recipeHash:string }
function canonicalEpoch(value:string):boolean {try{return new Date(value).toISOString()===value;}catch{return false;}}
function stored(db:Database):Record<string,string> {
  return Object.fromEntries((db.prepare("SELECT key,value FROM demo_metadata WHERE key IN ('geometry_epoch','geometry_recipe_version','geometry_recipe_hash')").all() as {key:string;value:string}[]).map(row=>[row.key,row.value]));
}
/** Run before initializer file work. A new recipe must never replace existing drawing context. */
export function checkGeometryInitialization(db:Database,epoch:string):void {
  if(!canonicalEpoch(epoch))throw new Error('The persisted geometry epoch is not a canonical UTC instant; initialization did not replace it.');
  const rows=stored(db),count=Object.keys(rows).length;if(!count)return;
  if(count!==keys.length||rows.geometry_epoch!==epoch||rows.geometry_recipe_version!==GEOMETRY_RECIPE_VERSION||rows.geometry_recipe_hash!==geometryRecipeHash)throw new Error('Existing geometry recipe version, hash or epoch differs from this build. Review it explicitly; initialization did not replace geometry or saved work.');
}
/** Called inside the ordinary explicit initializer transaction, after its held D0 is inserted. */
export function persistGeometryInitialization(db:Database,epoch:string):void {
  checkGeometryInitialization(db,epoch);
  const origin=db.prepare("SELECT value FROM demo_metadata WHERE key='d0'").get() as {value:string}|undefined;
  if(origin?.value!==epoch)throw new Error('Geometry must retain the same persisted initialization epoch.');
  const values:Record<typeof keys[number],string>={geometry_epoch:epoch,geometry_recipe_version:GEOMETRY_RECIPE_VERSION,geometry_recipe_hash:geometryRecipeHash};
  for(const key of keys)db.prepare('INSERT OR IGNORE INTO demo_metadata(key,value) VALUES(?,?)').run(key,values[key]);
}
function currentIdentity(db:Database):GeometryIdentity {
  const rows=stored(db),origin=db.prepare("SELECT value FROM demo_metadata WHERE key='d0'").get() as {value:string}|undefined;
  if(!origin||Object.keys(rows).length!==keys.length||!canonicalEpoch(origin.value)||rows.geometry_epoch!==origin.value||rows.geometry_recipe_version!==GEOMETRY_RECIPE_VERSION||rows.geometry_recipe_hash!==geometryRecipeHash)throw new Error('The exact initialized synthetic geometry is unavailable.');
  return {epoch:origin.value,recipeVersion:rows.geometry_recipe_version!,recipeHash:rows.geometry_recipe_hash!};
}
/** Immutable recipe + held D0 is generated/serialized once per process; no query includes private facts. */
export function createGeometryReader(db:Database,generate:typeof makeGeometry=makeGeometry):()=>string {
  let cached:string|undefined,cachedIdentity:string|undefined;
  return ()=>{
    try {
      const identity=currentIdentity(db),key=JSON.stringify(identity);
      if(cached&&cachedIdentity===key)return cached;
      const geometry={...generate(identity.epoch),recipeHash:identity.recipeHash};
      const expectedIds=GEOMETRY_RECIPE.objects.map(object=>object.itemId);
      const validTracks=geometry.tracks.every(track=>{
        const definition=GEOMETRY_RECIPE.objects.find(object=>object.itemId===track.itemId);
        return !!definition&&track.displayRadius===definition.displayRadius&&track.tiltDeg===definition.tiltDeg&&track.azimuthDeg===definition.azimuthDeg&&track.phaseDeg===definition.phaseDeg&&track.periodSeconds===definition.periodSeconds&&track.epoch===identity.epoch&&track.spanStart===geometry.spanStart&&track.spanEnd===geometry.spanEnd&&validateTrack(track).valid;
      });
      if(geometry.epoch!==identity.epoch||geometry.recipeVersion!==identity.recipeVersion||geometry.earthRadius!==GEOMETRY_RECIPE.earthRadius||geometry.frame!==GEOMETRY_RECIPE.frame||geometry.method!==GEOMETRY_RECIPE.method||geometry.cadenceSeconds!==GEOMETRY_RECIPE.cadenceSeconds||geometry.tracks.length!==expectedIds.length||new Set(geometry.tracks.map(track=>track.itemId)).size!==expectedIds.length||!validTracks)throw new Error('Generated geometry does not match its registered recipe.');
      cached=JSON.stringify(geometry);cachedIdentity=key;return cached;
    } catch {
      throw new ApiError(503,'GEOMETRY_UNAVAILABLE','Synthetic display geometry is unavailable. The list, coordinates and saved requests remain usable.',undefined,true);
    }
  };
}
