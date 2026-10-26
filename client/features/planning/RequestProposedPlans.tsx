import { useEffect, useMemo, useRef, useState } from 'react';
import type { Context, PublicCatalog, RequestProjection } from '../../../shared/contracts.js';
import type { PlanOption, PlanSelectionInput } from '../../../shared/plan-contracts.js';
import { planningToInput, revisionAllowed } from '../../../shared/workflow.js';
import { emptyDiscoveryValues, makeDiscoveryDictionary } from '../../../shared/discovery.js';
import { api, contextKey, message } from '../../lib/api.js';
import { requestPrivateDeparture } from '../../lib/privateDrafts.js';
import { useCurrentContext } from '../../lib/context.js';
import { Panel } from '../../shell/Panel.js';
import { useSavedCatalogDictionary } from '../discovery/useCatalogSources.js';
import { ActionNotice, BriefFacts, Errors, formatTime } from '../workflow/WorkflowUI.js';
import { useWorkflow } from '../workflow/useWorkflow.js';
import { ProposedPlan, ProposedPlanFacts } from './ProposedPlan.js';
import { useProposedPlan, type PlanOptionEdits } from './useProposedPlan.js';
import { RealPredictionStage } from '../globe/RealPredictionLayer.js';

interface PlanDraft { selection: PlanSelectionInput | null; option: PlanOption | null; optionDrafts: Record<string, PlanOptionEdits>; selectionOwner?: string | null }
export function RequestProposedPlans({ request, catalog, staff, saved, reload }: { request: RequestProjection; catalog: PublicCatalog | null; staff: boolean; saved: (text: string) => void; reload: () => void }) {
  const { context } = useCurrentContext(), [opened, setOpened] = useState(false), opener = useRef<HTMLElement | null>(null);
  const [browsingUtc, setBrowsingUtc] = useState(context?.serverNow ?? ''), [selectedId, setSelectedId] = useState<string | null>(null);
  const [globeOpen, setGlobeOpen] = useState(false), [viewError, setViewError] = useState<string | null>(null);
  const currentContext = useRef(contextKey(context)); currentContext.current = contextKey(context);
  const accepted = ['Accepted', 'Scheduled', 'Delivered'].includes(request.status);
  const writer = !staff && context?.audience === 'CUSTOMER' && context.organization?.id === request.organizationId && ['OWNER', 'REQUESTER'].includes(context.role ?? '');
  const writable = writer && !accepted && revisionAllowed(request.status);
  const raw = useMemo(() => planningToInput(request.brief), [request.brief]);
  const fallback = useMemo(() => makeDiscoveryDictionary(catalog?.items ?? []), [catalog]);
  const source = useSavedCatalogDictionary(request.brief.catalogContext, fallback);
  const binding = { requestId: request.id, requestVersion: request.requestVersion, briefRevision: request.briefRevision };
  const planner = useProposedPlan({ brief: raw, dictionary: source.dictionary, catalogContext: request.brief.catalogContext ?? { sourceKind: 'DEMONSTRATION' }, enabled: opened && writable && !source.loading && !source.error, request: binding });
  useEffect(() => { if (planner.view) setSelectedId(planner.view.selected.itemId); }, [planner.view]);
  const returnToBrowsing = () => { if (planner.view) setSelectedId(planner.view.snapshotSelectedId); planner.returnToBrowsing(); };
  const viewOption = (option: PlanOption) => { setGlobeOpen(true); void planner.viewOption(option, browsingUtc, selectedId); };
  const updateBrowsingTime = async () => {
    const owner = currentContext.current; setViewError(null);
    try { const value = await api<Context>('/api/context'); if (currentContext.current === owner && contextKey(value) === owner) { planner.returnToBrowsing(); setBrowsingUtc(value.serverNow); } }
    catch (failure) { if (currentContext.current === owner) setViewError(message(failure)); }
  };
  const criteria = request.brief.discovery?.effective ?? { ...emptyDiscoveryValues(), family: 'EO' as const, sensor: request.brief.sensor, outputs: request.brief.outputs, maxResolutionM: request.brief.maxResolutionM };
  const form = useWorkflow<PlanDraft>(request, 'proposed-plan-selection', { selection: null, option: null, optionDrafts: {}, selectionOwner: null }, text => { setOpened(false); planner.clearChoice(); saved(text); }, String(request.currentProposedPlan?.version ?? 'NONE'));
  const retained = form.entry.value;
  const retainedSelection = retained.selectionOwner === planner.ownershipStamp ? retained.selection : null;
  useEffect(() => {
    // Retained raw edits stay under their original private form key. A new
    // session cannot reuse that old session's completed calculation/selection.
    // Genuine pending commands remain owned by useWorkflow's recovery path.
    if (!form.busy && !form.entry.uncertain && retained.selection && retained.selectionOwner !== planner.ownershipStamp) {
      planner.clearChoice();
      form.change(previous => ({ ...previous, selection: null, option: null, selectionOwner: null }));
    }
  }, [form.key, form.busy, form.entry.uncertain, retained.selection, retained.selectionOwner, planner.ownershipStamp]);
  const recoverable = writer && form.entry.uncertain;
  const controlled = { ...planner, optionDrafts: retained.optionDrafts, editOption: (key: string, patch: Partial<PlanOptionEdits>, initial: PlanOptionEdits) => { if (!form.entry.uncertain) { planner.clearChoice(); form.change(previous => ({ ...previous, selection: null, option: null, selectionOwner: null, optionDrafts: { ...previous.optionDrafts, [key]: { ...(previous.optionDrafts[key] ?? initial), ...patch } } })); } }, choose: (selection: PlanSelectionInput, option: PlanOption) => { if (!form.entry.uncertain) { planner.choose(selection, option); form.change(previous => ({ ...previous, selection, option, selectionOwner: planner.ownershipStamp })); } }, clearChoice: () => {
    // This discards only the unsaved replacement. Retained per-option edits and
    // the durable request plan are independent; uncertain attempts must recover.
    if (form.busy || form.entry.uncertain) return;
    planner.clearChoice();
    form.change(previous => ({ ...previous, selection: null, option: null, selectionOwner: null }));
  } };
  const leave = async () => { if (!form.busy && await requestPrivateDeparture()) setOpened(false); };
  const preview = form.preview?.confirmation.proposedPlan;
  const review = () => { if (retainedSelection) void form.review('saveProposedPlan', { brief: raw, selection: retainedSelection }, undefined, undefined, { expected: { proposedPlanVersion: request.currentProposedPlan?.version ?? null } }); };
  const execute = () => { if (retainedSelection || form.entry.uncertain) void form.execute('saveProposedPlan', { brief: raw, selection: retainedSelection! }, { expected: { proposedPlanVersion: request.currentProposedPlan?.version ?? null } }); };
  const currentPlan = accepted ? request.acceptedPlan?.plan ?? null : request.currentProposedPlan;
  return <section className="ruled-section" aria-label="Saved proposed plans"><p className="eyebrow">CUSTOMER TECHNICAL PREFERENCE / SAME REQUEST</p><h2>{accepted ? 'Accepted tentative-plan snapshot' : 'Proposed mission plan'}</h2>{currentPlan ? <><p className="annotation">Plan version {currentPlan.version} · Brief revision {currentPlan.briefRevision} · {currentPlan.actorName} · {formatTime(currentPlan.createdAt)}</p><ProposedPlanFacts plan={currentPlan} historical={accepted} /></> : <><h3>No selected plan</h3><p>{accepted ? 'No selected plan was part of the accepted work.' : 'A selected technical proposal is optional and separate from submission or staff scheduling.'}</p></>}
    <p className="helper">A tentative customer preference does not create a quote, operator booking or Scheduled state. {accepted ? 'Accepted work is immutable; use Clarifications for a proposed change.' : 'Changing purpose, intent, target, requirements, window or comparison dates requires an explicit brief revision. A different option for unchanged inputs creates only a selected-plan version.'}</p>
    {(writable || recoverable) && <button type="button" className="button" onClick={event => { opener.current = event.currentTarget; event.currentTarget.focus(); setOpened(true); }}>{form.entry.uncertain ? 'Recover proposed-plan save…' : 'Inspect technical planning options'}</button>}
    {recoverable && <><ActionNotice error={form.entry.error} uncertain refresh={reload} /><button type="button" className="button" disabled={form.busy} onClick={execute}>Retry same proposed-plan save</button></>}
    {form.entry.dirty && Object.keys(retained.optionDrafts).length > 0 && <details className="folded-section"><summary>Option edits retained in this tab · original brief revision {form.entry.boundBriefRevision}</summary><p className="helper">These are your unsent values under their original assessment and option. They do not alter the saved or accepted plan.</p>{Object.entries(retained.optionDrafts).map(([key, edit]) => <section key={key}><p className="helper mono">{key}</p><p>Proposed instant: {edit.at || 'Unresolved'}<br />Personal processing hours: {edit.hours || 'Not entered'}<br />{edit.explanation}</p><p className="helper">{edit.acknowledged.length} named conditions checked in that original option.</p></section>)}</details>}{request.earlierProposedPlans.length > 0 && <details className="folded-section plan-history"><summary>Earlier selected-plan versions · as calculated</summary>{request.earlierProposedPlans.map(plan => <section key={plan.id} className="ruled-section"><h3>Plan version {plan.version} · {plan.state}</h3><p className="helper">Brief revision {plan.briefRevision} · {formatTime(plan.createdAt)} · {plan.actorName}{plan.invalidationReason && <><br />{plan.invalidationReason}</>}</p><ProposedPlanFacts plan={plan} historical /></section>)}</details>}
    {opened && (writable || recoverable) && <Panel title="Your request · Proposed plan" close={() => void leave()} busy={form.busy} opener={opener.current}><div className="sheet-body"><p className="eyebrow">{request.reference} / BRIEF REVISION {request.briefRevision}</p><h1>Proposed mission plan</h1><p>Inspect technical options for this exact saved brief. Saving a tentative preference does not submit or schedule this request.</p><Errors errors={form.entry.fieldErrors} /><ActionNotice error={form.entry.error} uncertain={form.entry.uncertain} refresh={reload} /><details className="folded-section"><summary>Exact saved planning inputs</summary><BriefFacts brief={request.brief} /></details>{source.loading && <p role="status">Checking the saved source dictionary…</p>}{source.error && <p className="notice warning" role="alert">{source.error}<button className="button" onClick={source.retry}>Retry source context</button></p>}
      {preview || form.entry.uncertain ? <><h2>Review proposed plan</h2>{preview ? <ProposedPlanFacts plan={preview} /> : <p>Your original unchanged plan-save attempt remains retained. Recover its outcome without selecting another option.</p>}<p>Destination: {request.organizationName} · {context.actor?.name} · {context.role}</p><div className="sheet-actions"><button className="button" disabled={form.busy || form.entry.uncertain} onClick={form.clearPreview}>Edit local selection</button><button className="button primary" disabled={form.busy} onClick={execute}>{form.busy ? 'Saving proposed plan…' : form.entry.uncertain ? 'Retry same proposed-plan save' : 'Save proposed plan'}</button></div></> : <><ProposedPlan planner={controlled} onSave={review} onView={viewOption} />{globeOpen && planner.page && <section className="private-plan-globe" aria-label="Checked opportunity position"><RealPredictionStage snapshotVersion={planner.page.snapshotVersion} factVersion={planner.page.factVersion} criteria={criteria} exclusions={request.brief.discovery?.exclusions ?? []} sources={planner.page.sources} serverNow={planner.page.serverNow} representedUtc={planner.view?.selected.atUtc ?? browsingUtc} selectedId={selectedId} shortlistedIds={request.brief.selectedEvidence.map(item => item.itemId)} target={{ ...request.brief.area, confirmed: true }} assessmentView={planner.view?.selected} onReturnToBrowsing={returnToBrowsing} onSelect={setSelectedId} onUpdateTime={updateBrowsingTime} />{viewError && <p className="notice warning" role="alert">{viewError}</p>}</section>}<p className="helper">To change the question or planning inputs, keep this work and use Revise brief in the request. No new requirements are attached by saving an option.</p>{retainedSelection && !planner.chosen && <div className="notice warning"><h3>Earlier local selection retained</h3><p>{retained.option?.name ?? retainedSelection.optionId} · {retainedSelection.proposedAtUtc ?? 'Instrument timing unresolved'}</p><p>The current review rechecks the exact assessment and saved brief. An expired or invalid selection cannot be silently refreshed.</p><button className="button" onClick={review}>Review retained proposed plan</button></div>}<div className="sheet-actions"><button type="button" className="button" onClick={() => void leave()}>Keep draft and close</button></div></>}
    </div></Panel>}
  </section>;
}
