import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [ledgerPath,emittedRoot=resolve('dist/node')]=process.argv.slice(2);
assert.ok(ledgerPath,'Supply the private fresh public-source ledger; no workflow database is read.');
const load=path=>import(pathToFileURL(join(emittedRoot,path)));
const {createConfig}=await load('server/config.js'),{openDatabase}=await load('server/db/database.js'),{migrate}=await load('server/db/migrate.js'),{initialize}=await load('server/db/initialize.js'),{buildApp}=await load('server/app.js');
const {createEmptyBrief,areaSignature}=await load('shared/validation.js');
const ledgerBytes=readFileSync(ledgerPath),ledger=JSON.parse(ledgerBytes),dataRoot=mkdtempSync(join(tmpdir(),'coruscant-plan-measure-')),orbital=join(dataRoot,'orbital');mkdirSync(orbital,{mode:0o700});
for(const entry of Object.values(ledger.groups)){assert.match(entry.rawFile,/^[a-f0-9]{64}\.json$/);const bytes=readFileSync(join(dirname(ledgerPath),entry.rawFile));assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);writeFileSync(join(orbital,entry.rawFile),bytes,{mode:0o600});}
writeFileSync(join(orbital,'initial-acquisition.json'),ledgerBytes,{mode:0o600});
const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise((yes,no)=>socket.close(error=>error?no(error):yes()));
const config=createConfig({dataRoot,port}),db=openDatabase(config);migrate(db);initialize(db,config);db.close();let app;
try {
  app=await buildApp({dataRoot,port});await app.listen({host:'127.0.0.1',port});const origin=config.origin;
  const get=async path=>{const response=await fetch(origin+path);assert.equal(response.status,200);return response.json();};
  const bootstrap=await fetch(origin+'/api/demo/bootstrap',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});assert.equal(bootstrap.status,200);
  const context=await bootstrap.json(),cookie=bootstrap.headers.get('set-cookie').split(';')[0];
  const post=async(path,value)=>{const response=await fetch(origin+path,{method:'POST',headers:{origin,cookie,'content-type':'application/json','x-coruscant-csrf':context.csrfToken},body:JSON.stringify({...value,contextGeneration:context.contextGeneration,contextToken:context.contextToken}),signal:AbortSignal.timeout(10000)});const text=await response.text();assert.equal(response.status,200,text);assert.ok(Buffer.byteLength(text)<=256*1024,'Assessment response exceeds page bound');return JSON.parse(text);};
  const catalog=await get('/api/public/real-catalog'),base=Math.ceil((Date.now()+120000)/60000)*60000,measurements=[];
  for(const [index,scenario]of [{name:'full-population-west-six-hours',lat:52.6,lon:-9.7,hours:6,sensor:'OPEN'},{name:'full-population-equator24-hours',lat:0,lon:0,hours:24,sensor:'OPEN'},{name:'documented-visible10m-next-day',lat:53.35,lon:-6.26,hours:18,sensor:'VISIBLE'}].entries()){
    const purpose='Explicit numerical planning measurement at these chosen coordinates; no place lookup or provider booking.',area={latitude:scenario.lat,longitude:scenario.lon,radiusKm:25,method:'coordinates',generation:1};
    // This benchmark uses the real brief path. Manual discovery controls are built
    // through the existing local interpreter so strict filters are actually saved.
    const {interpretNeed}=await load('shared/discovery.js');
    const manual=[{field:'family',action:'SET',value:'EO',label:'Earth observation'},{field:'sensor',action:'SET',value:scenario.sensor,label:scenario.sensor},...(scenario.sensor==='VISIBLE'?[{field:'maxResolutionM',action:'SET',value:10,label:'10 m'},{field:'documentedOnly',action:'SET',value:true,label:'Documented criteria only'}]:[])];
    const discovery=interpretNeed({text:purpose,generation:1,manual,dictionary:catalog.dictionary});
    const brief={...createEmptyBrief(),purpose,areaReviewedPurpose:purpose,observationIntent:'single-observation',sensor:scenario.sensor,maxResolution:scenario.sensor==='VISIBLE'?'10':'',latitude:String(scenario.lat),longitude:String(scenario.lon),radiusKm:'25',areaChoice:area,areaConfirmation:areaSignature(area),timingToDiscuss:false,windowStart:new Date(base).toISOString().slice(0,16),windowEnd:new Date(base+scenario.hours*3600000).toISOString().slice(0,16),catalogContext:{sourceKind:'PUBLIC_REAL',snapshotVersion:catalog.snapshotVersion,factVersion:catalog.factVersion},discovery:{rulesVersion:discovery.rulesVersion,generation:1,originalText:purpose,manual,reviewedSignature:discovery.reviewSignature}};
    const began=performance.now(),ordinary=[];let done=false,firstUsefulMs=null;
    const responsiveness=(async()=>{while(!done){await pause(10);const begin=performance.now();await get('/api/public/catalog');ordinary.push(performance.now()-begin);}})();
    let page=await post('/api/orbital-assessments',{generation:index+1,brief});
    while(['QUEUED','RUNNING'].includes(page.state)){
      if(firstUsefulMs===null&&page.options.some(option=>option.outcome!=='INELIGIBLE'))firstUsefulMs=performance.now()-began;
      await pause(20);page=await post('/api/orbital-assessments/status',page.handle);
    }
    if(firstUsefulMs===null&&page.options.some(option=>option.outcome!=='INELIGIBLE'))firstUsefulMs=performance.now()-began;
    const completedMs=performance.now()-began;done=true;await responsiveness;
    const options=[...page.options],outcomes=[];let cursor=page.nextCursor,pages=1;
    while(cursor){const next=await post('/api/orbital-assessments/status',{...page.handle,cursor,kind:'OPTIONS'});options.push(...next.options);cursor=next.nextCursor;pages++;}
    cursor=undefined;do{const next=await post('/api/orbital-assessments/status',{...page.handle,...(cursor?{cursor}:{}),kind:'OUTCOMES'});outcomes.push(...next.outcomes);cursor=next.nextCursor;pages++;}while(cursor);
    assert.equal(outcomes.length,page.counts.matching);assert.equal(new Set(outcomes.map(row=>row.itemId)).size,outcomes.length);assert.equal(options.length,page.totalOptions);
    assert.equal(page.counts.completed+page.counts.stale+page.counts.insufficient+page.counts.incomplete+page.counts.notAssessed,page.counts.matching);
    assert.equal(page.counts.remaining,0);if(page.state!=='COMPLETE')assert.equal(page.preferredOptionId,null);
    measurements.push({scenario:scenario.name,window:{startUtc:new Date(base).toISOString(),endUtc:new Date(base+scenario.hours*3600000).toISOString()},target:{latitude:scenario.lat,longitude:scenario.lon},state:page.state,reason:page.reason,counts:page.counts,options:{all:options.length,ready:options.filter(o=>o.outcome==='READY').length,provisional:options.filter(o=>o.outcome==='PROVISIONAL').length,ineligible:options.filter(o=>o.outcome==='INELIGIBLE').length},pages,firstUsefulMs:firstUsefulMs===null?null:Math.round(firstUsefulMs),completedMs:Math.round(completedMs),ordinaryRequests:ordinary.length,ordinaryMedianMs:Math.round([...ordinary].sort((a,b)=>a-b)[Math.floor(ordinary.length/2)]??0),ordinaryMaxMs:Math.round(Math.max(0,...ordinary)),coverageWarnings:page.coverageWarnings});
  }
  console.log(JSON.stringify({outcome:'PASS',sourceSnapshot:catalog.snapshotVersion,sourceHashes:Object.fromEntries(Object.entries(ledger.groups).map(([k,v])=>[k,v.sha256])),population:catalog.counts.unique,measurements,boundary:'Actual fresh source bytes and actual local HTTP requests in an isolated root; no source refetch, recording DB, workflow seeds, or forced matching/positive outcomes. Observed latency is not an SLA.'},null,2));
}finally{if(app)await app.close();rmSync(dataRoot,{recursive:true,force:true});}
