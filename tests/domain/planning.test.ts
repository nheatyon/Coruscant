import test from 'node:test';
import assert from 'node:assert/strict';
import { areaSignature, createEmptyBrief, validateBrief, validatePlanningBrief } from '../../shared/validation.js';
import { planningToInput, validateBriefRevision, validateQuoteForPublication, createEmptyQuoteDraft, validateQuoteDraft } from '../../shared/workflow.js';

function input() {
  const purpose='Inspect the visible-light shoreline near a deliberately chosen target.';
  const area={latitude:14.7,longitude:-17.4,radiusKm:12,method:'coordinates' as const,generation:2};
  return {...createEmptyBrief(),purpose,areaReviewedPurpose:purpose,observationIntent:'single-observation' as const,sensor:'Visible',latitude:String(area.latitude),longitude:String(area.longitude),radiusKm:String(area.radiusKm),areaChoice:area,areaConfirmation:areaSignature(area)};
}
const contact={name:'Generated planner',email:'planner@coruscant.example',organization:'Generated planning research'};
test('Planning accepts honest unknown contact/window and explicit single intent without comparison dates',()=>{
  const raw=input(),result=validatePlanningBrief(raw);assert.ok(result.value,JSON.stringify(result.fieldErrors));
  assert.equal(result.value.sensor,'VISIBLE');assert.equal(result.value.observationIntent,'single-observation');
  assert.equal(result.value.baselineDate,'');assert.equal(result.value.recentDate,'');assert.equal(result.value.requestedWindow,null);
  assert.deepEqual(result.value.contact,{name:'',email:'',organization:''});
  assert.equal(validateBrief(raw).value,undefined);
  assert.ok(validateBrief({...raw,contact,acknowledged:true}).value);
});
test('Preparation still refuses supplied invalid contact, partial timing, invalid dates and an unreviewed current purpose',()=>{
  const raw=input();assert.ok(validatePlanningBrief({...raw,contact:{...contact,email:'bad'}}).fieldErrors['contact.email']);
  assert.ok(validatePlanningBrief({...raw,timingToDiscuss:false,windowStart:'2026-11-01T08:00'}).fieldErrors.windowEnd);
  assert.ok(validatePlanningBrief({...raw,observationIntent:'comparison',baselineDate:'2026-02-30'}).fieldErrors.baselineDate);
  assert.ok(validatePlanningBrief({...raw,areaReviewedPurpose:'Previous question'}).fieldErrors.areaReviewedPurpose);
  assert.ok(validatePlanningBrief({...raw,purpose:'An edited question'}).fieldErrors.areaReviewedPurpose);
});
test('Comparison dates remain conditional, strictly ordered on submission, and absent legacy intent stays comparison',()=>{
  const raw={...input(),observationIntent:'comparison' as const,contact,acknowledged:true};
  assert.ok(validatePlanningBrief(raw).value);assert.ok(validateBrief(raw).fieldErrors.baselineDate);
  assert.ok(validateBrief({...raw,baselineDate:'2026-10-13',recentDate:'2026-10-12'}).fieldErrors.recentDate);
  const {observationIntent:_,...legacy}={...raw,baselineDate:'2026-10-12',recentDate:'2026-10-13'};
  const checked=validateBrief(legacy);assert.ok(checked.value);assert.equal(Object.hasOwn(checked.value,'observationIntent'),false);
});
test('All adopted EO sensor fields normalize and single intent never saves stale hidden pair dates',()=>{
  for(const sensor of ['OPEN','SAR','Visible','VISIBLE','SWIR','Thermal','THERMAL']) {
    const result=validatePlanningBrief({...input(),sensor,baselineDate:'2026-01-01',recentDate:'2026-01-02'});
    assert.ok(result.value,JSON.stringify(result.fieldErrors));assert.equal(result.value.baselineDate,'');assert.equal(result.value.recentDate,'');
  }
  assert.ok(validatePlanningBrief({...input(),family:'COMMUNICATIONS'}).fieldErrors.family);
  assert.ok(validatePlanningBrief({...input(),outputs:['Video']}).fieldErrors.outputs);
});
test('Private Planning revision permits actual contact completion while submitted original contact stays immutable',()=>{
  const previous=validatePlanningBrief(input()).value!,raw=planningToInput(previous);
  const checked=validateBriefRevision({...raw,contact},previous,undefined,{preparation:true,requireAreaPurposeReview:true});
  assert.ok(checked.value,JSON.stringify(checked.fieldErrors));assert.deepEqual(checked.value.contact,contact);
  assert.equal(validateBriefRevision({...raw,contact},previous).value,undefined);
  assert.equal(raw.observationIntent,'single-observation');assert.deepEqual(raw.contact,previous.contact);
});
test('Publication keeps commercial terms/window gates but comparison date requirements follow intent',()=>{
  const brief=validateBrief({...input(),contact,acknowledged:true,timingToDiscuss:false,windowStart:'2026-11-01T08:00',windowEnd:'2026-11-02T08:00'}).value!;
  const quote=validateQuoteDraft({...createEmptyQuoteDraft(),priceType:'FIXED',amount:'100.50',scope:'Single visible observation review only; no supplied optical recipe.',licence:'Explicit test rights',validUntil:'2026-10-30T00:00'}).value!;
  assert.ok(validateQuoteForPublication(quote,brief,'2026-10-25T00:00:00Z').value);
  assert.ok(validateQuoteForPublication(quote,{...brief,observationIntent:'comparison'},'2026-10-25T00:00:00Z').fieldErrors.comparisonDates);
  assert.ok(validateQuoteForPublication(quote,{...brief,requestedWindow:null},'2026-10-25T00:00:00Z').fieldErrors.requestedWindow);
});
