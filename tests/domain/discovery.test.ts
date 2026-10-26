import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgeReviewedFilters, clearManualChoice, emptyDiscoveryValues, interpretNeed, makeDiscoveryDictionary, matchEvidence, setManualChoice, validateDiscoverySnapshot, type DiscoveryEvidence, type DiscoveryInterpretation } from '../../shared/discovery.js';

const evidence = (): DiscoveryEvidence[] => [
  ['river-fine', 'Marsh SAR Fine', ['SAR'], 3, 'IE', 'River Demo Agency'],
  ['river-coarse', 'Marsh SAR Wide', ['SAR'], 20, 'IE', 'River Demo Agency'],
  ['river-unknown', 'Wetland Survey', null, null, null, null],
  ['river-optical', 'Marsh Visible', ['VISIBLE'], 0.5, 'CA', 'Coastal Demo Agency'],
  ['river-country', 'Delta SAR Candidate', ['SAR'], 5, null, 'Coastal Demo Agency'],
].map(([id, name, sensors, resolutionM, ownerCountry, operator]) => ({ id, name, sensors, resolutionM, ownerCountry, operator, family: 'EO', type: 'catalog', evidenceVersion: 'fresh-domain-evidence', source: 'New isolated fictional domain evidence', checkedAt: '2026-10-22T12:00:00.000Z', demonstration: true, caveats: ['Synthetic isolated evidence; not provider availability.'], status: 'unknown', launchDate: null })) as DiscoveryEvidence[];
const dictionary = () => makeDiscoveryDictionary(evidence());
const read = (text: string, generation = 1) => interpretNeed({ text, generation, dictionary: dictionary() });
const ids = (value: DiscoveryInterpretation) => matchEvidence(evidence(), value.effective, value.exclusions).matches.map(match => match.item.id);
const core = (value: DiscoveryInterpretation) => ({ family: value.effective.family ?? 'EO', sensor: value.effective.sensor ?? 'OPEN', outputs: value.effective.outputs ?? ['Imagery'], maxResolutionM: value.effective.maxResolutionM, cloudCover: value.effective.cloudCover, revisitHours: value.effective.revisitHours });

test('fresh outcome prose gets explained editable inference, while an isolated water word supplies no sensor', () => {
  const text = 'Could the team compare expanding surface-water near the estuary following rain?';
  const value = read(text);
  assert.equal(value.effective.sensor, 'SAR'); assert.equal(value.effective.maxResolutionM, 10); assert.equal(value.effective.family, 'EO');
  assert.ok(value.rationale.includes('Read by local rules')); assert.ok(value.rationale.some(line => line.includes('not a scientific threshold')));
  for (const fact of value.facts.filter(fact => fact.origin === 'inferred')) assert.equal(fact.phrase, text.slice(fact.span!.start, fact.span!.end));
  assert.equal(Object.hasOwn(value.effective, 'baselineDate'), false); assert.equal(Object.hasOwn(value.effective, 'latitude'), false);
  assert.equal(read('Our water team is drafting a report.').effective.sensor, null);
  assert.equal(read('A thesaurus for a research group.').effective.sensor, null);
});
test('bounded hyphenated phrases are equivalent while original phrase spans and numeric/date separators stay intact', () => {
  const text = 'İ team: Earth-observation; synthetic-aperture-radar imagery at 5 m resolution.';
  const value = read(text); assert.equal(value.effective.family, 'EO'); assert.equal(value.effective.sensor, 'SAR'); assert.equal(value.effective.maxResolutionM, 5);
  const sensor = value.facts.find(fact => fact.field === 'sensor')!; assert.equal(sensor.phrase, 'synthetic-aperture-radar'); assert.equal(text.slice(sensor.span!.start, sensor.span!.end), sensor.phrase);
  assert.equal(read('Short-wave-infrared imagery.').effective.sensor, 'SWIR');
  assert.equal(read('SAR resolution -5 m.').effective.maxResolutionM, null);
});
test('resolution preserves source units and normalizes equivalent upper bounds, excluding unrelated geometry and spectra', () => {
  for (const phrase of ['maximum ground resolution 500 cm', 'SAR at .005 km resolution', 'SAR imagery with resolution 5 metres', 'SAR no worse than 5 m resolution']) {
    const value = read(phrase); assert.equal(value.effective.maxResolutionM, 5, phrase);
    assert.ok(value.facts.some(fact => fact.field === 'maxResolutionM' && fact.origin === 'stated' && fact.phrase.includes(phrase.includes('.005') ? '.005 km' : phrase.includes('500') ? '500 cm' : '5 m')));
  }
  const geometry = read('SAR imagery; radius 25 km; spacecraft altitude 500 km; swath 80 km.');
  assert.equal(geometry.effective.maxResolutionM, null); assert.ok(geometry.diagnostics.some(item => item.phrase.includes('altitude 500 km')));
  assert.equal(read('SAR imagery with spectral response 540 nm.').effective.maxResolutionM, null);
  for (const phrase of ['SAR resolution 10.', 'SAR resolution between 3 and 8 m.', 'SAR minimum resolution 5 m.', 'SAR resolution 0 m.', 'SAR resolution -5 m.', 'SAR imagery; no 5 m resolution.', 'SAR imagery at 5–10 m resolution.', 'SAR imagery at 5-10 m resolution.', 'SAR imagery at 5—10 m resolution.', 'SAR imagery at 5 to 10 m resolution.', 'SAR resolution 5 m to 10 m.']) {
    const value = read(phrase); assert.equal(value.effective.maxResolutionM, null, phrase); assert.ok(value.diagnostics.some(item => item.field === 'maxResolutionM'), phrase);
  }
});
test('bounded negation and only modifiers do not reverse exclusions or negate all imagery output', () => {
  const optical = read('Surface-water expansion; no SAR, optical only.');
  assert.equal(optical.effective.sensor, 'VISIBLE'); assert.equal(optical.effective.maxResolutionM, null); assert.equal(optical.route.kind, 'EO');
  assert.ok(optical.exclusions.some(item => item.field === 'sensor' && item.value === 'SAR'));
  const radar = read('No optical imagery; SAR imagery at 10 m resolution.');
  assert.equal(radar.effective.sensor, 'SAR'); assert.equal(radar.effective.maxResolutionM, 10); assert.deepEqual(radar.effective.outputs, ['Imagery']);
  assert.ok(!radar.exclusions.some(item => item.field === 'outputs' && item.value === 'Imagery'));
  const coordinated = read('Without visible or thermal; SAR imagery.');
  assert.deepEqual(coordinated.exclusions.filter(item => item.field === 'sensor').map(item => item.value).sort(), ['THERMAL', 'VISIBLE']);
  for (const text of ['Maybe SAR, no more than an unclear resolution.', 'Not without SAR imagery.', 'SAR only and thermal only.']) assert.equal(read(text).route.kind, 'REVIEW', text);
  for (const text of ['Not not SAR imagery.', 'SAR maybe.', 'Inspection of the satellite.']) assert.equal(read(text).route.kind, 'REVIEW', text);
  assert.equal(read('No SAR optical only.').route.kind, 'REVIEW');
  assert.equal(read('Flood comparison with any resolution.').effective.maxResolutionM, null);
  assert.equal(read('Flood comparison with no resolution limit.').effective.maxResolutionM, null);
});
test('clear non-EO intent and explicit unsupported outcomes remain Planned; mixed requirements need reviewed choice', () => {
  for (const [text, family] of [['Broadband communications for an isolated region.', 'COMMUNICATIONS'], ['Astronomy and space-object observation.', 'SPACE'], ['Docker Doctor repair and refit.', 'SERVICING']] as const) {
    const value = read(text); assert.equal(value.route.kind, 'PLANNED'); assert.equal(value.route.family, family); assert.equal(value.effective.sensor, null);
  }
  const mixed = read('SAR imagery and broadband communications.'); assert.equal(mixed.route.kind, 'REVIEW');
  const objectContext = read('Connectivity for a SAR satellite.'); assert.equal(objectContext.route.kind, 'PLANNED'); assert.equal(objectContext.route.family, 'COMMUNICATIONS'); assert.equal(objectContext.effective.sensor, null); assert.ok(!objectContext.facts.some(fact => fact.field === 'family' && fact.value === 'EO'));
  assert.equal(read('SAR satellite imagery and broadband communications.').route.kind, 'REVIEW');
  for (const text of ['SAR video deliverable.', 'SAR GIS layers.']) assert.equal(read(text).route.kind, 'PLANNED', text);
  assert.equal(read('The GIS analyst needs SAR imagery after a video call.').effective.outputs?.includes('GIS'), false);
  assert.equal(read('The imagery analyst needs broadband connectivity.').effective.outputs, null);
});
test('cloud/revisit supported units and dictionary fields retain fragments without inventing owner, place coordinates or operator', () => {
  const value = read('SAR imagery; max cloud cover 12%; revisit every 2 days; operator: River Demo Agency; owner country: Ireland; near Shannon estuary; keyword: Marsh.');
  assert.equal(value.effective.cloudCover, 12); assert.equal(value.effective.revisitHours, 48); assert.equal(value.effective.operator, 'River Demo Agency'); assert.equal(value.effective.ownerCountry, 'IE'); assert.equal(value.effective.place, 'Shannon estuary'); assert.equal(value.effective.keyword, 'Marsh');
  assert.equal(read('SAR imagery weekly.').effective.revisitHours, 168); assert.equal(read('SAR imagery daily.').effective.revisitHours, 24);
  const ordinary = read('Compare imagery over Shannon estuary for the coastal group.'); assert.equal(ordinary.effective.keyword, null); assert.equal(ordinary.effective.operator, null); assert.equal(ordinary.effective.ownerCountry, null);
  const unknown = read('SAR imagery; operator: Unlisted Space Company; place: Unknown Bay; delivery: as soon as practical.');
  assert.equal(unknown.effective.operator, null); assert.equal(unknown.effective.place, null); assert.ok(unknown.diagnostics.some(item => item.phrase.includes('Unknown Bay'))); assert.ok(unknown.diagnostics.some(item => item.field === 'delivery'));
  assert.equal(read('SAR maximum cloud 101 percent.').effective.cloudCover, null);
  const fragments = read('SAR imagery; max cloud unknown; revisit on a convenient cadence; delivery within a week.');
  assert.ok(fragments.diagnostics.some(item => item.field === 'cloudCover')); assert.ok(fragments.diagnostics.some(item => item.field === 'revisitHours')); assert.ok(fragments.diagnostics.some(item => item.phrase.includes('delivery within a week')));
});
test('only complete ordered explicit offset timing resolves; invalid or partial wording stays raw and comparison dates remain absent', () => {
  const text = 'SAR imagery; window: 2026-11-03T10:00+01:00 to 2026-11-03T12:00+01:00; deadline: 2026-11-04T10:00Z; timezone: Europe/Dublin';
  const value = read(text); assert.deepEqual(value.effective.window, { startUtc: '2026-11-03T09:00:00.000Z', endUtc: '2026-11-03T11:00:00.000Z' }); assert.equal(value.effective.deadline, '2026-11-04T10:00:00.000Z'); assert.equal(value.effective.timezone, 'Europe/Dublin');
  assert.equal(read('SAR imagery; Timezone: Pacific/Auckland').effective.timezone, 'Pacific/Auckland');
  assert.equal(read('SAR imagery; TIMEZONE: Europe/Dublin').effective.timezone, 'Europe/Dublin');
  for (const text of ['Before heavy rain; from next Tuesday until…', 'SAR; window: 2026-11-03T10:00Z to', 'SAR; window: 2026-02-30T10:00Z to 2026-03-03T10:00Z', 'SAR; window: 2026-11-03T12:00Z to 2026-11-03T10:00Z']) {
    const value = read(text); assert.equal(value.effective.window, null); assert.equal(value.effective.deadline, null); assert.ok(value.diagnostics.some(item => item.field === 'window')); assert.equal(Object.hasOwn(value.effective, 'baselineDate'), false);
  }
  assert.ok(validateDiscoverySnapshot(value, text, dictionary(), { ...core(value), timezone: 'UTC', requestedWindow: value.effective.window, deadline: { utc: value.effective.deadline! } }).fieldErrors.discovery);
  const manualWindow = { startUtc: '2026-11-03T09:00:00.000Z', endUtc: '2026-11-03T11:00:00.000Z' }, manualDeadline = { utc: '2026-11-04T10:00:00.000Z' };
  const plain = read('SAR imagery.');
  assert.ok(validateDiscoverySnapshot(plain, plain.originalText, dictionary(), { ...core(plain), requestedWindow: manualWindow, deadline: manualDeadline }).value, 'independent manual timing remains allowed when discovery never claimed or cleared it');
  for (const field of ['window', 'deadline'] as const) {
    const cleared = interpretNeed({ text: plain.originalText, generation: 1, dictionary: dictionary(), manual: clearManualChoice([], field, `Cleared ${field}`) });
    assert.ok(validateDiscoverySnapshot(cleared, cleared.originalText, dictionary(), { ...core(cleared), requestedWindow: field === 'window' ? manualWindow : null, deadline: field === 'deadline' ? manualDeadline : null }).fieldErrors.discovery);
    assert.ok(validateDiscoverySnapshot(cleared, cleared.originalText, dictionary(), { ...core(cleared), requestedWindow: null, deadline: null }).value);
  }
});
test('new query replaces prior suggestions while deliberate manual values and clears retain correct provenance', () => {
  const first = read('Flood comparison.');
  const manual = setManualChoice(first.manual, 'maxResolutionM', 5, 'Custom resolution (m): 5');
  const second = interpretNeed({ text: 'SAR imagery at 8 m resolution.', generation: 2, manual, dictionary: dictionary() });
  assert.equal(second.effective.maxResolutionM, 5); assert.equal(second.route.kind, 'REVIEW');
  const fact = second.facts.find(item => item.origin === 'manual')!; assert.equal(fact.span, null); assert.equal(fact.phrase, 'Custom resolution (m): 5'); assert.equal(fact.generation, 2);
  const reviewed = acknowledgeReviewedFilters(second, dictionary()); assert.equal(reviewed.route.kind, 'EO');
  const stale = interpretNeed({ text: second.originalText, generation: 3, manual, dictionary: dictionary(), reviewedSignature: reviewed.reviewedSignature }); assert.equal(stale.route.kind, 'REVIEW');
  const cleared = interpretNeed({ text: first.originalText, generation: 1, dictionary: dictionary(), manual: clearManualChoice([], 'maxResolutionM', 'Removed maximum resolution') });
  assert.equal(cleared.effective.maxResolutionM, null); assert.ok(!cleared.exclusions.some(item => item.field === 'sensor')); assert.ok(ids(cleared).includes('river-coarse'));
  const optical = interpretNeed({ text: first.originalText, generation: 2, dictionary: dictionary(), manual: setManualChoice([], 'sensor', 'VISIBLE', 'Visible') });
  assert.equal(optical.effective.maxResolutionM, null); assert.equal(optical.effective.sensor, 'VISIBLE'); assert.equal(optical.route.kind, 'EO');
});
test('documented-only clear and clear-all remove actual criteria without manufacturing an invalid manual choice', () => {
  const manual = clearManualChoice(setManualChoice([], 'documentedOnly', true, 'Only documented criteria'), 'documentedOnly', 'Include unknown evidence');
  const cleared = interpretNeed({ text: 'SAR imagery at 5 m resolution.', generation: 1, dictionary: dictionary(), manual });
  assert.equal(cleared.effective.documentedOnly, false); assert.ok(!cleared.diagnostics.some(item => item.reason === 'A manual criterion is invalid.'));
  let all = manual;
  for (const field of Object.keys(emptyDiscoveryValues()) as (keyof ReturnType<typeof emptyDiscoveryValues>)[]) all = clearManualChoice(all, field, `Cleared ${field}`);
  const result = interpretNeed({ text: cleared.originalText, generation: 2, dictionary: dictionary(), manual: all });
  assert.deepEqual(result.effective, emptyDiscoveryValues()); assert.equal(result.route.kind, 'EO'); assert.equal(result.diagnostics.length, 0);
  assert.ok(validateDiscoverySnapshot(result, result.originalText, dictionary(), core(result)).value);
});
test('opposing sensor exclusions remain active until explicit manual choice and current reviewed acknowledgement', () => {
  const conflict = read('SAR imagery; no SAR.'); assert.equal(conflict.route.kind, 'REVIEW');
  assert.ok(!ids(conflict).includes('river-fine'));
  const chosen = interpretNeed({ text: conflict.originalText, generation: 1, dictionary: dictionary(), manual: setManualChoice([], 'sensor', 'SAR', 'Reviewed sensor: SAR') });
  assert.equal(chosen.route.kind, 'REVIEW'); assert.ok(!ids(chosen).includes('river-fine'));
  const reviewed = acknowledgeReviewedFilters(chosen, dictionary()); assert.equal(reviewed.route.kind, 'EO'); assert.ok(ids(reviewed).includes('river-fine'));
  assert.equal(reviewed.exclusions[0]!.active, false); assert.ok(reviewed.exclusions[0]!.phrase.includes('no SAR'));
});
test('invalid explicit numeric requirements cannot become unknown through acknowledgement alone', () => {
  for (const [text, field] of [['SAR resolution 0 m.', 'maxResolutionM'], ['SAR resolution -5 m.', 'maxResolutionM'], ['SAR resolution NaN m.', 'maxResolutionM'], ['SAR Infinity m resolution.', 'maxResolutionM'], ['SAR max cloud -1 percent.', 'cloudCover'], ['SAR revisit 0 hours.', 'revisitHours'], ['SAR revisit -2 days.', 'revisitHours']] as const) {
    const value = read(text); assert.ok(value.diagnostics.some(item => item.field === field && item.requiresManual), text);
    assert.equal(acknowledgeReviewedFilters(value, dictionary()).route.kind, 'REVIEW', text);
    const cleared = interpretNeed({ text, generation: 1, dictionary: dictionary(), manual: clearManualChoice([], field, `Explicitly clear invalid ${field}`) });
    assert.equal(acknowledgeReviewedFilters(cleared, dictionary()).route.kind, 'EO', text);
    const corrected = interpretNeed({ text, generation: 1, dictionary: dictionary(), manual: setManualChoice([], field, 5, `Corrected ${field} to 5`) });
    assert.equal(acknowledgeReviewedFilters(corrected, dictionary()).route.kind, 'EO', text);
  }
  assert.equal(acknowledgeReviewedFilters(read('SAR resolution 10.'), dictionary()).route.kind, 'EO', 'a unitless unresolved requirement may remain explicitly reviewed unknown');
});
test('known mismatches are excluded, unknown requested evidence is caveated, strict changes actual membership', () => {
  const value = read('SAR imagery at maximum resolution 10 m.');
  assert.deepEqual(ids(value), ['river-fine', 'river-country', 'river-unknown']);
  const loose = matchEvidence(evidence(), value.effective, value.exclusions);
  assert.ok(loose.excluded.find(item => item.item.id === 'river-coarse')?.reasons.some(reason => reason.includes('maximum 10 m')));
  assert.ok(loose.matches.find(item => item.item.id === 'river-unknown')?.unknowns.some(reason => reason.includes('sensor')));
  const strict = matchEvidence(evidence(), { ...value.effective, documentedOnly: true }); assert.deepEqual(strict.matches.map(row => row.item.id), ['river-fine', 'river-country']);
  const country = matchEvidence(evidence(), { ...value.effective, ownerCountry: 'IE', documentedOnly: true }); assert.deepEqual(country.matches.map(row => row.item.id), ['river-fine']);
  assert.equal(matchEvidence([{ ...evidence()[0]!, sensors: ['RADAR'] }], value.effective).matches.length, 0);
});
test('explicit text/operator constraints use word boundaries and real numeric identities without synthetic identifier inventions', () => {
  const base = emptyDiscoveryValues();
  assert.deepEqual(matchEvidence(evidence(), { ...base, keyword: 'Mar' }).matches.map(row => row.item.id).sort(), ['river-coarse', 'river-fine', 'river-optical']);
  assert.equal(matchEvidence(evidence(), { ...base, keyword: 'arsh' }).matches.length, 0);
  assert.equal(matchEvidence(evidence(), { ...base, operator: 'Coast' }).matches.length, 0);
  assert.equal(matchEvidence(evidence(), { ...base, operator: 'Coastal Demo Agency' }).matches.length, 2);
  assert.equal(matchEvidence(evidence(), { ...base, keyword: '123' }).matches.length, 0);
  const real = { ...evidence()[0]!, id: 'isolated-numeric', noradId: 123 };
  assert.equal(matchEvidence([real], { ...base, keyword: '123' }).matches.length, 1); assert.equal(matchEvidence([real], { ...base, keyword: '12' }).matches.length, 0);
  assert.equal(read(`SAR imagery; keyword: ${'x'.repeat(200)}.`).effective.keyword?.length, 200);
  const text = `SAR imagery; name: ${'x'.repeat(201)}.`; const overlong = read(text);
  assert.equal(overlong.originalText, text); assert.equal(overlong.effective.keyword, null); assert.ok(overlong.diagnostics.some(item => item.field === 'keyword' && item.phrase.includes('x'.repeat(201))));
  const snapshot = read('SAR imagery.');
  assert.ok(validateDiscoverySnapshot({ ...snapshot, manual: setManualChoice([], 'keyword', 'x'.repeat(200), 'Manual keyword') }, snapshot.originalText, dictionary()).value);
  assert.ok(validateDiscoverySnapshot({ ...snapshot, manual: setManualChoice([], 'keyword', 'x'.repeat(201), 'Overlong keyword') }, snapshot.originalText, dictionary()).fieldErrors.discovery);
});
test('rank order uses available evidence, public services first and stable internal tie; absent facts remain absent', () => {
  const a = { ...evidence()[0]!, id: 'a-same' }, z = { ...a, id: 'z-same' };
  const service = { ...a, id: 'service-sample', type: 'service' as const };
  assert.deepEqual(matchEvidence([z, a, service], emptyDiscoveryValues()).matches.map(row => row.item.id), ['service-sample', 'a-same', 'z-same']);
  const ended = { ...a, id: 'ended', status: 'ended' as const }, operational = { ...a, id: 'operational', status: 'operational' as const };
  assert.deepEqual(matchEvidence([ended, z, operational], emptyDiscoveryValues()).matches.map(row => row.item.id), ['operational', 'z-same', 'ended']);
  assert.equal(Object.hasOwn(a, 'noradId'), false); assert.equal(a.launchDate, null);
});
test('saved snapshot is recomputed from real purpose/dictionary and must agree with actual effective brief requirements', () => {
  const value = read('SAR imagery at 5 m resolution.'); const before = structuredClone(value);
  const forged = { ...value, effective: { ...value.effective, maxResolutionM: 99 }, facts: [], route: { kind: 'EO', reason: 'claimed' } };
  const checked = validateDiscoverySnapshot(forged, value.originalText, dictionary(), core(value)); assert.equal(checked.value?.effective.maxResolutionM, 5); assert.ok(checked.value!.facts.length); assert.deepEqual(value, before);
  assert.ok(validateDiscoverySnapshot(value, 'Different purpose.', dictionary()).fieldErrors.discovery);
  assert.ok(validateDiscoverySnapshot(value, value.originalText, dictionary(), { ...core(value), maxResolutionM: 99 }).fieldErrors.discovery);
  assert.ok(validateDiscoverySnapshot({ ...value, manual: [{ field: 'sensor', action: 'SET', value: 'unbounded', label: 'forged' }] }, value.originalText, dictionary()).fieldErrors.discovery);
  assert.ok(validateDiscoverySnapshot(read('SAR only and thermal only.'), 'SAR only and thermal only.', dictionary()).fieldErrors.discovery);
  const manual = [{ field: 'maxResolutionM', action: 'SET', value: 5, label: 'Custom resolution 5', canSelectOffers: true }, { field: 'keyword', action: 'CLEAR', label: 'Removed keyword', value: { inventedCapability: true } }];
  const sanitized = validateDiscoverySnapshot({ ...value, manual }, value.originalText, dictionary()).value!;
  assert.ok(sanitized); assert.equal(Object.hasOwn(sanitized.manual[0]!, 'canSelectOffers'), false); assert.equal(Object.hasOwn(sanitized.manual[1]!, 'value'), false);
  const timed = interpretNeed({ text: 'SAR imagery.', generation: 1, dictionary: dictionary(), manual: [{ field: 'window', action: 'SET', label: 'Chosen window', value: { startUtc: '2026-11-03T10:00+01:00', endUtc: '2026-11-03T12:00+01:00', authority: true } as unknown as { startUtc: string; endUtc: string } }] });
  assert.deepEqual(timed.manual[0]!.value, { startUtc: '2026-11-03T09:00:00.000Z', endUtc: '2026-11-03T11:00:00.000Z' });
});
