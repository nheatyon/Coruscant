import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPlacePhrase } from '../../shared/place-phrase.js';
import { PLACE_RULES_VERSION } from '../../shared/place-contracts.js';

const readyCases:[string,string][]=[
  ['Visible imagery over lower hutt, new zealand with 10 m resolution.','lower hutt, new zealand'],
  ['Thermal observations near san pedro de atacama during the requested window.','san pedro de atacama'],
  ['I need SWIR imagery around Port Elizabeth using the documented native band.','Port Elizabeth'],
  ['SAR imagery of Tromsø at 5 m resolution before the next review.','Tromsø'],
  ['Observe the shoreline in Vila Nova de Gaia, Portugal with cloud cover under 20%.','Vila Nova de Gaia, Portugal'],
  ['A visible image at Lake Tekapo with an explicit UTC window.','Lake Tekapo'],
  ['Inspect “Bay of Islands, New Zealand” with Visible imagery.','Bay of Islands, New Zealand'],
  ['Need imagery over the bay in Nova Scotia with a documented sensor.','the bay in Nova Scotia'],
];
test('local place clauses preserve ordinary multiword/lowercase names, region qualifiers and exact original spans',()=>{
  for(const [text,phrase] of readyCases){const result=extractPlacePhrase(text);assert.equal(result.state,'ready',`${text}: ${result.reason}`);assert.equal(result.phrase,phrase,text);assert.equal(text.slice(result.span!.start,result.span!.end),phrase);assert.equal(result.origin,'stated');assert.equal(result.rulesVersion,PLACE_RULES_VERSION);}
});
test('requirements, units and timing do not become a fabricated location',()=>{
  for(const text of ['SAR imagery at 5 m resolution.','Revisit in 12 hours with imagery.','Measure a radius of 25 km.','An altitude of 500 km.','Imagery at night.',''])assert.notEqual(extractPlacePhrase(text).state,'ready',text);
});
test('several locations, negated locations and unsupported clauses need an explicit phrase decision',()=>{
  for(const text of ['Imagery over Salta and near Mendoza.','Observe “Bergen” or “Bodø”.','Imagery not over Cork.','Imagery excluding near Nuuk.','Obtain an image outside the requested region.'])assert.notEqual(extractPlacePhrase(text).state,'ready',text);
});
test('a recognized date/window clause ends the place fragment without imposing date NLP',()=>{
  for(const [text,phrase] of [
    ['Visible imagery over Lyon on 2026-11-02 at 09:00 UTC.','Lyon'],
    ['SWIR imagery near Kaikōura window 2026-11-03T08:00Z to 2026-11-03T18:00Z.','Kaikōura'],
    ['Thermal imagery around Arequipa with a requested window tomorrow.','Arequipa'],
  ]) {const result=extractPlacePhrase(text!);assert.equal(result.state,'ready',text);assert.equal(result.phrase,phrase,text);assert.equal(text!.slice(result.span!.start,result.span!.end),phrase);}
});
test('a negated imaging action never automatically proposes its following location',()=>{
  for(const text of ['Do not image near Cork.','No observations over Nuuk.','Do not obtain imagery in Limassol.'])assert.notEqual(extractPlacePhrase(text).state,'ready',text);
});
test('quoting a location cannot bypass the same bounded negation check, while positive quoted spans stay exact',()=>{
  for(const text of ['Do not image near “Cork”.','No observations over “Nuuk”.','Imagery excluding "St. Louis".']) {
    const value=extractPlacePhrase(text);assert.equal(value.state,'review',text);assert.equal(value.phrase,'');assert.equal(value.span,null);
    assert.equal(value.reason,'A negated location needs a deliberate phrase correction.');
  }
  for(const [text,phrase] of [
    ['Visible imagery near “Cork”.','Cork'],
    ['Observe "St. Louis, Missouri" with a requested window.','St. Louis, Missouri'],
  ]) {
    const value=extractPlacePhrase(text!);assert.equal(value.state,'ready',text);assert.equal(value.phrase,phrase,text);
    assert.deepEqual(value.span,{start:text!.indexOf(phrase!),end:text!.indexOf(phrase!)+phrase!.length});
    assert.equal(text!.slice(value.span!.start,value.span!.end),phrase);
  }
});

test('requirement and relative-time suffixes end the exact local phrase without resolving a time or location',()=>{
  for(const [text,phrase] of [
    ['Visible imagery of Dublin, 1 m resolution','Dublin'],
    ['SWIR imagery over Valparaíso, 20 m spatial resolution with low cloud cover.','Valparaíso'],
    ['SAR observations around Kaikōura, maximum 500 cm ground resolution.','Kaikōura'],
    ['Visible imagery of Dublin next week','Dublin'],
    ['Thermal observations near Akureyri tomorrow with a requested window.','Akureyri'],
    ['SAR imagery over Puerto Madryn next Monday.','Puerto Madryn'],
    ['Visible imagery in Vila Nova de Gaia, Portugal next month.','Vila Nova de Gaia, Portugal'],
  ]) {
    const value=extractPlacePhrase(text!);assert.equal(value.state,'ready',`${text}: ${value.reason}`);assert.equal(value.phrase,phrase,text);
    assert.deepEqual(value.span,{start:text!.indexOf(phrase!),end:text!.indexOf(phrase!)+phrase!.length});
    assert.equal(text!.slice(value.span!.start,value.span!.end),phrase);assert.equal(value.origin,'stated');
  }
});

test('bounded geographic abbreviations and dotted region qualifiers stay complete in the source span',()=>{
  for(const [text,phrase] of [
    ['Visible imagery of St. Louis, 1 m resolution','St. Louis'],
    ['Visible imagery of Washington, D.C. next week','Washington, D.C.'],
    ['Thermal observations around St. Louis, Missouri with an explicit window.','St. Louis, Missouri'],
    ['SAR imagery near Mt. Cook, New Zealand during the requested window.','Mt. Cook, New Zealand'],
    ["SWIR imagery of St. John's, Newfoundland, 20 m resolution.","St. John's, Newfoundland"],
    ['Visible imagery near Ft. William before the next review.','Ft. William'],
    ['Thermal imagery of Ste. Anne, Québec next month.','Ste. Anne, Québec'],
    ['SAR imagery over Washington, D.C.','Washington, D.C.'],
  ]) {
    const value=extractPlacePhrase(text!);assert.equal(value.state,'ready',`${text}: ${value.reason}`);assert.equal(value.phrase,phrase,text);
    assert.equal(text!.slice(value.span!.start,value.span!.end),phrase);assert.equal(value.rulesVersion,PLACE_RULES_VERSION);
  }
});

test('unsupported punctuation requests an explicit correction rather than a truncated or whole-question phrase',()=>{
  for(const text of [
    'Visible imagery of Dublin / Cork, 1 m resolution.',
    'Thermal imagery near Port Dr. Vale with a window.',
    'Visible imagery of Dublin: resolution 1 m.',
    'SAR imagery over Washington, D.C. Additional unexplained prose.',
    'Visible imagery of St.',
  ]) {const value=extractPlacePhrase(text);assert.equal(value.state,'review',text);assert.equal(value.phrase,'');assert.equal(value.span,null);}
  for(const text of ['Visible imagery of St. Louis and near Washington, D.C. next week.','Do not image near St. Louis, 1 m resolution.'])assert.equal(extractPlacePhrase(text).state,'review',text);
});
