import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleCatalog, parseSourceBytes } from '../../server/orbital/catalog.js';
import { EO_FACT_CHECKED_AT, EO_IDENTITY_DESIGNATORS, opticalCapabilities } from '../../server/orbital/eo-facts.js';
import { emptyDiscoveryValues, matchEvidence } from '../../shared/discovery.js';
import type { DiscoverySensor } from '../../shared/discovery-contracts.js';

function row(id:number,designator=EO_IDENTITY_DESIGNATORS[`norad:${id}`]??'2099-000A') {
  // Original numerical response double; these are not actual acquired element values.
  return {NORAD_CAT_ID:id,OBJECT_NAME:`Generated EO response double ${id}`,OBJECT_ID:designator,EPOCH:'2026-10-25T09:00:00.123456',MEAN_MOTION:14.3,ECCENTRICITY:.002,INCLINATION:71,RA_OF_ASC_NODE:20,ARG_OF_PERICENTER:15,MEAN_ANOMALY:120,BSTAR:0,MEAN_MOTION_DOT:0,MEAN_MOTION_DDOT:0};
}
function catalog(extra=0) {
  const raw=[row(42063),row(60989),row(39084),row(49260),row(62261,'2024-235A'),...Array.from({length:extra+1},(_,i)=>row(800001+i))];
  const source=parseSourceBytes('resource',Buffer.from(JSON.stringify(raw)),'2026-10-25T10:00:00.000Z');
  return assembleCatalog([{source,rows:source.rows.map(row=>({row,confirmation:'CONFIRMED' as const,lastSeenAt:source.retrievedAt}))}]);
}
const ids=(items:{item:{id:string}}[])=>items.map(x=>x.item.id).sort();
function matched(sensor:DiscoverySensor,resolution:number|null,documentedOnly:boolean) {return matchEvidence(catalog().items,{...emptyDiscoveryValues(),family:'EO',sensor,maxResolutionM:resolution,documentedOnly});}
test('cited band facts keep Sentinel visible10/SWIR20 and Landsat visible/SWIR30/TIRS100 distinct',()=>{
  for(const id of ['norad:42063','norad:60989']){
    const facts=opticalCapabilities(id);assert.deepEqual(facts.map(x=>[x.sensor,x.spatialResolutionM]),[['VISIBLE',10],['SWIR',20]]);
    assert.ok(facts.every(x=>x.instrument==='MSI'&&x.nominalSwathKm===290&&x.checkedAt===EO_FACT_CHECKED_AT&&x.sourceUrl.startsWith('https://')));
  }
  for(const id of ['norad:39084','norad:49260']){
    const facts=opticalCapabilities(id),thermal=facts.find(x=>x.sensor==='THERMAL')!;
    assert.equal(thermal.instrument,id==='norad:49260'?'TIRS-2':'TIRS');assert.equal(thermal.spatialResolutionM,100);assert.equal(thermal.distributedPixelSpacingM,30);assert.equal(thermal.measurement,'emitted-thermal');
    assert.equal(facts.find(x=>x.sensor==='VISIBLE')!.spatialResolutionM,30);assert.equal(facts.find(x=>x.sensor==='SWIR')!.spatialResolutionM,30);assert.ok(facts.every(x=>x.nominalSwathKm===185));
  }
  assert.deepEqual(opticalCapabilities('norad:800001'),[]);
  assert.equal(opticalCapabilities('norad:42063')[0]!.equivalentSpectralSamples![0]!.wavelengthNm,492.3);
  assert.equal(opticalCapabilities('norad:60989')[0]!.equivalentSpectralSamples![0]!.wavelengthNm,489.1);
  assert.deepEqual(opticalCapabilities('norad:42063')[0]!.wavelengthRangesUm,[], 'equivalent center/width is not a measured continuous passband');
});
test('native resolution matching uses the requested band and never substitutes PAN, another band or distributed pixels',()=>{
  assert.deepEqual(ids(matched('VISIBLE',10,true).matches),['norad:42063','norad:60989']);
  assert.deepEqual(ids(matched('SWIR',10,true).matches),[]);
  assert.deepEqual(ids(matched('SWIR',20,true).matches),['norad:42063','norad:60989']);
  assert.deepEqual(ids(matched('SWIR',30,true).matches),['norad:39084','norad:42063','norad:49260','norad:60989']);
  assert.deepEqual(ids(matched('THERMAL',30,true).matches),[]);
  assert.deepEqual(ids(matched('THERMAL',100,true).matches),['norad:39084','norad:49260']);
  const landsat=matched('VISIBLE',15,false).excluded.find(x=>x.item.id==='norad:39084')!;assert.match(landsat.reasons.join(' '),/native resolution|spatial resolution/);
});
test('one-metre optical is a known mismatch while absent sensor/band evidence remains caveated only with strict off',()=>{
  for(const sensor of ['VISIBLE','SWIR','THERMAL'] as const){
    const relaxed=matched(sensor,1,false);assert.deepEqual(ids(relaxed.matches),['norad:800001']);assert.ok(relaxed.matches[0]!.unknowns.some(x=>/sensor|family|resolution/.test(x)));
    assert.equal(relaxed.excluded.some(x=>x.item.id==='norad:39084'),true);assert.equal(relaxed.excluded.some(x=>x.item.id==='norad:42063'),true);
    assert.deepEqual(matched(sensor,1,true).matches,[]);
  }
  assert.deepEqual(ids(matched('SWIR',null,true).matches),['norad:39084','norad:42063','norad:49260','norad:60989']);
});
test('identity/designator disagreement withholds enrichment without rewriting source membership or valid orbital state',()=>{
  const source=parseSourceBytes('resource',Buffer.from(JSON.stringify([row(42063,'2099-999A'),row(39084,'2099-999B'),row(800001)])),'2026-10-25T10:00:00.000Z');
  const result=assembleCatalog([{source,rows:source.rows.map(row=>({row,confirmation:'CONFIRMED' as const,lastSeenAt:source.retrievedAt}))}]);
  assert.equal(result.items.length,3);
  for(const item of result.items.filter(x=>x.id!=='norad:800001')){
    assert.equal(item.capabilityState,'NEEDS_REVIEW');assert.equal(item.sensors,null);assert.equal(item.familyDocumented,false);assert.deepEqual(item.capabilityFacts,[]);assert.equal(item.bandCapabilities,undefined);assert.equal(item.orbit.state,'VALID');assert.match(item.caveats.join(' '),/designator differs/);assert.equal(item.memberships[0]!.group,'resource');
  }
});
test('new facts enrich only adopted identities, preserving full population beyond list and display caps',()=>{
  const result=catalog(235);assert.equal(result.items.length,241);assert.equal(result.elements.size,241);
  assert.equal(result.items.filter(x=>x.bandCapabilities?.length).length,4);
  assert.equal(result.items.filter(x=>x.capabilityState==='UNKNOWN').length,236);
  assert.ok(result.items.every(x=>x.resolutionM===null));
  const relaxed=matchEvidence(result.items,{...emptyDiscoveryValues(),family:'EO',sensor:'VISIBLE',maxResolutionM:10,documentedOnly:false});
  assert.equal(relaxed.total,241);assert.equal(relaxed.matches.length,238);assert.equal(relaxed.excluded.length,3);
  const noOpticalSource=parseSourceBytes('resource',Buffer.from(JSON.stringify([row(800001)])),'2026-10-25T10:00:00.000Z');
  assert.equal(assembleCatalog([{source:noOpticalSource,rows:noOpticalSource.rows.map(row=>({row,confirmation:'CONFIRMED',lastSeenAt:noOpticalSource.retrievedAt}))}]).items.length,1);
});
