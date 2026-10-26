import { useEffect, useMemo, useRef, useState } from 'react';
import type { BriefInput, CatalogContext } from '../../../shared/contracts.js';
import type { DiscoveryDictionary } from '../../../shared/discovery-contracts.js';
import type { AssessmentHandle, AssessmentPage, AssessmentRecheckResult, AssessmentSelectedView, PlanOption, PlanSelectionInput } from '../../../shared/plan-contracts.js';
import { validatePlanningBrief, zonedInstant } from '../../../shared/validation.js';
import { contextKey, message, post } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';
import { useServerClock } from '../../lib/useServerClock.js';
import { planningCapability, planningIdentity, planningOwnershipStamp } from './planning-context.js';

export interface PlanningRequestBinding { requestId: string; requestVersion: number; briefRevision: number }
export interface LocalPlanSelection { selection: PlanSelectionInput; option: PlanOption; page: AssessmentPage }
export interface PlanOptionEdits { at: string; acknowledged: string[]; hours: string; explanation: string }
export interface PlanningGlobeView { selected: AssessmentSelectedView; snapshotUtc: string; snapshotSelectedId: string | null }
/** Contact and action acknowledgements do not change the physical calculation. */
export function planningInputKey(brief: BriefInput, source: CatalogContext): string {
  const { contact: _contact, acknowledged: _acknowledged, selectedEvidence: _shortlist, ...technical } = brief;
  return JSON.stringify({ ...technical, catalogContext: source });
}

/** One bounded local job; responses never restore an obsolete question or navigate. */
export function useProposedPlan({ brief, dictionary, catalogContext, enabled, pendingArea = false, request, serverNow }: {
  brief: BriefInput; dictionary: DiscoveryDictionary; catalogContext: CatalogContext; enabled: boolean;
  pendingArea?: boolean; request?: PlanningRequestBinding; serverNow?: string;
}) {
  const access = useCurrentContext(), accessRef = useRef(access); accessRef.current = access;
  const now = useServerClock(serverNow, 1000);
  const inputKey = planningInputKey(brief, catalogContext), bindingKey = JSON.stringify(request ?? null);
  const dataKey = JSON.stringify([inputKey, bindingKey]), ownershipStamp = planningOwnershipStamp(access.context), identity = planningIdentity(access.context);
  const capability = planningCapability(access.context);
  const previousOwner = useRef({ stamp: ownershipStamp, identity, audience: access.context?.audience, established: !!access.context?.csrfToken });
  const handoff = useRef<{ assessmentId: string; inputKey: string; bindingKey: string; page: AssessmentPage; chosen: LocalPlanSelection; edits: Record<string, PlanOptionEdits> } | null>(null);
  const [retired, setRetired] = useState(false);
  const current = useRef({ inputKey, bindingKey, enabled }); current.current = { inputKey, bindingKey, enabled };
  const sequence = useRef(0), generation = useRef(0), mounted = useRef(true), running = useRef<{ handle: AssessmentHandle; owner: string } | null>(null);
  const started = useRef<string | null>(null);
  const [pageState, setPage] = useState<{ key: string; owner: string; value: AssessmentPage } | null>(null);
  const [starting, setStarting] = useState(false), [error, setError] = useState<string | null>(null), [round, setRound] = useState(0);
  const [stoppedKey, setStoppedKey] = useState<string | null>(null), [selectionState, setSelection] = useState<{ key: string; owner: string; value: LocalPlanSelection } | null>(null);
  const [viewState, setViewState] = useState<{ key: string; owner: string; value: PlanningGlobeView } | null>(null), [viewBusy, setViewBusy] = useState(false);
  const view = !access.covered && capability.canCalculate && viewState?.key === dataKey && viewState.owner === ownershipStamp ? viewState.value : null;
  const setView = (value: PlanningGlobeView | null) => setViewState(value ? { key: dataKey, owner: planningOwnershipStamp(accessRef.current.context), value } : null);
  const [edits, setEdits] = useState<{ key: string; owner: string; values: Record<string, PlanOptionEdits> }>({ key: dataKey, owner: ownershipStamp, values: {} });
  const viewSequence = useRef(0);
  const checkedViews = useRef(new Map<string, { inputKey: string; bindingKey: string; sequence: number; owner: string; token: string | null; at: string; view: AssessmentSelectedView | null }>());
  // Cancel deliberately retires the polling effect. Its own acknowledgement must
  // survive that cleanup, while every newer intent still invalidates it.
  const cancelSequence = useRef(0);
  const checked = useMemo(() => validatePlanningBrief({ ...brief, catalogContext, contact: { name: '', email: '', organization: '' } }, { discoveryDictionary: dictionary }), [inputKey, dictionary]);
  const missing: string[] = [];
  if (catalogContext.sourceKind !== 'PUBLIC_REAL' || !catalogContext.snapshotVersion || !catalogContext.factVersion) missing.push('Choose an available real catalog source and fact version.');
  if (pendingArea) missing.push('Apply or cancel the pending area proposal.');
  for (const [field, reason] of Object.entries(checked.fieldErrors)) if (!field.startsWith('contact.') && !missing.includes(reason)) missing.push(reason);
  let window: { startUtc: string; endUtc: string } | null | undefined = checked.value?.requestedWindow;
  if (!window && !brief.timingToDiscuss) {
    try { window = { startUtc: zonedInstant(brief.windowStart, brief.timezone), endUtc: zonedInstant(brief.windowEnd, brief.timezone) }; }
    catch { /* The existing named field errors retain incomplete or ambiguous timing. */ }
  }
  if (!window) missing.push('Enter an explicit planning window start and end; Timing to be discussed cannot produce a timed plan.');
  else {
    if (!Number.isFinite(now) || Date.parse(window.startUtc) <= now) missing.push('The entire planning window must be in the future.');
    if (Date.parse(window.endUtc) - Date.parse(window.startUtc) > 24 * 3600_000) missing.push('Use a positive planning window of at most 24 hours.');
  }
  const ready = missing.length === 0, readiness = ready ? 'ready' : missing.join('\n');
  const page = !access.covered && capability.canCalculate && pageState?.key === dataKey && pageState.owner === ownershipStamp ? pageState.value : null;
  const pageRef = useRef(page); pageRef.current = page;
  const chosen = !access.covered && capability.canCalculate && selectionState?.key === dataKey && selectionState.owner === ownershipStamp ? selectionState.value : null;
  const cancelHandle = (handle: AssessmentHandle, owner: string) => {
    const ctx = accessRef.current.context;
    if (ctx && !accessRef.current.covered && planningOwnershipStamp(ctx) === owner) void post('/api/orbital-assessments/cancel', ctx, { ...handle }).catch(() => {});
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++sequence.current; ++cancelSequence.current; if (running.current) cancelHandle(running.current.handle, running.current.owner); }; }, []);
  useEffect(() => { checkedViews.current.clear(); ++viewSequence.current; ++cancelSequence.current; setViewBusy(false); setSelection(null); setView(null); setError(null); }, [inputKey, bindingKey]);
  useEffect(() => { checkedViews.current.clear(); ++cancelSequence.current; }, [access.covered, contextKey(access.context)]);
  useEffect(() => {
    const previous = previousOwner.current;
    previousOwner.current = { stamp: ownershipStamp, identity, audience: access.context?.audience, established: !!access.context?.csrfToken };
    if (previous.stamp === ownershipStamp || !previous.established && !previous.audience) return;
    // Initial public CSRF bootstrap establishes the same visitor before its first job.
    if (!previous.established && previous.identity === identity && access.context?.audience === 'PUBLIC') return;
    const continuation = access.context?.planningHandoff;
    if (!handoff.current || !continuation || continuation.phase === 'CONTINUE' && continuation.continuation.handle.assessmentId !== handoff.current.assessmentId || continuation.phase === 'COMPLETE' && continuation.result.handle.assessmentId !== handoff.current.assessmentId) handoff.current = null;
    ++sequence.current; ++viewSequence.current; ++cancelSequence.current;
    checkedViews.current.clear(); started.current = null; running.current = null;
    setPage(null); setSelection(null); setView(null); setEdits({ key: dataKey, owner: ownershipStamp, values: {} });
    setStarting(false); setViewBusy(false); setStoppedKey(null); setError(null); setRetired(true); setRound(value => value + 1);
  }, [ownershipStamp]);
  useEffect(() => {
    const jobKey = `${inputKey}:${bindingKey}:${identity}:${round}`;
    if (!enabled || !ready || !capability.canCalculate || stoppedKey === inputKey || access.covered || started.current === jobKey) return;
    const invocation = ++sequence.current, abort = new AbortController(), capturedKey = inputKey, capturedBinding = bindingKey, capturedIdentity = identity;
    let timer: ReturnType<typeof setTimeout> | undefined, finished = false;
    const valid = () => mounted.current && !abort.signal.aborted && sequence.current === invocation && current.current.inputKey === capturedKey && current.current.bindingKey === capturedBinding && current.current.enabled && !accessRef.current.covered && planningIdentity(accessRef.current.context) === capturedIdentity && planningCapability(accessRef.current.context).canCalculate;
    const update = (value: AssessmentPage, owner: string) => { if (valid()) { setPage({ key: dataKey, owner, value }); setRetired(false); } };
    timer = setTimeout(() => {
      ++cancelSequence.current;
      started.current = jobKey;
      setStarting(true); setError(null);
      void (async () => {
        const context = await accessRef.current.ensure(); if (!valid()) return;
        const owner = planningOwnershipStamp(context), ownGeneration = ++generation.current;
        let value = await post<AssessmentPage>('/api/orbital-assessments', context, { generation: ownGeneration, brief: { ...brief, catalogContext }, ...(request ? { request } : {}) }, abort.signal);
        if (!valid() || planningOwnershipStamp(accessRef.current.context) !== owner) return;
        if (value.handle.generation !== ownGeneration) throw new Error('The calculation returned an unrelated generation.');
        running.current = { handle: value.handle, owner }; setStarting(false); update(value, owner);
        while (value.state === 'QUEUED' || value.state === 'RUNNING') {
          await new Promise<void>(resolve => { timer = setTimeout(resolve, 500); });
          if (!valid() || planningOwnershipStamp(accessRef.current.context) !== owner) return;
          value = await post<AssessmentPage>('/api/orbital-assessments/status', context, { ...value.handle, kind: 'OPTIONS' }, abort.signal);
          if (value.handle.generation !== ownGeneration) throw new Error('The calculation returned an unrelated generation.');
          update(value, owner);
        }
        if (running.current?.handle.assessmentId === value.handle.assessmentId) running.current = null;
        finished = true;
      })().catch(failure => { if (valid()) { setStarting(false); setError(message(failure)); } });
    }, 300);
    return () => {
      abort.abort(); if (timer) clearTimeout(timer); ++sequence.current; setStarting(false);
      if (!finished && started.current === jobKey) started.current = null;
      if (running.current) { cancelHandle(running.current.handle, running.current.owner); running.current = null; started.current = null; }
    };
  }, [enabled, inputKey, bindingKey, readiness, stoppedKey, round, access.covered, identity, capability.canCalculate]);
  async function loadMore(kind: 'OPTIONS' | 'OUTCOMES' = 'OPTIONS') {
    if (!page?.nextCursor && page?.kind === kind || !page) return;
    const captured = inputKey, capturedBinding = bindingKey, invocation = sequence.current, handle = page.handle.assessmentId;
    const valid = () => mounted.current && current.current.inputKey === captured && current.current.bindingKey === capturedBinding && sequence.current === invocation && pageRef.current?.handle.assessmentId === handle;
    try {
      const context = await accessRef.current.ensure();
      if (!valid()) return;
      const owner = planningOwnershipStamp(context);
      const value = await post<AssessmentPage>('/api/orbital-assessments/status', context, { ...page.handle, kind, ...(page.kind === kind && page.nextCursor ? { cursor: page.nextCursor } : {}) });
      if (!valid() || accessRef.current.covered || planningOwnershipStamp(accessRef.current.context) !== owner) return;
      setPage({ key: dataKey, owner, value: page.kind === kind ? { ...value, options: [...page.options, ...value.options], outcomes: [...page.outcomes, ...value.outcomes] } : value });
    } catch (failure) { if (valid()) setError(message(failure)); }
  }
  async function recheckOption(option: PlanOption, proposedAtUtc: string, signal: AbortSignal): Promise<PlanOption | null> {
    if (!page || accessRef.current.covered) return null;
    const captured = inputKey, capturedBinding = bindingKey, invocation = sequence.current, handle = JSON.stringify(page.handle);
    const valid = () => mounted.current && !signal.aborted && current.current.enabled && !accessRef.current.covered &&
      current.current.inputKey === captured && current.current.bindingKey === capturedBinding && sequence.current === invocation &&
      JSON.stringify(pageRef.current?.handle) === handle;
    const context = await accessRef.current.ensure();
    if (!valid()) return null;
    const owner = planningOwnershipStamp(context), token = context.contextToken;
    const value = await post<AssessmentRecheckResult>('/api/orbital-assessments/recheck', context, { ...page.handle, optionId: option.id, proposedAtUtc }, signal);
    if (!valid() || planningOwnershipStamp(accessRef.current.context) !== owner || accessRef.current.context?.contextToken !== token ||
      JSON.stringify(value.handle) !== handle || value.option.id !== option.id || value.option.itemId !== option.itemId || value.option.proposedAtUtc !== proposedAtUtc) return null;
    checkedViews.current.set(`${handle}:${option.id}`, { inputKey: captured, bindingKey: capturedBinding, sequence: invocation, owner, token, at: proposedAtUtc, view: value.selectedView });
    return value.option;
  }
  function choose(selection: PlanSelectionInput, option: PlanOption) {
    if (!page || !page.attachmentReference || page.handle.assessmentId !== selection.handle.assessmentId) return;
    setSelection({ key: dataKey, owner: ownershipStamp, value: { selection, option, page } });
  }
  async function viewOption(option: PlanOption, snapshotUtc: string, snapshotSelectedId: string | null) {
    if (!page) return false; const captured = inputKey, capturedBinding = bindingKey, job = sequence.current, handle = page.handle.assessmentId, invocation = ++viewSequence.current; setViewBusy(true);
    const valid = () => mounted.current && current.current.inputKey === captured && current.current.bindingKey === capturedBinding && sequence.current === job && invocation === viewSequence.current && pageRef.current?.handle.assessmentId === handle;
    try {
      const context = await accessRef.current.ensure();
      if (!valid()) return false;
      const owner = planningOwnershipStamp(context);
      const original = page.options.find(value => value.id === option.id);
      if (option.proposedAtUtc !== original?.proposedAtUtc) {
        const checked = checkedViews.current.get(`${JSON.stringify(page.handle)}:${option.id}`);
        if (!checked || checked.inputKey !== captured || checked.bindingKey !== capturedBinding || checked.sequence !== job ||
          checked.owner !== owner || checked.token !== context.contextToken || checked.at !== option.proposedAtUtc || !checked.view ||
          checked.view.atUtc !== option.proposedAtUtc || checked.view.optionId !== option.id || checked.view.itemId !== option.itemId) {
          if (valid()) setError('The edited instant has no current checked position view. Keep the entered time and wait for its fresh checks.');
          return false;
        }
        if (valid() && !accessRef.current.covered && planningOwnershipStamp(accessRef.current.context) === owner) {
          setView({ selected: checked.view, snapshotUtc: view?.snapshotUtc ?? snapshotUtc, snapshotSelectedId: view?.snapshotSelectedId ?? snapshotSelectedId }); return true;
        }
        return false;
      }
      const value = await post<AssessmentPage>('/api/orbital-assessments/status', context, { ...page.handle, optionId: option.id });
      if (valid() && !accessRef.current.covered && planningOwnershipStamp(accessRef.current.context) === owner && value.selectedView) {
        setView({ selected: value.selectedView, snapshotUtc: view?.snapshotUtc ?? snapshotUtc, snapshotSelectedId: view?.snapshotSelectedId ?? snapshotSelectedId }); return true;
      }
      if (valid() && !value.selectedView) setError('The checked opportunity position is not available yet. Keep your inputs and inspect the completed calculation.');
      return false;
    } catch (failure) { if (valid()) setError(message(failure)); return false; }
    finally { if (current.current.inputKey === captured && invocation === viewSequence.current) setViewBusy(false); }
  }
  return { missing, ready, capability, ownershipStamp, requestBound: !!request, retired, page, starting, error, chosen, view, viewBusy, choose, loadMore, viewOption, recheckOption,
    recheckIdentity: JSON.stringify({ inputKey, bindingKey, handle: page?.handle, owner: contextKey(access.context), token: access.context?.contextToken, covered: access.covered }),
    recheckAllowed: !access.covered && !!access.context,
    cancellationRequested: stoppedKey === inputKey && !!page && ['QUEUED', 'RUNNING'].includes(page.state),
    optionDrafts: !access.covered && edits.key === dataKey && edits.owner === ownershipStamp ? edits.values : {},
    editOption: (key: string, patch: Partial<PlanOptionEdits>, initial: PlanOptionEdits) => {
      setSelection(null);
      setEdits(previous => ({ key: dataKey, owner: ownershipStamp, values: { ...(previous.key === dataKey && previous.owner === ownershipStamp ? previous.values : {}), [key]: { ...(previous.key === dataKey && previous.owner === ownershipStamp ? previous.values[key] ?? initial : initial), ...patch } } }));
    },
    clearChoice: () => setSelection(null), returnToBrowsing: () => { ++viewSequence.current; setViewBusy(false); setView(null); },
    cancel: () => {
      const invocation = ++cancelSequence.current;
      setStoppedKey(inputKey);
      if (running.current) {
        const handle = running.current.handle, ctx = accessRef.current.context, captured = inputKey, capturedBinding = bindingKey;
        const owner = planningOwnershipStamp(ctx), handleStamp = JSON.stringify(handle);
        if (ctx && !accessRef.current.covered) void post<AssessmentPage>('/api/orbital-assessments/cancel', ctx, { ...handle }).then(value => {
          if (mounted.current && cancelSequence.current === invocation && current.current.inputKey === captured &&
            current.current.bindingKey === capturedBinding && !accessRef.current.covered && planningOwnershipStamp(accessRef.current.context) === owner &&
            JSON.stringify(pageRef.current?.handle) === handleStamp && JSON.stringify(value.handle) === handleStamp) setPage({ key: dataKey, owner, value });
        }).catch(() => {});
      }
    },
    retry: () => { checkedViews.current.clear(); ++sequence.current; ++viewSequence.current; ++cancelSequence.current; setViewBusy(false); setStoppedKey(null); setSelection(null); setPage(null); setRound(value => value + 1); },
    reset: () => { checkedViews.current.clear(); ++sequence.current; ++viewSequence.current; ++cancelSequence.current; setViewBusy(false); setStoppedKey(null); setSelection(null); setPage(null); setView(null); },
    /** Only the explicit server-nonce public handoff can carry a completed choice. */
    prepareHandoff: (handle: AssessmentHandle) => {
      if (accessRef.current.context?.audience !== 'PUBLIC' || !page || !chosen || handle.assessmentId !== page.handle.assessmentId || handle.assessmentId !== chosen.selection.handle.assessmentId) return false;
      handoff.current = { assessmentId: handle.assessmentId, inputKey, bindingKey, page, chosen, edits: edits.key === dataKey && edits.owner === ownershipStamp ? edits.values : {} };
      return true;
    },
    adoptHandoff: (handle: AssessmentHandle, attachmentReference: string) => {
      const currentContext = accessRef.current.context, continuation = currentContext?.planningHandoff, held = handoff.current;
      if (!held || !planningCapability(currentContext).canSave || continuation?.phase !== 'COMPLETE' ||
        continuation.result.attachmentReference !== attachmentReference || JSON.stringify(continuation.result.handle) !== JSON.stringify(handle) ||
        held.assessmentId !== handle.assessmentId || held.inputKey !== inputKey || held.bindingKey !== bindingKey) return;
      const owner = planningOwnershipStamp(currentContext), restored = { ...held.page, handle, attachmentReference };
      setPage({ key: dataKey, owner, value: restored });
      setSelection({ key: dataKey, owner, value: { ...held.chosen, page: restored, selection: { ...held.chosen.selection, handle, attachmentReference } } });
      setEdits({ key: dataKey, owner, values: held.edits }); setRetired(false); handoff.current = null;
    },
  };
}
export type ProposedPlanController = ReturnType<typeof useProposedPlan>;
