import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { BriefInput, CatalogItem, NormalizedBrief } from '../../shared/contracts.js';
import type { DiscoverySnapshotInput, ManualChoice } from '../../shared/discovery-contracts.js';
import { DISCOVERY_RULES_VERSION } from '../../shared/discovery-contracts.js';
import { interpretNeed, makeDiscoveryDictionary } from '../../shared/discovery.js';
import { createEmptyQuoteDraft, revisionToInput } from '../../shared/workflow.js';
import { validBrief } from '../helpers/brief.js';
import { apiFixture, type ApiFixture } from './support.js';

async function dictionary(f:ApiFixture) {const response=await f.owner.get('/api/public/catalog');assert.equal(response.statusCode,200);return makeDiscoveryDictionary(response.json().items as CatalogItem[]);}
async function discovery(f:ApiFixture,text:string,manual:ManualChoice[]=[],review=false,generation=1):Promise<DiscoverySnapshotInput> {
  const read=interpretNeed({text,generation,manual,dictionary:await dictionary(f)});
  return {rulesVersion:DISCOVERY_RULES_VERSION,generation,originalText:text,manual,...(review?{reviewedSignature:read.reviewSignature}:{})};
}
async function submit(f:ApiFixture,brief:BriefInput) {
  const raw={target:{organizationId:'org-a'},expected:{},payload:{brief}};
  const preview=await f.owner.post('/api/command-reviews/submitRequest',raw);assert.equal(preview.statusCode,200,preview.body);
  const response=await f.owner.post('/api/commands/submitRequest',{...raw,commandId:randomUUID(),reviewToken:preview.json().reviewToken});assert.equal(response.statusCode,201,response.body);
  return {id:response.json().requestId as string,preview:preview.json() as {brief:NormalizedBrief}};
}
function factsOnly<T extends {matchReasons?:string[];uncertainties?:string[];matchesReviewedCriteria?:boolean}>(row:T) {const {matchReasons,uncertainties,matchesReviewedCriteria,...facts}=row;return facts;}

test('varied local interpretation provenance and normalized values reach the exact saved reviewed brief',async()=>{
  const f=await apiFixture();try {
    const cases=[
      {purpose:'Help a coastal group compare possible surface-water expansion after heavy rainfall.',maxResolution:'10',resolutionUnit:'m' as const,expected:10,origin:'inferred'},
      {purpose:'SAR imagery, maximum ground resolution 500 cm.',maxResolution:'500',resolutionUnit:'cm' as const,expected:5,origin:'stated'},
      {purpose:'Synthetic aperture radar at .005 km resolution.',maxResolution:'.005',resolutionUnit:'km' as const,expected:5,origin:'stated'},
    ];
    for(const sample of cases) {
      const brief=validBrief({...sample,discovery:await discovery(f,sample.purpose,[],true),selectedEvidence:[{itemId:'demo-sar-03',evidenceVersion:'demo-evidence-v1'}]});
      const {id,preview}=await submit(f,brief),saved=await f.owner.state(id);assert.equal(saved.brief.purpose,sample.purpose);assert.equal(saved.brief.maxResolutionM,sample.expected);assert.equal(saved.brief.baselineDate,'2026-10-07');assert.equal(saved.brief.recentDate,'2026-10-14');assert.deepEqual(saved.brief.discovery,preview.brief.discovery);
      const source=saved.brief.discovery!.facts.find(fact=>fact.field==='maxResolutionM');assert.ok(source);assert.equal(source.origin,sample.origin);assert.ok(source.span);assert.equal(sample.purpose.slice(source.span.start,source.span.end),source.phrase);assert.equal(source.generation,1);assert.ok(source.ruleId);assert.equal(saved.brief.discovery!.route.kind,'EO');
    }
    await f.restart();const rows=await f.owner.get('/api/customer/org-a/requests');assert.equal(rows.statusCode,200);assert.equal(rows.json().total,3);assert.ok(rows.json().requests.every((row:{brief:NormalizedBrief})=>row.brief.discovery?.rulesVersion===DISCOVERY_RULES_VERSION));
  }finally{await f.close();}
});

test('manual values and actual chip clear govern saved requirements while keeping truthful source provenance',async()=>{
  const f=await apiFixture();try {
    const purpose='Compare possible surface-water expansion after heavy rainfall.';
    const cleared:ManualChoice[]=[{field:'maxResolutionM',action:'CLEAR',label:'Removed maximum ground resolution criterion'}];
    const clearedBrief=validBrief({purpose,maxResolution:'',discovery:await discovery(f,purpose,cleared,true)});const first=await submit(f,clearedBrief);const saved=await f.owner.state(first.id);assert.equal(saved.brief.maxResolutionM,null);assert.equal(saved.brief.discovery!.effective.maxResolutionM,null);assert.ok(saved.brief.discovery!.facts.some(fact=>fact.field==='maxResolutionM'&&fact.origin==='manual'&&fact.span===null));
    const manual:ManualChoice[]=[{field:'maxResolutionM',action:'SET',value:5,label:'5 m entered in the maximum resolution control'}];
    const second=await submit(f,validBrief({purpose,maxResolution:'5',discovery:await discovery(f,purpose,manual,true,2)}));const changed=await f.owner.state(second.id);assert.equal(changed.brief.maxResolutionM,5);const fact=changed.brief.discovery!.facts.find(fact=>fact.field==='maxResolutionM'&&fact.origin==='manual');assert.ok(fact);assert.equal(fact.span,null);assert.equal(fact.phrase,manual[0]!.label);assert.equal(fact.generation,2);
    const stale=validBrief({purpose,maxResolution:'10',discovery:await discovery(f,purpose,manual,true,2)});const refusal=await f.owner.post('/api/command-reviews/submitRequest',{target:{organizationId:'org-a'},expected:{},payload:{brief:stale}});assert.equal(refusal.statusCode,422);assert.ok(refusal.json().fieldErrors.discovery||refusal.json().fieldErrors.maxResolution||Object.keys(refusal.json().fieldErrors).some(key=>key.includes('discovery')));
  }finally{await f.close();}
});

test('stated/inferred facts and route are recomputed from purpose; fabricated facts cannot bypass Planned or conflicting work',async()=>{
  const f=await apiFixture();try {
    const purpose='SAR imagery, maximum ground resolution 500 cm.';const raw=await discovery(f,purpose);
    const spoof={...raw,effective:{sensor:'SAR',maxResolutionM:0.001},facts:[{origin:'manual',verified:true,phrase:'invented'}],route:{kind:'EO'},canSelectOffers:true};
    const {id}=await submit(f,validBrief({purpose,maxResolution:'500',resolutionUnit:'cm',discovery:spoof}));const actual=(await f.owner.state(id)).brief.discovery!;assert.equal(actual.effective.maxResolutionM,5);assert.ok(!JSON.stringify(actual).includes('invented'));assert.equal(Object.hasOwn(actual,'canSelectOffers'),false);
    const choices:ManualChoice[]=[{field:'window',action:'SET',value:{startUtc:'2026-10-23T08:00:00.000Z',endUtc:'2026-10-25T18:00:00.000Z'},label:'Entered this explicit request window'}];
    const authored=await discovery(f,purpose,choices,true,2);const injected={...authored,manual:authored.manual.map(choice=>({...choice,canSelectOffers:true,claimedRole:'STAFF',value:{...choice.value as object,claimedCapability:'Guaranteed coverage'}}))};
    const strict=await submit(f,validBrief({purpose,maxResolution:'500',resolutionUnit:'cm',discovery:injected as unknown as DiscoverySnapshotInput}));const clean=(await f.owner.state(strict.id)).brief.discovery!;assert.ok(!JSON.stringify(clean).includes('Guaranteed coverage'));assert.ok(!JSON.stringify(clean).includes('canSelectOffers'));assert.ok(!JSON.stringify(clean).includes('claimedRole'));
    for(const text of ['Broadband communications for a region.','SAR only and thermal only.','SAR imagery and broadband communications.','Surface-water expansion; no SAR, optical only.']) {
      const snapshot={...await discovery(f,text),reviewedSignature:'forged-reviewed-signature',route:{kind:'EO'},effective:{family:'EO',sensor:'SAR',outputs:['Imagery'],maxResolutionM:10}};
      const response=await f.owner.post('/api/command-reviews/submitRequest',{target:{organizationId:'org-a'},expected:{},payload:{brief:validBrief({purpose:text,discovery:snapshot})}});assert.equal(response.statusCode,422,response.body);
    }
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM service_requests').get() as {n:number}).n,2);
    for(const snapshot of [{...raw,generation:0},{...raw,originalText:'A different query.'},{...raw,rulesVersion:'invented-rules'}, {...raw,manual:[{field:'sensor',action:'SET',value:{role:'STAFF'},label:'forged'}]}]) {
      const response=await f.owner.post('/api/command-reviews/submitRequest',{target:{organizationId:'org-a'},expected:{},payload:{brief:validBrief({purpose,maxResolution:'500',resolutionUnit:'cm',discovery:snapshot as DiscoverySnapshotInput})}});assert.equal(response.statusCode,422,response.body);
    }
  }finally{await f.close();}
});

test('saved match reasons come from exact canonical evidence and keep identity verification distinct from technical fit',async()=>{
  const f=await apiFixture();try {
    const purpose='SAR imagery, maximum ground resolution 10 m.';const brief=validBrief({purpose,discovery:await discovery(f,purpose),selectedEvidence:[{itemId:'demo-sar-03',evidenceVersion:'demo-evidence-v1'},{itemId:'demo-sar-20',evidenceVersion:'demo-evidence-v1'},{itemId:'demo-eo-unknown',evidenceVersion:'demo-evidence-v1'},{itemId:'missing-intention',evidenceVersion:'not-published'}]});
    const hostile={...brief,selectedEvidence:brief.selectedEvidence.map(ref=>({...ref,verified:true,resolutionM:0.001,matchReasons:['Client says perfect coverage'],matchesReviewedCriteria:true,source:'fake-operator'}))};
    const {id}=await submit(f,hostile),row=await f.owner.state(id);const [fine,coarse,unknown,missing]=row.evidence;
    assert.equal(fine!.resolutionM,3);assert.equal(fine!.matchesReviewedCriteria,true);assert.ok(fine!.matchReasons!.length);assert.equal(coarse!.verified,true);assert.equal(coarse!.resolutionM,20);assert.equal(coarse!.matchesReviewedCriteria,false);assert.ok(coarse!.matchReasons!.length);assert.equal(unknown!.verified,true);assert.equal(unknown!.sensors,null);assert.equal(unknown!.matchesReviewedCriteria,true);assert.ok(unknown!.uncertainties!.length);assert.equal(missing!.verified,false);assert.equal(missing!.name,'missing-intention');assert.ok(missing!.caveats.length);assert.ok(!JSON.stringify(row).includes('perfect coverage'));assert.ok(!JSON.stringify(row).includes('fake-operator'));
    const strict=await discovery(f,purpose,[{field:'documentedOnly',action:'SET',value:true,label:'Documented criteria only'}]);const next=await submit(f,{...brief,discovery:strict});const strictUnknown=(await f.owner.state(next.id)).evidence.find(item=>item.itemId==='demo-eo-unknown')!;assert.equal(strictUnknown.verified,true);assert.equal(strictUnknown.matchesReviewedCriteria,false);
  }finally{await f.close();}
});

test('new revision rationale changes with reviewed criteria while original facts/contact/timing and prior JSON remain immutable',async()=>{
  const f=await apiFixture();try {
    const purpose='SAR imagery, maximum ground resolution 10 m. window: 2026-10-23T08:00:00Z to 2026-10-25T18:00:00Z; deadline: 2026-10-26T18:00:00Z; timezone: UTC.';const {id}=await submit(f,validBrief({purpose,deadline:'2026-10-26T18:00',discovery:await discovery(f,purpose),selectedEvidence:[{itemId:'demo-sar-08',evidenceVersion:'demo-evidence-v1'}]}));const before=await f.owner.state(id),oldJson=(f.app.coruscant.db.prepare('SELECT brief_json,evidence_json FROM brief_revisions WHERE request_id=? AND revision=1').get(id) as {brief_json:string;evidence_json:string});assert.equal(before.evidence[0]!.matchesReviewedCriteria,true);assert.ok(before.brief.discovery!.effective.window);assert.ok(before.brief.discovery!.effective.deadline);
    const revised=revisionToInput(before.brief);revised.maxResolution='5';revised.discovery=await discovery(f,purpose,[{field:'maxResolutionM',action:'SET',value:5,label:'Changed maximum resolution to 5 m after review'}],true,2);
    f.app.coruscant.db.prepare('DELETE FROM evidence_versions WHERE item_id=? AND evidence_version=?').run('demo-sar-08','demo-evidence-v1');await f.owner.action('reviseBrief',id,{brief:revised});const after=await f.owner.state(id);assert.equal(after.briefRevision,2);assert.deepEqual(factsOnly(after.evidence[0]!),factsOnly(before.evidence[0]!));assert.equal(after.evidence[0]!.matchesReviewedCriteria,false);assert.notDeepEqual(after.evidence[0]!.matchReasons,before.evidence[0]!.matchReasons);assert.deepEqual(after.brief.contact,before.brief.contact);assert.deepEqual(after.brief.requestedWindow,before.brief.requestedWindow);assert.deepEqual(after.brief.deadline,before.brief.deadline);assert.equal(after.brief.baselineDate,before.brief.baselineDate);assert.equal(after.brief.recentDate,before.brief.recentDate);
    const retained=f.app.coruscant.db.prepare('SELECT brief_json,evidence_json FROM brief_revisions WHERE request_id=? AND revision=1').get(id);assert.deepEqual(retained,oldJson);assert.deepEqual(after.revisions[0]!.evidence,before.evidence);assert.deepEqual(after.revisions[0]!.brief,before.brief);
  }finally{await f.close();}
});

test('source failure retains a valid interpreted submission and legacy/manual briefs need no snapshot',async()=>{
  const f=await apiFixture({preliminaryCheck(){throw new Error('isolated source failure');}});try {
    const purpose='SAR imagery, maximum ground resolution 5 m.';const {id}=await submit(f,validBrief({purpose,maxResolution:'5',discovery:await discovery(f,purpose),selectedEvidence:[{itemId:'demo-sar-03',evidenceVersion:'demo-evidence-v1'}]}));const saved=await f.owner.state(id);assert.equal(saved.matchingState,'Automatic check unavailable');assert.equal(saved.evidence[0]!.verified,false);assert.ok(saved.brief.discovery);assert.equal(saved.brief.maxResolutionM,5);
    const old=await submit(f,validBrief());assert.equal(Object.hasOwn((await f.owner.state(old.id)).brief,'discovery'),false);
  }finally{await f.close();}
});

test('acceptance freezes the exact reviewed discovery requirements and current reads never reinterpret accepted prose',async()=>{
  const f=await apiFixture();try {
    const purpose='SAR imagery, maximum ground resolution 500 cm.';const {id}=await submit(f,validBrief({purpose,maxResolution:'500',resolutionUnit:'cm',discovery:await discovery(f,purpose),selectedEvidence:[{itemId:'demo-sar-03',evidenceVersion:'demo-evidence-v1'}]}));const original=await f.owner.state(id);
    await f.staff.action('startReview',id);const quote=await f.staff.action('saveQuoteDraft',id,{quote:{...createEmptyQuoteDraft(),priceType:'FIXED',amount:'2400.00',scope:'Synthetic comparison against the exact saved requirements and dates, without a new collection.',licence:'Local demonstration use.',validUntil:'2026-10-22T18:00'}});
    await f.staff.action('publishQuote',id,{replacesQuoteId:null},{quoteId:quote.quoteId!},{quoteContentVersion:quote.quoteContentVersion!});await f.owner.action('acceptQuote',id,{},{quoteId:quote.quoteId!},{quoteContentVersion:quote.quoteContentVersion!});
    const accepted=await f.owner.state(id);assert.equal(accepted.status,'Accepted');assert.deepEqual(accepted.acceptedQuote!.pricedBrief,original.brief);assert.deepEqual(accepted.acceptedQuote!.pricedBrief.discovery,original.brief.discovery);
    const revision=revisionToInput(accepted.brief);revision.maxResolution='1';const denied=await f.owner.post('/api/command-reviews/reviseBrief',f.owner.envelope(accepted,{brief:revision}));assert.equal(denied.statusCode,409);assert.equal(denied.json().code,'ACCEPTED_WORK_LOCKED');
    await f.restart();const reopened=await f.owner.state(id);assert.deepEqual(reopened.brief,accepted.brief);assert.deepEqual(reopened.acceptedQuote,accepted.acceptedQuote);assert.deepEqual(reopened.evidence,accepted.evidence);
  }finally{await f.close();}
});

test('explicit timing clears cannot retain an old actual saved window or deadline behind a null effective criterion',async()=>{
  const f=await apiFixture();try {
    const purpose='SAR imagery, maximum ground resolution 10 m.';
    for(const field of ['window','deadline'] as const) {
      const context=await discovery(f,purpose,[{field,action:'CLEAR',label:`Removed ${field} criterion`}]);
      const mismatched=validBrief({purpose,deadline:'2026-10-26T18:00',discovery:context});
      const response=await f.owner.post('/api/command-reviews/submitRequest',{target:{organizationId:'org-a'},expected:{},payload:{brief:mismatched}});
      assert.equal(response.statusCode,422,response.body);assert.ok(response.json().fieldErrors.discovery);
    }
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM service_requests').get() as {n:number}).n,0);
    const clears:ManualChoice[]=[{field:'window',action:'CLEAR',label:'Timing to be discussed'},{field:'deadline',action:'CLEAR',label:'No deadline stated'}];
    const {id}=await submit(f,validBrief({purpose,timingToDiscuss:true,windowStart:'',windowEnd:'',deadline:'',discovery:await discovery(f,purpose,clears)}));
    const saved=await f.owner.state(id);assert.equal(saved.brief.requestedWindow,null);assert.equal(saved.brief.deadline,null);assert.equal(saved.brief.discovery!.effective.window,null);assert.equal(saved.brief.discovery!.effective.deadline,null);assert.equal(saved.brief.baselineDate,'2026-10-07');assert.equal(saved.brief.recentDate,'2026-10-14');
  }finally{await f.close();}
});
