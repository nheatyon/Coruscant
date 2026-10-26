import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BriefInput, CatalogItem, RequestProjection } from '../../shared/contracts.js';
import type { MissionsSnapshot, RequestListPage } from '../../shared/tracking.js';
import { makeDiscoveryDictionary, interpretNeed } from '../../shared/discovery.js';
import { createEmptyQuoteDraft } from '../../shared/workflow.js';
import { normalizeReference } from '../../server/projections.js';
import { validBrief } from '../helpers/brief.js';
import { ApiClient, apiFixture, scheduledRequest, preparedResult, approveAndPublishImages, grant, resultInput, type ApiFixture } from './support.js';

async function submit(client:ApiClient,brief:BriefInput=validBrief()){
  const input={target:{organizationId:client.context!.organization!.id},expected:{},payload:{brief}};
  const review=await client.post('/api/command-reviews/submitRequest',input);assert.equal(review.statusCode,200,review.body);
  const result=await client.post('/api/commands/submitRequest',{...input,commandId:randomUUID(),reviewToken:review.json().reviewToken});assert.equal(result.statusCode,201,result.body);
  return result.json().requestId as string;
}
async function list(client:ApiClient,query=''):Promise<RequestListPage>{
  const response=await client.get(`/api/customer/${client.context!.organization!.id}/requests${query}`);assert.equal(response.statusCode,200,response.body);return response.json();
}
async function missions(client:ApiClient,org=client.context!.organization!.id):Promise<MissionsSnapshot>{
  const response=await client.get(`/api/customer/${org}/missions`);assert.equal(response.statusCode,200,response.body);return response.json();
}
function writes(f:ApiFixture){return ['service_requests','brief_revisions','request_events','quotes','quote_decisions','schedules','action_receipts'].map(table=>({table,n:(f.app.coruscant.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n}));}

test('Requests applies bound search/status/page with truthful20-row totals and deterministic ordering; Missions loads the complete authorized workspace',async()=>{
  const f=await apiFixture();try{
    const ids:string[]=[];
    for(let index=0;index<23;index++)ids.push(await submit(f.owner,validBrief({purpose:`Tracking request ${String(index).padStart(2,'0')}. SAR imagery.`})));
    await f.staff.action('startReview',ids[0]!);
    const expected=[...ids].sort(),first=await list(f.owner),second=await list(f.owner,'?page=2'),third=await list(f.owner,'?page=3');
    assert.equal(first.total,23);assert.equal(first.page,1);assert.equal(first.pageSize,20);assert.equal(first.hasNext,true);assert.equal(first.nextPage,2);assert.equal(first.requests.length,20);
    assert.deepEqual(first.requests.map(row=>row.id),expected.slice(0,20));assert.deepEqual(second.requests.map(row=>row.id),expected.slice(20));assert.equal(second.total,23);assert.equal(second.page,2);assert.equal(second.hasNext,false);assert.equal(second.nextPage,null);
    assert.deepEqual(third.requests,[]);assert.equal(third.total,23);assert.equal(third.hasNext,false);assert.equal(third.nextPage,null);
    assert.equal(first.contextGeneration,f.owner.context!.contextGeneration);assert.equal(first.serverNow,f.clock().toISOString());
    const filtered=await list(f.owner,'?search=Tracking&status=In%20review&page=1');assert.equal(filtered.total,1);assert.equal(filtered.requests[0]!.id,ids[0]);assert.equal(filtered.requests[0]!.requestVersion,2);
    const snapshot=await missions(f.owner);assert.equal(snapshot.requests.length,23);assert.equal(snapshot.scope.kind,'ALL_AUTHORIZED_WORKSPACE_REQUESTS');assert.equal(snapshot.scope.organizationId,'org-a');assert.equal(snapshot.scope.loaded,23);assert.equal(snapshot.scope.total,23);assert.equal(snapshot.completeness,'COMPLETE');assert.deepEqual(snapshot.requests.map(row=>row.id),expected);
    assert.equal(snapshot.contextGeneration,f.owner.context!.contextGeneration);assert.equal(snapshot.serverNow,f.clock().toISOString());
    const recent=await submit(f.owner,validBrief({purpose:'A later tracking request.'}));
    // Real saved submission time is authoritative, with ID tie-breaking only within that instant.
    f.advance(1000);const newest=await submit(f.owner,validBrief({purpose:'The genuinely newest tracking request.'}));assert.equal((await list(f.owner)).requests[0]!.id,newest);assert.ok((await missions(f.owner)).requests.some(row=>row.id===recent));
  }finally{await f.close();}
});

test('Requests searches literal wildcard punctuation, normalized references, family, title and the actual saved place without trusting query structure',async()=>{
  const f=await apiFixture();try{
    const special=await submit(f.owner,validBrief({purpose:'Measure the literal 50%_! demonstration label.'}));
    const ordinary=await submit(f.owner,validBrief({purpose:'Ordinary shoreline comparison.'}));
    const dictionary=makeDiscoveryDictionary((await f.owner.get('/api/public/catalog')).json().items as CatalogItem[]),purpose='SAR imagery, maximum ground resolution 10 m.';
    const reading=interpretNeed({text:purpose,generation:1,manual:[{field:'place',action:'SET',value:'Hidden Estuary Zone',label:'Explicitly entered this place label'}],dictionary});
    const place=await submit(f.owner,validBrief({purpose,discovery:{rulesVersion:reading.rulesVersion,generation:reading.generation,originalText:purpose,manual:reading.manual,reviewedSignature:reading.reviewSignature}}));
    for(const search of ['%','_','!','50%_!']){const found=await list(f.owner,`?search=${encodeURIComponent(search)}`);assert.deepEqual(found.requests.map(row=>row.id),[special]);}
    assert.equal((await list(f.owner,'?search=%25%25')).total,0);assert.equal((await list(f.owner,`?search=${encodeURIComponent("' OR 1=1 --")}`)).total,0);
    const byPlace=await list(f.owner,'?search=hidden%20estuary');assert.deepEqual(byPlace.requests.map(row=>row.id),[place]);assert.ok(!byPlace.requests[0]!.title.includes('Hidden Estuary Zone'));
    const byTitle=await list(f.owner,'?search=ordinary%20shoreline');assert.deepEqual(byTitle.requests.map(row=>row.id),[ordinary]);assert.equal((await list(f.owner,'?search=Earth%20observation')).total,3);
    const reference=(await f.owner.state(ordinary)).reference,byReference=await list(f.owner,`?search=${reference.toLowerCase().replace(/-/g,'')}`);assert.deepEqual(byReference.requests.map(row=>row.id),[ordinary]);assert.equal(normalizeReference('srs-oI1l0-abcde'),'SRS01110ABCDE');
  }finally{await f.close();}
});

test('Requests invalid filters are explicit failures, while current customer, membership and organization guard every list and mission snapshot',async()=>{
  const f=await apiFixture();try{
    const id=await submit(f.owner),secret=(await f.owner.state(id)).reference;
    for(const query of ['?search='+ 'x'.repeat(201),'?status=Cancelled','?page=0','?page=-1','?page=1.5','?page=100001','?search=a&search=b','?status=Submitted&status=Delivered','?page=1&page=2','?unknown=1']){
      const response=await f.owner.get(`/api/customer/org-a/requests${query}`);assert.equal(response.statusCode,422,response.body);assert.equal(response.json().code,'FILTER_INVALID');assert.ok(response.json().fieldErrors.filters);assert.ok(!response.body.includes(secret));
    }
    const anonymous=new ApiClient(f.app),b=new ApiClient(f.app),viewer=new ApiClient(f.app);await b.enter('b-owner','org-b');await viewer.enter('a-viewer');
    for(const suffix of ['requests','missions']){
      assert.equal((await anonymous.get(`/api/customer/org-a/${suffix}`)).statusCode,401);
      const denied=await b.get(`/api/customer/org-a/${suffix}`);assert.equal(denied.statusCode,404,denied.body);assert.ok(!denied.body.includes(secret));
      assert.equal((await f.staff.get(`/api/customer/org-a/${suffix}`)).statusCode,403);
      assert.equal((await viewer.get(`/api/customer/org-a/${suffix}`)).statusCode,200);
    }
    const empty=await missions(b);assert.deepEqual(empty.requests,[]);assert.equal(empty.scope.total,0);assert.equal(empty.completeness,'COMPLETE');
    f.app.coruscant.db.prepare("UPDATE memberships SET active=0 WHERE actor_id='a-viewer' AND organization_id='org-a'").run();
    const revoked=await viewer.get('/api/customer/org-a/missions');assert.notEqual(revoked.statusCode,200);assert.ok(!revoked.body.includes(secret));
  }finally{await f.close();}
});

test('Mission snapshot and detail share current exact versions, commercial records and history; private drafts remain private and clocks perform no transition',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f),unquoted=await submit(f.owner);await f.staff.action('startReview',unquoted);
    await f.staff.action('saveQuoteDraft',unquoted,{quote:{...createEmptyQuoteDraft(),scope:'STAFF-PRIVATE unshared drafting text'}});
    await f.owner.action('replyToTeam',id,{message:'A post-acceptance question must not change accepted terms or schedule.'});
    const detail=await f.owner.state(id),first=await missions(f.owner),row=first.requests.find(row=>row.id===id)!;
    const {detailAvailability,result,...same}=row;const {contextGeneration,serverNow,...detailFacts}=detail as unknown as RequestProjection&{result:unknown;contextGeneration:number;serverNow:string};
    assert.deepEqual({...same,result},detailFacts);assert.deepEqual(detailAvailability,{quote:'KNOWN',window:'KNOWN',result:'KNOWN'});assert.equal(row.status,'Scheduled');assert.equal(row.messages.at(-1)!.message,'A post-acceptance question must not change accepted terms or schedule.');
    assert.ok(!JSON.stringify(first).includes('STAFF-PRIVATE'));assert.ok(first.requests.every(value=>!Object.hasOwn(value,'quoteDrafts')));
    const before=writes(f);f.advance(2*3600*1000);const later=await missions(f.owner);assert.equal(later.requests.find(row=>row.id===id)!.status,'Scheduled');assert.deepEqual(writes(f),before);assert.notEqual(later.serverNow,first.serverNow);
    await f.restart();const reopened=await missions(f.owner);assert.deepEqual(reopened.requests,later.requests);assert.deepEqual(reopened.scope,later.scope);
  }finally{await f.close();}
});

test('Mission result links require current publication, organization entitlement and rights independently of delivery',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f),result=await preparedResult(f,id);assert.equal((await missions(f.owner)).requests[0]!.result,null);
    await f.staff.action('saveResultDraft',id,{result:{...resultInput(),rightsExpiresAt:'2026-10-21T13:00:00.000Z'}},{resultId:result.id});
    await approveAndPublishImages(f,id);assert.equal((await missions(f.owner)).requests[0]!.result,null,'publication does not grant organization access');
    await grant(f,id);const visible=(await missions(f.owner)).requests[0]!;assert.equal(visible.result!.id,result.id);assert.equal(visible.result!.title,result.metadata.title);assert.equal(visible.status,'Scheduled','readable material does not imply delivery');assert.equal(visible.detailAvailability.result,'KNOWN');
    const b=new ApiClient(f.app);await b.enter('b-owner','org-b');assert.ok(!JSON.stringify(await missions(b)).includes(result.metadata.title));
    f.app.coruscant.db.prepare('UPDATE result_entitlements SET active=0 WHERE result_id=?').run(result.id);const lost=(await missions(f.owner)).requests[0]!;assert.equal(lost.result,null);assert.equal(lost.detailAvailability.result,'KNOWN');
    f.app.coruscant.db.prepare('UPDATE result_entitlements SET active=1 WHERE result_id=?').run(result.id);f.advance(2*3600*1000);const expired=(await missions(f.owner)).requests[0]!;assert.equal(expired.result,null);assert.equal(expired.status,'Scheduled');assert.equal(expired.detailAvailability.result,'KNOWN');
  }finally{await f.close();}
});

test('Real failed quote/window/result details preserve known authorized mission records and provenance as unknown, never false zero',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f);const result=await preparedResult(f,id),other=await submit(f.owner),before=await f.owner.state(id);
    // Isolated store faults exercise the real builders; no public fault endpoint or successful workflow seed.
    f.app.coruscant.db.exec('DROP TRIGGER accepted_quote_no_update; DROP TRIGGER quote_frozen_terms; DROP TRIGGER schedules_no_update;');
    f.app.coruscant.db.prepare("UPDATE quotes SET terms_json='null' WHERE id=?").run(before.acceptedQuote!.id);
    f.app.coruscant.db.prepare("UPDATE schedules SET plan_json='null' WHERE request_id=?").run(id);
    f.app.coruscant.db.prepare("UPDATE result_sets SET metadata_json='null' WHERE id=?").run(result.id);
    const snapshot=await missions(f.owner),row=snapshot.requests.find(row=>row.id===id)!;assert.equal(snapshot.completeness,'PARTIAL');assert.equal(snapshot.scope.total,2);assert.equal(snapshot.scope.loaded,2);assert.equal(row.status,'Scheduled');assert.equal(row.reference,before.reference);assert.equal(row.requestVersion,before.requestVersion);assert.deepEqual(row.brief,before.brief);assert.deepEqual(row.evidence,before.evidence);assert.deepEqual(row.history,before.history);
    assert.deepEqual(row.detailAvailability,{quote:'UNAVAILABLE',window:'UNAVAILABLE',result:'UNAVAILABLE'});assert.equal(row.acceptedQuote,null);assert.equal(row.schedule,null);assert.equal(row.result,null);assert.equal(snapshot.requests.find(row=>row.id===other)!.detailAvailability.quote,'KNOWN');
    const strict=await f.owner.get(`/api/customer/org-a/requests/${id}`);assert.equal(strict.statusCode,503,'strict detail remains an honest error rather than an empty success');assert.ok(!strict.body.includes(f.dataRoot));
  }finally{await f.close();}
});

test('Malformed normalized published quote fields stay inside the unavailable child boundary while valid expired accepted terms remain readable',async()=>{
  const f=await apiFixture();try{
    const id=await scheduledRequest(f),original=await f.owner.state(id),quote=original.acceptedQuote!;
    f.advance(2*86400*1000);f.owner.context=null;f.owner.cookie='';await f.owner.enter();
    const expired=(await missions(f.owner)).requests.find(row=>row.id===id)!;assert.ok(quote.terms.validUntil!<f.clock().toISOString());assert.equal(expired.detailAvailability.quote,'KNOWN');assert.deepEqual(expired.acceptedQuote,quote,'structural reads must not apply new-decision expiry rules');
    f.app.coruscant.db.exec('DROP TRIGGER accepted_quote_no_update; DROP TRIGGER quote_frozen_terms;');
    const badTerms:unknown[]=[null,{}, {...quote.terms,priceType:'RANGE',amount:null,minimum:'not a decimal',maximum:'2800.00'},
      {...quote.terms,currency:'US Dollars'}, {...quote.terms,scope:undefined}, {...quote.terms,licence:''},
      {...quote.terms,validUntil:'2026-10-22T18:00:00+00:00'}, {...quote.terms,recommendedEvidence:null}];
    for(const terms of badTerms){
      f.app.coruscant.db.prepare('UPDATE quotes SET terms_json=? WHERE id=?').run(JSON.stringify(terms),quote.id);
      const snapshot=await missions(f.owner),row=snapshot.requests.find(row=>row.id===id)!;assert.equal(snapshot.completeness,'PARTIAL');assert.equal(row.detailAvailability.quote,'UNAVAILABLE');assert.equal(row.detailAvailability.window,'KNOWN');assert.equal(row.acceptedQuote,null);assert.deepEqual(row.brief,original.brief);assert.equal(row.reference,original.reference);assert.equal(row.requestVersion,original.requestVersion);
    }
    f.app.coruscant.db.prepare('UPDATE quotes SET terms_json=? WHERE id=?').run(JSON.stringify(quote.terms),quote.id);
    for(const brief of [null,{}, {...quote.pricedBrief,area:null}, {...quote.pricedBrief,requestedWindow:{}}, {...quote.pricedBrief,deadline:{}}]){
      f.app.coruscant.db.prepare('UPDATE quotes SET priced_brief_json=? WHERE id=?').run(JSON.stringify(brief),quote.id);
      const row=(await missions(f.owner)).requests.find(row=>row.id===id)!;assert.equal(row.detailAvailability.quote,'UNAVAILABLE');assert.equal(row.acceptedQuote,null);assert.deepEqual(row.brief,original.brief);
    }
    f.app.coruscant.db.prepare('UPDATE quotes SET priced_brief_json=? WHERE id=?').run(JSON.stringify(quote.pricedBrief),quote.id);
    const restored=await missions(f.owner);assert.equal(restored.completeness,'COMPLETE');assert.deepEqual(restored.requests.find(row=>row.id===id)!.acceptedQuote,quote);
  }finally{await f.close();}
});

test('Mission authority or base-request corruption cannot be converted into a partial empty success',async()=>{
  const f=await apiFixture();try{
    const id=await submit(f.owner);const saved=f.app.coruscant.db.prepare('SELECT brief_json FROM brief_revisions WHERE request_id=?').get(id) as {brief_json:string};
    f.app.coruscant.db.exec('DROP TRIGGER brief_no_update');f.app.coruscant.db.prepare("UPDATE brief_revisions SET brief_json='null' WHERE request_id=?").run(id);
    const corrupt=await f.owner.get('/api/customer/org-a/missions');assert.equal(corrupt.statusCode,503);assert.ok(!corrupt.body.includes('Demonstration contact'));assert.equal(corrupt.json().requests,undefined);
    f.app.coruscant.db.prepare('UPDATE brief_revisions SET brief_json=? WHERE request_id=?').run(saved.brief_json,id);f.app.coruscant.db.prepare('UPDATE service_requests SET current_brief_revision=99 WHERE id=?').run(id);
    const missing=await f.owner.get('/api/customer/org-a/missions');assert.equal(missing.statusCode,503);assert.equal(missing.json().requests,undefined);
    f.app.coruscant.db.prepare('UPDATE service_requests SET current_brief_revision=1 WHERE id=?').run(id);f.app.coruscant.db.prepare("UPDATE actors SET active=0 WHERE id='a-owner'").run();const denied=await f.owner.get('/api/customer/org-a/missions');assert.notEqual(denied.statusCode,200);assert.equal(denied.json().requests,undefined);
  }finally{await f.close();}
});
