import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url)),project=resolve(here,'..');
const [ledgerPath,python,emittedRoot=join(project,'dist/node')]=process.argv.slice(2);
assert.ok(ledgerPath&&python,'Usage: node scripts/verify-plan-agreement.mjs /absolute/fresh-ledger.json /absolute/venv/bin/python [emittedRoot]');
const load=path=>import(pathToFileURL(join(emittedRoot,path)));
const {parseSourceBytes,assembleCatalog,canonicalJson,digest}=await load('server/orbital/catalog.js');
const {calculateAssessment}=await load('server/orbital/plan.js');
const {groundCenterDistanceKm,solarElevationDeg,SOLAR_PACKAGE_SHA256}=await load('server/orbital/constraints.js');
const {createEmptyBrief,validateBrief,areaSignature}=await load('shared/validation.js');
const ledger=JSON.parse(readFileSync(ledgerPath,'utf8')),groups=[],sourceHashes={};
for(const group of ['sar','resource']){
  const entry=ledger.groups[group],bytes=readFileSync(join(dirname(ledgerPath),entry.rawFile));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);assert.equal(entry.httpStatus,200);
  const source=parseSourceBytes(group,bytes,entry.retrievedAt);sourceHashes[group]=entry.sha256;
  groups.push({source,rows:source.rows.map(row=>({row,confirmation:'CONFIRMED',lastSeenAt:source.retrievedAt}))});
}
assert.equal(createHash('sha256').update(readFileSync(join(project,'node_modules/satellite.js/dist/sun.js'))).digest('hex'),SOLAR_PACKAGE_SHA256);
const assembled=assembleCatalog(groups),selected=['norad:62261','norad:66315','norad:42063','norad:60989','norad:39084','norad:49260'];
const now=new Date(),start=Math.ceil((now.getTime()+120000)/60000)*60000,end=start+6*3600000;
const targets=[{caseId:'deliberate-numeric-west',latitude:52.6,longitude:-9.7},{caseId:'deliberate-numeric-equator',latitude:0,longitude:0}];
const records=selected.filter(id=>assembled.elements.has(id)).map(id=>({id,omm:assembled.elements.get(id),cases:targets.map(target=>({...target,startUtc:new Date(start).toISOString(),endUtc:new Date(end).toISOString()}))}));
assert.equal(records.length,6,'The adopted six numerical examples must actually be present in this source; no fabricated replacement.');
const solar=[];for(const [season,date]of [['march','2026-03-20'],['june','2026-06-21'],['september','2026-09-23'],['december','2026-12-21']])for(const [name,latitude,longitude]of [['north',52.6,-9.7],['south',-33.9,151.2],['pole',89.999,179.999],['equator',0,0]])for(const hour of ['00','06','12','18'])solar.push({id:`${season}-${name}-${hour}`,at:`${date}T${hour}:00:00.000Z`,latitude,longitude});
const distances=[{id:'seam',coordinates:[0,179.999,0,-179.999]},{id:'near-north-pole',coordinates:[89.999,170,89.999,-170]},{id:'coincident-pole',coordinates:[90,0,90,180]},{id:'antipodal',coordinates:[0,0,0,180]},{id:'corridor145',coordinates:[0,0,145/6371.0088*180/Math.PI,0]}];
const reference=spawnSync(python,[join(here,'plan-reference.py')],{input:JSON.stringify({records,solar,distances}),encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000});
assert.equal(reference.status,0,reference.stderr);const oracle=JSON.parse(reference.stdout);assert.equal(oracle.sgp4Version,'2.27');
const maxima={losBoundarySeconds:0,peakTimeSeconds:0,peakElevationDeg:0,closestTimeSeconds:0,closestDistanceKm:0,solarDeg:0,distanceKm:0};
let comparisons=0,positiveCases=0,negativeCases=0;
const outcomes=[];
for(const record of records)for(const target of record.cases){
  const item=assembled.items.find(value=>value.id===record.id),area={latitude:target.latitude,longitude:target.longitude,radiusKm:25,method:'coordinates',generation:1};
  const raw={...createEmptyBrief(),purpose:'Numerical verification at this explicitly chosen coordinate; no named-place or collection claim.',observationIntent:'single-observation',sensor:'OPEN',latitude:String(area.latitude),longitude:String(area.longitude),radiusKm:'25',areaChoice:area,areaConfirmation:areaSignature(area),areaReviewedPurpose:'Numerical verification at this explicitly chosen coordinate; no named-place or collection claim.',timingToDiscuss:false,windowStart:target.startUtc.slice(0,16),windowEnd:target.endUtc.slice(0,16)};
  const checked=validateBrief(raw,{preparation:true,requireAcknowledgement:false,requireAreaPurposeReview:true});assert.ok(checked.value,JSON.stringify(checked.fieldErrors));
  const brief=checked.value,input={purposeDigest:digest(brief.purpose),observationIntent:'single-observation',area,areaSource:null,timezone:'UTC',baselineDate:'',recentDate:'',window:{startUtc:target.startUtc,endUtc:target.endUtc},sensor:'OPEN',maxResolutionM:null,cloudCover:null,revisitHours:null,spectralRequirements:'',outputs:['Imagery'],timingNotes:'',unknowns:[]};
  const prepared={generation:1,input,briefDigest:digest(canonicalJson(brief)),inputDigest:digest(canonicalJson(input)),brief,request:null,requirements:{purpose:brief.purpose,deadlineUtc:null,delivery:null,operator:null,ownerCountry:null},catalog:{snapshotVersion:'numeric-only',factVersion:item.factVersion,validation:'COMPLETE',sources:groups.map(g=>g.source),items:[item],dictionary:{operators:[],countries:[],places:[]},rejected:0,matching:[{item,omm:record.omm,reasons:[],unknowns:[]}]}};
  const actual=await calculateAssessment(prepared,now.toISOString());
  // Freshness refusals are independently honest, never rewritten to force a pass.
  if(actual.counts.stale||actual.counts.insufficient){outcomes.push({id:record.id,target:target.caseId,state:'UNAVAILABLE',reason:actual.outcomes[0].reason});continue;}
  assert.equal(actual.state,'COMPLETE',JSON.stringify(actual));
  const expected=oracle.results.find(value=>value.id===record.id).cases.find(value=>value.caseId===target.caseId),intervals=[...new Map(actual.options.map(option=>[option.los.startUtc+option.los.endUtc,option])).values()];
  assert.equal(intervals.length,expected.intervals.length,`${record.id}/${target.caseId}: detected LOS intervals differ from dense reference`);
  if(intervals.length)positiveCases++;else negativeCases++;
  for(let index=0;index<intervals.length;index++){
    const option=intervals[index],ref=expected.intervals[index],seconds=(a,b)=>Math.abs(Date.parse(a)-Date.parse(b))/1000;
    maxima.losBoundarySeconds=Math.max(maxima.losBoundarySeconds,seconds(option.los.startUtc,ref.startUtc),seconds(option.los.endUtc,ref.endUtc));
    maxima.peakTimeSeconds=Math.max(maxima.peakTimeSeconds,seconds(option.los.peakUtc,ref.peakUtc));
    maxima.peakElevationDeg=Math.max(maxima.peakElevationDeg,Math.abs(option.los.peakElevationDeg-ref.peakElevationDeg));
    if(option.nominalClosest){maxima.closestTimeSeconds=Math.max(maxima.closestTimeSeconds,seconds(option.nominalClosest.atUtc,ref.closestUtc));maxima.closestDistanceKm=Math.max(maxima.closestDistanceKm,Math.abs(option.nominalClosest.distanceKm-ref.closestDistanceKm));}
    assert.equal(option.los.clippedStart,ref.clippedStart);assert.equal(option.los.clippedEnd,ref.clippedEnd);comparisons++;
  }
  outcomes.push({id:record.id,target:target.caseId,state:actual.state,intervals:intervals.length,evaluations:actual.counts.evaluations});
}
for(const expected of oracle.solar){const input=solar.find(v=>v.id===expected.id),value=solarElevationDeg(input.at,input.latitude,input.longitude);assert.notEqual(value,null);maxima.solarDeg=Math.max(maxima.solarDeg,Math.abs(value-expected.elevationDeg));}
for(const expected of oracle.distances){const input=distances.find(v=>v.id===expected.id),value=groundCenterDistanceKm(...input.coordinates);assert.notEqual(value,null);maxima.distanceKm=Math.max(maxima.distanceKm,Math.abs(value-expected.km));}
assert.ok(comparisons>0,'No eligible independent LOS comparison was performed.');
assert.ok(maxima.losBoundarySeconds<=1,JSON.stringify(maxima));assert.ok(maxima.peakTimeSeconds<=1,JSON.stringify(maxima));assert.ok(maxima.closestTimeSeconds<=1,JSON.stringify(maxima));
assert.ok(maxima.peakElevationDeg<=.01,JSON.stringify(maxima));assert.ok(maxima.closestDistanceKm<=.01,JSON.stringify(maxima));assert.ok(maxima.solarDeg<=.03,JSON.stringify(maxima));assert.ok(maxima.distanceKm<=.001,JSON.stringify(maxima));
console.log(JSON.stringify({outcome:'PASS',sourceHashes,uniquePopulation:assembled.items.length,records:records.length,window:{startUtc:new Date(start).toISOString(),endUtc:new Date(end).toISOString()},positiveCases,negativeCases,intervalComparisons:comparisons,solarCases:solar.length,distanceCases:distances.length,maxima,outcomes,solarPackageHash:SOLAR_PACKAGE_SHA256,limits:'Implementation agreement, not observational accuracy. USNO solar comparison uses a different approximate formula;≤0.03° tolerance is an engineering comparison bound, with the approved0.1° policy uncertainty guard. Dense1s reference does not validate sub-sample events.'},null,2));
