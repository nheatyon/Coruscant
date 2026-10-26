import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Context } from '../../shared/contracts.js';
import { api, post, ContextChangedError } from './api.js';
import { PrivateDepartureCancelled, requestPrivateDeparture } from './privateDrafts.js';

interface ContextState {
  context: Context | null; covered: boolean; error: string | null;
  refresh: (cover?: boolean) => Promise<Context | null>;
  enter: (path: string, payload?: Record<string, unknown>) => Promise<Context>;
  ensure: () => Promise<Context>;
}
const CurrentContext = createContext<ContextState | null>(null);
/** GET rechecks do not repeat an entry-only handoff projection. Preserve only the
 * server-issued value for this exact still-current opaque context, in memory. */
function retainPlanningHandoff(value: Context, previous: Context | null): Context {
  if (!value.planningHandoff && previous?.planningHandoff &&
    value.audience === previous.audience && value.actor?.id === previous.actor?.id &&
    value.organization?.id === previous.organization?.id && value.contextGeneration === previous.contextGeneration &&
    value.contextToken === previous.contextToken && value.csrfToken === previous.csrfToken) {
    return { ...value, planningHandoff: previous.planningHandoff };
  }
  return value;
}
export function ContextProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<Context | null>(null);
  const [covered, setCovered] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<Context | null>(null);
  const sequence = useRef(0);
  const activeEntry = useRef<number | null>(null);
  const ensureFlight = useRef<Promise<Context> | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const refresh = useCallback(async (cover = true): Promise<Context | null> => {
    // Routine polls defer to intentional entry and fresh public checks. Deliberate
    // lifecycle covers still advance the generation and invalidate pending work.
    if (!cover && (activeEntry.current !== null || ensureFlight.current !== null)) return current.current;
    const request = ++sequence.current;
    if (cover) setCovered(true);
    try {
      let value = await api<Context>('/api/context');
      if (request !== sequence.current) return null;
      value = retainPlanningHandoff(value, current.current);
      current.current = value; setContext(value); setError(null); setCovered(document.visibilityState === 'hidden'); return value;
    } catch {
      if (request === sequence.current) { setCovered(true); setError('We could not check your current access. Your unsent input is retained behind this cover.'); }
      return null;
    }
  }, []);
  // Explicit public actions need an opaque context for CSRF, never a selected persona or navigation.
  const ensure = useCallback((): Promise<Context> => {
    if (ensureFlight.current) return ensureFlight.current;
    const task = (async () => {
      if (activeEntry.current !== null || document.visibilityState === 'hidden') throw new ContextChangedError('Access is changing. Try this action again when the current context is visible.');
      // A cached CSRF token does not prove current access. Own a fresh check before
      // lowering an existing cover, and invalidate any older refresh response.
      const invocation = ++sequence.current;
      try {
        let value = await api<Context>('/api/context');
        const valid = () => {
          if (invocation !== sequence.current || activeEntry.current !== null || document.visibilityState === 'hidden') throw new ContextChangedError('Access changed while preparing this action. Your input is retained.');
        };
        valid();
        if (!value.csrfToken) value = await api<Context>('/api/demo/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        valid(); value = retainPlanningHandoff(value, current.current); current.current = value; setContext(value); setError(null); setCovered(false); return value;
      } catch (failure) {
        if (invocation === sequence.current && activeEntry.current === null) {
          setCovered(true); setError('We could not check your current access. Your unsent input is retained behind this cover.');
        }
        throw failure;
      }
    })();
    ensureFlight.current = task;
    void task.finally(() => { if (ensureFlight.current === task) ensureFlight.current = null; }).catch(() => {});
    return task;
  }, []);
  const enter = useCallback(async (path: string, payload: Record<string, unknown> = {}): Promise<Context> => {
    if (!await requestPrivateDeparture()) throw new PrivateDepartureCancelled('Stayed with the private draft.');
    setCovered(true); const transition = ++sequence.current;
    activeEntry.current = transition;
    const stillCurrent = () => {
      if (transition !== sequence.current || document.visibilityState === 'hidden') throw new ContextChangedError('Access changed while this action was in progress. Review the current context before continuing.');
    };
    try {
      let value = current.current ?? await api<Context>('/api/context');
      stillCurrent();
      if (!value.csrfToken) value = await api<Context>('/api/demo/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      stillCurrent();
      value = await post<Context>(path, value, payload);
      stillCurrent();
      current.current = value; setContext(value); setError(null); setCovered(false);
      channel.current?.postMessage({ changed: true });
      return value;
    } catch (failure) {
      // An older entry cannot cancel a newer entry by launching another cover check.
      if (activeEntry.current === transition) { activeEntry.current = null; await refresh(); }
      throw failure;
    } finally { if (activeEntry.current === transition) activeEntry.current = null; }
  }, [refresh]);
  useEffect(() => {
    void refresh();
    // Native lifecycle events may be followed immediately by a bfcache snapshot.
    // Commit the cover synchronously so that snapshot contains no private DOM.
    const hide = () => { ++sequence.current; flushSync(() => setCovered(true)); };
    const restore = () => { if (document.visibilityState !== 'hidden') { hide(); void refresh(true); } };
    const visibility = () => document.visibilityState === 'hidden' ? hide() : restore();
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', restore);
    window.addEventListener('focus', restore); document.addEventListener('visibilitychange', visibility);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(false); }, 15_000);
    if ('BroadcastChannel' in window) {
      channel.current = new BroadcastChannel('coruscant-context');
      channel.current.onmessage = () => { hide(); void refresh(true); };
    }
    return () => { clearInterval(timer); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', restore); window.removeEventListener('focus', restore); document.removeEventListener('visibilitychange', visibility); channel.current?.close(); };
  }, [refresh]);
  return <CurrentContext.Provider value={{ context, covered, error, refresh, enter, ensure }}>{children}</CurrentContext.Provider>;
}
export function useCurrentContext(): ContextState {
  const value = useContext(CurrentContext);
  if (!value) throw new Error('Missing context provider');
  return value;
}
