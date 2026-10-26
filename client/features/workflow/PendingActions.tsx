import { useEffect, useRef, useState } from 'react';
import type { WorkflowRecord } from './useWorkflow.js';
import type { WorkflowCommandEnvelope, WorkflowOutcome } from '../../../shared/workflow.js';
import { ApiError, contextKey, message, post } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';
import { settlePrivateAttempt, usePendingPrivateAttempts } from '../../lib/privateDrafts.js';

const actionLabels: Record<string, string> = { saveProposedPlan: 'proposed-plan save', submitPlanningRequest: 'review submission', recordDelivery: 'delivery', createObservation: 'observation save', updateObservation: 'observation save', deleteObservation: 'observation deletion', createResultSet: 'result creation', saveResultDraft: 'metadata save', prepareDemoPair: 'pair preparation', saveImageMetadata: 'image metadata save', approveImage: 'image approval', publishImage: 'image publication', saveFindingDraft: 'finding save', reviewFinding: 'finding review', publishFinding: 'finding publication', withdrawFinding: 'withdrawal', grantResultAccess: 'access change', saveQuoteDraft: 'draft save', publishQuote: 'publication', acceptQuote: 'acceptance', declineQuote: 'decline', recordInitialSchedule: 'schedule', reviseBrief: 'revision', askCustomer: 'question', replyToTeam: 'reply', staffReply: 'reply', startReview: 'review start' };
/** A changed saved state must not hide an unresolved original command after a covered remount. */
export function PendingActions({ request, saved }: { request: WorkflowRecord; saved: (text: string) => void }) {
  const { context, covered } = useCurrentContext(); const stamp = contextKey(context);
  const pending = usePendingPrivateAttempts(context?.actor?.id ?? '', context?.audience ?? '', request.organizationId, request.id, stamp);
  const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const live = useRef(true); const current = useRef({ stamp, covered }); current.current = { stamp, covered };
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const retry = async (key: string, name: string, envelope: WorkflowCommandEnvelope) => {
    if (!context || covered || busy) return;
    const captured = stamp; setBusy(key); setError(null);
    try {
      const outcome = await post<WorkflowOutcome>(`/api/commands/${name}`, context, { ...envelope });
      if (!live.current || current.current.covered || current.current.stamp !== captured) return;
      settlePrivateAttempt(key); saved(outcome.message || 'Saved. The latest request is shown below.');
    } catch (failure) {
      if (!live.current || current.current.covered || current.current.stamp !== captured) return;
      const text = message(failure); setError(text);
      if (failure instanceof ApiError && failure.status < 500) settlePrivateAttempt(key, text);
    } finally { if (live.current && current.current.stamp === captured) setBusy(null); }
  };
  if (!pending.length && !error) return null;
  return <section className="notice warning" aria-label="Uncertain saved action"><strong>Recover the original action outcome</strong><p>The saved request may have advanced while its response was unavailable. These are the original unchanged attempts, bound to this context; retrying does not create another record or decision.</p>{error && <p className="inline-error" role="alert">{error} Your input is retained in its original form.</p>}{pending.map(item => <button key={item.key} className="button" disabled={!!busy || item.entry.inFlight} onClick={() => void retry(item.key, item.entry.pendingCommand!, item.entry.attempt as WorkflowCommandEnvelope)}>{busy === item.key || item.entry.inFlight ? 'Checking original outcome…' : `Retry same ${actionLabels[item.entry.pendingCommand!] ?? 'action'}`}</button>)}</section>;
}
