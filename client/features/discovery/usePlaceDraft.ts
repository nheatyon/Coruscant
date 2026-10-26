import { useEffect, useMemo, useRef, useState } from 'react';
import type { BriefInput } from '../../../shared/contracts.js';
import type { AreaProposal } from '../../../shared/area-proposal.js';
import type { PlaceCandidate, PlaceLookupResult, PlaceSourceReference } from '../../../shared/place-contracts.js';
import { extractPlacePhrase } from '../../../shared/place-phrase.js';
import { readCoordinate } from '../../../shared/validation.js';
import { ApiError, contextKey, message, post } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';

type NumericArea = { latitude: string; longitude: string; radiusKm: string };
const numericOf = (brief: BriefInput): NumericArea => ({ latitude: brief.latitude, longitude: brief.longitude, radiusKm: brief.radiusKm });
export function usePlaceDraft(brief: BriefInput, question: string, change: (patch: Partial<BriefInput>) => void) {
  const access = useCurrentContext(), accessRef = useRef(access); accessRef.current = access;
  const current = useRef({ brief, question, change }); current.current = { brief, question, change };
  const extracted = useMemo(() => extractPlacePhrase(question), [question]);
  const [manual, setManual] = useState<{ question: string; phrase: string } | null>(null);
  const phrase = manual?.question === question ? manual.phrase : extracted.phrase;
  const phraseRef = useRef(phrase); phraseRef.current = phrase;
  const [result, setResult] = useState<PlaceLookupResult | null>(null), [state, setState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'failed' | 'canceled'>('idle');
  const [error, setError] = useState<string | null>(null), [retryAfter, setRetryAfter] = useState<string | null>(null);
  const [retryUntil, setRetryUntil] = useState(0), [clock, setClock] = useState(Date.now());
  const retryRemaining = Math.max(0, Math.ceil((retryUntil - clock) / 1000));
  useEffect(() => { if (!retryUntil || retryUntil <= Date.now()) return; const timer = window.setInterval(() => setClock(Date.now()), 250); return () => clearInterval(timer); }, [retryUntil, retryRemaining > 0]);
  const [proposal, writeProposal] = useState<AreaProposal | null>(null), proposalRef = useRef(proposal); proposalRef.current = proposal;
  const setProposal = (value: AreaProposal | null) => { proposalRef.current = value; writeProposal(value); };
  const [candidate, setCandidate] = useState<PlaceCandidate | null>(null), sourceRef = useRef<PlaceSourceReference | null>(null), manualSource = useRef(false);
  const [numeric, writeNumeric] = useState<NumericArea>(() => numericOf(brief)), numericRef = useRef(numeric); numericRef.current = numeric;
  const setNumeric = (value: NumericArea) => { numericRef.current = value; writeNumeric(value); };
  const [numericErrors, setNumericErrors] = useState<Record<string, string>>({});
  const sequence = useRef(0), generation = useRef(brief.areaChoice?.generation ?? 0), mounted = useRef(true), controller = useRef<AbortController | null>(null);
  const stamp = contextKey(access.context), previousQuestion = useRef(question), lookupOwner = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++sequence.current; controller.current?.abort(); }; }, []);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') { ++sequence.current; controller.current?.abort(); lookupOwner.current = null; setState(previous => previous === 'loading' ? 'canceled' : previous); } };
    document.addEventListener('visibilitychange', hide); return () => document.removeEventListener('visibilitychange', hide);
  }, []);
  useEffect(() => { if (lookupOwner.current && (lookupOwner.current !== stamp || access.covered)) { ++sequence.current; controller.current?.abort(); lookupOwner.current = null; setState(previous => previous === 'loading' ? 'canceled' : previous); } }, [stamp, access.covered]);
  useEffect(() => {
    if (previousQuestion.current === question) return;
    previousQuestion.current = question; ++sequence.current; controller.current?.abort(); setResult(null); setState('idle'); setError(null); setRetryAfter(null);
    // Keep the deliberate applied target; a result for a different question cannot restore a preview.
    // A staged area stays visible until explicitly applied or canceled; it is never applied by a new description.
  }, [question]);
  useEffect(() => {
    if (!proposal) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [!!proposal]);
  const nextGeneration = () => generation.current = Math.max(generation.current, current.current.brief.areaChoice?.generation ?? 0, proposalRef.current?.generation ?? 0) + 1;
  const setPhrase = (value: string) => { ++sequence.current; controller.current?.abort(); setManual({ question, phrase: value }); setResult(null); setState('idle'); setError(null); };
  const stageCandidate = (value: PlaceCandidate, lookup = result) => {
    if (!lookup || !lookup.candidates.some(row => row.id === value.id)) return;
    ++sequence.current; manualSource.current = false;
    sourceRef.current = { lookupVersion: lookup.version, candidateId: value.id, sourcePhrase: phrase.trim(), phraseOrigin: manual?.question === question ? 'manual' : 'stated', phraseSpan: manual?.question === question ? null : extracted.span, questionAtLookup: question, reviewedPurpose: question, radiusAssumptionKm: 25 };
    setState('ready'); setError(null); setCandidate(value); setNumeric({ latitude: String(value.latitude), longitude: String(value.longitude), radiusKm: '25' });
    setProposal({ generation: nextGeneration(), origin: 'lookup', circle: { latitude: value.latitude, longitude: value.longitude, radiusKm: 25 } }); setNumericErrors({});
  };
  const lookup = async () => {
    if (Date.now() < retryUntil) return;
    const text = phrase.trim(), original = question;
    if (current.current.question !== original || phraseRef.current.trim() !== text) return;
    if (text.length < 2 || text.length > 200) { setError('Enter a place phrase of 2–200 characters. Your complete mission question is never sent as a fallback.'); return; }
    lookupOwner.current = null; const invocation = ++sequence.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort;
    setState('loading'); setError(null); setRetryAfter(null); setResult(null);
    try {
      const context = await access.ensure(), owner = contextKey(context);
      const intentCurrent = () => mounted.current && sequence.current === invocation && current.current.question === original && phraseRef.current.trim() === text && document.visibilityState !== 'hidden' && !abort.signal.aborted;
      if (!intentCurrent()) return;
      lookupOwner.current = owner;
      const matches = () => intentCurrent() && contextKey(accessRef.current.context) === owner && !accessRef.current.covered;
      const value = await post<PlaceLookupResult>('/api/place-lookups', context, { query: text, generation: invocation }, abort.signal);
      if (!matches()) return;
      setResult(value); setState(value.candidates.length ? 'ready' : 'empty');
      if (value.candidates.length === 1) stageCandidate(value.candidates[0]!, value);
    } catch (failure) {
      if (!mounted.current || invocation !== sequence.current || abort.signal.aborted || current.current.question !== original) return;
      setState('failed'); setError(message(failure));
      if (failure instanceof ApiError && failure.body.fieldErrors?.retryAfter) { const seconds = Number(failure.body.fieldErrors.retryAfter); setRetryAfter(failure.body.fieldErrors.retryAfter); if (Number.isFinite(seconds) && seconds > 0) { setClock(Date.now()); setRetryUntil(Date.now() + seconds * 1000); } }
    }
  };
  const cancel = () => { ++sequence.current; controller.current?.abort(); lookupOwner.current = null; setProposal(null); sourceRef.current = null; manualSource.current = false; setCandidate(null); setNumeric(numericOf(current.current.brief)); setNumericErrors({}); setState('canceled'); };
  const stage = (value: AreaProposal | null) => {
    ++sequence.current; controller.current?.abort(); setState(previous => previous === 'loading' ? 'canceled' : previous);
    if (!value) { cancel(); return; }
    if (value.generation === proposalRef.current?.generation && value.origin === proposalRef.current.origin) return;
    generation.current = Math.max(generation.current, value.generation); sourceRef.current = null; manualSource.current = false; setCandidate(null); setProposal(value);
    setNumeric({ latitude: String(value.circle.latitude), longitude: String(value.circle.longitude), radiusKm: String(value.circle.radiusKm) }); setNumericErrors({});
  };
  const editNumeric = (name: keyof NumericArea, value: string) => {
    ++sequence.current; controller.current?.abort(); lookupOwner.current = null; setState(previous => previous === 'loading' ? 'canceled' : previous);
    const next = { ...numericRef.current, [name]: value }, latitude = readCoordinate(next.latitude, -90, 90), longitude = readCoordinate(next.longitude, -180, 180), radiusKm = readCoordinate(next.radiusKm, .001, Number.MAX_VALUE);
    setNumeric(next);
    if (latitude !== null && longitude !== null && radiusKm !== null) setProposal({ generation: nextGeneration(), origin: 'numeric', circle: { latitude, longitude, radiusKm } });
    else setProposal(null);
    setNumericErrors(previous => { const fields = { ...previous }; delete fields[name]; return fields; });
  };
  const apply = (value = proposalRef.current) => {
    if (!value || value.generation !== proposalRef.current?.generation || JSON.stringify(value.circle) !== JSON.stringify(proposalRef.current.circle)) return;
    const now = current.current, source = manualSource.current ? null : sourceRef.current ?? (value.origin === 'numeric' ? now.brief.areaSource ?? null : null);
    ++sequence.current; controller.current?.abort(); lookupOwner.current = null; setState(previous => previous === 'loading' ? 'canceled' : previous);
    now.change({ ...(now.question !== now.brief.purpose ? { purpose: now.question } : {}), latitude: String(value.circle.latitude), longitude: String(value.circle.longitude), radiusKm: String(value.circle.radiusKm),
      areaChoice: { ...value.circle, method: value.origin === 'globe-drag' ? 'globe' : 'coordinates', generation: nextGeneration() },
      areaSource: source ? { ...source, reviewedPurpose: now.question } : null, areaReviewedPurpose: now.question, areaConfirmation: null });
    setProposal(null); setCandidate(null); sourceRef.current = null; manualSource.current = false; setNumeric({ latitude: String(value.circle.latitude), longitude: String(value.circle.longitude), radiusKm: String(value.circle.radiusKm) }); setNumericErrors({});
  };
  const reviewAsManual = () => {
    // The existing applied lookup remains unchanged until an explicit Apply/Use.
    ++sequence.current; controller.current?.abort(); lookupOwner.current = null;
    setState(previous => previous === 'loading' ? 'canceled' : previous);
    manualSource.current = true; sourceRef.current = null; setCandidate(null);
    const raw = numericRef.current, latitude = readCoordinate(raw.latitude, -90, 90), longitude = readCoordinate(raw.longitude, -180, 180), radiusKm = readCoordinate(raw.radiusKm, .001, Number.MAX_VALUE);
    setProposal(latitude !== null && longitude !== null && radiusKm !== null ? { generation: nextGeneration(), origin: 'numeric', circle: { latitude, longitude, radiusKm } } : null);
  };
  const applyNumeric = () => {
    const latitude = readCoordinate(numeric.latitude, -90, 90), longitude = readCoordinate(numeric.longitude, -180, 180), radiusKm = readCoordinate(numeric.radiusKm, .001, Number.MAX_VALUE), errors: Record<string, string> = {};
    if (latitude === null) errors.latitude = 'Enter a latitude from −90 to 90; blank is not zero.';
    if (longitude === null) errors.longitude = 'Enter a longitude from −180 to 180; blank is not zero.';
    if (radiusKm === null) errors.radiusKm = 'Enter a finite radius of at least 0.001 km.';
    setNumericErrors(errors); if (Object.keys(errors).length) return;
    const next: AreaProposal = { generation: nextGeneration(), origin: sourceRef.current ? 'lookup' : 'numeric', circle: { latitude: latitude!, longitude: longitude!, radiusKm: radiusKm! } }; setProposal(next); apply(next);
  };
  const keep = () => { const now = current.current; cancel(); now.change({ ...(now.question !== now.brief.purpose ? { purpose: now.question } : {}), areaReviewedPurpose: now.question, ...(now.brief.areaSource ? { areaSource: { ...now.brief.areaSource, reviewedPurpose: now.question } } : {}) }); };
  const reset = () => { cancel(); setManual(null); setResult(null); setState('idle'); setError(null); setNumeric({ latitude: '0', longitude: '0', radiusKm: '25' }); };
  const stagedNumericDirty = JSON.stringify(numeric) !== JSON.stringify(numericOf(brief));
  const pendingArea = !!proposal || stagedNumericDirty || state === 'loading';
  const needsReview = !!brief.areaChoice && brief.areaReviewedPurpose !== question;
  return { extracted, phrase, setPhrase, lookup, result, state, error, retryAfter, retryRemaining, proposal, stage, candidate, proposalSourcePhrase: sourceRef.current?.sourcePhrase ?? null, chooseCandidate: stageCandidate, apply, cancel, keep, needsReview, stagedNumericDirty, pendingArea, numeric, numericErrors, editNumeric, applyNumeric, reviewAsManual, reset };
}
export type PlaceDraft = ReturnType<typeof usePlaceDraft>;
