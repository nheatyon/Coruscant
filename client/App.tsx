import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import type { BriefInput, PublicCatalog, RequestProjection } from '../shared/contracts.js';
import { createPlanningBrief } from './features/discovery/EOIntent.js';
import { api, ContextChangedError, message, post } from './lib/api.js';
import { PlanningContext, VisitorTransition } from './features/planning/PlanningContext.js';
import { useCurrentContext } from './lib/context.js';
import { Discovery } from './features/discovery/Discovery.js';
import { usePlaceDraft } from './features/discovery/usePlaceDraft.js';
import { useDiscoveryDraft } from './features/discovery/useDiscoveryDraft.js';
import { useCatalogSources, type CatalogMode } from './features/discovery/useCatalogSources.js';
import { BriefSheet } from './features/brief/BriefSheet.js';
import { PrivateDraftGuard, PrivateDepartureCancelled } from './lib/privateDrafts.js';
import { WorkflowDetail } from './features/workflow/WorkflowDetail.js';
import { WorkspaceNav } from './shell/WorkspaceNav.js';
import { ResultsLibrary, ResultDetail } from './features/results/ResultPages.js';
import { RequestList, MissionsLanding } from './features/tracking/TrackingPages.js';
import { usePrivateData } from './features/tracking/usePrivateData.js';
import { requestListReturn } from './features/tracking/navigation.js';
import { useProposedPlan } from './features/planning/useProposedPlan.js';
import type { AssessmentHandoffInput, PlanOption } from '../shared/plan-contracts.js';

function useTitle(title: string) { useEffect(() => { document.title = `${title} · Coruscant`; }, [title]); }
export function App() {
  const [brief, setBrief] = useState<BriefInput>(createPlanningBrief);
  const [catalog, setCatalog] = useState<PublicCatalog | null>(null);
  const source = useCatalogSources(catalog); const publicLocation = useLocation();
  // A pending submission keeps its original reviewed raw input/envelope. The sheet
  // handles source invalidation during review; returning to edit re-reads criteria.
  const reviewingBrief = publicLocation.pathname === '/' && new URLSearchParams(publicLocation.search).get('brief') === 'review';
  const discovery = useDiscoveryDraft(brief, setBrief, source.catalog, source.dictionary, reviewingBrief ? undefined : `${source.mode}:${source.page?.snapshotVersion ?? ''}:${source.page?.factVersion ?? ''}`);
  const place = usePlaceDraft(brief, discovery.text, discovery.editBrief);
  const planner = useProposedPlan({ brief, dictionary: source.dictionary, catalogContext: source.catalogContext, enabled: publicLocation.pathname === '/' && new URLSearchParams(publicLocation.search).get('brief') === 'edit', pendingArea: place.pendingArea, serverNow: source.page?.serverNow });
  const [planningHandoff, setPlanningHandoff] = useState<AssessmentHandoffInput | null>(null);
  const { context: planningContext, ensure: ensurePlanningContext } = useCurrentContext();
  const adoptedHandoff = useRef<string | null>(null), handoffOrigin = useRef<string | null>(null);
  useEffect(() => {
    if (!planningHandoff || handoffOrigin.current === planner.ownershipStamp) return;
    const continuation = planningContext?.planningHandoff;
    if (!continuation || (continuation.phase === 'CONTINUE' ? continuation.continuation.handle.assessmentId : continuation.result.handle.assessmentId) !== planningHandoff.handle.assessmentId) setPlanningHandoff(null);
  }, [planner.ownershipStamp, planningContext?.planningHandoff, planningHandoff]);
  useEffect(() => {
    const handoff = planningContext?.planningHandoff;
    if (handoff?.phase !== 'COMPLETE' || adoptedHandoff.current === handoff.result.attachmentReference) return;
    adoptedHandoff.current = handoff.result.attachmentReference;
    planner.adoptHandoff(handoff.result.handle, handoff.result.attachmentReference); setPlanningHandoff(null);
  }, [planningContext?.planningHandoff]);
  const viewPlanningOption = async (option: PlanOption) => { return source.representedUtc ? planner.viewOption(option, source.representedUtc, discovery.selectedId) : false; };
  const viewedOption = useRef<string | null>(null);
  useEffect(() => {
    if (planner.view) {
      viewedOption.current = planner.view.selected.optionId; discovery.setSelected(planner.view.selected.itemId);
    }
  }, [planner.view]);
  const returnToBrowsing = () => { if (planner.view) discovery.setSelected(planner.view.snapshotSelectedId); viewedOption.current = null; planner.returnToBrowsing(); };
  const preparePlanningHandoff = async () => {
    if (!planner.chosen || planningContext?.audience !== 'PUBLIC') return;
    const context = await ensurePlanningContext();
    const value = await post<AssessmentHandoffInput>('/api/orbital-assessments/handoff', context, { handle: planner.chosen.selection.handle });
    if (!planner.prepareHandoff(value.handle)) throw new ContextChangedError('The planning context changed. Your brief is retained; choose a current option before continuing.');
    handoffOrigin.current = planner.ownershipStamp; setPlanningHandoff(value);
  };
  const sourceSelections = useRef<Record<CatalogMode, { selectedId: string | null; evidence: BriefInput['selectedEvidence'] }>>({ REAL: { selectedId: null, evidence: [] }, DEMONSTRATION: { selectedId: null, evidence: [] } });
  const changeSource = (next: CatalogMode) => {
    if (source.mode === next) return;
    sourceSelections.current[source.mode] = { selectedId: discovery.selectedId, evidence: brief.selectedEvidence };
    const restored = sourceSelections.current[next]; source.setMode(next); discovery.setSelected(restored.selectedId);
    setBrief(previous => ({ ...previous, selectedEvidence: restored.evidence, acknowledged: false, catalogContext: next === 'REAL' ? { sourceKind: 'PUBLIC_REAL', snapshotVersion: source.page?.snapshotVersion ?? null, factVersion: source.page?.snapshotVersion ? source.page.factVersion : null } : { sourceKind: 'DEMONSTRATION' } }));
  };
  const submitted = () => { place.reset(); discovery.reset(); planner.reset(); setPlanningHandoff(null); sourceSelections.current = { REAL: { selectedId: null, evidence: [] }, DEMONSTRATION: { selectedId: null, evidence: [] } }; };
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setCatalogLoading(true); setCatalogError(null);
    void api<PublicCatalog>('/api/public/catalog', { signal: controller.signal }).then(value => { setCatalog(value); setCatalogLoading(false); }).catch(error => { if (controller.signal.aborted) return; setCatalogError(message(error)); setCatalogLoading(false); });
    return () => controller.abort();
  }, [reload]);
  return <><PrivateDraftGuard /><Header /><div id="page-content"><Routes>
    <Route path="/" element={<Discovery brief={brief} draft={discovery} place={place} catalog={source.catalog} source={source} changeSource={changeSource} loading={source.mode === 'REAL' ? source.loading : catalogLoading} error={source.mode === 'REAL' ? source.error ?? (source.page?.availability === 'UNAVAILABLE' ? source.page.message ?? 'Real catalog not loaded.' : null) : catalogError} retry={source.mode === 'REAL' ? source.retry : () => setReload(n => n + 1)} planner={planner} returnToBrowsing={returnToBrowsing} />} />
    <Route path="/request" element={<Navigate to="/" replace />} />
    <Route path="/about/data" element={<DataExplanation />} />
    <Route path="/access" element={<Access catalog={catalog} retry={() => setReload(n => n + 1)} planningHandoff={planningHandoff} />} />
    <Route path="/staff/login" element={<Access staff catalog={catalog} retry={() => setReload(n => n + 1)} />} />
    <Route path="/workspaces" element={<WorkspaceChooser />} />
    <Route path="/workspaces/:org/requests" element={<PrivateGate organization><RequestList /></PrivateGate>} />
    <Route path="/workspaces/:org/service-requests/:id" element={<PrivateGate organization><RequestDetail catalog={catalog} /></PrivateGate>} />
    <Route path="/workspaces/:org/missions/:id" element={<PrivateGate organization><RequestDetail mission catalog={catalog} /></PrivateGate>} />
    <Route path="/workspaces/:org/missions" element={<PrivateGate organization><MissionsLanding /></PrivateGate>} />
    <Route path="/workspaces/:org/missions/*" element={<PrivateGate organization><Unavailable /></PrivateGate>} />
    <Route path="/workspaces/:org/results" element={<PrivateGate organization><ResultsLibrary /></PrivateGate>} />
    <Route path="/workspaces/:org/results/:resultId" element={<PrivateGate organization><ResultDetail /></PrivateGate>} />
    <Route path="/staff/requests" element={<PrivateGate staff><RequestList staff /></PrivateGate>} />
    <Route path="/staff/requests/:id" element={<PrivateGate staff><RequestDetail staff catalog={catalog} /></PrivateGate>} />
    <Route path="*" element={<main className="page narrow"><p className="eyebrow">Navigation</p><h1>Page unavailable</h1><p>This address does not name an available Coruscant page.</p><Link className="button primary" to="/">Return to StarSearch</Link></main>} />
  </Routes></div><BriefSheet place={place} brief={brief} setBrief={setBrief} catalog={source.catalog} dictionary={source.dictionary} catalogContext={source.catalogContext} onManualChange={discovery.editBrief} onSubmitted={submitted} onUseReviewedFilters={discovery.reviewed} planner={planner} onViewPlanningOption={viewPlanningOption} preparePlanningHandoff={preparePlanningHandoff} /></>;
}

function Wordmark() {
  return <svg className="wordmark" viewBox="0 0 258 31" role="img" aria-label="Coruscant"><g fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d="M21 4H9L4 9V22L9 27H21M34 4H44L49 9V22L44 27H34L29 22V9ZM58 27V4H71L76 9V14L71 18H58M68 18L78 27M87 4V22L92 27H103L108 22V4M137 4H123L118 9V13L123 16H132L137 20V23L133 27H118M167 4H155L150 9V22L155 27H167M177 27L187 4L197 27M181 19H193M206 27V4L226 27V4M231 4H251M241 4V27" /></g></svg>;
}
function Header() {
  const { context, enter, covered } = useCurrentContext();
  const location = useLocation(); const navigate = useNavigate();
  const [menu, setMenu] = useState(false); const [clock, setClock] = useState(new Date());
  const menuButton = useRef<HTMLButtonElement>(null); const menuRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const org = context?.audience === 'CUSTOMER' ? context.organization?.id : null;
  const privateLink = (product: string) => org ? `/workspaces/${org}/${product === 'requests' ? 'requests' : product}` : `/workspaces${product === 'requests' ? '' : `?product=${product}`}`;
  const current = location.pathname === '/access' ? 'Customer access' : location.pathname.includes('/missions') ? 'Mission Control' : location.pathname.includes('/results') ? 'SatSuite' : location.pathname.startsWith('/workspaces') ? 'Workspace' : location.pathname.startsWith('/staff') ? 'Staff' : 'StarSearch';
  const links = [{ label: 'StarSearch', to: '/' }, { label: 'Workspace', to: privateLink('requests') }, { label: 'Mission Control', to: privateLink('missions') }, { label: 'SatSuite', to: privateLink('results') }];
  useEffect(() => { const timer = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (menu) { setMenu(false); menuButton.current?.focus(); } }, [location.pathname, location.search]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMenu(false); menuButton.current?.focus(); } };
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !menuButton.current?.contains(event.target as Node)) { setMenu(false); menuButton.current?.focus(); } };
    document.addEventListener('keydown', close); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', outside); };
  }, [menu]);
  const leave = async () => { try { await enter('/api/demo/leave'); navigate('/'); } catch (error) { if (!(error instanceof PrivateDepartureCancelled)) setFailure(message(error)); } };
  return <><header className="global-header"><Link className="brand" to="/" aria-label="Coruscant — StarSearch"><Wordmark /></Link><nav className="desktop-products" aria-label="Products">{links.map(link => <Link key={link.label} to={link.to} aria-current={current === link.label ? 'page' : undefined}>{link.label}</Link>)}</nav><button ref={menuButton} className="mobile-product" aria-expanded={menu} aria-controls="product-menu" onClick={() => setMenu(!menu)}>{current}<span aria-hidden="true">⌄</span></button><div className="header-context"><span className="utc"><i />{clock.toISOString().slice(11, 19)} UTC</span>{context?.actor && !covered ? <><Link className="context-name" to={context.audience === 'STAFF' ? '/staff/login' : '/access'}>{context.actor.name}<span className="demo-inline">DEMO</span></Link><button className="leave-link" onClick={() => void leave()}>{context.audience === 'STAFF' ? 'Leave demonstration staff access' : 'Leave demonstration access'}</button></> : <Link className="access-link" to="/access">Customer access</Link>}</div>{menu && <div ref={menuRef} id="product-menu" className="product-menu"><nav aria-label="Products">{links.map(link => <Link key={link.label} to={link.to} aria-current={current === link.label ? 'page' : undefined}>{link.label}</Link>)}</nav></div>}</header>{failure && <div className="global-error" role="alert">{failure}<button onClick={() => setFailure(null)}>Dismiss</button></div>}<div className="crop-marks" aria-hidden="true"><i /><i /><i /><i /></div></>;
}

function Access({ staff = false, catalog, retry, planningHandoff }: { staff?: boolean; catalog: PublicCatalog | null; retry: () => void; planningHandoff?: AssessmentHandoffInput | null }) {
  useTitle(staff ? 'Demonstration staff access' : 'Demonstration access');
  const { enter } = useCurrentContext(); const navigate = useNavigate(); const [query] = useSearchParams();
  const [persona, setPersona] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const continueAccess = async () => {
    if (!staff && !persona) { setError('Choose a demonstration customer.'); return; }
    setBusy(true); setError(null);
    try {
      await enter(staff ? '/api/demo/staff/enter' : '/api/demo/customer/enter', staff ? {} : { personaId: persona, ...(planningHandoff && query.get('returnTo') === '/?brief=review' ? { planningHandoff } : {}) });
      if (staff) navigate('/staff/requests');
      else navigate(`/workspaces?product=${query.get('product') === 'missions' ? 'missions' : query.get('product') === 'results' ? 'results' : 'requests'}&returnTo=${encodeURIComponent(safeReturn(query.get('returnTo')))}`);
    } catch (failure) { if (!(failure instanceof PrivateDepartureCancelled)) setError(message(failure)); } finally { setBusy(false); }
  };
  return <main className="access-page"><section className="access-form"><p className="eyebrow">CORUSCANT / {staff ? 'STAFF' : 'WORKSPACE'}</p><h1>{staff ? 'Demonstration staff access' : 'Demonstration access'}</h1><p className="lead">{staff ? 'Review the same requests in the separate Staff Admin context.' : 'Follow shared mission requests, review decisions, and inspect supplied results.'}</p><div className="notice"><strong>Local sample identities</strong><p>This is a local demonstration, not authentication of a real person. Anyone using this Mac can choose these sample identities. Server-enforced membership and role decisions still apply. Entering access does not submit, accept, schedule or deliver anything.</p></div><PlanningContext /><form onSubmit={event => { event.preventDefault(); void continueAccess(); }}><label className="field">{staff ? 'Staff context' : 'Demonstration customer'}{staff ? <input value="Staff Admin — demonstration" readOnly /> : <select value={persona} onChange={event => setPersona(event.target.value)} aria-describedby="persona-description"><option value="">Choose a sample customer</option>{catalog?.personas.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select>}</label>{!staff && <p id="persona-description" className="helper">{catalog?.personas.find(value => value.id === persona)?.description ?? 'Choose a configured role; customer access never grants staff authority.'}</p>}{!catalog && !staff && <p className="inline-error">Sample definitions are unavailable. <button type="button" className="text-button" onClick={retry}>Retry definitions</button></p>}{error && <p role="alert" className="inline-error">{error}</p>}<button className="button primary full" disabled={busy || (!catalog && !staff)}>{busy ? 'Opening demonstration context…' : staff ? 'Enter demonstration staff access' : 'Continue to workspace'}</button></form><VisitorTransition to="/" label="Explore StarSearch as a visitor" /><div className="access-footer"><Link to={staff ? '/access' : '/staff/login'}>{staff ? 'Customer access' : 'Staff access'}</Link><Link to="/about/data">How our data works</Link></div></section><aside className="access-aside" aria-label="Connected request journey"><p className="eyebrow">ONE QUESTION / SHARED RECORDS</p><div className="orbital-mark" aria-hidden="true"><span /><span /><span /><i /></div><ol className="access-journey"><li><span>01</span>Discover relevant evidence</li><li><span>02</span>Request human review</li><li><span>03</span>Follow the saved decision</li></ol><p>Technical relevance is not coverage, operator availability or a booked collection.</p></aside></main>;
}
function safeReturn(value: string | null): string {
  if (value === '/?brief=review' || value === '/?brief=edit') return value;
  if (!value || value.length > 4000 || !value.startsWith('/') || value.startsWith('//')) return '/workspaces';
  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin || !/^\/workspaces(?:\/[A-Za-z0-9_-]+\/(?:requests|service-requests|missions|results)(?:\/[A-Za-z0-9_-]+)?)?$/.test(target.pathname) || target.hash && target.hash !== '#clarifications') return '/workspaces';
    return target.pathname + target.search + target.hash;
  } catch { return '/workspaces'; }
}
function PrivateGate({ children, staff = false, organization = false }: { children: ReactNode; staff?: boolean; organization?: boolean }) {
  const { context, covered, error, refresh } = useCurrentContext(); const location = useLocation(); const { org } = useParams();
  if (covered || !context) return <AccessCover error={error} retry={() => void refresh()} />;
  if (staff && context.audience !== 'STAFF') return <Navigate to="/staff/login" replace />;
  if (!staff && context.audience !== 'CUSTOMER') return <Navigate to={`/access?returnTo=${encodeURIComponent(safeReturn(location.pathname + location.search + location.hash))}&product=${location.pathname.includes('/missions') ? 'missions' : location.pathname.includes('/results') ? 'results' : 'requests'}`} replace />;
  if (organization && context.organization?.id !== org) return <Unavailable />;
  return <>{children}</>;
}
function AccessCover({ error, retry }: { error: string | null; retry: () => void }) {
  return <main className="page narrow access-cover" role="status"><p className="eyebrow">PRIVATE WORKSPACE</p><h1>{error ? 'Check account' : 'Checking current access…'}</h1><p>{error ?? 'Private records remain covered until your current permissions have been checked.'}</p>{error && <button className="button" onClick={retry}>Try again</button>}</main>;
}
function WorkspaceChooser() {
  useTitle('Choose workspace');
  const { context, covered, enter } = useCurrentContext(), [query] = useSearchParams(), navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const automatic = useRef(''), mounted = useRef(true), choiceSequence = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++choiceSequence.current; }; }, []);
  const product = query.get('product') === 'missions' ? 'missions' : query.get('product') === 'results' ? 'results' : 'requests';
  const returning = safeReturn(query.get('returnTo')), handoff = returning === '/?brief=review', planningReturn = handoff || returning === '/?brief=edit';
  const destination = product === 'missions' ? 'Open Mission Control' : product === 'results' ? 'Open SatSuite results' : 'View shared requests';
  const choose = async (organizationId: string) => {
    if (busy || !context || covered) return;
    const invocation = ++choiceSequence.current; setBusy(organizationId); setError(null);
    try {
      const selected = context.organization?.id === organizationId ? context : await enter('/api/context/workspace', { organizationId, ...(handoff && context.planningHandoff?.phase === 'CONTINUE' ? { planningHandoff: context.planningHandoff.continuation } : {}) });
      if (!mounted.current || invocation !== choiceSequence.current || selected.audience !== 'CUSTOMER' || selected.actor?.id !== context.actor?.id || selected.organization?.id !== organizationId) return;
      // A foreign private return is handled by the neutral gate, never fetched or moved into this workspace.
      const privateItem = /^\/workspaces\/[A-Za-z0-9_-]+\/(?:service-requests|missions|results)\/[A-Za-z0-9_-]+(?:[?#]|$)/.test(returning);
      navigate(planningReturn ? returning : returning.startsWith(`/workspaces/${organizationId}/`) || privateItem ? returning : `/workspaces/${organizationId}/${product}`, { replace: !handoff && context.memberships.length === 1 });
    } catch (failure) { if (mounted.current && invocation === choiceSequence.current && !(failure instanceof PrivateDepartureCancelled)) setError(message(failure)); }
    finally { if (mounted.current && invocation === choiceSequence.current) setBusy(null); }
  };
  useEffect(() => {
    if (covered || !context || context.audience !== 'CUSTOMER' || handoff || context.memberships.length !== 1 || busy) return;
    const key = `${context.actor?.id}:${context.contextGeneration}:${product}:${returning}`;
    if (automatic.current === key) return;
    automatic.current = key;
    void choose(context.memberships[0]!.organizationId);
  }, [context, covered, product, returning, handoff]);
  return <PrivateGate><main className="page wide"><p className="eyebrow">{context?.actor?.name} / DEMONSTRATION</p><h1>{context?.memberships.length ? busy && !handoff ? 'Opening workspace…' : 'Choose workspace' : 'No workspace access is configured'}</h1><p className="lead">{handoff ? 'Choose the actual destination, then return to your brief for final review. Nothing will be submitted here.' : context?.memberships.length === 1 ? 'Opening your permitted workspace for the selected product. Entering or switching does not submit or change a mission.' : 'Only your current configured memberships appear below. Choosing a workspace preserves the selected product.'}</p>{error && <p className="inline-error" role="alert">{error}</p>}<div className="workspace-list">{context?.memberships.map(membership => <article key={membership.organizationId} className="workspace-row"><div><span className="eyebrow">WORKSPACE</span><h2>{membership.organizationName}</h2><p>{roleLabel(membership.role)}{membership.canSelectOffers ? ' · Offer-selection authority' : ' · No offer-selection authority'}</p></div><button className="button primary" disabled={!!busy} onClick={() => void choose(membership.organizationId)}>{busy === membership.organizationId ? 'Opening workspace…' : handoff ? 'Review request in this workspace' : planningReturn ? 'Return to planning brief' : destination}</button></article>)}</div><Link className="text-link" to="/">Return to StarSearch</Link></main></PrivateGate>;
}
function RequestDetail({ staff = false, mission = false, catalog }: { staff?: boolean; mission?: boolean; catalog: PublicCatalog | null }) {
  useTitle(staff ? 'Staff request' : mission ? 'Mission Control' : 'Request'); const { org, id } = useParams(); const location = useLocation();
  const { data: request, error, loading, retry } = usePrivateData<RequestProjection>(staff ? `/api/staff/requests/${id}` : `/api/customer/${org}/requests/${id}`);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  useEffect(() => { setSavedNotice(null); }, [id]);
  if (error && !request) return <><WorkspaceNav staff={staff} /><Unavailable message={error} retry={retry} /></>;
  if (!request) return <><WorkspaceNav staff={staff} /><main className="page"><p role="status">Loading the saved request…</p></main></>;
  const saved = (text: string) => { setSavedNotice(text + ' Saved. The latest request is shown below.'); retry(); };
  return <><WorkspaceNav staff={staff} /><main className="page wide"><Link className="back-link" to={staff ? '/staff/requests' : mission ? `/workspaces/${org}/missions` : requestListReturn(org!, location.search)}>← {mission ? 'Back Missions' : 'Back Requests'}</Link>{savedNotice && <div className="notice saved-notice" role="status"><strong>{savedNotice}</strong>{error && <p>Saved, but refreshed details are temporarily unavailable. Do not repeat this as a new action.</p>}</div>}{error && <div className="notice warning" role="alert"><strong>Current details could not be refreshed</strong><p>{error} The last permitted saved details remain below and may be stale. Your unsent input is retained; review current data before confirming.</p><button className="button" onClick={retry}>Try again</button></div>}{loading && <p role="status" className="helper">Refreshing current saved details… The displayed version may be stale.</p>}<WorkflowDetail request={request} staff={staff} mission={mission} catalog={catalog} reload={retry} saved={saved} /></main></>;
}
function Unavailable({ message: detail, retry }: { message?: string; retry?: () => void }) {
  const { context } = useCurrentContext(), location = useLocation();
  const product = location.pathname.includes('/results') ? 'results' : location.pathname.includes('/missions') ? 'missions' : 'requests';
  const label = product === 'results' ? 'Results' : product === 'missions' ? 'Missions' : 'Requests';
  return <main className="page narrow"><p className="eyebrow">CURRENT WORKSPACE</p><h1>This item is unavailable in your current workspace</h1><p>{detail ?? 'It may be unavailable or outside your current permissions. No other workspace details are shown.'}</p>{retry && <button className="button" onClick={retry}>Try again</button>}<Link className="text-link" to={context?.audience === 'STAFF' ? '/staff/requests' : context?.organization ? `/workspaces/${context.organization.id}/${product}` : `/workspaces?product=${product}`}>Return to permitted {label}</Link></main>;
}
function DataExplanation() {
  useTitle('How our data works');
  return <main className="page narrow"><Link className="back-link" to="/">← StarSearch</Link><p className="eyebrow">CORUSCANT / EVIDENCE</p><h1>How our data works</h1><p className="lead">What the catalog, the globe and Mission Control can and cannot tell you.</p>{[
    ['01 / Catalog', 'Real source records and a separate demonstration catalog', 'StarSearch normally reads the adopted CelesTrak Synthetic Aperture Radar and Earth Resources source populations. Full canonical identities are deduplicated; source versions, retrieval times, rejected records and partial or unavailable sources are shown. Source membership is classification, not proof of an operational sensor or available service. Independently cited instrument, operator and mode/product facts remain separate; missing values stay unknown. Explicit Demonstration catalog mode retains the six fictional records, original IDs and held-D0 tracks. A real-source failure never substitutes fictional rows. Refresh public catalog is deliberate and shared; typing a query does not contact the provider.'],
    ['02 / Matches', 'Relevance still needs human review', 'A bounded English rule reader runs locally with no remote AI, geocoder or account. It preserves original phrases, stated/inferred/manual origins, explicit exclusions and unresolved wording for review. Effective reviewed criteria compare documented family, text, operator, owner country, sensor and maximum ground resolution evidence. Known mismatches are excluded in both modes. Missing requested evidence may remain caveated with Documented criteria only off; switching it on excludes that missing evidence. Real matching covers the full adopted snapshot, independent of list pages or rendering limits. A SAR group label, best-mode brochure figure or pixel spacing does not prove the applicable ground-resolution requirement. Relevance does not prove area/time coverage, operator availability, price or booking. Descriptions remain verbatim purpose. Explicit values and deliberate changes override compatible heuristics; flood-related SAR/10 m is an editable search suggestion, never a scientific threshold. Comparison dates stay independently manual. Unknown or conflicting grammar needs review; chips change actual criteria and saved requirements.'],
    ['03 / Globe positions', 'Predicted positions at an explicit UTC, never live telemetry', 'Real catalog draws locally calculated SGP4 positions from the corresponding source elements, at one visible paused server-UTC snapshot. Update predicted time to now changes that display time only; source refresh, camera rotation, Follow, the Earth target and a planning window are separate. Inspect element epoch, retrieval time, supported span and stated frame approximation. Missing, stale, unsupported or conflicting orbit data never receives a demonstration track. Matching counts, successfully computed positions/paths and display limits are distinct. Demonstration catalog retains synthetic display geometry held at its original D0. Saved mission detail uses only its recorded schedule’s tracked IDs at plan start; unsupported real mission geometry is unavailable there. The local NASA July 2004 texture remains historical context, not live imagery or requested SAR data. Texture failure leaves plain Earth and WebGL failure leaves list, manual coordinates and saved navigation. Explicit place lookup sends only the visible reviewed place phrase to Nominatim/OpenStreetMap; your full question stays local. One candidate is an unapplied preview, and ambiguous results require your choice. Drawing and numeric proposals also need deliberate application and separate size confirmation. Retaining a target for a changed question needs an explicit review. With a confirmed target and valid future planning window, local checks automatically produce bounded technical options and tentative plan selection. Use this plan is a local choice; saving is explicit and creates no provider booking or confirmed staff schedule.'],
    ['04 / Requests, quotes and schedules', 'A saved request is the start of review', 'Explicit submission saves your brief and evidence in the named workspace. It does not contact an operator, charge money, command a spacecraft or collect imagery. Private staff drafts become customer-visible only through explicit publication. Authorized acceptance records intent; staff records a separate schedule. None confirms operator agreement or execution. A display clock never changes workflow status.'],
    ['05 / Results', 'Supplied evidence must be labeled and permitted', 'SatSuite shows newly authored synthetic scenes with separately recorded staff review, publication and organization entitlement, plus an evidence-cited finding when published. Publication does not grant access and access does not expose drafts. Manual delivery is a separate staff decision requiring the complete readable pair, reviewed finding and exact accepted reference-date alignment. Owner and Requester can save their own exact-image point notes; Viewer reads. Historical delivery does not override current material permissions. Demonstration scenes cannot establish flooding, causation, passability, damage or a calibrated measurement.'],
  ].map(([number, title, text]) => <section className="ruled-section" key={number}><p className="eyebrow">{number}</p><h2>{title}</h2><p>{text}</p></section>)}<Link className="button" to="/">Return to StarSearch</Link></main>;
}
export function Status({ children, tone = 'success' }: { children: ReactNode; tone?: 'success' | 'warning' | 'info' }) { return <span className={`status ${tone}`}><i />{children}</span>; }
export function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Time unavailable' : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`; }
function roleLabel(value: string | null | undefined): string { return value === 'OWNER' ? 'Owner' : value === 'REQUESTER' ? 'Requester' : value === 'VIEWER' ? 'Viewer' : 'No workspace role'; }
