import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Panel } from '../shell/Panel.js';

export interface PrivateFormMemory<T> {
  value: T; baseline: string; dirty: boolean; contextStamp: string; recordStamp: string;
  preview: unknown | null; attempt: unknown | null; uncertain: boolean; error: string | null;
  pendingCommand?: string | null;
  inFlight?: boolean;
  boundBriefRevision?: number;
  boundRequestStatus?: string;
  freshAuthoringRevision?: number;
  forceNewQuote?: boolean;
  fieldErrors: Record<string, string>;
}
const entries = new Map<string, PrivateFormMemory<unknown>>();
const subscriptions = new Map<string, Set<() => void>>();
const activeForms = new Map<string, number>();
const allListeners = new Set<() => void>();
let departurePrompt: (() => Promise<boolean>) | null = null;
const serialize = (value: unknown) => JSON.stringify(value);
function write<T>(key: string, value: PrivateFormMemory<T>) {
  entries.set(key, value); subscriptions.get(key)?.forEach(listener => listener()); allListeners.forEach(listener => listener());
}
export function privateFormKey(actorId: string, audience: string, organizationId: string, requestId: string, form: string): string {
  return JSON.stringify([actorId, audience, organizationId, requestId, form]);
}
export function usePrivateDraft<T>(key: string, contextStamp: string, recordStamp: string, initial: T, boundBriefRevision?: number, boundRequestStatus?: string) {
  const initialText = serialize(initial);
  useMemo(() => {
    if (!entries.has(key)) entries.set(key, { value: structuredClone(initial), baseline: initialText, dirty: false, contextStamp, recordStamp, boundBriefRevision, boundRequestStatus, preview: null, attempt: null, uncertain: false, error: null, fieldErrors: {} });
  }, [key]);
  const entry = useSyncExternalStore(listener => {
    const list = subscriptions.get(key) ?? new Set(); list.add(listener); subscriptions.set(key, list);
    return () => { list.delete(listener); };
  }, () => entries.get(key) as PrivateFormMemory<T>);
  useEffect(() => {
    activeForms.set(key, (activeForms.get(key) ?? 0) + 1);
    allListeners.forEach(listener => listener());
    return () => { const count = (activeForms.get(key) ?? 1) - 1; if (count) activeForms.set(key, count); else activeForms.delete(key); allListeners.forEach(listener => listener()); };
  }, [key]);
  useEffect(() => {
    const current = entries.get(key)! as PrivateFormMemory<T>;
    const contextChanged = current.contextStamp !== contextStamp;
    const recordChanged = current.recordStamp !== recordStamp;
    if (contextChanged || recordChanged || (!current.dirty && current.baseline !== initialText)) {
      const preserveAttempt = !contextChanged && current.uncertain && !!current.attempt;
      write(key, { ...current, value: current.dirty || preserveAttempt ? current.value : structuredClone(initial), baseline: current.dirty ? current.baseline : initialText, contextStamp, recordStamp,
        boundBriefRevision: current.dirty || preserveAttempt ? current.boundBriefRevision : boundBriefRevision,
        boundRequestStatus: current.dirty || preserveAttempt ? current.boundRequestStatus : boundRequestStatus,
        preview: preserveAttempt ? current.preview : null, attempt: preserveAttempt ? current.attempt : null, pendingCommand: preserveAttempt ? current.pendingCommand : null, inFlight: preserveAttempt ? current.inFlight : false, uncertain: preserveAttempt,
        error: preserveAttempt ? current.error : current.dirty && (contextChanged || recordChanged) ? 'The context or saved request changed. Your input is retained; review the current record before confirming again.' : null, fieldErrors: {} });
    }
  }, [key, contextStamp, recordStamp, initialText, boundBriefRevision, boundRequestStatus]);
  const set = (patch: Partial<PrivateFormMemory<T>>) => write(key, { ...(entries.get(key) as PrivateFormMemory<T>), ...patch });
  return {
    entry,
    set,
    change: (next: T | ((current: T) => T)) => {
      const current = entries.get(key) as PrivateFormMemory<T>;
      if (current.uncertain) return;
      const value = typeof next === 'function' ? (next as (current: T) => T)(current.value) : next;
      set({ value, dirty: serialize(value) !== current.baseline, preview: null, attempt: null, pendingCommand: null, uncertain: false, error: null, fieldErrors: {} });
    },
    saved: (value: T, revision = boundBriefRevision) => set({ value, baseline: serialize(value), dirty: false, boundBriefRevision: revision, preview: null, attempt: null, pendingCommand: null, inFlight: false, uncertain: false, error: null, fieldErrors: {} }),
  };
}
export function startFreshPrivatePreparation<T>(key: string, value: T, contextStamp: string, recordStamp: string, revision: number) {
  const current = entries.get(key); if (!current || current.uncertain || current.inFlight) return;
  if (current.dirty) {
    const identity = JSON.parse(key) as string[]; identity[4] = `quote-prior:${current.boundBriefRevision ?? 'unknown'}:${crypto.randomUUID()}`;
    write(JSON.stringify(identity), { ...structuredClone(current), preview: null, attempt: null, pendingCommand: null, uncertain: false, inFlight: false });
  }
  write(key, { ...current, value: structuredClone(value), baseline: serialize(value), dirty: false, contextStamp, recordStamp, boundBriefRevision: revision, freshAuthoringRevision: revision, forceNewQuote: true, preview: null, attempt: null, pendingCommand: null, uncertain: false, inFlight: false, error: null, fieldErrors: {} });
}
export function privatePreparationBinding(key: string) { const entry = entries.get(key); return { forceNewQuote: entry?.forceNewQuote ?? false, freshAuthoringRevision: entry?.freshAuthoringRevision }; }
export function usePriorPrivatePreparations<T>(actorId: string, audience: string, organizationId: string, requestId: string) {
  const [, update] = useState(0);
  useEffect(() => { const listener = () => update(value => value + 1); allListeners.add(listener); return () => { allListeners.delete(listener); }; }, []);
  return [...entries.entries()].filter(([key]) => { const id = JSON.parse(key) as string[]; return id[0] === actorId && id[1] === audience && id[2] === organizationId && id[3] === requestId && id[4]?.startsWith('quote-prior:'); }).map(([key, entry]) => ({ key, entry: entry as PrivateFormMemory<T> }));
}
export function useEarlierMessagePreparations(actorId: string, audience: string, organizationId: string, requestId: string, currentForm: string) {
  const [, update] = useState(0);
  useEffect(() => { const listener = () => update(value => value + 1); allListeners.add(listener); return () => { allListeners.delete(listener); }; }, []);
  return [...entries.entries()].filter(([key, entry]) => {
    const id = JSON.parse(key) as string[];
    return id[0] === actorId && id[1] === audience && id[2] === organizationId && id[3] === requestId && id[4]?.startsWith('clarification:') && id[4] !== currentForm && entry.dirty;
  }).map(([key, entry]) => ({ key, command: (JSON.parse(key) as string[])[4]!.slice('clarification:'.length), entry: entry as PrivateFormMemory<{ message: string }> }));
}
export function useRetainedMaterialPreparations(actorId: string, audience: string, organizationId: string, requestId: string, slots: string[]) {
  const [, update] = useState(0);
  useEffect(() => { const listener = () => update(value => value + 1); allListeners.add(listener); return () => { allListeners.delete(listener); }; }, []);
  return [...entries.entries()].filter(([key, entry]) => {
    const id = JSON.parse(key) as string[];
    return id[0] === actorId && id[1] === audience && id[2] === organizationId && id[3] === requestId && slots.includes(id[4] ?? '') && (entry.dirty || entry.uncertain);
  }).map(([key, entry]) => ({ key, slot: (JSON.parse(key) as string[])[4]!, entry }));
}
export function usePendingPrivateAttempts(actorId: string, audience: string, organizationId: string, requestId: string, contextStamp: string) {
  const [, update] = useState(0);
  useEffect(() => { const listener = () => update(value => value + 1); allListeners.add(listener); return () => { allListeners.delete(listener); }; }, []);
  return [...entries.entries()].filter(([key, value]) => {
    const identity = JSON.parse(key) as string[];
    return identity[0] === actorId && identity[1] === audience && identity[2] === organizationId && identity[3] === requestId && value.contextStamp === contextStamp && value.uncertain && value.attempt && value.pendingCommand && !activeForms.has(key);
  }).map(([key, entry]) => ({ key, entry }));
}
export function settlePrivateAttempt(key: string, error?: string) {
  const current = entries.get(key); if (!current) return;
  const value = current.pendingCommand === 'askCustomer' || current.pendingCommand === 'replyToTeam' || current.pendingCommand === 'staffReply' ? { message: '' } : current.value;
  write(key, { ...current, value: error ? current.value : value, baseline: error ? current.baseline : serialize(value), dirty: error ? current.dirty : false, preview: null, attempt: null, pendingCommand: null, uncertain: false, error: error ?? null, fieldErrors: {} });
}
export function hasActivePrivateDraft(): boolean {
  return [...activeForms.keys()].some(key => entries.get(key)?.dirty || entries.get(key)?.uncertain);
}
export async function requestPrivateDeparture(): Promise<boolean> {
  if (!hasActivePrivateDraft()) return true;
  return departurePrompt ? departurePrompt() : false;
}
export class PrivateDepartureCancelled extends Error {}
export function PrivateDraftGuard() {
  const navigate = useNavigate(); const location = useLocation();
  const [pending, setPending] = useState<((answer: boolean) => void) | null>(null);
  const resolvers = useRef<((answer: boolean) => void)[]>([]);
  const navigation = useRef({ path: location.pathname + location.search, index: Number(history.state?.idx ?? 0) });
  const restorePop = useRef(false); const bypassPop = useRef(false);
  useEffect(() => { navigation.current = { path: location.pathname + location.search, index: Number(history.state?.idx ?? 0) }; }, [location.pathname, location.search]);
  useEffect(() => {
    departurePrompt = () => new Promise(resolve => {
      resolvers.current.push(resolve);
      setPending(() => (answer: boolean) => { const callbacks = resolvers.current.splice(0); setPending(null); callbacks.forEach(callback => callback(answer)); });
    });
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !hasActivePrivateDraft()) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin || target.pathname + target.search === navigation.current.path) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void requestPrivateDeparture().then(leave => { if (leave) navigate(target.pathname + target.search + target.hash); });
    };
    const unload = (event: BeforeUnloadEvent) => { if (hasActivePrivateDraft()) { event.preventDefault(); event.returnValue = ''; } };
    const pop = (event: PopStateEvent) => {
      if (bypassPop.current) { bypassPop.current = false; return; }
      if (restorePop.current) { restorePop.current = false; return; }
      if (!hasActivePrivateDraft()) return;
      const previous = navigation.current.index; const target = Number(event.state?.idx);
      if (!Number.isFinite(target) || target === previous) return;
      event.stopImmediatePropagation(); restorePop.current = true; history.go(previous - target);
      void requestPrivateDeparture().then(leave => { if (leave) { bypassPop.current = true; history.go(target - previous); } });
    };
    document.addEventListener('click', click, true); window.addEventListener('beforeunload', unload); window.addEventListener('popstate', pop, true);
    return () => { departurePrompt = null; document.removeEventListener('click', click, true); window.removeEventListener('beforeunload', unload); window.removeEventListener('popstate', pop, true); resolvers.current.splice(0).forEach(resolve => resolve(false)); };
  }, [navigate]);
  return pending ? <Panel title="Keep your private draft?" close={() => pending(false)}><div className="sheet-body"><p className="eyebrow">UNSENT PRIVATE WORK</p><h1>Keep your draft here?</h1><p>Your unsent input stays only in this tab, kept for the same customer or staff context, workspace and request. Continuing does not submit or transfer it. Return with the same permitted context to review it again.</p><div className="sheet-actions"><button className="button primary" onClick={() => pending(false)}>Stay here</button><button className="button" onClick={() => pending(true)}>Keep draft and continue</button></div></div></Panel> : null;
}
