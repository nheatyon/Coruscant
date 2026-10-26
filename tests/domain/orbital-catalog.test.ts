import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleCatalog, normalizeSourceRow, parseSourceBytes } from '../../server/orbital/catalog.js';
import { canonicalCatalogNumber, orbitalFreshness } from '../../shared/orbital-policy.js';
import { emptyDiscoveryValues, matchEvidence } from '../../shared/discovery.js';
const epoch='2026-10-25T00:00:00.123456Z',at='2026-10-25T01:00:00.000Z';
function raw(id:unknown=123456,extra:Record<string,unknown>={}){return {NORAD_CAT_ID:id,OBJECT_NAME:'Fresh orbital example',OBJECT_ID:'2026-001A',EPOCH:epoch,MEAN_MOTION:14.6,ECCENTRICITY:0.001,INCLINATION:73,RA_OF_ASC_NODE:36,ARG_OF_PERICENTER:17,MEAN_ANOMALY:42,BSTAR:0.00002,MEAN_MOTION_DOT:0.000001,MEAN_MOTION_DDOT:0,...extra};}
function source(group:'sar'|'resource',rows:unknown[],retrieved=at){return parseSourceBytes(group,Buffer.from(JSON.stringify(rows)),retrieved);}
function assembled(a:ReturnType<typeof source>,b?:ReturnType<typeof source>){return assembleCatalog([a,...(b?[b]:[])].map(source=>({source,rows:source.rows.map(row=>({row,confirmation:'CONFIRMED' as const,lastSeenAt:source.retrievedAt}))})));}

test('canonical full decimal identities accept modern widths without truncation',()=>{
  for(const id of ['7','099999','123456','1234567','12345678','123456789'])assert.equal(canonicalCatalogNumber(id),String(Number(id)));
  for(const bad of [0,'000','1234567890','12A34','1e5',-5,12.5,null])assert.equal(canonicalCatalogNumber(bad),null);
  assert.equal(normalizeSourceRow(raw('123456789'))!.omm!.NORAD_CAT_ID,'123456789');
});
test('source metadata defaults are CelesTrak-specific; invalid supported identity remains inspectable',()=>{
  const parsed=source('sar',[raw(),raw(123457,{REF_FRAME:'ITRF'}),{NORAD_CAT_ID:'abc'},null]);
  assert.equal(parsed.validation,'PARTIAL');assert.equal(parsed.rejected,2);assert.equal(parsed.invalidOrbits,1);assert.equal(parsed.rows[1]!.id,'norad:123457');assert.equal(parsed.rows[1]!.omm,null);
  assert.equal(parsed.rows[0]!.omm!.REF_FRAME,'TEME');assert.equal(parsed.rows[0]!.sourceEpoch,epoch);assert.equal(parsed.rows[0]!.epoch,'2026-10-25T00:00:00.123Z');
  assert.equal(normalizeSourceRow(raw(14,{EPOCH:'2026-02-30T00:00:00'}))!.omm,null);
});
test('source envelope/byte/row bounds reject complete promotion rather than truncate',()=>{
  assert.throws(()=>parseSourceBytes('sar',Buffer.from('<html>unavailable</html>'),at),/JSON array/);
  assert.throws(()=>parseSourceBytes('sar',Buffer.from('{}'),at),/JSON array/);
  assert.throws(()=>parseSourceBytes('sar',new Uint8Array(8*1024*1024+1),at),/reviewed limit/);
  assert.throws(()=>source('sar',Array.from({length:5001},(_,i)=>raw(i+1))),/reviewed limit/);
  assert.equal(source('sar',[]).validation,'COMPLETE');
});
test('cross-group identity dedup preserves memberships, rename is not an orbital conflict',()=>{
  const a=source('sar',[raw(123456,{OBJECT_NAME:'First attributed name'})]),b=source('resource',[raw(123456,{OBJECT_NAME:'Alternate attributed name'})]);
  assert.equal(a.rows[0]!.orbitalHash,b.rows[0]!.orbitalHash);
  const result=assembled(a,b);assert.equal(result.items.length,1);assert.equal(result.items[0]!.memberships.length,2);assert.equal(result.items[0]!.orbit.state,'VALID');assert.equal(result.items[0]!.aliases!.length,2);
});
test('source epoch precision controls ordering and equal-epoch conflicts despite millisecond propagation inputs',()=>{
  const a=source('sar',[raw(123456,{EPOCH:'2026-10-25T00:00:00.123100'})]),b=source('resource',[raw(123456,{EPOCH:'2026-10-25T00:00:00.123200',MEAN_ANOMALY:80})]);
  assert.equal(a.rows[0]!.epoch,b.rows[0]!.epoch);const picked=assembled(a,b);assert.equal(picked.items[0]!.orbit.sourceEpoch,'2026-10-25T00:00:00.123200Z');assert.equal(picked.elements.get('norad:123456')!.MEAN_ANOMALY,80);
  const conflict=assembled(a,source('resource',[raw(123456,{EPOCH:'2026-10-25T00:00:00.1231000',MEAN_ANOMALY:80})]));assert.equal(conflict.items[0]!.orbit.state,'CONFLICT');assert.equal(conflict.elements.size,0);
});
test('SAR source classification is not sensor proof; C/D resolution stays mode-dependent',()=>{
  const {items}=assembled(source('sar',[raw(123456),raw(62261,{OBJECT_ID:'2024-235A'})]));const general=items.find(i=>i.id==='norad:123456')!,sentinel=items.find(i=>i.id==='norad:62261')!;
  assert.equal(general.sensors,null);assert.equal(general.familyDocumented,false);assert.equal(sentinel.familyDocumented,true);assert.deepEqual(sentinel.sensors,['SAR']);assert.equal(sentinel.resolutionM,null);assert.equal(sentinel.ownerCountry,null);
  assert.ok(sentinel.capabilityFacts.some(f=>f.mode==='IW'&&f.product==='GRD HR'&&JSON.stringify(f.value)==='[20,22]'));
  const criteria={...emptyDiscoveryValues(),family:'EO' as const,sensor:'SAR' as const,maxResolutionM:10};
  assert.equal(matchEvidence(items,criteria).matches.length,2);assert.equal(matchEvidence(items,{...criteria,documentedOnly:true}).matches.length,0);
  assert.equal(matchEvidence(items,{...criteria,maxResolutionM:null,documentedOnly:true}).matches[0]!.item.id,'norad:62261');
  const familyOnly={...emptyDiscoveryValues(),family:'EO' as const,documentedOnly:true};assert.deepEqual(matchEvidence(items,familyOnly).matches.map(m=>m.item.id),['norad:62261']);
});
test('real final ranking is numeric and stale/future/span policy has exact inclusive boundaries',()=>{
  const {items}=assembled(source('sar',[raw(100000,{OBJECT_NAME:'Same'}),raw(99999,{OBJECT_NAME:'Same'})]));assert.deepEqual(matchEvidence(items,emptyDiscoveryValues()).matches.map(m=>m.item.id),['norad:99999','norad:100000']);
  assert.equal(orbitalFreshness('2026-10-24T01:00:00.000Z',at,at,['2026-10-26T01:00:00.000Z']),null);
  assert.match(orbitalFreshness('2026-10-24T00:59:59.999Z',at,at)!,/stale/);
  assert.match(orbitalFreshness('2026-10-25T01:00:00.001Z',at,at)!,/Future/);
  assert.match(orbitalFreshness(epoch,at,at,['2026-10-27T00:00:00.124Z'])!,/span/);
});

test('contradictory designators withhold enrichment without creating false orbital conflict, while preserving attribution',()=>{
  const a=source('sar',[raw(62261,{OBJECT_ID:'2024-235A',OBJECT_NAME:'One attributed source name'})]),b=source('resource',[raw(62261,{OBJECT_ID:'2099-999X',OBJECT_NAME:'Conflicting identity metadata'})]);
  const item=assembled(a,b).items[0]!;assert.equal(item.orbit.state,'VALID');assert.equal(item.capabilityState,'NEEDS_REVIEW');assert.equal(item.sensors,null);assert.equal(item.operator,null);assert.equal(item.capabilityFacts.length,0);assert.equal(item.identitySources.length,2);assert.ok(item.caveats.some(c=>c.includes('Needs review')));
  const missing=assembled(source('sar',[raw(62261,{OBJECT_ID:''})])).items[0]!;assert.equal(missing.cosparId,null);assert.deepEqual(missing.sensors,['SAR']);
});
