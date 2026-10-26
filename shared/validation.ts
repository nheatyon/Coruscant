import { Temporal } from '@js-temporal/polyfill';
import type { AreaChoice, BriefInput, CatalogContext, NormalizedBrief } from './contracts.js';
import type { DiscoveryDictionary } from './discovery-contracts.js';
import { makeDiscoveryDictionary, validateDiscoverySnapshot } from './discovery.js';
import type { PlaceSourceSnapshot } from './place-contracts.js';

export function createEmptyBrief(): BriefInput {
  return {
    purpose: '', family: 'EO', sensor: 'OPEN', outputs: ['Imagery'],
    latitude: '0', longitude: '0', radiusKm: '25', areaChoice: null, areaConfirmation: null,
    baselineDate: '', recentDate: '', timezone: 'UTC', maxResolution: '', resolutionUnit: 'm',
    cloudCover: '', revisitHours: '', spectralRequirements: '', timingToDiscuss: true,
    windowStart: '', windowEnd: '', deadline: '', timingNotes: '', unknowns: '',
    contact: { name: '', email: '', organization: '' }, selectedEvidence: [], acknowledged: false,
  };
}
export function areaSignature(choice: AreaChoice): string {
  return JSON.stringify([choice.method, choice.generation, choice.latitude, choice.longitude, choice.radiusKm]);
}
export function readCoordinate(value: string, min: number, max: number): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
export function circleReadouts(radiusKm: number): { areaKm2: number; diameterKm: number } {
  const radius = 6371.0088;
  const theta = Math.min(radiusKm / radius, Math.PI);
  return { areaKm2: 4 * Math.PI * radius ** 2 * Math.sin(theta / 2) ** 2, diameterKm: 2 * Math.min(radiusKm, Math.PI * radius / 2) };
}
function plainDate(raw: unknown): boolean {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  try { return Temporal.PlainDate.from(raw, { overflow: 'reject' }).toString() === raw; } catch { return false; }
}
export function zonedInstant(raw: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/.test(raw)) throw new Error('Enter a complete local date and time.');
  return Temporal.PlainDateTime.from(raw, { overflow: 'reject' })
    .toZonedDateTime(timezone, { disambiguation: 'reject' }).toInstant().toString({ smallestUnit: 'millisecond' });
}
export interface BriefValidationOptions {
  requireAcknowledgement?: boolean; discoveryDictionary?: DiscoveryDictionary; preparation?: boolean;
  requireAreaPurposeReview?: boolean;
  resolveAreaSource?: (reference: unknown, area: AreaChoice, purpose: string) => PlaceSourceSnapshot;
}
/** Preparation still validates every supplied fact; it does not fabricate submission contact or timing. */
export function validatePlanningBrief(input: unknown, options: Omit<BriefValidationOptions, 'preparation' | 'requireAcknowledgement'> = {}) {
  return validateBrief(input, { requireAreaPurposeReview: true, ...options, preparation: true, requireAcknowledgement: false });
}
export function observationIntent(brief: Pick<BriefInput, 'observationIntent'>): 'single-observation' | 'comparison' { return brief.observationIntent ?? 'comparison'; }
export function validateBrief(input: unknown, options: BriefValidationOptions = {}): { value?: NormalizedBrief; fieldErrors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fieldErrors: { brief: 'Provide a mission brief.' } };
  const b = input as BriefInput;
  const text = (key: keyof BriefInput, max: number, required = false): string => {
    const raw = b[key];
    if (typeof raw !== 'string') { errors[key] = 'Enter text in this field.'; return ''; }
    if (raw.length > max) errors[key] = `Use at most ${max} characters.`;
    if (required && !raw.trim()) errors[key] = 'This field is required.';
    return raw;
  };
  const purpose = text('purpose', 4000, true);
  if (b.observationIntent !== undefined && !['single-observation','comparison'].includes(b.observationIntent)) errors.observationIntent = 'Choose Single observation or Baseline/Recent comparison.';
  const intent = observationIntent(b);
  if (b.family !== 'EO') errors.family = 'Planned — outside this prototype. Return to Earth-observation planning.';
  const sensor = b.sensor === 'Visible' ? 'VISIBLE' : b.sensor === 'Thermal' ? 'THERMAL' : b.sensor;
  if (!['OPEN','SAR','VISIBLE','SWIR','THERMAL'].includes(sensor)) errors.sensor = 'Choose an Earth-observation sensor; other service families remain Planned.';
  if (!Array.isArray(b.outputs) || b.outputs.length !== 1 || b.outputs[0] !== 'Imagery') errors.outputs = 'Only Imagery planning is supported. Video and GIS remain Planned.';
  const latitude = readCoordinate(b.latitude, -90, 90);
  const longitude = readCoordinate(b.longitude, -180, 180);
  const radiusKm = readCoordinate(b.radiusKm, 0.001, Number.MAX_VALUE);
  if (latitude === null) errors.latitude = 'Enter a latitude from −90 to90; blank is not zero.';
  if (longitude === null) errors.longitude = 'Enter a longitude from −180 to180; blank is not zero.';
  if (radiusKm === null) errors.radiusKm = 'Enter a radius of at least0.001km.';
  const choice = b.areaChoice;
  if (!choice || !['coordinates','globe'].includes(choice.method) || !Number.isSafeInteger(choice.generation) || choice.generation < 1 || choice.latitude !== latitude || choice.longitude !== longitude || choice.radiusKm !== radiusKm) {
    errors.areaChoice = 'Choose your target deliberately with Use these coordinates, then check its size.';
  } else if (typeof b.areaConfirmation !== 'string' || b.areaConfirmation !== areaSignature(choice)) {
    errors.areaConfirmation = 'Confirm that you chose this target and checked the area size.';
  }
  if (options.requireAreaPurposeReview && b.areaReviewedPurpose !== purpose) errors.areaReviewedPurpose = 'Review and keep or apply this area for the current question before saving.';
  let areaSource: PlaceSourceSnapshot | null | undefined;
  if (b.areaSource === null) areaSource = null;
  else if (b.areaSource !== undefined) {
    const source = b.areaSource;
    if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.lookupVersion !== 'string' || typeof source.candidateId !== 'string' || typeof source.sourcePhrase !== 'string' ||
      !['stated','manual'].includes(source.phraseOrigin) || typeof source.questionAtLookup !== 'string' || typeof source.reviewedPurpose !== 'string' || source.reviewedPurpose !== purpose || source.radiusAssumptionKm !== 25) errors.areaSource = 'Review the selected place source for this question.';
    else if (options.resolveAreaSource && choice && !errors.areaChoice) {
      try { areaSource = options.resolveAreaSource(source, choice, purpose); }
      catch { errors.areaSource = 'The exact selected place source could not be verified. Keep your input and review the area source.'; }
    }
  }
  if (intent === 'comparison') {
    if ((!options.preparation || b.baselineDate !== '') && !plainDate(b.baselineDate)) errors.baselineDate = 'Enter a valid Baseline reference date.';
    if ((!options.preparation || b.recentDate !== '') && !plainDate(b.recentDate)) errors.recentDate = 'Enter a valid Recent reference date.';
    if (b.baselineDate && b.recentDate && !errors.baselineDate && !errors.recentDate && b.baselineDate >= b.recentDate) errors.recentDate = 'Recent reference date must be later than Baseline reference date.';
  }
  const timezone = text('timezone', 100, true);
  try {
    if (!(timezone === 'UTC' || /^[A-Za-z][A-Za-z0-9_+\-/]+\/[A-Za-z0-9_+\-/]+$/.test(timezone))) throw new Error();
    Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(timezone);
  } catch { errors.timezone = 'Enter a named IANA timezone such as UTC or Europe/Dublin.'; }
  const numeric = (key: 'maxResolution' | 'cloudCover' | 'revisitHours', zero: boolean, max = Number.MAX_VALUE): number | null => {
    const raw = b[key];
    if (typeof raw !== 'string') { errors[key] = 'Enter a number or leave unknown.'; return null; }
    if (!raw.trim()) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || (zero ? n < 0 : n <= 0) || n > max) { errors[key] = zero ? `Enter a number from0 to${max}.` : 'Enter a positive finite number or leave unknown.'; return null; }
    return n;
  };
  const rawResolution = numeric('maxResolution', false);
  const multipliers = { m: 1, cm: 0.01, km: 1000 };
  if (typeof b.resolutionUnit !== 'string' || !Object.hasOwn(multipliers, b.resolutionUnit)) errors.resolutionUnit = 'Choose m, cm or km.';
  const maxResolutionM = rawResolution === null ? null : rawResolution * (errors.resolutionUnit ? 0 : multipliers[b.resolutionUnit]);
  if (maxResolutionM !== null && (!Number.isFinite(maxResolutionM) || maxResolutionM <= 0)) errors.maxResolution = 'Converted ground resolution must be positive and finite.';
  const cloudCover = numeric('cloudCover', true, 100);
  const revisitHours = numeric('revisitHours', false);
  const spectralRequirements = text('spectralRequirements', 200);
  const timingNotes = text('timingNotes', 4000);
  const unknownText = text('unknowns', 4020);
  const unknowns = unknownText.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (unknowns.length > 20 || unknowns.some(x => x.length > 200)) errors.unknowns = 'Use at most20 lines, each at most200 characters.';
  const contact = b.contact;
  for (const key of ['name', 'email', 'organization'] as const) {
    if (!contact || typeof contact[key] !== 'string' || (!options.preparation && !contact[key].trim())) errors[`contact.${key}`] = 'This contact field is required.';
    else if (contact[key].length > 200) errors[`contact.${key}`] = 'Use at most200 characters.';
  }
  if (contact && typeof contact.email === 'string' && contact.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) errors['contact.email'] = 'Enter an email address. This does not verify the address.';
  if (!Array.isArray(b.selectedEvidence) || b.selectedEvidence.length > 50 || b.selectedEvidence.some(e => !e || typeof e.itemId !== 'string' || e.itemId.length > 200 || typeof e.evidenceVersion !== 'string' || e.evidenceVersion.length > 200)) {
    errors.selectedEvidence = 'Select at most50 catalog evidence records.';
  } else if (new Set(b.selectedEvidence.map(e => e.itemId)).size !== b.selectedEvidence.length) errors.selectedEvidence = 'Each evidence identity can appear only once.';
  let catalogContext: CatalogContext | undefined;
  if (b.catalogContext !== undefined) {
    const context = b.catalogContext;
    if (!context || typeof context !== 'object' || Array.isArray(context)) errors.catalogContext = 'Review the discovery catalog context.';
    else if (context.sourceKind === 'DEMONSTRATION' && Object.keys(context).every(key => key === 'sourceKind')) catalogContext = { sourceKind: 'DEMONSTRATION' };
    else if (context.sourceKind === 'PUBLIC_REAL' && Object.keys(context).every(key => ['sourceKind','snapshotVersion','factVersion'].includes(key)) &&
      ((context.snapshotVersion === null && context.factVersion === null) ||
      (typeof context.snapshotVersion === 'string' && context.snapshotVersion.length > 0 && context.snapshotVersion.length <= 200 && typeof context.factVersion === 'string' && context.factVersion.length > 0 && context.factVersion.length <= 200))) {
      catalogContext = { sourceKind: 'PUBLIC_REAL', snapshotVersion: context.snapshotVersion, factVersion: context.factVersion };
      if (Array.isArray(b.selectedEvidence) && b.selectedEvidence.some(ref => !ref || typeof ref.itemId !== 'string' || !/^norad:[1-9]\d{0,8}$/.test(ref.itemId))) errors.selectedEvidence = 'Review real-catalog selections separately from demonstration evidence.';
      if (context.snapshotVersion === null && Array.isArray(b.selectedEvidence) && b.selectedEvidence.length) errors.catalogContext = 'Real selections require their captured catalog version. Your input is retained.';
    } else errors.catalogContext = 'Review the discovery catalog and its exact source/fact versions.';
  }
  if (catalogContext?.sourceKind !== 'PUBLIC_REAL' && Array.isArray(b.selectedEvidence) &&
      b.selectedEvidence.some(ref => ref && typeof ref.itemId === 'string' && ref.itemId.startsWith('norad:'))) {
    errors.selectedEvidence = 'Real-catalog selections require their explicit captured real catalog context. Review them separately from demonstration evidence.';
  }
  if (typeof b.timingToDiscuss !== 'boolean') errors.timingToDiscuss = 'Choose whether timing needs discussion.';
  let requestedWindow: NormalizedBrief['requestedWindow'] = null;
  let deadline: NormalizedBrief['deadline'] = null;
  if (!b.timingToDiscuss && !(options.preparation && b.windowStart === '' && b.windowEnd === '')) {
    let startUtc = '', endUtc = '';
    if (!errors.timezone) {
      try { startUtc = zonedInstant(b.windowStart, timezone); } catch { errors.windowStart = 'Enter a valid, unambiguous start in this timezone; use UTC for a DST gap or repeated time.'; }
      try { endUtc = zonedInstant(b.windowEnd, timezone); } catch { errors.windowEnd = 'Enter a valid, unambiguous end in this timezone; use UTC for a DST gap or repeated time.'; }
      if (startUtc && endUtc && startUtc >= endUtc) errors.windowEnd = 'Window end must be later than start.';
      if (startUtc && endUtc) requestedWindow = { startUtc, endUtc, localStart: b.windowStart, localEnd: b.windowEnd, timezone };
    }
  }
  if (typeof b.deadline !== 'string') errors.deadline = 'Enter a local deadline or leave it blank.';
  else if (b.deadline.trim() && !errors.timezone) {
    try { deadline = { utc: zonedInstant(b.deadline, timezone), local: b.deadline, timezone }; }
    catch { errors.deadline = 'Enter a valid unambiguous deadline, or leave it unknown.'; }
  }
  if (options.requireAcknowledgement !== false && b.acknowledged !== true) errors.acknowledged = 'Confirm the brief/contact details and request a feasibility review.';
  if (Object.keys(errors).length) return { fieldErrors: errors };
  const normalized: NormalizedBrief = {
    purpose, family: 'EO', sensor: sensor as NormalizedBrief['sensor'], outputs: ['Imagery'], area: { method: choice!.method, generation: choice!.generation, latitude: latitude!, longitude: longitude!, radiusKm: radiusKm! }, areaConfirmation: b.areaConfirmation!,
    baselineDate: intent === 'comparison' ? b.baselineDate : '', recentDate: intent === 'comparison' ? b.recentDate : '', timezone, maxResolutionM, cloudCover, revisitHours,
    spectralRequirements, timingToDiscuss: b.timingToDiscuss, requestedWindow, deadline, timingNotes, unknowns,
    contact: { name: contact.name, email: contact.email, organization: contact.organization }, selectedEvidence: b.selectedEvidence.map(e => ({ itemId: e.itemId, evidenceVersion: e.evidenceVersion })),
  };
  if (b.observationIntent !== undefined) normalized.observationIntent = intent;
  if (areaSource !== undefined) normalized.areaSource = areaSource;
  if(catalogContext) normalized.catalogContext = catalogContext;
  if(b.discovery!==undefined&&b.discovery!==null) {
    const discovery=validateDiscoverySnapshot(b.discovery,purpose,options.discoveryDictionary??makeDiscoveryDictionary([]),normalized);
    if(!discovery.value)return {fieldErrors:discovery.fieldErrors};
    normalized.discovery=discovery.value;
  }
  return { fieldErrors: {}, value: normalized };
}
