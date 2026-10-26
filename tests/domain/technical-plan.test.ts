import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDiscoveryValues,makeDiscoveryDictionary } from '../../shared/discovery.js';
import { areaSignature,createEmptyBrief,validatePlanningBrief } from '../../shared/validation.js';
import { assembleCatalog,parseSourceBytes } from '../../server/orbital/catalog.js';
import { opticalCapabilities } from '../../server/orbital/eo-facts.js';
import { applicableModes,fixedChecks,groundCenterDistanceKm,instantaneousChecks,measurementRequirements,parseSpectralRequirement,solarElevationDeg,spectralCheck } from '../../server/orbital/constraints.js';
import { calculateAssessment } from '../../server/orbital/plan.js';
import { calculationInputDigest,technicalSummary,type PreparedAssessmentInput } from '../../server/orbital/plan-input.js';
import { observerAt,type OrbitPropagator } from '../../server/orbital/propagation.js';

const at='2026-10-25T11:50:00.000Z';
function prepared(ids=[42063],sensor='VISIBLE',seconds=60):PreparedAssessmentInput {
  const raw=ids.map(id=>({NORAD_CAT_ID:id,OBJECT_NAME:`Original analytic test ${id}`,OBJECT_ID:id===42063?'2017-013A':'',EPOCH:'2026-10-25T11:00:00.000Z',MEAN_MOTION:14.5,ECCENTRICITY:.001,INCLINATION:63,RA_OF_ASC_NODE:30,ARG_OF_PERICENTER:10,MEAN_ANOMALY:42,BSTAR:0,MEAN_MOTION_DOT:0,MEAN_MOTION_DDOT:0}));
  const source=parseSourceBytes('resource',Buffer.from(JSON.stringify(raw)),at),assembled=assembleCatalog([{source,rows:source.rows.map(row=>({row,confirmation:'CONFIRMED',lastSeenAt:at}))}]);
  const area={latitude:0,longitude:0,radiusKm:25,method:'coordinates' as const,generation:1},purpose='Inspect this deliberately chosen target.',brief=validatePlanningBrief({...createEmptyBrief(),purpose,areaReviewedPurpose:purpose,observationIntent:'single-observation',sensor,latitude:'0',longitude:'0',areaChoice:area,areaConfirmation:areaSignature(area),timingToDiscuss:false,windowStart:'2026-10-25T12:00:00',windowEnd:new Date(Date.parse('2026-10-25T12:00:00.000Z')+seconds*1000).toISOString().slice(0,-1),catalogContext:{sourceKind:'PUBLIC_REAL',snapshotVersion:'test-snapshot',factVersion:'test-facts'}}).value!;
  const input=technicalSummary(brief);return {generation:1,input,brief,inputDigest:'original-analytic-input',calculationDigest:calculationInputDigest(brief),briefDigest:'original-analytic-brief',request:null,requirements:{purpose,deadlineUtc:null,delivery:null,operator:null,ownerCountry:null},catalog:{snapshotVersion:'test-snapshot',factVersion:'test-facts',validation:'COMPLETE',sources:[],items:assembled.items,dictionary:makeDiscoveryDictionary(assembled.items),rejected:0,matching:assembled.items.map(item=>({item,omm:assembled.elements.get(item.id)!,reasons:[],unknowns:[]}))}};
}
/** Analytic physical trajectory double, explicitly not a reference orbit/provider fixture. */
function overhead():OrbitPropagator {const observer=observerAt(0,0);return {catalogNumber:'42063',epoch:'2026-10-25T11:00:00.000Z',at:utc=>({ok:true,at:utc,catalogNumber:'42063',teme:{positionKm:{x:6878.137,y:0,z:0},velocityKmPerSecond:{x:0,y:7,z:0}},ecfKm:{x:observer.ecfKm.x+500,y:0,z:0},geodetic:{latitude:0,longitude:0,heightKm:500},display:{x:1+500/6378.137,y:0,z:0}})};}
test('nominal mean-sphere center distance is stable at seam/poles/antipodes and distinct from circle radius',()=>{
  assert.equal(groundCenterDistanceKm(0,0,0,0),0);assert.ok(Math.abs(groundCenterDistanceKm(0,179.9,0,-179.9)!-22.2390160467)<1e-6);
  assert.ok(groundCenterDistanceKm(90,0,90,175)!<1e-9);assert.ok(Math.abs(groundCenterDistanceKm(0,0,0,180)!-Math.PI*6371.0088)<1e-8);assert.equal(groundCenterDistanceKm(91,0,0,0),null);
});
test('supported spectral grammar keeps continuous coverage, overlap, equivalent samples and band sets separate',()=>{
  const p=prepared(),mode=applicableModes(p.catalog.items[0]!,p.input)[0]!;
  assert.equal(spectralCheck(parseSpectralRequirement('B2, B3 and B4'),mode).state,'PASS');assert.equal(spectralCheck(parseSpectralRequirement('B2, B11'),mode).state,'FAIL');
  assert.equal(spectralCheck(parseSpectralRequirement('continuous 450-670 nm'),mode).state,'UNKNOWN','equivalent centers/widths do not establish passbands');
  const landsat={...mode,capability:opticalCapabilities('norad:39084')[0]!,bands:['B02','B03','B04']};
  assert.equal(spectralCheck(parseSpectralRequirement('overlap 450-670 nm'),landsat).state,'PASS');assert.equal(spectralCheck(parseSpectralRequirement('continuous 450-670 nm'),landsat).state,'FAIL');assert.equal(parseSpectralRequirement('some near infrared preferably').kind,'UNRESOLVED');
});
test('solar policy guards thresholds and applies stronger L2A only to positively supported actual wording',()=>{
  const p=prepared(),mode=applicableModes(p.catalog.items[0]!,p.input)[0]!,position=overhead().at('2026-10-25T12:00:00.000Z');assert.ok(position.ok);
  assert.ok(solarElevationDeg('2026-06-21T12:00:00.000Z',0,0)!>60);assert.ok(solarElevationDeg('2026-06-21T00:00:00.000Z',0,0)!<0);assert.equal(solarElevationDeg('2051-01-01T12:00:00.000Z',0,0),null);
  assert.equal(instantaneousChecks(mode,p,position,90,0,.05).checks.find(c=>c.id==='illumination')!.state,'BOUNDARY_UNCERTAIN');
  p.requirements.purpose='Scientific quantitative L2A surface reflectance is required.';
  assert.equal(measurementRequirements(p).quantitativeL2A,true);assert.equal(instantaneousChecks(mode,p,position,90,0,19).checks.find(c=>c.id==='illumination')!.state,'FAIL');
  p.requirements.purpose='Do not use L2A surface reflectance.';assert.equal(measurementRequirements(p).quantitativeL2A,false);
  p.requirements.purpose='Night thermal observation';const thermal=opticalCapabilities('norad:39084')[2]!,thermalMode={...mode,capability:thermal,instrument:thermal.instrument,sensor:'THERMAL' as const,measurement:thermal.measurement};
  const night=instantaneousChecks(thermalMode,p,position,90,0,-20).checks;assert.equal(night.find(c=>c.id==='illumination')!.state,'NOT_APPLICABLE');assert.equal(night.find(c=>c.id==='night-policy')!.state,'UNKNOWN');
});
test('full supported analytic optical interval creates checked instant; actual cloud unknown stays provisional',async()=>{
  const p=prepared();p.input.cloudCover=5;p.brief.cloudCover=5;const result=await calculateAssessment(p,at,{propagator:overhead});
  assert.equal(result.counts.completed,1);assert.equal(result.options.length,1);const option=result.options[0]!;
  assert.equal(option.outcome,'PROVISIONAL');assert.ok(option.proposedAtUtc);assert.equal(option.unknowns.some(u=>u.id==='cloud'),true);assert.equal(option.checks.find(c=>c.id==='whole-circle')!.applicability,'CONTEXT');assert.equal(option.nominalClosest!.distanceKm,0);
  assert.ok(result.counts.evaluations>=14);assert.ok(result.views[option.id]!.arc!.points.length<=256);
});
test('SAR never passes an optical proxy and keeps genuinely unresolved instrument timing',async()=>{
  const p=prepared([990021001],'SAR');const result=await calculateAssessment(p,at,{propagator:overhead}),option=result.options[0]!;
  assert.equal(option.checks.find(c=>c.id==='corridor')!.state,'NOT_APPLICABLE');assert.equal(option.checks.find(c=>c.id==='sensor-geometry')!.state,'UNKNOWN');assert.equal(option.outcome,'PROVISIONAL');assert.equal(option.proposedAtUtc,null);
});
test('budget/cancel leaves exact terminal accounting and respects full population plus shortlist-first ordering',async()=>{
  const p=prepared([990021001,990021002,990021003],'SAR');p.brief.selectedEvidence=[{itemId:'norad:990021003',evidenceVersion:'test'}];
  const result=await calculateAssessment(p,at,{propagator:overhead,limits:{maxEvaluations:10}});
  assert.equal(result.state,'INCOMPLETE');assert.equal(result.counts.matching,3);assert.equal(result.counts.remaining,0);assert.equal(result.outcomes[0]!.itemId,'norad:990021003');assert.equal(result.counts.completed+result.counts.stale+result.counts.insufficient+result.counts.incomplete+result.counts.notAssessed,3);assert.equal(result.preferredOptionId,null);
  const controller=new AbortController();controller.abort();const canceled=await calculateAssessment(p,at,{signal:controller.signal});assert.equal(canceled.state,'CANCELED');assert.equal(canceled.counts.notAssessed,3);
});
test('a ten-object forced yield failure returns terminal incomplete instead of escaping as FAILED',async()=>{
  const p=prepared(Array.from({length:12},(_,i)=>990021001+i),'SAR');let tick=0;
  const result=await calculateAssessment(p,at,{propagator:overhead,now:()=>tick,yieldControl:async()=>{if(++tick===21)tick=100000;}});
  assert.ok(['COMPLETE','INCOMPLETE'].includes(result.state));assert.equal(result.counts.remaining,0);assert.equal(result.counts.completed+result.counts.incomplete+result.counts.notAssessed,12);
});
test('calculation semantic digest excludes contact/shortlist/source revisions but includes actual requirement and target changes',()=>{
  const p=prepared(),old=calculationInputDigest(p.brief),changed=structuredClone(p.brief);changed.contact.name='Another contact';changed.selectedEvidence=[];changed.catalogContext={sourceKind:'PUBLIC_REAL',snapshotVersion:'new-source',factVersion:'new-facts'};changed.area.generation++;
  assert.equal(calculationInputDigest(changed),old);changed.maxResolutionM=5;assert.notEqual(calculationInputDigest(changed),old);assert.equal(fixedChecks(p.catalog.items[0]!,applicableModes(p.catalog.items[0]!,p.input)[0]!,p,[]).some(c=>c.id==='cloud'),false);
});
/** Fresh analytic moving trajectory, not provider data/reference samples. At the
 * equator solve radius from the desired local-up elevation and geodetic longitude,
 * so physical ECF and the ground-distance minimum describe the same moving point. */
function narrowPass(requested:number[]):OrbitPropagator {
  return {catalogNumber:'42063',epoch:'2026-10-25T11:00:00.000Z',at:utc=>{
    const seconds=(Date.parse(utc)-Date.parse('2026-10-25T12:00:00.000Z'))/1000;requested.push(seconds);
    const rad=Math.PI/180,elevation=Math.max(0,14.2-(seconds-12)**2),longitude=5+.1*(seconds-12)**2;
    const radius=6378.137/(Math.cos(longitude*rad)-Math.tan(elevation*rad)*Math.sin(longitude*rad)),ecf={x:radius*Math.cos(longitude*rad),y:radius*Math.sin(longitude*rad),z:0};
    return {ok:true,at:utc,catalogNumber:'42063',teme:{positionKm:ecf,velocityKmPerSecond:{x:0,y:0,z:0}},ecfKm:ecf,geodetic:{latitude:0,longitude,heightKm:radius-6378.137},display:{x:radius/6378.137*Math.cos(longitude*rad),y:0,z:-radius/6378.137*Math.sin(longitude*rad)}};
  }};
}
test('one coarse positive sample refines peak and nominal closest inside the actual entry/exit bracket',async()=>{
  const p=prepared([42063],'VISIBLE',30),requested:number[]=[],result=await calculateAssessment(p,at,{propagator:()=>narrowPass(requested)}),option=result.options[0]!;
  assert.equal(result.state,'COMPLETE');assert.equal(result.counts.positive,1);assert.equal(option.los.clippedStart,false);assert.equal(option.los.clippedEnd,false);
  const peakSeconds=(Date.parse(option.los.peakUtc)-Date.parse(p.input.window.startUtc))/1000,closestSeconds=(Date.parse(option.nominalClosest!.atUtc)-Date.parse(p.input.window.startUtc))/1000;
  assert.ok(Math.abs(peakSeconds-12)<=1,`Peak must refine near the analytic12s maximum; received${peakSeconds}s.`);assert.ok(Math.abs(closestSeconds-12)<=1,`Closest must refine near the analytic12s minimum; received${closestSeconds}s.`);
  assert.ok(option.los.peakElevationDeg>14);assert.ok(option.nominalClosest!.distanceKm<560);
  assert.equal(result.counts.evaluations,2*requested.length+1,'Charge every unique propagation+LOS and corridor sample, plus the one shared solar evaluation.');
  assert.ok(requested.every(seconds=>seconds>=0&&seconds<=30));
});
test('singleton pass refinement respects clipped window edges and never extrapolates a peak outside the requested window',async()=>{
  for(const [start,end,expected,clippedStart,clippedEnd] of [[11,30,12,true,false],[0,11,11,false,true]] as const){
    const p=prepared([42063],'VISIBLE',30),origin=Date.parse('2026-10-25T12:00:00.000Z');p.input.window={startUtc:new Date(origin+start*1000).toISOString(),endUtc:new Date(origin+end*1000).toISOString()};
    const requested:number[]=[],result=await calculateAssessment(p,at,{propagator:()=>narrowPass(requested)}),option=result.options[0]!;
    assert.equal(result.state,'COMPLETE');assert.equal(option.los.clippedStart,clippedStart);assert.equal(option.los.clippedEnd,clippedEnd);
    assert.ok(Math.abs((Date.parse(option.los.peakUtc)-origin)/1000-expected)<=1);assert.ok(Math.abs((Date.parse(option.nominalClosest!.atUtc)-origin)/1000-expected)<=1);
    assert.ok(requested.every(seconds=>seconds>=start&&seconds<=end));assert.equal(result.counts.evaluations,2*requested.length+1);
  }
});
test('singleton extrema refinement remains charged and terminates incomplete when its actual work budget is exhausted',async()=>{
  const p=prepared([42063],'VISIBLE',30),requested:number[]=[],result=await calculateAssessment(p,at,{propagator:()=>narrowPass(requested),limits:{maxEvaluations:26}});
  assert.equal(result.state,'INCOMPLETE');assert.equal(result.counts.evaluations,26);assert.equal(result.counts.completed,0);assert.equal(result.counts.incomplete,1);assert.equal(result.counts.remaining,0);assert.equal(result.preferredOptionId,null);assert.match(result.outcomes[0]!.reason,/budget/);assert.ok(requested.length<=13);
});
