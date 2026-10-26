import assert from 'node:assert/strict';
import type { BriefInput } from '../../shared/contracts.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { parseSourceBytes } from '../../server/orbital/catalog.js';
import { captureCatalog, ingestSources } from '../../server/orbital/repository.js';
import { createPropagator } from '../../server/orbital/propagation.js';
import type { Database } from '../../server/db/database.js';

/** Freshly authored isolated input, not provider data or a real satellite claim.
 * Its future subpoint deliberately supplies an analytic positive LOS test; the
 * actual production propagator and assessment still do all the work. */
export function installTechnicalPlanning(db: Database, at: string) {
  const now=Date.parse(at),epoch=new Date(now-3600000).toISOString();
  const sourceRow={NORAD_CAT_ID:990021001,OBJECT_NAME:'Original numerical planning test object',OBJECT_ID:'',EPOCH:epoch,
    MEAN_MOTION:14.5,ECCENTRICITY:.002,INCLINATION:67,RA_OF_ASC_NODE:32,ARG_OF_PERICENTER:55,MEAN_ANOMALY:80,
    BSTAR:.00003,MEAN_MOTION_DOT:.000001,MEAN_MOTION_DDOT:0};
  const sources=(['sar','resource'] as const).map(group=>{
    const source=parseSourceBytes(group,Buffer.from(JSON.stringify(group==='sar'?[sourceRow]:[])),at);
    return {source,rawFilename:`${source.responseHash}.json`};
  });
  ingestSources(db,sources,at);const catalog=captureCatalog(db)!;
  const omm=sources[0]!.source.rows[0]!.omm!;
  const instant=new Date(now+6*60000).toISOString(),predicted=createPropagator(omm).at(instant);assert.ok(predicted.ok);
  const area={latitude:predicted.geodetic.latitude,longitude:predicted.geodetic.longitude,radiusKm:25,method:'coordinates' as const,generation:1};
  const purpose='Original isolated numerical planning question at this deliberately chosen coordinate.';
  const brief:BriefInput={...createEmptyBrief(),purpose,areaReviewedPurpose:purpose,areaSource:null,observationIntent:'single-observation',sensor:'SAR',
    latitude:String(area.latitude),longitude:String(area.longitude),radiusKm:'25',areaChoice:area,areaConfirmation:areaSignature(area),
    timingToDiscuss:false,windowStart:new Date(now+2*60000).toISOString().slice(0,16),windowEnd:new Date(now+12*60000).toISOString().slice(0,16),
    catalogContext:{sourceKind:'PUBLIC_REAL',snapshotVersion:catalog.snapshotVersion,factVersion:catalog.factVersion}};
  return {brief,omm,instant,catalog,itemId:'norad:990021001'};
}
