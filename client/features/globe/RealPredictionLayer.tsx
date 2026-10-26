import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { DiscoveryExclusion, DiscoveryValues } from '../../../shared/discovery-contracts.js';
import type { OrbitalBrowseInput, OrbitalBrowseObject, OrbitalBrowsePage, OrbitalSourceSummary } from '../../../shared/orbital-contracts.js';
import type { AssessmentSelectedView } from '../../../shared/plan-contracts.js';
import { ORBITAL_LIMITS } from '../../../shared/orbital-policy.js';
import { contextKey, message, post } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';
import type { DisplayTrack, GlobeController, GlobeHover, GlobeSceneState, GlobeTarget, OrbitVisibility } from './scene-contract.js';
import { AreaProposal, useAreaProposal, type AreaProposalProps } from './AreaProposal.js';
import './globe.css';

export interface RealPredictionStageProps extends AreaProposalProps {
  snapshotVersion: string; factVersion: string; criteria: DiscoveryValues; exclusions: DiscoveryExclusion[];
  sources: OrbitalSourceSummary[]; serverNow: string; representedUtc: string; selectedId: string | null;
  shortlistedIds: readonly string[]; target?: GlobeTarget | null; railOffset?: number; completedSearchGeneration?: number;
  onSelect: (id: string) => void; onEarthPick?: (point: { latitude: number; longitude: number; radiusKm: 25 }) => void;
  onListFallback?: () => void; onUpdateTime: () => void | Promise<void>;
  assessmentView?: AssessmentSelectedView; onReturnToBrowsing?: () => void;
}
const visibilityValue = (value: OrbitVisibility): NonNullable<OrbitalBrowseInput['visibility']> => ({ all: 'ALL', matches: 'MATCHES', shortlist: 'SHORTLIST', 'shortlist-only': 'SHORTLIST_ONLY' })[value] as NonNullable<OrbitalBrowseInput['visibility']>;
function assertPage(page: OrbitalBrowsePage, input: OrbitalBrowseInput): void {
  if (!page || page.snapshotVersion !== input.snapshotVersion || page.factVersion !== input.factVersion || page.representedAt !== input.representedAt || page.generation !== input.generation || !Array.isArray(page.objects) || page.objects.length > ORBITAL_LIMITS.browsePage) throw new Error('Mixed or malformed real prediction pages.');
  for (const item of page.objects) {
    if (!/^norad:\d{1,9}$/.test(item.id) || typeof item.name !== 'string' || item.positionAvailability === 'AVAILABLE' && (!item.position || !Object.values(item.position).every(Number.isFinite))) throw new Error('Invalid predicted object.');
    if (item.pathAvailability === 'AVAILABLE' && (!Array.isArray(item.path) || item.path.flat().length > ORBITAL_LIMITS.pathVertices || item.path.some(segment => segment.length < 2 || segment.some(value => !Object.values(value).filter(v => typeof v === 'number').every(Number.isFinite) || !Number.isFinite(Date.parse(value.at)))))) throw new Error('Invalid predicted path.');
  }
}
/** Real source adapter only. It never loads or evaluates a demonstration keyframe recipe. */
export function RealPredictionStage(props: RealPredictionStageProps) {
  const access = useCurrentContext(), stamp = contextKey(access.context), contextRef = useRef(stamp); contextRef.current = stamp;
  const [page, setPage] = useState<OrbitalBrowsePage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const [visibility, setVisibility] = useState<OrbitVisibility>(() => innerWidth < 768 ? 'shortlist' : 'matches');
  const [ready, setReady] = useState(false), [fatal, setFatal] = useState<string | null>(null), [sceneRound, setSceneRound] = useState(0), [texture, setTexture] = useState('loading');
  const [rotating, setRotating] = useState(false), [following, setFollowing] = useState(false), [details, setDetails] = useState(false), [hover, setHover] = useState<GlobeHover | null>(null), [reticle, setReticle] = useState<{ x: number; y: number } | null>(null);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches), [anchor, setAnchor] = useState<{ x: number; y: number }>(), [callout, setCallout] = useState<{ left: number; top: number } | null>(null);
  const wrapper = useRef<HTMLElement>(null), host = useRef<HTMLDivElement>(null), hud = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null), scene = useRef<GlobeController | null>(null), sequence = useRef(0), propsRef = useRef(props); propsRef.current = props;
  const criteriaStamp = JSON.stringify([props.criteria, props.exclusions]), shortlistStamp = JSON.stringify(props.shortlistedIds), targetStamp = JSON.stringify(props.target);
  const shortlist = useMemo(() => new Set(props.shortlistedIds), [shortlistStamp]);
  const target = useMemo(() => props.target ?? null, [targetStamp]);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)'), change = () => { setReduced(media.matches); if (media.matches) setRotating(false); };
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  const completed = useRef<number | undefined>(undefined);
  useEffect(() => { if (props.completedSearchGeneration !== undefined && completed.current !== props.completedSearchGeneration) { completed.current = props.completedSearchGeneration; setVisibility('matches'); } }, [props.completedSearchGeneration]);
  useEffect(() => {
    const request = ++sequence.current, abort = new AbortController(); setPage(null); setHover(null); setReticle(null); setLoading(true); setError(null);
    if (access.covered) {
      if (access.error) { setError(access.error); setLoading(false); }
      return () => abort.abort();
    }
    void (async () => {
      const current = await access.ensure(), owner = contextKey(current);
      const input: OrbitalBrowseInput = { snapshotVersion: props.snapshotVersion, factVersion: props.factVersion, representedAt: props.representedUtc, generation: request,
        criteria: props.criteria, exclusions: props.exclusions, selectedId: props.selectedId, shortlistedIds: [...props.shortlistedIds], visibility: visibilityValue(visibility) };
      const objects: OrbitalBrowseObject[] = []; const ids = new Set<string>(), cursors = new Set<string>(); let first: OrbitalBrowsePage | null = null, cursor: string | null = null;
      do {
        const result: OrbitalBrowsePage = await post('/api/orbital-browse', current, { ...input, ...(cursor ? { cursor } : {}) }, abort.signal);
        if (abort.signal.aborted || sequence.current !== request || contextRef.current !== owner) return;
        assertPage(result, input);
        if (first && JSON.stringify(first.counts) !== JSON.stringify(result.counts)) throw new Error('Prediction counts changed between pages.');
        first ??= result;
        for (const object of result.objects) { if (ids.has(object.id)) throw new Error('Duplicate prediction identity.'); ids.add(object.id); objects.push(object); }
        if (objects.length > ORBITAL_LIMITS.unionObjects || result.nextCursor && cursors.has(result.nextCursor)) throw new Error('Prediction paging exceeds its bound.');
        cursor = result.nextCursor; if (cursor) cursors.add(cursor);
      } while (cursor);
      if (!abort.signal.aborted && sequence.current === request && contextRef.current === owner && first) { setPage({ ...first, objects, nextCursor: null }); setLoading(false); }
    })().catch(failure => { if (!abort.signal.aborted && sequence.current === request) { setError(message(failure)); setLoading(false); } });
    return () => abort.abort();
  }, [props.snapshotVersion, props.factVersion, props.representedUtc, props.selectedId, criteriaStamp, shortlistStamp, targetStamp, visibility, retry, stamp, access.covered, access.error, access.ensure]);
  const objects = useMemo<DisplayTrack[]>(() => (page?.objects ?? []).filter(row => row.positionAvailability === 'AVAILABLE' && row.position).map(row => ({ id: row.id, name: row.name, position: { x: row.position!.x, y: row.position!.y, z: row.position!.z },
    paths: props.assessmentView?.itemId === row.id ? props.assessmentView.arc ? [props.assessmentView.arc.points.map(value => ({ x: value.x, y: value.y, z: value.z }))] : [] : row.pathAvailability === 'AVAILABLE' ? row.path!.map(segment => segment.map(value => ({ x: value.x, y: value.y, z: value.z }))) : [], matched: row.matched, shortlisted: shortlist.has(row.id) })), [page, shortlist, props.assessmentView]);
  const areaEnabled = !!props.onAreaProposal;
  const area = useAreaProposal(props, areaEnabled, () => { setRotating(false); setFollowing(false); setHover(null); });
  const areaRef = useRef(area); areaRef.current = area;
  const model = useMemo<GlobeSceneState>(() => ({ objects, selectedId: props.selectedId, target, visibility, rotating, following, reducedMotion: reduced, followAnchor: anchor, areaMode: areaEnabled ? area.mode : undefined, areaPreview: areaEnabled ? area.preview : null }), [objects, props.selectedId, target, visibility, rotating, following, reduced, anchor, areaEnabled, area.mode, area.preview]);
  const latest = useRef(model); latest.current = model;
  const reset = () => { setFollowing(false); setHover(null); scene.current?.reset(); }, resetRef = useRef(reset); resetRef.current = reset;
  const toggle = () => { if (area.strokeActive) return; if (area.mode === 'select') area.changeMode('rotate'); if (!rotating) setFollowing(false); setRotating(value => !value); }, toggleRef = useRef(toggle); toggleRef.current = toggle;
  useEffect(() => {
    let active = true; setReady(false); setHover(null); setFatal(null); setTexture('loading');
    const relative = <T extends { x: number; y: number }>(value: T | null): T | null => { if (!value || !host.current || !wrapper.current) return null; const canvas = host.current.getBoundingClientRect(), frame = wrapper.current.getBoundingClientRect(); return { ...value, x: value.x + canvas.left - frame.left, y: value.y + canvas.top - frame.top }; };
    void import('./ThreeGlobe.js').then(module => {
      if (!active || !host.current) return;
      const controller = module.createGlobe(host.current, { canvasLabel: 'Real predicted Earth globe', onSelect: id => propsRef.current.onSelect(id), onEarthClick: () => { if (areaEnabled) areaRef.current.earthNotice(); }, onAreaStroke: value => { if (active) areaRef.current.feedback(value); }, onAreaEscape: () => areaRef.current.escape(),
        onFatal: reason => { if (active) { setFatal(reason); setReady(false); scene.current?.dispose(); scene.current = null; } }, onTexture: status => { if (active) setTexture(status); },
        onHover: value => { if (active) setHover(relative(value)); }, onSelectedScreen: value => { if (active) setReticle(relative(value)); }, onReset: () => resetRef.current(), onToggleRotation: () => toggleRef.current() });
      if (!active) { controller.dispose(); return; } scene.current = controller; controller.update(latest.current); setReady(true);
    }).catch(() => { if (active) setFatal('The 3D renderer could not be loaded. Use the same catalog list and manual area controls.'); });
    return () => { active = false; scene.current?.dispose(); scene.current = null; };
  }, [sceneRound]);
  // Keep stationary hover through equivalent context/model adoption. New browse
  // generations, reset, lifecycle and stroke transitions retain their own clears.
  useEffect(() => { scene.current?.update(model); if (!props.selectedId) setReticle(null); }, [model]);
  useLayoutEffect(() => {
    if (!following || !ready || !wrapper.current || !host.current || !hud.current) return;
    const measure = () => {
      if (!wrapper.current || !host.current || !hud.current) return;
      const frame = wrapper.current.getBoundingClientRect(), canvas = host.current.getBoundingClientRect(), overlays = [hud.current, wrapper.current.querySelector('.globe-legend'), wrapper.current.closest('.discovery-stage')?.querySelector('.stage-topline'), document.querySelector('.mission-dock')].filter((value): value is HTMLElement => value instanceof HTMLElement);
      const bounds = { left: Math.max(0, frame.left) + 8, right: Math.min(innerWidth, frame.right) - 8, top: Math.max(0, frame.top) + 8, bottom: Math.min(innerHeight, frame.bottom) - 8 }, obstacles = overlays.map(value => value.getBoundingClientRect()).filter(rect => rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom);
      const xs = [...new Set([bounds.left, bounds.right, ...obstacles.flatMap(rect => [Math.max(bounds.left, rect.left - 8), Math.min(bounds.right, rect.right + 8)])])], ys = [...new Set([bounds.top, bounds.bottom, ...obstacles.flatMap(rect => [Math.max(bounds.top, rect.top - 8), Math.min(bounds.bottom, rect.bottom + 8)])])]; let best: { x: number; y: number; area: number } | undefined;
      for (const left of xs) for (const right of xs) for (const top of ys) for (const bottom of ys) { if (right - left < 44 || bottom - top < 44 || obstacles.some(rect => left < rect.right + 8 && right > rect.left - 8 && top < rect.bottom + 8 && bottom > rect.top - 8)) continue; const area = (right - left) * (bottom - top); if (!best || area > best.area) best = { x: (left + right) / 2 - canvas.left, y: (top + bottom) / 2 - canvas.top, area }; }
      if (best) setAnchor(previous => previous?.x === best.x && previous?.y === best.y ? previous : { x: best.x, y: best.y });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(wrapper.current); observer.observe(host.current); observer.observe(hud.current); window.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener('scroll', measure); };
  }, [following, ready, details, props.railOffset]);
  useLayoutEffect(() => {
    if (!hover || !card.current || !wrapper.current || !hud.current) { setCallout(null); return; }
    const place = () => {
      if (!card.current || !wrapper.current || !hud.current) return;
      const frame = wrapper.current.getBoundingClientRect(), obstacle = hud.current.getBoundingClientRect(), panel = card.current.getBoundingClientRect();
      const left = obstacle.left - frame.left, right = obstacle.right - frame.left, top = obstacle.top - frame.top, bottom = obstacle.bottom - frame.top;
      const choices = [{ left: hover.x + 12, top: hover.y + 12 }, { left: hover.x - panel.width - 12, top: hover.y + 12 }, { left: left - panel.width - 12, top: hover.y }, { left: hover.x, top: top - panel.height - 12 }, { left: hover.x, top: bottom + 12 }, { left: right + 12, top: hover.y }].map(value => ({ left: Math.max(8, Math.min(frame.width - panel.width - 8, value.left)), top: Math.max(8, Math.min(frame.height - panel.height - 8, value.top)) }));
      const next = choices.find(value => value.left + panel.width + 8 <= left || value.left >= right + 8 || value.top + panel.height + 8 <= top || value.top >= bottom + 8) ?? null;
      setCallout(previous => previous?.left === next?.left && previous?.top === next?.top ? previous : next);
    };
    place(); const observer = new ResizeObserver(place); observer.observe(card.current); observer.observe(hud.current); observer.observe(wrapper.current); return () => observer.disconnect();
  }, [hover]);
  const selected = page?.objects.find(row => row.id === props.selectedId), hovered = hover?.kind === 'object' ? page?.objects.find(row => row.id === hover.id) : null;
  const status = loading ? 'Calculating bounded predicted display…' : error ? 'Predicted display unavailable' : `${page?.counts.positions ?? 0} positions / ${page?.counts.paths ?? 0} tracks shown; ${page?.counts.displayLimited ?? 0} display-limited; ${page?.counts.unavailable ?? 0} missing, stale or unsupported orbit data`;
  const style = { left: callout?.left ?? 0, top: callout?.top ?? 0, visibility: callout ? 'visible' : 'hidden' } as const;
  return <section ref={wrapper} className="globe-stage public-globe real-prediction-globe" style={{ '--globe-rail-offset': `${props.railOffset ?? 0}px` } as CSSProperties} aria-label="Real orbital prediction" data-represented-utc={props.representedUtc} data-drawable-ids={objects.map(row => row.id).join(',')} data-source-version={props.snapshotVersion} data-visibility={visibility}>
    <div ref={host} className="globe-canvas-host" />{(props.railOffset ?? 0) > 0 && <div className="globe-rail-fade" aria-hidden="true" />}
    {!ready && !fatal && <p className="globe-loading" role="status">Preparing the real prediction view…</p>}
    {fatal && <div className="globe-failure" role="alert"><h2>3D globe unavailable</h2><p>{fatal}</p>{props.onListFallback && <button className="button primary" onClick={props.onListFallback}>List view · continue without WebGL</button>}<button className="button" onClick={() => setSceneRound(value => value + 1)}>Retry 3D view</button></div>}
    {ready && reticle && <span className="globe-selected-reticle" aria-hidden="true" style={{ left: reticle.x, top: reticle.y }} />}
    {ready && hover?.kind === 'ground' && areaEnabled && <><span className="globe-ground-crosshair" aria-hidden="true" style={{ left: hover.x, top: hover.y }} /><div ref={card} className="globe-ground-card" style={style}><span className="mono">{hover.latitude.toFixed(4)}°, {hover.longitude.toFixed(4)}°</span><span>Choose Select area to draw, or edit coordinates</span></div></>}
    {ready && hovered && <div ref={card} className="globe-hover-card" style={style}><strong>{hovered.name}</strong><span>{hovered.id}</span><span>Predicted at {props.representedUtc}</span><span>Element epoch {hovered.epoch ?? 'Not stated'}</span><span>Not live telemetry · Click for details</span></div>}
    <div className="globe-legend"><p className="eyebrow">Real orbital prediction · paused</p><p><i className="selected-swatch" />Selected and shortlisted</p><p><i className="matching-swatch" />Matching real identities</p><p className="helper">SGP4 prediction; no coverage, imageability or operator availability claim.</p></div>
    <div ref={hud} className="globe-hud">{areaEnabled && <AreaProposal {...props} controller={area} ready={ready && !fatal} />}
      {details && <section className="globe-orbit-details" aria-label="Real orbit details"><h2>Real orbit details</h2><p className="helper">SGP4 · TEME → approximate Earth-fixed frame; UT1≈UTC, no EOP/polar-motion correction. WGS84 geodetic display; not telemetry.</p><p className="mono">Predicted positions at {props.representedUtc}</p>{props.sources.map(source => <p className="helper" key={source.key}>{source.key}: {source.validation} · retrieved {source.retrievedAt ?? 'Not available'} · {source.error ?? 'Source provenance retained'}</p>)}<h3>Selected satellite</h3>{selected ? <><p>{selected.name} · {selected.id}</p><p className="helper">Source element epoch {selected.sourceEpoch ?? 'Not stated'}<br />Calculation epoch (UTC, millisecond precision) {selected.epoch ?? 'Not stated'}<br />Retrieved {selected.retrievedAt ?? 'Not stated'}<br />{selected.positionReason ?? selected.reason ?? 'Predicted position available.'}<br />{props.assessmentView?.itemId === selected.id ? props.assessmentView.arc ? 'Manifest-bound checked opportunity arc; the ordinary browsing path is replaced for this object.' : 'Checked opportunity arc unavailable; no ordinary path is substituted.' : selected.pathReason ?? 'Path sampled within the declared span.'}</p>{props.assessmentView?.itemId === selected.id ? props.assessmentView.arc && <p className="helper">Assessment arc {props.assessmentView.arc.startUtc} → {props.assessmentView.arc.endUtc}; {props.assessmentView.arc.sourceCadenceSeconds}s source samples · {props.assessmentView.arc.displayStepSeconds}s drawing step{props.assessmentView.arc.clippedStart || props.assessmentView.arc.clippedEnd ? ' · clipped to the checked interval' : ''}.</p> : selected.pathWindow && <p className="helper">Path {selected.pathWindow.start} → {selected.pathWindow.end}; {selected.pathWindow.stepSeconds}s samples{selected.pathWindow.clippedStart || selected.pathWindow.clippedEnd ? ' · clipped to supported span' : ''}.</p>}</> : <p className="helper">{props.selectedId ? 'Selected identity is not plotted in this mode.' : 'No selected satellite.'}</p>}<h3>Available predicted positions</h3><ul className="globe-position-list">{page?.objects.filter(row => row.positionAvailability === 'AVAILABLE').map(row => <li key={row.id}><button className="text-button" onClick={() => props.onSelect(row.id)}>{row.name}</button><span>{row.id} · {row.position!.latitude.toFixed(4)}°, {row.position!.longitude.toFixed(4)}°<br />Element epoch {row.epoch ?? 'Not stated'} · predicted, not measured</span></li>)}</ul><details><summary>Display limitations and unavailable objects</summary><ul className="globe-unavailable-list">{page?.objects.filter(row => row.positionAvailability !== 'AVAILABLE' || row.pathAvailability !== 'AVAILABLE').map(row => <li key={row.id}><strong>{row.name} · {row.id}</strong><span>{row.positionReason ?? row.reason ?? 'Position available.'} {row.pathReason}</span></li>)}</ul></details></section>}
      {error && <p className="globe-warning" role="alert">{error} No demonstration tracks are substituted. <button className="text-button" onClick={() => void access.refresh(true).then(current => { if (current) setRetry(value => value + 1); })}>Retry predicted display</button></p>}
      {texture === 'unavailable' && <p className="globe-warning" role="status">Static Earth imagery unavailable — plain Earth remains.</p>}
      <section className="globe-clock-cluster" aria-label="Real prediction controls">{props.assessmentView && <div className="planning-view-notice"><strong>Assessment view at {props.representedUtc} — paused</strong><p className="helper">The selected checked opportunity uses its manifest-bound arc; all other positions use this same UTC. {props.assessmentView.arc ? `Arc: ${props.assessmentView.arc.sourceCadenceSeconds}s source samples · ${props.assessmentView.arc.displayStepSeconds}s drawing step.` : 'Checked pass arc unavailable.'}</p><button type="button" className="button" onClick={props.onReturnToBrowsing}>Return to browsing snapshot</button></div>}<div className="globe-time"><span className="globe-time-square" aria-hidden="true" /><div><p>Real orbital prediction</p><time dateTime={props.representedUtc}>{props.representedUtc}</time></div><span className="globe-mode">PAUSED</span></div><p className="helper">Predicted positions at this shared UTC snapshot — not live telemetry.</p><p className="helper">Source: CelesTrak SAR + Earth Resources · {props.snapshotVersion.slice(0, 12)}. Element epochs vary by satellite.</p>{selected && <p className="helper">Selected element epoch {selected.epoch ?? 'Not stated'} · retrieved {selected.retrievedAt ?? 'Not stated'}{selected.position ? ` · modeled height ${selected.position.heightKm.toFixed(1)} km` : ''}. Inspect source and path bounds in Orbit details.</p>}<button className="button full" disabled={!!props.assessmentView} onClick={() => void props.onUpdateTime()}>Update predicted time to now</button>{props.assessmentView && <p className="helper">Return to browsing snapshot before updating its ordinary predicted time. The checked assessment UTC remains fixed here.</p>}<p className="globe-drawing-status" role="status">{status}</p><div className="globe-result-summary"><p>{page ? `${page.counts.matching} matching catalog objects` : loading ? 'Checking matching catalog objects…' : 'Matching display count unavailable'} · {shortlist.size} shortlisted</p>{page && <p>{page.counts.processed} records processed · {page.counts.remaining} unfinished · {page.counts.pathsLimited} paths display-limited</p>}{page?.message && <p className="helper">{page.message}</p>}<button className="button full" aria-pressed={visibility === 'shortlist-only'} onClick={() => setVisibility('shortlist-only')}>Show shortlist only</button></div>
        <label className="globe-mode-label" htmlFor="real-orbit-visibility">Show orbits for<select id="real-orbit-visibility" value={visibility} onChange={event => setVisibility(event.target.value as OrbitVisibility)}><option value="all">All catalog objects</option><option value="matches">Matches + shortlist</option><option value="shortlist">Shortlist and selected only</option><option value="shortlist-only">Shortlist only</option></select></label>
        <div className="globe-controls"><button className="button" disabled={!ready || area.strokeActive} onClick={toggle}>{rotating ? 'Pause rotation' : 'Resume rotation'}</button><button className="button" disabled={!ready || area.strokeActive} onClick={reset}>Reset view</button><button className="button" aria-pressed={details} onClick={() => setDetails(value => !value)}>Orbit details</button><button className="button" disabled={!ready || area.strokeActive || !following && !objects.some(row => row.id === props.selectedId)} onClick={() => { if (area.mode === 'select') area.changeMode('rotate'); setFollowing(value => !value); setRotating(false); }}>{following ? 'Stop following' : 'Follow selected'}</button></div>
        <div className="globe-interaction-help"><p><strong>Camera:</strong> Drag rotates; scroll zooms. Selection never follows automatically.</p><p><strong>Earth target:</strong> Use Select area to stage a circle, then Use this circle and confirm the size separately. Edit coordinates/radius remains available.</p><p>Orbit prediction does not resolve a place name, confirm imageability, reserve an operator or change your request.</p></div><p className="globe-attribution">Static context: NASA Earth Observatory — Blue Marble, July2004; Reto Stöckli. <a href="/earth/NOTICE.txt" target="_blank" rel="noreferrer">Source and rights</a>. Not live imagery.</p>
      </section>
    </div><p id="globe-keyboard-help" className="globe-keyboard-help">Drag rotates the camera; wheel or +/− zoom. In Rotate, arrows rotate, Home or0 resets and Space toggles camera rotation. Select area stages a preview; Escape cancels. Follow is explicit. Coordinate entry remains available.</p>
  </section>;
}
