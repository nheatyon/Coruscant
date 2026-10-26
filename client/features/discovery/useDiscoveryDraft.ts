import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { Temporal } from '@js-temporal/polyfill';
import type { BriefInput } from '../../../shared/contracts.js';
import type { DiscoveryFamily, DiscoveryField, DiscoveryInterpretation, DiscoverySnapshotInput, DiscoveryValue, DiscoveryOutput, DiscoveryDictionary, ManualChoice } from '../../../shared/discovery-contracts.js';
import { acknowledgeReviewedFilters, clearManualChoice, interpretNeed, makeDiscoveryDictionary, setManualChoice } from '../../../shared/discovery.js';
import { zonedInstant } from '../../../shared/validation.js';
import { contextKey } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';
import type { DiscoveryCatalog } from './useCatalogSources.js';

const sensorInput = (value: string | null) => value ?? 'OPEN';
const sensorValue = (value: string) => value === 'Visible' ? 'VISIBLE' : value === 'Thermal' ? 'THERMAL' : value;
export function discoveryInput(value: DiscoveryInterpretation): DiscoverySnapshotInput { return { rulesVersion: value.rulesVersion, generation: value.generation, originalText: value.originalText, manual: value.manual, ...(value.reviewedSignature ? { reviewedSignature: value.reviewedSignature } : {}) }; }
function localTime(instant: string, zone: string) { return Temporal.Instant.from(instant).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: 'millisecond' }); }
type EditableBrief = Omit<BriefInput, 'contact'>;
function interpretedBrief<T extends EditableBrief>(brief: T, result: DiscoveryInterpretation, dictionary: DiscoveryDictionary): T {
  const values = result.effective;
  const next = { ...brief, purpose: result.originalText, family: 'EO', sensor: sensorInput(values.sensor), outputs: values.outputs ?? ['Imagery'], maxResolution: values.maxResolutionM === null ? '' : String(values.maxResolutionM), resolutionUnit: 'm', cloudCover: values.cloudCover === null ? '' : String(values.cloudCover), revisitHours: values.revisitHours === null ? '' : String(values.revisitHours), discovery: discoveryInput(result), acknowledged: false } as T;
  const prior = brief.discovery ? interpretNeed({ ...brief.discovery, text: brief.discovery.originalText, dictionary }) : null;
  if (values.timezone) next.timezone = values.timezone;
  else if (prior?.effective.timezone && !result.manual.some(choice => choice.field === 'timezone' && choice.action === 'SET')) next.timezone = '';
  if (!values.window && prior?.effective.window) { next.windowStart = ''; next.windowEnd = ''; next.timingToDiscuss = true; }
  if (!values.deadline && prior?.effective.deadline) next.deadline = '';
  const timingLines = (snapshot: DiscoveryInterpretation | null) => [...new Set(snapshot?.diagnostics.filter(item => ['window','deadline','timezone','delivery'].includes(item.field)).map(item => `Unresolved source timing: ${item.phrase}`) ?? [])];
  const oldLines = new Set(timingLines(prior));
  const retainedNotes = brief.timingNotes.split('\n').filter(line => !oldLines.has(line));
  next.timingNotes = [...new Set([...retainedNotes, ...timingLines(result)])].filter(Boolean).join('\n');
  try { if (values.window) { next.windowStart = localTime(values.window.startUtc, next.timezone); next.windowEnd = localTime(values.window.endUtc, next.timezone); next.timingToDiscuss = false; } if (values.deadline) next.deadline = localTime(values.deadline, next.timezone); } catch { /* Unsupported temporal input remains in source diagnostics, never guessed. */ }
  return next;
}
export function manualFromSavedBrief(brief: EditableBrief): ManualChoice[] {
  let choices: ManualChoice[] = [];
  const set = (field: DiscoveryField, value: DiscoveryValue, label: string) => { choices = setManualChoice(choices, field, value, label); };
  set('family', 'EO', 'Previously saved Earth-observation requirement');
  set('sensor', sensorValue(brief.sensor) as DiscoveryValue, `Previously saved sensor: ${brief.sensor}`);
  set('outputs', brief.outputs as DiscoveryOutput[], `Previously saved deliverables: ${brief.outputs.join(', ')}`);
  const resolution = Number(brief.maxResolution) * ({ m: 1, cm: .01, km: 1000 }[brief.resolutionUnit]);
  choices = !brief.maxResolution.trim() ? clearManualChoice(choices, 'maxResolutionM', 'Previously saved maximum: not stated') : setManualChoice(choices, 'maxResolutionM', resolution, `Previously saved maximum: ${brief.maxResolution} ${brief.resolutionUnit}`);
  for (const field of ['cloudCover', 'revisitHours'] as const) if (brief[field].trim()) set(field, Number(brief[field]), `Previously saved ${field}: ${brief[field]}`);
  if (brief.timezone) set('timezone', brief.timezone, `Previously saved request timezone: ${brief.timezone}`);
  try { if (!brief.timingToDiscuss) set('window', { startUtc: zonedInstant(brief.windowStart, brief.timezone), endUtc: zonedInstant(brief.windowEnd, brief.timezone) }, `Previously saved planning window: ${brief.windowStart} → ${brief.windowEnd}`); } catch { /* Raw validation owns invalid historical input. */ }
  try { if (brief.deadline) set('deadline', zonedInstant(brief.deadline, brief.timezone), `Previously saved deadline: ${brief.deadline}`); } catch { /* Retain raw historical input. */ }
  return choices;
}
export function patchDiscoveryBrief<T extends EditableBrief>(previous: T, patch: Partial<T>, dictionary: DiscoveryDictionary, generation: number, manual: ManualChoice[] = previous.discovery?.manual ?? []): { brief: T; interpretation: DiscoveryInterpretation | null } {
    const raw = { ...previous, ...patch, acknowledged: false }; let choices = manual; let changed = false;
    const choice = (field: DiscoveryField, value: DiscoveryValue, label: string, clear = false) => { choices = clear ? clearManualChoice(choices, field, label) : setManualChoice(choices, field, value, label); changed = true; };
    if ('sensor' in patch) choice('sensor', sensorValue(raw.sensor) as DiscoveryValue, raw.sensor);
    if ('outputs' in patch) choice('outputs', raw.outputs as DiscoveryOutput[], raw.outputs.join(', '));
    if ('maxResolution' in patch || 'resolutionUnit' in patch) { const value = Number(raw.maxResolution) * ({ m: 1, cm: .01, km: 1000 }[raw.resolutionUnit]); if (!raw.maxResolution.trim()) choice('maxResolutionM', null, 'No resolution limit', true); else if (Number.isFinite(value) && value > 0) choice('maxResolutionM', value, `${raw.maxResolution} ${raw.resolutionUnit}`); }
    for (const [key, field] of [['cloudCover','cloudCover'],['revisitHours','revisitHours']] as const) if (key in patch) { const value = Number(raw[key]); if (!raw[key].trim()) choice(field, null, `Cleared ${field}`, true); else if (Number.isFinite(value)) choice(field, value, `${raw[key]} ${field === 'cloudCover' ? '%' : 'hours'}`); }
    if ('timezone' in patch) choice('timezone', raw.timezone || null, raw.timezone || 'Timezone not stated', !raw.timezone);
    if ('windowStart' in patch || 'windowEnd' in patch || 'timingToDiscuss' in patch || 'timezone' in patch) { if (raw.timingToDiscuss) choice('window', null, 'Timing to be discussed', true); else try { choice('window', { startUtc: zonedInstant(raw.windowStart, raw.timezone), endUtc: zonedInstant(raw.windowEnd, raw.timezone) }, `${raw.windowStart} → ${raw.windowEnd} · ${raw.timezone}`); } catch { /* Incomplete raw fields remain editable and are validated independently. */ } }
    if ('deadline' in patch) { if (!raw.deadline) choice('deadline', null, 'No deadline stated', true); else try { choice('deadline', zonedInstant(raw.deadline, raw.timezone), `${raw.deadline} · ${raw.timezone}`); } catch { /* Retain raw validation errors. */ } }
    if (changed || 'purpose' in patch) {
      const text = raw.purpose; const result = interpretNeed({ text, generation, manual: choices, dictionary });
      // Direct editor values remain authoritative, including temporarily invalid numeric/date text.
      const next = interpretedBrief(raw, result, dictionary);
      return { interpretation: result, brief: { ...next, ...patch, ...(('maxResolution' in patch || 'resolutionUnit' in patch) ? { maxResolution: raw.maxResolution, resolutionUnit: raw.resolutionUnit } : {}), discovery: discoveryInput(result) } };
    } else return { brief: raw, interpretation: null };
}

interface DiscoverySession { text: string; manual: ManualChoice[]; interpretation: DiscoveryInterpretation | null; generation: number; info: DiscoveryFamily | null; planned: DiscoveryInterpretation | null; selectedId: string | null; railWidth: number; collapsed: boolean }
export function useDiscoveryDraft(brief: BriefInput, setBrief: Dispatch<SetStateAction<BriefInput>>, catalog: DiscoveryCatalog | null, suppliedDictionary?: DiscoveryDictionary, sourceStamp?: string) {
  const { context } = useCurrentContext(); const contextStamp = contextKey(context); const contextRef = useRef(contextStamp); contextRef.current = contextStamp;
  const dictionary = useMemo(() => suppliedDictionary ?? makeDiscoveryDictionary(catalog?.items ?? []), [catalog, suppliedDictionary]);
  const [state, setState] = useState<DiscoverySession>({ text: '', manual: [], interpretation: null, generation: 0, info: null, planned: null, selectedId: null, railWidth: 320, collapsed: false });
  const current = useRef(state); current.current = state; const latestBrief = useRef(brief); latestBrief.current = brief;
  const generation = useRef(0); const [reading, setReading] = useState(false); const [notice, setNotice] = useState<string | null>(null);
  const commit = (value: DiscoverySession) => { current.current = value; setState(value); };
  const saveBrief = (value: BriefInput) => { latestBrief.current = value; setBrief(value); };
  useEffect(() => { ++generation.current; setReading(false); }, [contextStamp]);
  const apply = (result: DiscoveryInterpretation, text: string, manual: ManualChoice[]) => {
    const previous = current.current;
    if (result.route.kind === 'PLANNED' && result.route.family && result.route.family !== 'EO') { commit({ ...previous, text, generation: result.generation, info: result.route.family, planned: result }); return; }
    commit({ ...previous, text, manual, generation: result.generation, interpretation: result, info: null, planned: null });
    saveBrief(interpretedBrief(latestBrief.current, result, dictionary));
  };
  const seenSource = useRef(sourceStamp);
  useEffect(() => {
    if (sourceStamp === undefined || seenSource.current === sourceStamp) return;
    seenSource.current = sourceStamp; const invocation = ++generation.current; setReading(false); setNotice(null);
    const previous = current.current;
    if (previous.interpretation) {
      const result = interpretNeed({ text: previous.interpretation.originalText, generation: invocation, manual: previous.manual, dictionary });
      apply(result, previous.text, previous.manual);
    } else { commit({ ...previous, generation: invocation }); saveBrief({ ...latestBrief.current, acknowledged: false }); }
  }, [sourceStamp]);
  const describe = (text: string) => { ++generation.current; setReading(false); setNotice(null); commit({ ...current.current, text, generation: generation.current }); };
  const explore = async (text = current.current.text) => {
    const invocation = ++generation.current, capturedContext = contextRef.current, manual = current.current.manual;
    commit({ ...current.current, text, generation: invocation }); setReading(true); setNotice(null);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (generation.current !== invocation || contextRef.current !== capturedContext) return;
    try { apply(interpretNeed({ text, generation: invocation, manual, dictionary }), text, manual); } catch { setNotice('The local reading could not complete. Your words and prepared brief are retained; adjust the manual filters or try again.'); }
    if (generation.current === invocation) setReading(false);
  };
  const manual = (field: DiscoveryField, value: DiscoveryValue, label: string, clear = false) => {
    ++generation.current; setReading(false); setNotice(null);
    let choices = clear ? clearManualChoice(current.current.manual, field, label) : setManualChoice(current.current.manual, field, value, label);
    const result = interpretNeed({ text: current.current.text, generation: generation.current, manual: choices, dictionary });
    apply(result, current.current.text, choices);
  };
  const remove = (field: DiscoveryField) => manual(field, null, `Cleared ${field}`, true);
  const clear = () => {
    let choices = current.current.manual;
    for (const field of ['family','sensor','maxResolutionM','outputs','keyword','operator','ownerCountry','place','cloudCover','revisitHours','timezone','window','deadline','delivery','documentedOnly'] as DiscoveryField[]) choices = clearManualChoice(choices, field, `Cleared ${field}`);
    const invocation = ++generation.current; const result = interpretNeed({ text: current.current.text, generation: invocation, manual: choices, dictionary }); apply(result, current.current.text, choices); setNotice(null);
  };
  const reviewed = () => { if (!current.current.interpretation) return; const result = acknowledgeReviewedFilters(current.current.interpretation, dictionary); apply(result, current.current.text, result.manual); };
  const information = (family: DiscoveryFamily) => { if (family === 'EO') { commit({ ...current.current, info: null, planned: null, text: current.current.info ? latestBrief.current.purpose : current.current.text }); manual('family', 'EO', 'Earth observation'); } else commit({ ...current.current, info: family, planned: null }); };
  const returnEO = () => { commit({ ...current.current, info: null, planned: null, text: latestBrief.current.purpose }); setNotice(null); };
  const returnSAR = () => {
    let choices = setManualChoice(current.current.manual, 'family', 'EO', 'Earth observation'); choices = setManualChoice(choices, 'sensor', 'SAR', 'Synthetic aperture radar'); choices = setManualChoice(choices, 'outputs', ['Imagery'], 'Imagery');
    const invocation = ++generation.current; apply(interpretNeed({ text: current.current.text, generation: invocation, manual: choices, dictionary }), current.current.text, choices);
  };
  const editBrief = (patch: Partial<BriefInput>) => {
    setReading(false);
    const invocation = ++generation.current;
    const value = patchDiscoveryBrief(latestBrief.current, patch, dictionary, invocation, current.current.manual);
    if (value.interpretation) commit({ ...current.current, text: value.brief.purpose, manual: value.interpretation.manual, interpretation: value.interpretation, generation: invocation });
    saveBrief(value.brief);
  };
  const reset = () => { const invocation = ++generation.current; commit({ text: '', manual: [], interpretation: null, generation: invocation, info: null, planned: null, selectedId: null, railWidth: 320, collapsed: false }); setReading(false); setNotice(null); };
  return { ...state, dictionary, reading, notice, describe, explore, manual, remove, clear, reviewed, information, returnEO, returnSAR, editBrief, reset,
    setSelected: (selectedId: string | null) => commit({ ...current.current, selectedId }),
    setRailWidth: (railWidth: number) => commit({ ...current.current, railWidth: Math.max(280, Math.min(520, railWidth)) }),
    setCollapsed: (collapsed: boolean) => commit({ ...current.current, collapsed }),
  };
}
export type DiscoveryController = ReturnType<typeof useDiscoveryDraft>;
