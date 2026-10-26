import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { organizations, actors, memberships, makeCatalog, sceneAssets } from '../../demo/index.js';
import type { AppConfig } from '../config.js';
import type { Database } from './database.js';
import { transaction } from './database.js';
import { verifySchema } from './migrate.js';
import { checkGeometryInitialization, persistGeometryInitialization } from '../geometry.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const definitionHash = (value: unknown) => digest(JSON.stringify(value));
const DEMO_RECIPE_VERSION='coruscant-demo-v1';
export function getD0(db: Database): string {
  const row = db.prepare("SELECT value FROM demo_metadata WHERE key='d0'").get() as {value:string}|undefined;
  if (!row) throw new Error('Demonstration definitions are not initialized. Run npm run demo:init before starting.');
  return row.value;
}
/** Insert definitions once. No request, success, staff review or observation is invented. */
export function initialize(db: Database, config: AppConfig, clock: () => Date = () => new Date()): string {
  verifySchema(db);
  const recordedRecipe=(db.prepare("SELECT value FROM demo_metadata WHERE key='recipe_version'").get() as {value:string}|undefined)?.value;
  if(recordedRecipe!==undefined&&recordedRecipe!==DEMO_RECIPE_VERSION){
    throw new Error('Existing demonstration recipe version differs from this build. Review it explicitly; initialization did not overwrite definitions or assets.');
  }
  let d0 = (db.prepare("SELECT value FROM demo_metadata WHERE key='d0'").get() as {value:string}|undefined)?.value;
  if (!d0) d0=clock().toISOString();
  checkGeometryInitialization(db,d0);
  const catalog = makeCatalog(d0);
  const sources = sceneAssets(d0);
  mkdirSync(config.sourceRoot,{recursive:true,mode:0o700});
  mkdirSync(config.materialRoot,{recursive:true,mode:0o700});
  // File I/O completes before a write transaction; a registered recipe is never replaced.
  for (const source of sources) {
    if (basename(source.filename)!==source.filename) throw new Error('Source recipe filename must be a basename.');
    const expected=digest(source.content);
    const registered=db.prepare('SELECT content_hash FROM demo_source_assets WHERE id=?').get(source.id) as {content_hash:string}|undefined;
    if (registered&&registered.content_hash!==expected) throw new Error(`Registered recipe changed for ${source.id}; review a forward correction.`);
    const path=resolve(config.sourceRoot,source.filename);
    if (existsSync(path)) {
      if(digest(readFileSync(path,'utf8'))!==expected) throw new Error(`Source asset ${source.filename} differs from its registered recipe; it was not overwritten.`);
    } else writeFileSync(path,source.content,{encoding:'utf8',mode:0o600,flag:'wx'});
  }
  transaction(db,()=>{
    const ensure = (table:string,id:string,expected:string) => {
      const row=db.prepare(`SELECT definition_hash FROM ${table} WHERE id=?`).get(id) as {definition_hash:string}|undefined;
      if(row&&row.definition_hash!==expected) throw new Error(`Existing ${table} definition ${id} changed; initialization will not overwrite it.`);
      return !row;
    };
    db.prepare("INSERT OR IGNORE INTO demo_metadata(key,value) VALUES('d0',?)").run(d0!);
    db.prepare("INSERT OR IGNORE INTO demo_metadata(key,value) VALUES('recipe_version',?)").run(DEMO_RECIPE_VERSION);
    persistGeometryInitialization(db,d0!);
    for(const org of organizations){const h=definitionHash(org);if(ensure('organizations',org.id,h))db.prepare('INSERT INTO organizations(id,name,definition_hash) VALUES(?,?,?)').run(org.id,org.name,h);}
    for(const actor of actors){const h=definitionHash(actor);if(ensure('actors',actor.id,h))db.prepare('INSERT INTO actors(id,name,audience,active,definition_hash) VALUES(?,?,?,?,?)').run(actor.id,actor.name,actor.audience,actor.active===false?0:1,h);}
    for(const member of memberships){
      const h=definitionHash(member);
      const old=db.prepare('SELECT definition_hash FROM memberships WHERE actor_id=? AND organization_id=?').get(member.actorId,member.organizationId) as {definition_hash:string}|undefined;
      if(old&&old.definition_hash!==h)throw new Error('Existing membership definition changed; review it explicitly.');
      if(!old)db.prepare('INSERT INTO memberships(actor_id,organization_id,role,can_select_offers,active,definition_hash) VALUES(?,?,?,?,?,?)').run(member.actorId,member.organizationId,member.role,member.canSelectOffers?1:0,Number(member.active),h);
    }
    const items = catalog;
    for(const item of items){
      const json=JSON.stringify(item);const h=digest(json);
      if(ensure('discovery_items',item.id,h))db.prepare('INSERT INTO discovery_items(id,definition_json,definition_hash) VALUES(?,?,?)').run(item.id,json,h);
      const old=db.prepare('SELECT definition_hash FROM evidence_versions WHERE item_id=? AND evidence_version=?').get(item.id,item.evidenceVersion) as {definition_hash:string}|undefined;
      if(old&&old.definition_hash!==h)throw new Error('Evidence version changed; it cannot replace saved public facts.');
      if(!old)db.prepare('INSERT INTO evidence_versions(item_id,evidence_version,snapshot_json,definition_hash) VALUES(?,?,?,?)').run(item.id,item.evidenceVersion,json,h);
    }
    for(const source of sources){
      const {content,...metadata}=source;const json=JSON.stringify(metadata);const old=db.prepare('SELECT definition_json FROM demo_source_assets WHERE id=?').get(source.id) as {definition_json:string}|undefined;
      if(old&&old.definition_json!==json)throw new Error('Existing source metadata changed; initialization will not overwrite it.');
      if(!old)db.prepare('INSERT INTO demo_source_assets(id,role,content_version,filename,content_hash,recipe_version,illustrative_date,width,height,definition_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(source.id,source.role,source.contentVersion,source.filename,digest(content),source.recipeVersion,source.illustrativeDate,source.width,source.height,json);
    }
  });
  return d0;
}
