import { useEffect, useRef, useState } from 'react';
import type { RequestProjection } from '../../../shared/contracts.js';
import type { WorkflowCommandEnvelope, WorkflowCommandName, WorkflowExpected, WorkflowOutcome, WorkflowPayloads, WorkflowReview, WorkflowTarget } from '../../../shared/workflow.js';
import { ApiError, contextKey, message, post } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';
import { privateFormKey, usePrivateDraft } from '../../lib/privateDrafts.js';

/** Raw private work and unchanged retry envelopes live only in this tab, under the original authority. */
type ChildBinding = { target?: Omit<WorkflowTarget, 'requestId'>; expected?: Omit<WorkflowExpected, 'requestVersion' | 'briefRevision' | 'quoteContentVersion'> };
export type WorkflowRecord = Pick<RequestProjection, 'id' | 'organizationId' | 'requestVersion' | 'briefRevision'> & { status?: RequestProjection['status'] };
export function useWorkflow<T>(request: WorkflowRecord, form: string, initial: T, onSaved: (text: string) => void, childStamp = '') {
  const { context, covered } = useCurrentContext();
  const stamp = contextKey(context); const record = `${request.requestVersion}:${request.briefRevision}${childStamp ? `:${childStamp}` : ''}`; const current = useRef({ stamp, covered, record }); current.current = { stamp, covered, record };
  const reviewSequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = privateFormKey(context?.actor?.id ?? '', context?.audience ?? 'PUBLIC', request.organizationId, request.id, form);
  const memory = usePrivateDraft(key, stamp, record, initial, request.briefRevision, request.status);
  useEffect(() => () => { memory.set({ inFlight: false }); }, [key]);
  const [busy, setBusy] = useState(false);
  const bindingChanged = memory.entry.contextStamp !== stamp || memory.entry.recordStamp !== record;
  const preserveAttempt = memory.entry.contextStamp === stamp && memory.entry.uncertain && !!memory.entry.attempt;
  // A changed binding must not render a stale confirmation while the store effect catches up.
  const visibleEntry = bindingChanged && !preserveAttempt ? { ...memory.entry, preview: null, attempt: null, pendingCommand: null, inFlight: false, uncertain: false } : memory.entry;
  const preview = visibleEntry.preview as WorkflowReview | null;
  const attempt = visibleEntry.attempt as WorkflowCommandEnvelope | null;
  const matches = (captured: string) => mounted.current && current.current.stamp === captured && !current.current.covered;
  const expected = (quoteContentVersion?: number): WorkflowExpected => ({ requestVersion: request.requestVersion, briefRevision: request.briefRevision, ...(quoteContentVersion === undefined ? {} : { quoteContentVersion }) });
  const fail = (error: unknown, uncertain: boolean) => memory.set({ error: message(error), uncertain, fieldErrors: error instanceof ApiError ? error.body.fieldErrors ?? {} : {} });
  async function review<K extends WorkflowCommandName>(name: K, payload: WorkflowPayloads[K], quoteId?: string, version?: number, child: ChildBinding = {}) {
    if (!context || covered || busy || memory.entry.uncertain) return;
    const captured = stamp; const invocation = ++reviewSequence.current; const capturedRecord = record;
    setBusy(true); memory.set({ error: null, fieldErrors: {}, preview: null, attempt: null });
    try {
      const value = await post<WorkflowReview>(`/api/command-reviews/${name}`, context, { target: { requestId: request.id, ...(quoteId ? { quoteId } : {}), ...child.target }, expected: { ...expected(version), ...child.expected }, payload });
      if (matches(captured) && invocation === reviewSequence.current && current.current.record === capturedRecord) memory.set({ preview: value });
    } catch (error) { if (matches(captured)) fail(error, false); }
    finally { if (matches(captured)) setBusy(false); }
  }
  async function execute<K extends WorkflowCommandName>(name: K, payload: WorkflowPayloads[K], options: ChildBinding & { quoteId?: string; quoteContentVersion?: number; direct?: boolean } = {}) {
    if (!context || covered || busy) return;
    if (!attempt && !options.direct && (!preview || preview.commandName !== name || preview.contextGeneration !== context.contextGeneration)) return;
    const target: WorkflowTarget = { requestId: request.id, ...(options.quoteId ? { quoteId: options.quoteId } : {}), ...options.target };
    const command: WorkflowCommandEnvelope = attempt ?? {
      commandId: crypto.randomUUID(), contextGeneration: context.contextGeneration, contextToken: context.contextToken!,
      target, expected: { ...expected(options.quoteContentVersion), ...options.expected }, payload: structuredClone(payload), ...(!options.direct && preview ? { reviewToken: preview.reviewToken } : {}),
    };
    const captured = stamp; setBusy(true); memory.set({ attempt: command, pendingCommand: name, inFlight: true, uncertain: true, error: null, fieldErrors: {} });
    try {
      const value = await post<WorkflowOutcome>(`/api/commands/${name}`, context, { ...command });
      if (!matches(captured)) return;
      memory.saved(memory.entry.value, command.expected.briefRevision);
      if (name === 'saveQuoteDraft') memory.set({ forceNewQuote: false });
      onSaved(value.detailsUnavailable ? `${value.message} Saved, but refreshed details are temporarily unavailable. Do not repeat this as a new action.` : value.message || 'Saved. The latest request is shown below.');
    } catch (error) {
      if (!matches(captured)) return;
      const uncertain = !(error instanceof ApiError) || error.status >= 500;
      fail(error, uncertain);
      if (!uncertain) memory.set({ preview: null, attempt: null, pendingCommand: null });
    } finally { if (matches(captured)) { memory.set({ inFlight: false }); setBusy(false); } }
  }
  return { ...memory, key, entry: visibleEntry, busy, preview, attempt, review, execute,
    change: (value: T | ((current: T) => T)) => { ++reviewSequence.current; memory.change(value); },
    clearPreview: () => { if (!memory.entry.uncertain) memory.set({ preview: null, attempt: null, error: null, fieldErrors: {} }); },
    errors: (errors: Record<string, string>) => memory.set({ fieldErrors: errors, error: null, preview: null, attempt: null }),
  };
}
