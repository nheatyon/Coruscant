import { Temporal } from '@js-temporal/polyfill';
import { DISCOVERY_RULES_VERSION, type DiscoveryBriefRequirements, type DiscoveryDiagnostic, type DiscoveryDictionary, type DiscoveryEvidence, type DiscoveryExclusion, type DiscoveryFact, type DiscoveryField, type DiscoveryInterpretation, type DiscoveryOutput, type DiscoverySensor, type DiscoveryValue, type DiscoveryValues, type EvidenceMatches, type InterpretNeedInput, type ManualChoice, type SourceSpan } from './discovery-contracts.js';
export * from './discovery-contracts.js';

export function emptyDiscoveryValues(): DiscoveryValues {
  return { family: null, sensor: null, maxResolutionM: null, outputs: null, keyword: null, operator: null, ownerCountry: null, place: null, cloudCover: null, revisitHours: null, timezone: null, window: null, deadline: null, delivery: null, documentedOnly: false };
}
// Recognition is bounded English; each substitution preserves source UTF-16 offsets.
const normalized = (text: string) => text.replace(/[A-Z]/g, character => character.toLowerCase()).replace(/[‐‑‒–—]/g, '-').replace(/(?<=[a-z])-(?=[a-z])/g, ' ');
const canonical = (text: string) => normalized(text).replace(/[\s-]+/g, ' ').trim();
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const valueKey = (value: unknown) => JSON.stringify(value);
export function makeDiscoveryDictionary(items: readonly DiscoveryEvidence[]): DiscoveryDictionary {
  const operators = unique(items.flatMap(item => item.operator ? [item.operator] : [])).sort().map(value => ({ value, label: value, aliases: [value, ...items.filter(item => item.operator === value).flatMap(item => item.operatorCode ? [item.operatorCode] : [])] }));
  const names: Record<string, string> = { IE: 'Ireland', CA: 'Canada' };
  const countries = unique(items.flatMap(item => item.ownerCountry ? [item.ownerCountry] : [])).sort().map(value => ({ value, label: names[value] ?? value, aliases: unique([value, names[value] ?? value]) }));
  return { operators, countries, places: [{ value: 'Shannon estuary', label: 'Shannon estuary', aliases: ['Shannon estuary', 'the Shannon estuary'] }] };
}
export function setManualChoice(manual: readonly ManualChoice[], field: DiscoveryField, value: DiscoveryValue, label: string): ManualChoice[] {
  return [...manual.filter(choice => choice.field !== field), { field, action: 'SET', value: structuredClone(value), label }];
}
export function clearManualChoice(manual: readonly ManualChoice[], field: DiscoveryField, label: string): ManualChoice[] {
  return [...manual.filter(choice => choice.field !== field), { field, action: 'CLEAR', label }];
}
function canonicalManual(choice: ManualChoice): ManualChoice {
  const base = { field: choice.field, action: choice.action, label: choice.label };
  if (choice.action === 'CLEAR') return base;
  let value = choice.value;
  if (choice.field === 'window' && value && typeof value === 'object' && !Array.isArray(value) && 'startUtc' in value && 'endUtc' in value && validInstant(String(value.startUtc)) && validInstant(String(value.endUtc))) value = { startUtc: Temporal.Instant.from(String(value.startUtc)).toString({ smallestUnit: 'millisecond' }), endUtc: Temporal.Instant.from(String(value.endUtc)).toString({ smallestUnit: 'millisecond' }) };
  else if (choice.field === 'deadline' && typeof value === 'string' && validInstant(value)) value = Temporal.Instant.from(value).toString({ smallestUnit: 'millisecond' });
  return { ...base, value: structuredClone(value) };
}
function allowedValue(field: DiscoveryField, value: unknown): boolean {
  if (field === 'documentedOnly') return typeof value === 'boolean';
  if (value === null) return true;
  if (field === 'family') return ['EO', 'SPACE', 'COMMUNICATIONS', 'SERVICING'].includes(String(value));
  if (field === 'sensor') return ['OPEN', 'SAR', 'VISIBLE', 'SWIR', 'THERMAL'].includes(String(value));
  if (field === 'outputs') return Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every(item => ['Imagery', 'Video', 'GIS'].includes(item)) && unique(value).length === value.length;
  if (['maxResolutionM', 'cloudCover', 'revisitHours'].includes(field)) return typeof value === 'number' && Number.isFinite(value) && (field === 'cloudCover' ? value >= 0 && value <= 100 : value > 0);
  if (field === 'window') return !!value && typeof value === 'object' && 'startUtc' in value && 'endUtc' in value && validInstant(String(value.startUtc)) && validInstant(String(value.endUtc)) && Temporal.Instant.compare(String(value.startUtc), String(value.endUtc)) < 0;
  if (field === 'deadline') return typeof value === 'string' && validInstant(value);
  if (field === 'timezone') return typeof value === 'string' && validZone(value);
  if (field === 'keyword') return typeof value === 'string' && value.length <= 200;
  return typeof value === 'string' && value.length <= 4000;
}
function validInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return false;
  try { Temporal.Instant.from(value); return true; } catch { return false; }
}
function validZone(value: string): boolean {
  if (!(value === 'UTC' || /^[A-Za-z][A-Za-z0-9_+\-/]+\/[A-Za-z0-9_+\-/]+$/.test(value))) return false;
  try { Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(value); return true; } catch { return false; }
}
function signature(value: unknown): string {
  // A deterministic review binding, never an authentication token or a security hash.
  let hash = 2166136261;
  for (const character of JSON.stringify(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `${DISCOVERY_RULES_VERSION}:${(hash >>> 0).toString(16)}`;
}

export function interpretNeed(input: InterpretNeedInput): DiscoveryInterpretation {
  const text = input.text, source = normalized(text), generation = input.generation;
  const dictionary = input.dictionary ?? makeDiscoveryDictionary([]), facts: DiscoveryFact[] = [], exclusions: DiscoveryExclusion[] = [], diagnostics: DiscoveryDiagnostic[] = [];
  const manual = (input.manual ?? []).map(canonicalManual);
  const span = (start: number, end: number): SourceSpan => ({ start, end });
  const diagnostic = (field: DiscoveryField | 'description', start: number, end: number, reason: string, severity: 'unresolved' | 'conflict' = 'unresolved', requiresManual = false) => {
    const item: DiscoveryDiagnostic = { id: `${field}:${start}:${end}:${reason}`, field, phrase: text.slice(start, end), span: span(start, end), reason, severity, ...(requiresManual ? { requiresManual: true } : {}) };
    if (!diagnostics.some(existing => existing.id === item.id)) diagnostics.push(item);
  };
  const add = (field: DiscoveryField, value: DiscoveryValue, start: number, end: number, ruleId: string, origin: 'stated' | 'inferred' = 'stated') => facts.push({ field, value, phrase: text.slice(start, end), span: span(start, end), origin, ruleId, generation });
  const clausePrefix = (start: number) => source.slice(0, start).split(/[;.!?\n,]/).at(-1) ?? '';
  const modifier = (start: number): 'negative' | 'uncertain' | 'positive' => {
    const prefix = clausePrefix(start);
    if (/\b(?:maybe|perhaps|possibly|uncertain|not\s+only|not\s+without|no\s+not|not\s+not|no\s+no|without\s+not)\b/.test(prefix)) return 'uncertain';
    return /\b(?:no|not|without|exclud(?:e|ing))\b(?:(?!\b(?:but|rather|instead)\b).)*$/.test(prefix) ? 'negative' : 'positive';
  };
  const term = (field: 'sensor' | 'family' | 'outputs', value: string, match: RegExpMatchArray, ruleId: string) => {
    const start = match.index!, end = start + match[0].length, mod = /^\s+(?:maybe|perhaps|possibly)\b/.test(source.slice(end)) ? 'uncertain' : modifier(start);
    if (mod === 'uncertain') { diagnostic(field, start, end, 'The modifier or negation scope needs manual review.'); return; }
    if (field === 'sensor' && mod === 'negative' && /\b(?:sar|optical|visible|thermal|swir|radar)\b/.test(clausePrefix(start)) && !/\b(?:and|or)\s*$/.test(clausePrefix(start))) { diagnostic(field, start, end, 'The coordinated negation scope is unclear; review the sensor choices manually.'); return; }
    if (mod === 'negative') exclusions.push({ field, value, phrase: text.slice(Math.max(0, start - clausePrefix(start).length), end), span: span(Math.max(0, start - clausePrefix(start).length), end), origin: 'stated', ruleId: `${ruleId}.excluded`, generation });
    else add(field, field === 'outputs' ? [value as DiscoveryOutput] : value, start, end, ruleId);
  };
  if (!text.trim() || text.length > 4000 || !Number.isSafeInteger(generation) || generation < 1) diagnostic('description', 0, text.length, 'Use a mission description of 1–4000 characters and a current generation.');
  const sensorPatterns: [DiscoverySensor, RegExp][] = [
    ['SAR', /\b(?:synthetic\s+aperture\s+radar|sar)\b/gi], ['VISIBLE', /\b(?:optical|visible)\b/gi],
    ['SWIR', /\b(?:swir|short[\s-]*wave\s+infrared)\b/gi], ['THERMAL', /\bthermal(?:\s+infrared)?\b/gi],
  ];
  const explicitNonEOContext = /\b(?:communications?|broadband|connectivity|space\s+observation|astronomy|docker\s+doctor|in[\s-]+orbit\s+servicing|repair|refit|readjustment)\b/.test(source);
  for (const [sensor, pattern] of sensorPatterns) for (const match of source.matchAll(pattern)) {
    const suffix = source.slice(match.index! + match[0].length);
    if (explicitNonEOContext && /^\s+(?:satellite|spacecraft|payload|instrument)\b(?!\s+(?:imagery|images|observations|imaging)\b)/.test(suffix)) {
      const object = /^\s+(?:satellite|spacecraft|payload|instrument)\b/.exec(suffix)!;
      diagnostic('sensor', match.index!, match.index! + match[0].length + object[0].length, 'Customer-object context retained; its sensor does not choose the requested service family.');
      continue;
    }
    term('sensor', sensor, match, `sensor.${sensor.toLowerCase()}`);
  }
  for (const match of source.matchAll(/\bradar\b/gi)) {
    if (!facts.some(fact => fact.field === 'sensor' && fact.span && fact.span.start <= match.index! && fact.span.end >= match.index! + match[0].length) && !exclusions.some(fact => fact.field === 'sensor' && fact.span && fact.span.start <= match.index! && fact.span.end >= match.index! + match[0].length)) diagnostic('sensor', match.index!, match.index! + match[0].length, 'Generic radar does not establish synthetic aperture radar.');
  }
  const familyPatterns: [string, RegExp][] = [
    ['EO', /\b(?:earth\s+observation|eo|imagery\s+of\s+(?:earth|a\s+port|a\s+place))\b/gi],
    ['COMMUNICATIONS', /\b(?:communications?|broadband|connectivity|communications[\s-]+capacity)\b/gi],
    ['SPACE', /\b(?:space\s+observation|astronomy|space[\s-]+object\s+observation)\b/gi],
    ['SERVICING', /\b(?:docker\s+doctor|in[\s-]+orbit\s+servicing|repair|refit|readjustment)\b/gi],
  ];
  for (const [family, pattern] of familyPatterns) for (const match of source.matchAll(pattern)) {
    if (family === 'SERVICING' && /^\s+(?:engineer|technician|specialist|department)\b/.test(source.slice(match.index! + match[0].length))) continue;
    term('family', family, match, `family.${family.toLowerCase()}`);
  }
  if (!facts.some(fact => fact.field === 'family' && fact.value === 'SERVICING')) for (const match of source.matchAll(/\b(?:inspection|inspect)\b/gi)) diagnostic('family', match.index!, match.index! + match[0].length, 'Inspection wording alone does not choose an operational service family.');
  for (const match of source.matchAll(/\b(?:imagery|images|video|gis\s+layers)\b/gi)) {
    const value: DiscoveryOutput = match[0] === 'video' ? 'Video' : match[0].startsWith('gis') ? 'GIS' : 'Imagery';
    if (value === 'Video' && /^\s+(?:call|conference|tutorial)\b/.test(source.slice(match.index! + match[0].length))) continue;
    if (/^\s+(?:analyst|specialist|engineer|technician|professional)\b/.test(source.slice(match.index! + match[0].length))) continue;
    // A negated sensor phrase does not exclude the entire imagery output.
    const prior = source.slice(Math.max(0, match.index! - 35), match.index!);
    if (value === 'Imagery' && /\b(?:optical|visible|sar|radar|thermal|infrared)\s*$/.test(prior) && modifier(match.index!) === 'negative') continue;
    term('outputs', value, match, `output.${value.toLowerCase()}`);
  }
  if (facts.some(fact => fact.field === 'sensor') && !facts.some(fact => fact.field === 'family' && fact.value === 'EO')) {
    const sensor = facts.find(fact => fact.field === 'sensor')!; add('family', 'EO', sensor.span!.start, sensor.span!.end, 'family.sensor-context');
  }
  const resolutionSpans: SourceSpan[] = [];
  for (const match of source.matchAll(/\b(?:no\s+resolution\s+limit|any\s+(?:ground\s+)?resolution)\b/gi)) { add('maxResolutionM', null, match.index!, match.index! + match[0].length, 'resolution.explicit-clear'); resolutionSpans.push(span(match.index!, match.index! + match[0].length)); }
  const number = '[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
  const unit = '(?:kilomet(?:er|re)s?|centimet(?:er|re)s?|met(?:er|re)s?|km|cm|m)';
  for (const match of source.matchAll(new RegExp(`\\b(?:ground\\s+)?resolution\\s*[:=]?\\s*(?:nan|[+-]?infinity)(?:\\s*${unit})?\\b|(?:nan|[+-]?infinity)\\s*${unit}\\s+(?:ground\\s+)?resolution\\b`, 'gi'))) {
    const start = match.index!, end = start + match[0].length; resolutionSpans.push(span(start, end));
    diagnostic('maxResolutionM', start, end, 'Ground resolution must be positive and finite.', 'unresolved', true);
  }
  const ranges = [new RegExp(`(?<![\\w.])${number}\\s*(?:${unit}\\s*)?(?:-|\\bto\\b)\\s*${number}\\s*${unit}\\s+(?:ground\\s+)?resolution\\b`, 'gi'),
    new RegExp(`\\b(?:ground\\s+)?resolution\\s*(?:[:=]|of|between)?\\s*${number}\\s*(?:${unit}\\s*)?(?:-|\\bto\\b|\\band\\b)\\s*${number}\\s*(?:${unit})?\\b`, 'gi')];
  for (const pattern of ranges) for (const match of source.matchAll(pattern)) {
    const start = match.index!, end = start + match[0].length; resolutionSpans.push(span(start, end));
    diagnostic('maxResolutionM', start, end, 'A resolution range is not a supported maximum bound; review and choose a maximum explicitly.');
  }
  const resPatterns = [new RegExp(`\\b(?:(?:max(?:imum)?|at\\s+most|no\\s+worse\\s+than|no\\s+more\\s+than)\\s+)?(?:ground\\s+)?resolution\\s*(?:[:=]|of|at\\s+most|up\\s+to|no\\s+worse\\s+than|no\\s+more\\s+than)?\\s*(${number})\\s*(${unit})\\b`, 'gi'),
    new RegExp(`(?<![\\w.])(?:(?:max(?:imum)?|at\\s+most|no\\s+worse\\s+than|no\\s+more\\s+than)\\s+)?(${number})\\s*(${unit})\\s+(?:ground\\s+)?resolution\\b`, 'gi')];
  for (const pattern of resPatterns) for (const match of source.matchAll(pattern)) {
    const start = match.index!, end = start + match[0].length;
    if (resolutionSpans.some(part => part.start < end && part.end > start)) continue;
    resolutionSpans.push(span(start, end));
    const prefix = source.slice(Math.max(0, start - 35), start), raw = Number(match[1]), u = match[2]!;
    if (/\b(?:radius|altitude|swath|object\s+size)\s*[:=]?\s*$/.test(prefix)) { diagnostic('maxResolutionM', start, end, 'This geometry measurement is not a ground-resolution requirement.'); continue; }
    if (/\b(?:minimum|at\s+least|better\s+than|between)\s*$/.test(prefix) || modifier(start) !== 'positive') { diagnostic('maxResolutionM', start, end, 'Only an unambiguous maximum ground-resolution bound is supported.'); continue; }
    const value = raw * (/^(?:cm|centim)/.test(u) ? 0.01 : /^(?:km|kilom)/.test(u) ? 1000 : 1);
    if (!Number.isFinite(value) || value <= 0) diagnostic('maxResolutionM', start, end, 'Ground resolution must be positive and finite.', 'unresolved', true);
    else add('maxResolutionM', value, start, end, 'resolution.maximum-metres');
  }
  for (const match of source.matchAll(/\b(?:ground\s+)?resolution\b/gi)) if (!resolutionSpans.some(part => part.start <= match.index! && part.end >= match.index! + match[0].length)) diagnostic('maxResolutionM', match.index!, Math.min(text.length, match.index! + 65), 'Resolution is unitless, partial, ranged or uses unsupported wording; enter a maximum manually.');
  for (const match of source.matchAll(new RegExp(`\\b(?:radius|altitude|swath|object\\s+size)\\s*[:=]?\\s*${number}\\s*${unit}\\b`, 'gi'))) diagnostic('place', match.index!, match.index! + match[0].length, 'Geometry context retained; this does not choose coordinates or set ground resolution.');
  for (const match of source.matchAll(/\b(?:cloud\s+cover|max(?:imum)?\s+cloud(?:\s+cover)?|at\s+most\s+cloud)\s*[:=]?\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:%|percent\b)/gi)) {
    const value = Number(match[1]), start = match.index!, end = start + match[0].length;
    if (modifier(start) !== 'positive' || value < 0 || value > 100) diagnostic('cloudCover', start, end, 'Cloud cover needs an unambiguous maximum from 0 to 100 percent.', 'unresolved', value < 0 || value > 100); else add('cloudCover', value, start, end, 'cloud.maximum-percent');
  }
  for (const match of source.matchAll(/\b(?:revisit(?:\s+(?:every|interval))?|every)\s*[:=]?\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*(hours?|hrs?|h|days?|d)\b|\b(daily|weekly)\b/gi)) {
    const start = match.index!, end = start + match[0].length, value = match[3] ? match[3] === 'daily' ? 24 : 168 : Number(match[1]) * (/^d/.test(match[2]!) ? 24 : 1);
    if (modifier(start) !== 'positive' || value <= 0 || !Number.isFinite(value)) diagnostic('revisitHours', start, end, 'Revisit interval needs a positive unambiguous value in hours or days.', 'unresolved', value <= 0 || !Number.isFinite(value)); else add('revisitHours', value, start, end, 'revisit.hours');
  }
  for (const [field, pattern] of [['cloudCover', /\b(?:cloud\s+cover|max(?:imum)?\s+cloud)[^;\n.!?]*/gi], ['revisitHours', /\brevisit[^;\n.!?]*/gi]] as const) for (const match of source.matchAll(pattern)) {
    if (!facts.some(fact => fact.field === field && fact.span && fact.span.start <= match.index! && fact.span.end > match.index!) && !diagnostics.some(item => item.field === field && item.span && item.span.start <= match.index! && item.span.end > match.index!)) diagnostic(field, match.index!, match.index! + match[0].length, 'The unsupported requirement fragment is retained for manual review.');
  }
  const labeled = /\b(operator\s*:|operated\s+by\s+|owner\s+country\s*:|owned\s+by\s+|keyword\s*:|name\s*:|place\s*:|target\s*:|delivery\s*:|deliverables?\s*:)([^;\n.!?]+)/gi;
  for (const match of source.matchAll(labeled)) {
    const label = canonical(match[1]!), start = match.index!, end = start + match[0].length, raw = text.slice(start + match[1]!.length, end).trim().replace(/[,.]+$/, '');
    const field: DiscoveryField = label.startsWith('operator') || label.startsWith('operated') ? 'operator' : label.startsWith('owner') || label.startsWith('owned') ? 'ownerCountry' : label.startsWith('keyword') || label.startsWith('name') ? 'keyword' : label.startsWith('delivery') ? 'delivery' : label.startsWith('deliverable') ? 'outputs' : 'place';
    if (field === 'operator' || field === 'ownerCountry' || field === 'place') {
      const entries = field === 'operator' ? dictionary.operators : field === 'ownerCountry' ? dictionary.countries : dictionary.places;
      const found = entries.find(entry => entry.aliases.some(alias => canonical(alias) === canonical(raw)));
      if (found) add(field, found.value, start, end, `dictionary.${field}`); else diagnostic(field, start, end, `The stated ${field === 'ownerCountry' ? 'owner country' : field} is not resolved in the public evidence dictionary.`);
    } else if (field === 'keyword') { if (raw.length > 200) diagnostic(field, start, end, 'The explicit keyword exceeds 200 characters; retain the source and enter a shorter keyword manually.'); else if (raw) add(field, raw, start, end, 'keyword.explicit'); }
    else if (field === 'delivery') diagnostic(field, start, end, 'Delivery wording is retained for manual review; no deadline or collection is invented.');
  }
  for (const place of dictionary.places) for (const alias of place.aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const match of source.matchAll(new RegExp(`\\b(?:over|near)\\s+(${escaped})\\b`, 'gi'))) add('place', place.value, match.index!, match.index! + match[0].length, 'place.label-only');
  }
  const instant = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:\\d{2})';
  const temporalSpans: SourceSpan[] = [];
  for (const match of text.matchAll(new RegExp(`\\bwindow\\s*:\\s*(${instant})\\s+to\\s+(${instant})`, 'gi'))) {
    const start = match.index!, end = start + match[0].length; temporalSpans.push(span(start, end));
    if (!validInstant(match[1]!) || !validInstant(match[2]!) || Temporal.Instant.compare(match[1]!, match[2]!) >= 0) diagnostic('window', start, end, 'The complete explicit window must contain valid ordered instants with offsets.');
    else add('window', { startUtc: Temporal.Instant.from(match[1]!).toString({ smallestUnit: 'millisecond' }), endUtc: Temporal.Instant.from(match[2]!).toString({ smallestUnit: 'millisecond' }) }, start, end, 'timing.explicit-window');
  }
  for (const match of text.matchAll(new RegExp(`\\bdeadline\\s*:\\s*(${instant})`, 'gi'))) {
    const start = match.index!, end = start + match[0].length; temporalSpans.push(span(start, end));
    if (validInstant(match[1]!)) add('deadline', Temporal.Instant.from(match[1]!).toString({ smallestUnit: 'millisecond' }), start, end, 'timing.explicit-deadline'); else diagnostic('deadline', start, end, 'The deadline is not a valid explicit instant.');
  }
  for (const match of text.matchAll(/\btimezone\s*:\s*([A-Za-z_+\-/]+)/gi)) { const start = match.index!, end = start + match[0].length; if (validZone(match[1]!)) add('timezone', match[1]!, start, end, 'timing.explicit-zone'); else diagnostic('timezone', start, end, 'Enter a valid named IANA timezone.'); }
  for (const match of source.matchAll(/\b(?:window\s*:|deadline\s*:|before|after|last\s+week|next\s+\w+|from\s+next|deliver(?:y|ed)?\s+(?:by|within|in))[^;\n.!?]*/gi)) {
    if (!temporalSpans.some(part => part.start <= match.index! && part.end >= match.index! + match[0].length)) diagnostic(match[0].startsWith('deadline') ? 'deadline' : 'window', match.index!, match.index! + match[0].length, 'Timing fragment retained verbatim; comparison dates and missing instants remain manual.');
  }
  const positiveFamilies = unique(facts.filter(fact => fact.field === 'family' && fact.origin === 'stated').map(fact => String(fact.value)));
  const explicitSensors = facts.filter(fact => fact.field === 'sensor');
  const water = /\b(?:flood(?:ing)?|surface[\s-]+water)\b/.exec(source);
  const compatibleWater = !!water && (/\bflood(?:ing)?\b/.test(source) || /\b(?:expan(?:sion|d)|compar(?:e|ison)|chang(?:e|es)|before|after)\b/.test(source));
  const nonEO = positiveFamilies.filter(family => family !== 'EO');
  const forbidsSAR = exclusions.some(item => item.field === 'sensor' && item.value === 'SAR');
  const sensorAmbiguity = diagnostics.some(item => item.field === 'sensor');
  const manualSensor = manual.find(choice => choice.field === 'sensor');
  const incompatibleManualSensor = manualSensor?.action === 'SET' && !['SAR', 'OPEN', null].includes(manualSensor.value as string | null);
  if (compatibleWater && !nonEO.length && !forbidsSAR && !sensorAmbiguity && !incompatibleManualSensor && !explicitSensors.some(fact => fact.value !== 'SAR')) {
    const start = water!.index, end = start + water![0].length;
    if (!facts.some(fact => fact.field === 'family')) add('family', 'EO', start, end, 'goal.water-comparison', 'inferred');
    if (!explicitSensors.length) add('sensor', 'SAR', start, end, 'goal.water-comparison', 'inferred');
    if (!facts.some(fact => fact.field === 'maxResolutionM') && !diagnostics.some(item => item.field === 'maxResolutionM')) add('maxResolutionM', 10, start, end, 'goal.water-comparison', 'inferred');
  }
  const effective = emptyDiscoveryValues();
  const fields = Object.keys(effective) as DiscoveryField[];
  for (const field of fields) {
    const candidates = facts.filter(fact => fact.field === field), stated = candidates.filter(fact => fact.origin === 'stated'), chosen = stated.length ? stated : candidates;
    const distinct = unique(chosen.map(fact => valueKey(fact.value)));
    if (distinct.length > 1 && field !== 'outputs') diagnostic(field, chosen[0]!.span!.start, chosen.at(-1)!.span!.end, `Conflicting stated ${field} requirements need an explicit reviewed choice.`, 'conflict');
    if (chosen.length) (effective as unknown as Record<string, DiscoveryValue>)[field] = field === 'outputs' ? unique(chosen.flatMap(fact => Array.isArray(fact.value) ? fact.value : [fact.value])) as DiscoveryOutput[] : distinct.length === 1 ? chosen[0]!.value : null;
  }
  for (const exclusion of exclusions) if (facts.some(fact => fact.field === exclusion.field && (Array.isArray(fact.value) ? fact.value.some(value => value === exclusion.value) : fact.value === exclusion.value))) diagnostic(exclusion.field, exclusion.span!.start, exclusion.span!.end, 'A stated requirement is also explicitly excluded.', 'conflict');
  for (const choice of manual) {
    if (!fields.includes(choice.field) || !['SET', 'CLEAR'].includes(choice.action) || choice.action === 'SET' && !allowedValue(choice.field, choice.value)) { diagnostic('description', 0, text.length, 'A manual criterion is invalid.'); continue; }
    const value = choice.action === 'CLEAR' ? choice.field === 'documentedOnly' ? false : null : choice.value!;
    const stated = facts.filter(fact => fact.field === choice.field && fact.origin === 'stated');
    if (stated.some(fact => valueKey(fact.value) !== valueKey(value)) && choice.action !== 'CLEAR') diagnostic(choice.field, 0, text.length, 'The retained manual choice differs from the new stated requirement; review both.', 'conflict');
    if (choice.action === 'SET' && exclusions.some(exclusion => exclusion.field === choice.field && (Array.isArray(value) ? value.some(item => item === exclusion.value) : value === exclusion.value))) diagnostic(choice.field, 0, text.length, 'The manual choice opposes an explicit exclusion; review both before using it.', 'conflict');
    (effective as unknown as Record<string, DiscoveryValue>)[choice.field] = structuredClone(value);
    facts.push({ field: choice.field, value, phrase: choice.label, span: null, origin: 'manual', ruleId: `manual.${choice.action.toLowerCase()}`, generation });
  }
  const reviewSignature = signature({ rulesVersion: DISCOVERY_RULES_VERSION, generation, text, manual, effective, exclusions, diagnostics });
  const reviewed = input.reviewedSignature === reviewSignature;
  if (reviewed) for (const exclusion of exclusions) {
    const choice = manual.find(choice => choice.field === exclusion.field && choice.action === 'SET');
    if (choice && (Array.isArray(choice.value) ? choice.value.some(value => value === exclusion.value) : choice.value === exclusion.value)) exclusion.active = false;
  }
  const conflicts = diagnostics.filter(item => item.severity === 'conflict');
  const unresolvedConflict = conflicts.some(item => item.field === 'description' || !manual.some(choice => choice.field === item.field)) || diagnostics.some(item => item.requiresManual && !manual.some(choice => choice.field === item.field && (choice.action === 'CLEAR' || choice.action === 'SET' && typeof choice.value === 'number' && allowedValue(choice.field, choice.value))));
  const solelyPlanned = nonEO.length > 0 && !positiveFamilies.includes('EO') && !explicitSensors.length;
  const unsupported = effective.family !== null && effective.family !== 'EO' || effective.sensor !== null && !['OPEN', 'SAR', 'VISIBLE', 'SWIR', 'THERMAL'].includes(effective.sensor) || !!effective.outputs?.some(output => output !== 'Imagery');
  let route: DiscoveryInterpretation['route'];
  if (solelyPlanned || unsupported && !(conflicts.length && !reviewed)) route = { kind: 'PLANNED', family: (solelyPlanned ? nonEO[0] : effective.family ?? 'EO') as DiscoveryInterpretation['route']['family'], reason: 'Planned — outside this prototype. Return explicitly to supported EO planning; no provider availability is established.' };
  else if (diagnostics.length && (!reviewed || unresolvedConflict) || unsupported || nonEO.length && !reviewed) route = { kind: 'REVIEW', reason: 'Review conflicting fields or unresolved wording, adjust the filters, then use reviewed filters.' };
  else route = { kind: 'EO', family: 'EO', reason: 'Supported EO planning and human review; technical relevance does not establish coverage, availability or collection.' };
  return { rulesVersion: DISCOVERY_RULES_VERSION, generation, originalText: text, manual, ...(input.reviewedSignature ? { reviewedSignature: input.reviewedSignature } : {}), facts, exclusions, diagnostics, effective, route, reviewSignature,
    rationale: [compatibleWater && facts.some(fact => fact.origin === 'inferred') ? 'EO/SAR/maximum 10 m is an editable demonstration heuristic for a flood/surface-water comparison, not a scientific threshold or answerability guarantee.' : 'Explicit requirements and exclusions govern; unknowns remain for human review.', 'Read by local rules', 'Place labels do not choose coordinates, confirm an area, or imply owner country.'] };
}
export function acknowledgeReviewedFilters(value: DiscoveryInterpretation, dictionary?: DiscoveryDictionary): DiscoveryInterpretation {
  return interpretNeed({ text: value.originalText, generation: value.generation, manual: value.manual, dictionary, reviewedSignature: value.reviewSignature });
}

function tokens(text: string): string[] { return canonical(text).match(/[\p{L}\p{N}]+/gu) ?? []; }
function keywordMatch(item: DiscoveryEvidence, keyword: string): boolean {
  const sought = tokens(keyword);
  if (!sought.length) return true;
  if (/^\d+$/.test(keyword.trim())) return item.noradId !== null && item.noradId !== undefined && String(item.noradId) === keyword.trim();
  const haystack = tokens([item.name, item.operator ?? '', item.id, ...(item.aliases ?? [])].join(' '));
  return sought.every(token => haystack.some(word => /^\d+$/.test(token) ? word === token : word.startsWith(token)));
}
function operatorMatch(item: DiscoveryEvidence, operator: string): boolean {
  if (item.operatorCode && canonical(operator) === canonical(item.operatorCode)) return true;
  if (!item.operator) return false;
  const wanted = tokens(operator).join(' '), actual = tokens(item.operator).join(' ');
  return !!wanted && ` ${actual} `.includes(` ${wanted} `);
}
export function matchEvidence<T extends DiscoveryEvidence>(items: readonly T[], criteria: DiscoveryValues, exclusions: readonly DiscoveryExclusion[] = []): EvidenceMatches<T> {
  const matches: EvidenceMatches<T>['matches'] = [], excluded: EvidenceMatches<T>['excluded'] = [];
  for (const item of items) {
    const reasons: string[] = [], unknowns: string[] = [], failures: string[] = []; let documentedCriteria = 0;
    if (criteria.family) {
      if (item.familyDocumented === false) unknowns.push('Requested mission/service family is not independently documented; EO source scope alone is classification.');
      else if (item.family !== criteria.family) failures.push('Documented service family differs from the reviewed family.');
    }
    if (criteria.keyword && !keywordMatch(item, criteria.keyword)) failures.push('The explicit keyword does not match word-start identity/name evidence.');
    if (criteria.operator && !operatorMatch(item, criteria.operator)) failures.push('The requested operator does not match the recorded operator.');
    if (criteria.ownerCountry) {
      if (item.ownerCountry === null) unknowns.push('Requested owner country is not recorded.');
      else if (canonical(item.ownerCountry) !== canonical(criteria.ownerCountry)) failures.push('Recorded owner country differs from the requested ownership criterion.');
      else { reasons.push(`Recorded owner country ${item.ownerCountry} matches.`); documentedCriteria++; }
    }
    if (criteria.sensor && criteria.sensor !== 'OPEN') {
      if (item.sensors === null) unknowns.push('Requested sensor is not recorded.');
      else if (!item.sensors.some(sensor => canonical(sensor) === canonical(criteria.sensor!))) failures.push('The exhaustive documented sensor list does not include the requested sensor.');
      else { reasons.push(`Documented ${criteria.sensor} sensor matches.`); documentedCriteria++; }
    }
    if (criteria.maxResolutionM !== null) {
      const bands = item.bandCapabilities?.filter(capability => !criteria.sensor || criteria.sensor === 'OPEN' || capability.sensor === criteria.sensor);
      if (bands?.length) {
        const qualifying = bands.filter(capability => Number.isFinite(capability.spatialResolutionM) && capability.spatialResolutionM > 0 && capability.spatialResolutionM <= criteria.maxResolutionM!);
        if (!qualifying.length) failures.push(`Documented applicable ${criteria.sensor ?? 'EO'} band spatial resolution does not satisfy maximum ${criteria.maxResolutionM} m; resampled pixels do not improve native resolution.`);
        else { reasons.push(qualifying.map(capability => `${capability.instrument} ${capability.bands.join('/')} nominal ${capability.spatialResolutionM} m native spatial resolution satisfies maximum ${criteria.maxResolutionM} m; mode and imageability remain to be checked.`).join(' ')); documentedCriteria++; }
      } else if (item.resolutionM === null) unknowns.push(item.bandCapabilities?.length ? 'Requested applicable band/mode ground resolution is not recorded.' : 'Requested ground resolution is not recorded.');
      else if (!Number.isFinite(item.resolutionM) || item.resolutionM <= 0 || item.resolutionM > criteria.maxResolutionM) failures.push(`Documented ground resolution does not satisfy maximum ${criteria.maxResolutionM} m.`);
      else { reasons.push(`${item.resolutionM} m satisfies maximum ${criteria.maxResolutionM} m.`); documentedCriteria++; }
    }
    for (const exclusion of exclusions) {
      if (exclusion.active === false) continue;
      if (exclusion.field === 'sensor') {
        if (item.sensors === null) unknowns.push(`Excluded ${exclusion.value} sensor cannot be checked because sensor evidence is missing.`);
        else if (item.sensors.includes(exclusion.value)) failures.push(`The documented sensor is explicitly excluded: ${exclusion.value}.`);
      } else if (exclusion.field === 'family' && item.family === exclusion.value) failures.push(`The service family is explicitly excluded: ${exclusion.value}.`);
    }
    if (criteria.documentedOnly && unknowns.length) failures.push('Documented criteria only excludes this missing requested evidence.');
    if (!reasons.length) reasons.push('Available EO evidence for manual inspection; no coverage or availability is established.');
    if (failures.length) excluded.push({ item, reasons: unique(failures) }); else matches.push({ item, reasons: unique(reasons), unknowns: unique(unknowns), documentedCriteria });
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  matches.sort((a, b) => {
    if (a.item.type !== b.item.type) return a.item.type === 'service' ? -1 : 1;
    if (a.item.type === 'service') return compare(a.item.operator ?? '', b.item.operator ?? '') || compare(a.item.name, b.item.name) || compare(a.item.id, b.item.id);
    const status = { operational: 0, unknown: 1, ended: 2 };
    return b.documentedCriteria - a.documentedCriteria || Number(a.item.status === 'ended') - Number(b.item.status === 'ended') ||
      (criteria.maxResolutionM === null ? 0 : (a.item.resolutionM ?? Infinity) - (b.item.resolutionM ?? Infinity)) ||
      (criteria.keyword ? Number(!canonical(a.item.name).includes(canonical(criteria.keyword))) - Number(!canonical(b.item.name).includes(canonical(criteria.keyword))) : 0) ||
      status[a.item.status] - status[b.item.status] || Number(b.item.commercial === true) - Number(a.item.commercial === true) ||
      compare(b.item.launchDate ?? '', a.item.launchDate ?? '') || (/^norad:\d{1,9}$/.test(a.item.id) && /^norad:\d{1,9}$/.test(b.item.id) ? Number(a.item.id.slice(6))-Number(b.item.id.slice(6)) : compare(a.item.id, b.item.id));
  });
  return { matches, excluded, total: items.length };
}

export function validateDiscoverySnapshot(input: unknown, purpose: string, dictionary: DiscoveryDictionary, brief?: DiscoveryBriefRequirements): { value?: DiscoveryInterpretation; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fieldErrors: { discovery: 'Provide the relevant reviewed public discovery context.' } };
  const row = input as Record<string, unknown>;
  if (row.rulesVersion !== DISCOVERY_RULES_VERSION || row.originalText !== purpose || !Number.isSafeInteger(row.generation) || Number(row.generation) < 1 || purpose.length > 4000) errors.discovery = 'The discovery source, rules version or generation no longer matches this purpose.';
  const fields = Object.keys(emptyDiscoveryValues());
  if (!Array.isArray(row.manual) || row.manual.length > fields.length || row.manual.some(choice => !choice || typeof choice !== 'object' || !fields.includes(choice.field) || !['SET', 'CLEAR'].includes(choice.action) || typeof choice.label !== 'string' || choice.label.length > 4000 || choice.action === 'SET' && !allowedValue(choice.field, choice.value)) || unique(row.manual.map(choice => choice.field)).length !== row.manual.length) errors.discovery = 'Use one valid explicit manual choice or clear per discovery field.';
  if (row.reviewedSignature !== undefined && (typeof row.reviewedSignature !== 'string' || row.reviewedSignature.length > 200)) errors.discovery = 'The reviewed discovery binding is malformed.';
  if (Object.keys(errors).length) return { fieldErrors: errors };
  const value = interpretNeed({ text: purpose, generation: row.generation as number, manual: row.manual as ManualChoice[], dictionary, reviewedSignature: row.reviewedSignature as string | undefined });
  if (value.route.kind !== 'EO') errors.discovery = value.route.reason;
  if (brief) {
    const expected = { family: value.effective.family ?? 'EO', sensor: value.effective.sensor ?? 'OPEN', outputs: value.effective.outputs ?? ['Imagery'], maxResolutionM: value.effective.maxResolutionM, cloudCover: value.effective.cloudCover, revisitHours: value.effective.revisitHours };
    const actual = { ...brief, sensor: brief.sensor.toUpperCase() };
    for (const field of Object.keys(expected) as (keyof typeof expected)[]) if (valueKey(actual[field]) !== valueKey(expected[field])) errors.discovery = 'The effective discovery requirements changed. Review current criteria before saving the same brief.';
    if (value.effective.timezone && brief.timezone !== value.effective.timezone || value.effective.window && valueKey(brief.requestedWindow && { startUtc: brief.requestedWindow.startUtc, endUtc: brief.requestedWindow.endUtc }) !== valueKey(value.effective.window) || value.effective.deadline && brief.deadline?.utc !== value.effective.deadline) errors.discovery = 'The resolved discovery timing differs from the actual reviewed brief timing.';
    for (const field of ['window', 'deadline'] as const) {
      const cleared = value.manual.some(choice => choice.field === field && (choice.action === 'CLEAR' || choice.action === 'SET' && choice.value === null));
      if (cleared && (field === 'window' ? brief.requestedWindow != null : brief.deadline != null)) errors.discovery = 'An explicitly cleared discovery timing field is still present in the reviewed brief.';
    }
  }
  return Object.keys(errors).length ? { fieldErrors: errors } : { value, fieldErrors: {} };
}
