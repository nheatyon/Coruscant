import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { message } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';
import { PrivateDepartureCancelled } from '../../lib/privateDrafts.js';
import { planningCapability } from './planning-context.js';

export function PlanningContext({ privateRequest = false }: { privateRequest?: boolean }) {
  const { context, covered, error, refresh } = useCurrentContext();
  const capability = planningCapability(context);
  const role = context?.role === 'OWNER' ? 'Owner' : context?.role === 'REQUESTER' ? 'Requester' : context?.role === 'VIEWER' ? 'Viewer' : 'No workspace role';
  return <section className="notice planning-context" aria-label="Planning context and permissions">
    <p className="eyebrow">CURRENT CONTEXT / PLANNING PERMISSIONS</p>
    <h2>{covered || !context ? 'Checking planning access' : context.audience === 'PUBLIC' ? 'Public visitor' : context.actor?.name ?? 'Current demonstration context'}</h2>
    {!covered && context && <p>{context.organization ? `${context.organization.name} · ${role}` : context.audience === 'STAFF' ? 'Staff context · customer planning is separate' : context.audience === 'CUSTOMER' ? 'No customer workspace selected' : 'No customer workspace or identity is selected'}</p>}
    <p>Catalog search: available in every context. Automatic calculation: {covered ? 'waiting for current access' : capability.canCalculate ? 'available for ready inputs' : 'unavailable in this context'}. Saving Planning: {!covered && capability.canSave ? 'available after explicit review' : 'requires a selected customer workspace and an Owner or Requester'}.</p>
    {!covered && capability.kind === 'VIEWER' && <p>Your Viewer role is read-only. Retrying cannot grant calculation or save permission. You can keep the brief, choose a different customer, or deliberately continue as a public visitor.</p>}
    {!covered && capability.kind === 'STAFF' && <p>Staff can inspect permitted saved work. Technical calculation belongs to a public visitor or a customer Owner or Requester; staff entry does not grant either role.</p>}
    {!covered && capability.kind === 'NO_WORKSPACE' && <p>{context?.memberships.length ? 'Choose a permitted workspace to use its actual role.' : 'This customer has no configured workspace access. Choose a different customer or continue as a visitor.'}</p>}
    {!covered && capability.kind === 'PUBLIC' && <p>You can calculate locally before customer entry. Saving still requires explicit customer and workspace review; nothing is saved or booked automatically.</p>}
    <p className="helper">{privateRequest ? 'This saved request and its private draft stay with their original customer and workspace. Recovery opens public StarSearch without transferring that private input.' : 'Your same-tab public question, target, timing and contact draft remain when changing access. Calculated options belong to their creating context.'}</p>
    {covered ? error && <><p role="alert">{error}</p><button type="button" className="button" onClick={() => void refresh()}>Check current access</button></> : <div className="plan-option-actions">
      <Link className="button" to="/access?returnTo=%2F%3Fbrief%3Dedit">Choose customer access</Link>
      {context?.audience === 'CUSTOMER' && !!context.memberships.length && <Link className="button" to="/workspaces?returnTo=%2F%3Fbrief%3Dedit">Choose planning workspace</Link>}
      {context?.audience !== 'PUBLIC' && <VisitorTransition />}
    </div>}
  </section>;
}

/** An explicit visitor transition uses the existing guarded leave operation. */
export function VisitorTransition({ to = '/?brief=edit', label = 'Continue as visitor' }: { to?: string; label?: string }) {
  const access = useCurrentContext(), navigate = useNavigate();
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const visit = async () => {
    setBusy(true); setFailure(null);
    try { if (access.context?.audience !== 'PUBLIC') await access.enter('/api/demo/leave'); navigate(to); }
    catch (cause) { if (!(cause instanceof PrivateDepartureCancelled)) setFailure(message(cause)); }
    finally { setBusy(false); }
  };
  return <><button type="button" className="button" disabled={busy || access.covered || !access.context} onClick={() => void visit()}>{busy ? 'Changing to visitor…' : label}</button>{failure && <p className="inline-error" role="alert">{failure}</p>}</>;
}
