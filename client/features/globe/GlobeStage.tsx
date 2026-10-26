import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CatalogItem } from '../../../shared/contracts.js';
import { GEOGRAPHIC_FRAME, GEOMETRY_METHOD, GEOMETRY_CADENCE_SECONDS, GEOMETRY_SPAN_DAYS, evaluateTrack, sampleTrackPath, validateTrack, vectorToLatLon, type DemoGeometry, type DemoTrack, type TrackValidation } from '../../../shared/globe.js';
import { api, message } from '../../lib/api.js';
import type { DisplayTrack, GlobeController, GlobeHover, GlobeSceneState, GlobeTarget, OrbitVisibility } from './scene-contract.js';
import { trackIsShown } from './scene-contract.js';
import { AreaProposal, useAreaProposal, type AreaProposalProps } from './AreaProposal.js';
import './globe.css';
export type { GlobeTarget } from './scene-contract.js';
export interface GlobeStageProps extends AreaProposalProps {
  items: CatalogItem[]; matchingIds: readonly string[] | Set<string>; selectedId: string | null; shortlistedIds: readonly string[] | Set<string>;
  target?: GlobeTarget | null; representedUtc?: string; trackedIds?: readonly string[]; railOffset?: number;
  completedSearchGeneration?: number;
  onSelect: (id: string) => void; onEarthPick?: (point: { latitude: number; longitude: number; radiusKm: 25 }) => void; onListFallback?: () => void;
}
let publicGeometry: Promise<DemoGeometry> | null = null;
function loadGeometry(retry = false) { if (retry) publicGeometry = null; if (!publicGeometry) publicGeometry = api<DemoGeometry>('/api/public/geometry').catch(error => { publicGeometry = null; throw error; }); return publicGeometry; }
function canonicalUtc(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && new Date(instant).toISOString() === value ? instant : null;
}
function validGeometryIdentity(value: DemoGeometry): boolean {
  if (!value || typeof value !== 'object' || value.earthRadius !== 1 || value.frame !== GEOGRAPHIC_FRAME || value.method !== GEOMETRY_METHOD || value.recipeVersion !== 'synthetic-display-geometry-v1' || value.cadenceSeconds !== GEOMETRY_CADENCE_SECONDS || !Array.isArray(value.tracks)) return false;
  const epoch = canonicalUtc(value.epoch), start = canonicalUtc(value.spanStart), end = canonicalUtc(value.spanEnd), halfSpan = GEOMETRY_SPAN_DAYS * 86400 * 1000;
  return epoch !== null && start !== null && end !== null && start === epoch - halfSpan && end === epoch + halfSpan;
}
export function GlobeStage(props: GlobeStageProps) {
  const mission = props.trackedIds !== undefined;
  const [geometry, setGeometry] = useState<DemoGeometry | null>(null), [geometryError, setGeometryError] = useState<string | null>(null), [geometryRound, setGeometryRound] = useState(0);
  const [fatal, setFatal] = useState<string | null>(null), [sceneRound, setSceneRound] = useState(0), [ready, setReady] = useState(false), [texture, setTexture] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches), [rotating, setRotating] = useState(() => !mission && !matchMedia('(prefers-reduced-motion: reduce)').matches), [following, setFollowing] = useState(false);
  const [visibility, setVisibility] = useState<OrbitVisibility>(() => window.innerWidth < 768 ? 'shortlist' : 'all'), [details, setDetails] = useState(false), [hover, setHover] = useState<GlobeHover | null>(null), [reticle, setReticle] = useState<{ x: number; y: number } | null>(null);
  const [hoverPlacement, setHoverPlacement] = useState<{ left: number; top: number } | null>(null);
  const [followAnchor, setFollowAnchor] = useState<{ x: number; y: number }>();
  const hud = useRef<HTMLDivElement>(null), hoverCard = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null), wrapper = useRef<HTMLElement>(null), scene = useRef<GlobeController | null>(null), mounted = useRef(true), propsRef = useRef(props); propsRef.current = props;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const preference = matchMedia('(prefers-reduced-motion: reduce)'); const changed = () => { setReduced(preference.matches); if (preference.matches) setRotating(false); }; preference.addEventListener('change', changed); return () => preference.removeEventListener('change', changed); }, []);
  useEffect(() => { let active = true; setGeometryError(null); void loadGeometry(geometryRound > 0).then(value => { if (!active) return; if (!validGeometryIdentity(value)) throw new Error('The demonstration geometry source has an invalid identity, epoch or declared span.'); setGeometry(value); }).catch(error => { if (active) { setGeometry(null); setGeometryError(message(error)); } }); return () => { active = false; }; }, [geometryRound]);
  const matching = useMemo(() => new Set(props.matchingIds), [props.matchingIds]), shortlisted = useMemo(() => new Set(props.shortlistedIds), [props.shortlistedIds]);
  const tracked = useMemo(() => mission ? new Set(props.trackedIds) : null, [mission, props.trackedIds]);
  const instant = mission ? props.representedUtc ?? null : props.representedUtc ?? geometry?.epoch ?? null;
  const validation = useMemo(() => {
    const result = new Map<string, { track: DemoTrack; checked: TrackValidation }>();
    for (const track of geometry?.tracks ?? []) {
      if (!track || typeof track !== 'object' || Array.isArray(track) || typeof track.itemId !== 'string') continue;
      const checked = result.has(track.itemId) ? { valid: false, reason: 'This identity has duplicate demonstration geometry.' } : geometry && (track.epoch !== geometry.epoch || track.spanStart !== geometry.spanStart || track.spanEnd !== geometry.spanEnd || track.cadenceSeconds !== geometry.cadenceSeconds || track.frame !== geometry.frame || track.method !== geometry.method) ? { valid: false, reason: 'This object does not match the source’s declared epoch, span or display identity.' } : validateTrack(track);
      result.set(track.itemId, { track, checked });
    }
    return result;
  }, [geometry]);
  const evaluated = useMemo(() => {
    const objects: DisplayTrack[] = [], missing: { id: string; name: string; reason: string }[] = [];
    const requested = tracked ? [...tracked] : props.items.map(item => item.id);
    for (const id of requested) {
      const item = props.items.find(value => value.id === id), name = item?.name ?? id, entry = validation.get(id), track = entry?.track, checked = entry?.checked;
      let reason = !geometry && geometryError ? 'Demonstration orbit data source unavailable.' : !instant ? mission ? 'No recorded planned instant.' : 'Waiting for the held demonstration epoch.' : !track ? 'No demonstration orbit data is supplied for this satellite.' : !checked?.valid ? checked?.reason ?? 'Invalid geometry.' : '';
      const position = !reason && track && instant ? evaluateTrack(track, instant) : null, path = position && track && instant ? sampleTrackPath(track, instant) : null;
      if (!reason && (!position || !path)) reason = 'The displayed instant is outside the valid supplied span, or an interval is unavailable. No extrapolation is shown.';
      if (position && path) objects.push({ id, name, position, path: path.points, matched: matching.has(id), shortlisted: shortlisted.has(id) }); else missing.push({ id, name, reason });
    }
    return { objects, missing };
  }, [geometry, geometryError, validation, instant, tracked, props.items, matching, shortlisted, mission]);
  const areaEnabled = !mission && !!props.onAreaProposal;
  const area = useAreaProposal(props, areaEnabled, () => { setRotating(false); setFollowing(false); setHover(null); });
  const areaRef = useRef(area); areaRef.current = area;
  const model = useMemo<GlobeSceneState>(() => ({ objects: evaluated.objects, selectedId: props.selectedId, target: props.target ?? null, visibility, rotating: rotating && (!mission || !!instant), following, reducedMotion: reduced, followAnchor, areaMode: areaEnabled ? area.mode : undefined, areaPreview: areaEnabled ? area.preview : null }), [evaluated.objects, props.selectedId, props.target, visibility, rotating, mission, instant, following, reduced, followAnchor, areaEnabled, area.mode, area.preview]);
  const latest = useRef(model); latest.current = model;
  const reset = () => { setFollowing(false); setHover(null); scene.current?.reset(); };
  const toggleRotation = () => { if (mission && !instant || area.strokeActive) return; if (area.mode === 'select') area.changeMode('rotate'); if (!rotating) setFollowing(false); setRotating(value => !value); };
  const resetRef = useRef(reset), toggleRef = useRef(toggleRotation); resetRef.current = reset; toggleRef.current = toggleRotation;
  const relative = <T extends { x: number; y: number }>(value: T | null): T | null => { if (!value || !host.current || !wrapper.current) return null; const canvasBox = host.current.getBoundingClientRect(), box = wrapper.current.getBoundingClientRect(); return { ...value, x: value.x + canvasBox.left - box.left, y: value.y + canvasBox.top - box.top }; };
  useEffect(() => {
    let active = true; setReady(false); setHover(null); setFatal(null); setTexture('loading');
    void import('./ThreeGlobe.js').then(module => {
      if (!active || !host.current) return;
      const controller = module.createGlobe(host.current, { onSelect: id => propsRef.current.onSelect(id), onEarthClick: () => { if (areaEnabled) areaRef.current.earthNotice(); }, onAreaStroke: value => { if (active) areaRef.current.feedback(value); }, onAreaEscape: () => areaRef.current.escape(), onFatal: reason => { if (active) { setFatal(reason); setReady(false); scene.current?.dispose(); scene.current = null; } }, onTexture: status => { if (active) setTexture(status); }, onHover: value => { if (active) setHover(relative(value)); }, onSelectedScreen: value => { if (active) setReticle(relative(value)); }, onReset: () => resetRef.current(), onToggleRotation: () => toggleRef.current() });
      if (!active) { controller.dispose(); return; } scene.current = controller; controller.update(latest.current); setReady(true);
    }).catch(error => { if (active) { setFatal(error instanceof Error ? error.message : 'The 3D renderer could not be loaded.'); setReady(false); } });
    return () => { active = false; scene.current?.dispose(); scene.current = null; };
  }, [sceneRound]);
  // Equivalent parent renders must not erase a stationary pointer's hover. The
  // renderer recomputes its current hit; reset, leave and stroke clears stay explicit.
  useEffect(() => { scene.current?.update(model); if (!props.selectedId) setReticle(null); }, [model]);
  useEffect(() => { if (mission) { setRotating(false); setFollowing(false); } }, [mission, instant]);
  const completedSearch = useRef<number | undefined>(undefined);
  useEffect(() => {
    const generation = props.completedSearchGeneration;
    if (mission || generation === undefined || !Number.isSafeInteger(generation) || generation < 1 || completedSearch.current === generation) return;
    completedSearch.current = generation;
    // Reveal eligible drawings only. Search never selects, follows or moves the chosen Earth area.
    setVisibility('matches');
  }, [mission, props.completedSearchGeneration]);
  const visible = evaluated.objects.filter(item => trackIsShown(item, visibility, props.selectedId));
  const selected = evaluated.objects.find(item => item.id === props.selectedId), selectedMissing = evaluated.missing.find(item => item.id === props.selectedId);
  const hoveredItem = hover?.kind === 'object' ? props.items.find(item => item.id === hover.id) : null;
  useLayoutEffect(() => {
    if (!following || !ready || !wrapper.current || !host.current || !hud.current) return;
    // Follow must frame the selected point in usable canvas space, not behind the HUD.
    // This changes only explicit camera framing; geography, selection and target stay fixed.
    const measure = () => {
      if (!wrapper.current || !host.current || !hud.current) return;
      const frame = wrapper.current.getBoundingClientRect(), canvas = host.current.getBoundingClientRect();
      const overlays = [hud.current, wrapper.current.querySelector('.globe-legend'), document.querySelector('.mission-dock')].filter((value): value is HTMLElement => value instanceof HTMLElement);
      const bounds = { left: Math.max(frame.left, 0) + 8, top: Math.max(frame.top, 0) + 8, right: Math.min(frame.right, innerWidth) - 8, bottom: Math.min(frame.bottom, innerHeight) - 8 };
      const obstacles = overlays.map(value => value.getBoundingClientRect()).filter(rect => rect.right > bounds.left && rect.left < bounds.right && rect.bottom > bounds.top && rect.top < bounds.bottom);
      const xs = [...new Set([bounds.left, bounds.right, ...obstacles.flatMap(rect => [Math.max(bounds.left, rect.left - 8), Math.min(bounds.right, rect.right + 8)])])].sort((a, b) => a - b);
      const ys = [...new Set([bounds.top, bounds.bottom, ...obstacles.flatMap(rect => [Math.max(bounds.top, rect.top - 8), Math.min(bounds.bottom, rect.bottom + 8)])])].sort((a, b) => a - b);
      let best: { x: number; y: number; area: number } | undefined;
      for (const left of xs) for (const right of xs) for (const top of ys) for (const bottom of ys) {
        if (right - left < 44 || bottom - top < 44 || obstacles.some(rect => left < rect.right + 8 && right > rect.left - 8 && top < rect.bottom + 8 && bottom > rect.top - 8)) continue;
        const area = (right - left) * (bottom - top);
        if (!best || area > best.area) best = { x: (left + right) / 2 - canvas.left, y: (top + bottom) / 2 - canvas.top, area };
      }
      if (best) setFollowAnchor(previous => previous?.x === best.x && previous?.y === best.y ? previous : { x: best.x, y: best.y });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(wrapper.current); observer.observe(host.current); observer.observe(hud.current);
    for (const overlay of [wrapper.current.querySelector('.globe-legend'), document.querySelector('.mission-dock')]) if (overlay) observer.observe(overlay);
    window.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); window.removeEventListener('scroll', measure); };
  }, [following, ready, details, props.railOffset]);
  useLayoutEffect(() => {
    if (!hover || !ready || !wrapper.current || !hud.current || !hoverCard.current) { setHoverPlacement(null); return; }
    const place = () => {
      const frame = wrapper.current?.getBoundingClientRect(), controls = hud.current?.getBoundingClientRect(), card = hoverCard.current?.getBoundingClientRect();
      if (!frame || !controls || !card) return;
      const margin = 8, gap = 12, maxLeft = frame.width - card.width - margin, maxTop = frame.height - card.height - margin;
      const left = controls.left - frame.left, right = controls.right - frame.left, top = controls.top - frame.top, bottom = controls.bottom - frame.top;
      const candidates = [
        { left: hover.x + gap, top: hover.y + gap }, { left: hover.x - card.width - gap, top: hover.y + gap },
        { left: hover.x + gap, top: hover.y - card.height - gap }, { left: hover.x - card.width - gap, top: hover.y - card.height - gap },
        { left: left - card.width - gap, top: hover.y + gap }, { left: right + gap, top: hover.y + gap },
        { left: hover.x + gap, top: top - card.height - gap }, { left: hover.x + gap, top: bottom + gap },
      ].map(value => ({ left: Math.max(margin, Math.min(maxLeft, value.left)), top: Math.max(margin, Math.min(maxTop, value.top)) }));
      const next = maxLeft < margin || maxTop < margin ? null : candidates.find(value => value.left + card.width + margin <= left || value.left >= right + margin || value.top + card.height + margin <= top || value.top >= bottom + margin) ?? null;
      // If the HUD fills a narrow view, keep its controls clear instead of covering them.
      setHoverPlacement(previous => previous?.left === next?.left && previous?.top === next?.top ? previous : next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(wrapper.current); observer.observe(hud.current); observer.observe(hoverCard.current);
    return () => observer.disconnect();
  }, [hover, ready]);
  const hoverStyle = { left: hoverPlacement?.left ?? 0, top: hoverPlacement?.top ?? 0, visibility: hoverPlacement ? 'visible' : 'hidden' } as const;
  const unavailableCount = evaluated.missing.length;
  const geometryLoading = !geometry && !geometryError;
  const matchingGeometry = evaluated.objects.filter(item => item.matched).length, shortlistGeometry = evaluated.objects.filter(item => item.shortlisted).length;
  const timeLabel = instant ?? (mission ? 'No recorded planned instant' : geometryError ? 'Held D0 unavailable' : 'Loading held D0…');
  const tracks = (count: number) => `${count} satellite track${count === 1 ? '' : 's'}`;
  return <section ref={wrapper} className={`globe-stage ${mission ? 'mission-globe' : 'public-globe'}`} style={{ '--globe-rail-offset': `${props.railOffset ?? 0}px` } as React.CSSProperties} aria-label={mission ? 'Recorded mission demonstration geometry' : 'Public demonstration geometry'} data-represented-utc={instant ?? ''} data-tracked-ids={mission ? [...tracked!].join(',') : undefined} data-drawable-ids={visible.map(item => item.id).join(',')} data-visibility={visibility}>
    <div ref={host} className="globe-canvas-host" aria-hidden={!!fatal} />{(props.railOffset ?? 0) > 0 && <div className="globe-rail-fade" aria-hidden="true" />}
    {!ready && !fatal && <p className="globe-loading" role="status">Preparing the demonstration Earth view…</p>}{fatal && <div className="globe-failure" role="alert"><h2>3D globe unavailable</h2><p>{fatal}</p>{props.onListFallback && <button className="button primary" onClick={props.onListFallback}>List view · continue without WebGL</button>}<button className="button" onClick={() => setSceneRound(value => value + 1)}>Retry 3D view</button><p className="helper">The same list, explicit coordinates, brief and saved records remain available.</p></div>}
    {ready && reticle && <span className="globe-selected-reticle" aria-hidden="true" style={{ left: reticle.x, top: reticle.y }} />}
    {ready && hover && hover.kind === 'ground' && areaEnabled && <><span className="globe-ground-crosshair" aria-hidden="true" style={{ left: hover.x, top: hover.y }} /><div ref={hoverCard} className="globe-ground-card" style={hoverStyle}><span className="mono">{hover.latitude.toFixed(4)}°, {hover.longitude.toFixed(4)}°</span><span>Choose Select area to draw, or edit coordinates</span></div></>}
    {ready && hover?.kind === 'object' && <div ref={hoverCard} className="globe-hover-card" style={hoverStyle}><strong>{hoveredItem?.name ?? hover.id}</strong><span>{hover.id} · Demonstration</span><span>{instant ?? 'No represented instant'}</span><span>synthetic display geometry v1</span><span>Physical altitude / real elements: Not recorded</span><span>{matching.has(hover.id) ? 'Click for details' : 'Not in the current matches · Click for details'}</span></div>}
    <div className="globe-legend"><p className="eyebrow">Demonstration geometry</p><p><i className="selected-swatch" />Selected and shortlisted tracks</p><p><i className="matching-swatch" />Matching satellite tracks</p><p><i className="available-swatch" />Every available satellite track</p>{ready && visible.length > 0 && <p className="helper">Earth observation · {tracks(visible.length)} shown</p>}<p className="helper">Hover or click a satellite. No telemetry, coverage or operator availability.</p></div>
    <div ref={hud} className="globe-hud">{areaEnabled && <AreaProposal {...props} controller={area} ready={ready && !fatal} />}{details && <section className="globe-orbit-details" aria-label="Orbit details"><h2>Orbit details</h2><p className="helper">Synthetic display geometry v1 · Earth-fixed display frame. Not orbital elements, propagation, telemetry, measured altitude or collection evidence.</p><dl className="globe-counts"><div><dt>{mission ? 'Tracked IDs' : 'In catalog'}</dt><dd>{mission ? tracked!.size : props.items.length}</dd></div><div><dt>Satellite tracks available</dt><dd>{evaluated.objects.length}</dd></div><div><dt>Satellite tracks shown</dt><dd>{visible.length}</dd></div><div><dt>Matching tracks available</dt><dd>{evaluated.objects.filter(item => item.matched).length}</dd></div></dl><h3>Represented instant</h3><p className="mono">{timeLabel}</p><p className="helper">{mission ? 'Paused at the saved schedule start. Only this plan’s tracked IDs are eligible; the display never borrows public or shortlisted tracks.' : 'Held at the persisted D0 initialization snapshot. The separate live header UTC is not this represented time.'} Rotation moves only the camera.</p>{geometry && <p className="helper">Supplied span: {geometry.spanStart} → {geometry.spanEnd}. Nothing is extrapolated outside it.</p>}<h3>Selected object</h3>{selected ? <><p>{selected.name}</p><p className="helper">{selected.id}<br />{visible.some(item => item.id === selected.id) ? 'Available in this display mode.' : 'Satellite track available, hidden by the chosen display mode.'}<br />Display radius is dimensionless; physical altitude is Not recorded.</p></> : <p className="helper">{props.selectedId ? selectedMissing?.reason ?? (mission ? 'The selected identity is not recorded among this plan’s tracked spacecraft.' : 'The selected satellite has no available orbit data.') : 'No selected object.'}</p>}<h3>Camera and keyboard</h3><p className="helper">Drag to rotate the camera; wheel or +/− zoom. Arrow keys rotate. Home or 0 resets; Space pauses/resumes camera rotation. Selection alone never follows; displayed time stays fixed.</p><h3>Available positions</h3>{evaluated.objects.length ? <ul className="globe-position-list">{evaluated.objects.map(item => { const location = vectorToLatLon(item.position)!; return <li key={item.id}><button className="text-button" onClick={() => props.onSelect(item.id)}>{item.name}</button><span>{location.latitude.toFixed(4)}°, {location.longitude.toFixed(4)}° · Demonstration</span></li>; })}</ul> : <p className="helper">No satellite tracks are available at this represented instant.</p>}{unavailableCount > 0 && <details><summary>Missing orbit data · {unavailableCount}</summary><ul className="globe-unavailable-list">{evaluated.missing.map(item => <li key={item.id}><strong>{item.name}</strong><span>{item.reason}</span></li>)}</ul></details>}{geometryError && <p className="warning-text helper">{geometryError}</p>}<button className="button" onClick={() => setGeometryRound(value => value + 1)}>Retry demonstration geometry</button></section>}
      {geometryError && <p className="globe-warning" role="alert">Demonstration orbit data unavailable. Earth and the list remain usable. <button className="text-button" onClick={() => setGeometryRound(value => value + 1)}>Retry geometry</button></p>}{texture === 'unavailable' && <p className="globe-warning" role="status">Static Earth imagery unavailable — plain Earth remains. This does not change evidence, target or request records.</p>}
      <section className="globe-clock-cluster" aria-label="Demonstration geometry controls"><div className="globe-time"><span className="globe-time-square" aria-hidden="true" /><div><p>Demonstration geometry</p><time dateTime={instant ?? undefined}>{timeLabel}</time></div><span className="globe-mode">{mission ? 'PLAN / PAUSED' : geometryError ? 'UNAVAILABLE' : 'HELD D0'}</span></div>{mission && tracked!.size === 0 && <p className="helper">No tracked spacecraft recorded{instant ? ' for this plan' : ' yet'}. The confirmed Earth target remains visible; no catalog tracks are substituted.</p>}<p className="globe-drawing-status" role="status">{geometryLoading ? 'Loading demonstration satellite tracks…' : fatal ? `3D display unavailable · ${tracks(evaluated.objects.length)} available` : `${tracks(visible.length)} shown${unavailableCount ? ` · ${unavailableCount} without orbit data` : ''}`}</p>{!mission && <div className="globe-result-summary" aria-label="Match and shortlist satellite tracks"><p className="globe-match-summary">{matching.size} current matches · {geometryLoading ? 'checking orbit data' : `${tracks(matchingGeometry)} available · ${matching.size - matchingGeometry} without orbit data`}</p><p className="globe-shortlist-summary">{shortlisted.size} shortlisted · {geometryLoading ? 'checking orbit data' : `${tracks(shortlistGeometry)} available · ${shortlisted.size - shortlistGeometry} without orbit data`}</p><button className="button full" aria-pressed={visibility === 'shortlist-only'} onClick={() => setVisibility('shortlist-only')}>Show shortlist only</button>{visibility === 'shortlist-only' && <p className="helper">{shortlisted.size ? 'Only exact shortlisted satellites with orbit data are shown. Selection, camera and Earth target stay unchanged.' : 'Your shortlist is empty. Add a candidate from the list or its details; no selected or matching identity is substituted.'}</p>}</div>}<div className="globe-interaction-help" aria-label="Globe interactions">{!mission && <p>Search filters a fixed set of authored demonstration tracks. It does not fetch new orbit data.</p>}<p><strong>Camera:</strong> Drag to rotate; scroll to zoom. Use Follow selected to follow a satellite.</p>{!mission && <p><strong>Satellites:</strong> Click for details; shortlist to keep evidence. Neither changes the camera or Earth target.</p>}<p><strong>Earth target:</strong> {areaEnabled ? 'Use Select area to stage a circle, then Use this circle and confirm the size separately. Numeric editing remains in the request brief.' : 'The saved circle is shown for context. This view does not change the brief.'}</p></div><label className="globe-mode-label" htmlFor={`orbit-visibility-${mission ? 'mission' : 'public'}`}>Show orbits for<select id={`orbit-visibility-${mission ? 'mission' : 'public'}`} value={visibility} onChange={event => setVisibility(event.target.value as OrbitVisibility)}><option value="all">All visible satellites</option><option value="matches">Matches + shortlist</option><option value="shortlist">Shortlist and selected only</option>{!mission && <option value="shortlist-only">Shortlist only</option>}</select></label><div className="globe-controls"><button className="button" disabled={!ready || area.strokeActive || mission && !instant} onClick={toggleRotation}>{rotating ? 'Pause rotation' : 'Resume rotation'}</button><button className="button" disabled={!ready || area.strokeActive} onClick={reset}>Reset view</button><button className="button" aria-pressed={details} onClick={() => setDetails(value => !value)}>Orbit details</button><button className="button" disabled={!ready || area.strokeActive || !following && (!selected || !visible.some(item => item.id === selected.id))} onClick={() => { if (area.mode === 'select') area.changeMode('rotate'); setFollowing(value => !value); setRotating(false); }}>{following ? 'Stop following' : 'Follow selected'}</button></div><p className="globe-attribution">Static context: NASA Earth Observatory — Blue Marble: Next Generation, July 2004; Reto Stöckli. <a href="/earth/NOTICE.txt" target="_blank" rel="noreferrer">Source and rights</a>. Not live imagery or the requested SAR result.</p></section>
    </div><p id="globe-keyboard-help" className="globe-keyboard-help">Drag to rotate the camera; wheel or +/− zoom. In Rotate, arrow keys rotate, Home or 0 resets and Space pauses/resumes rotation. Select area draws a staged preview; Escape cancels. Satellite selection never follows. Use the list for keyboard details and explicit coordinates for a target.</p>
  </section>;
}
