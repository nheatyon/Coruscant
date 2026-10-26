import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { circleReadouts } from '../../../shared/validation.js';
import { nextAreaGeneration, validAreaCircle, type AreaCircle, type AreaInteractionMode, type AreaProposal as Proposal, type AreaStrokeFeedback } from '../../../shared/area-proposal.js';

export interface AreaProposalProps {
  areaProposal?: Proposal | null;
  onAreaProposal?: (proposal: Proposal | null) => void;
  onUseAreaProposal?: (proposal: Proposal) => void;
  onAdjustAreaProposal?: (proposal: Proposal | null) => void;
}
export function useAreaProposal(props: AreaProposalProps, enabled: boolean, onEnter: () => void) {
  const [mode, setMode] = useState<AreaInteractionMode>('rotate'), [stroke, setStroke] = useState<{ active: boolean; circle: AreaCircle | null }>({ active: false, circle: null }), [notice, setNotice] = useState('');
  const sequence = useRef(0), current = useRef({ props, enabled, onEnter, mode, stroke }); current.current = { props, enabled, onEnter, mode, stroke };
  const changeMode = (value: AreaInteractionMode) => {
    if (!enabled || value === mode) return;
    if (value === 'select') { onEnter(); setNotice('Drag from the circle center to its edge. Release to preview; then use and confirm the area separately.'); }
    setStroke({ active: false, circle: null }); setMode(value);
  };
  const feedback = (value: AreaStrokeFeedback) => {
    const state = current.current; if (!state.enabled) return;
    if (value.phase === 'start') {
      // A deliberate new gesture invalidates pending lookup work immediately;
      // the central controller retains this exact preceding proposal.
      state.props.onAreaProposal?.(state.props.areaProposal ?? null);
      setStroke({ active: true, circle: null }); setNotice('Drag from the circle center to its edge.');
    }
    else if (value.phase === 'move') { setStroke({ active: true, circle: value.circle }); setNotice(value.message); }
    else if (value.phase === 'complete') {
      setStroke({ active: false, circle: null });
      const generation = nextAreaGeneration(sequence.current, state.props.areaProposal?.generation); sequence.current = generation;
      state.props.onAreaProposal?.({ generation, origin: 'globe-drag', circle: value.circle }); setNotice('Proposed area. The brief and its confirmation have not changed.');
    } else { setStroke({ active: false, circle: null }); setNotice(value.message); }
  };
  const escape = () => {
    if (current.current.stroke.active) return;
    if (current.current.props.areaProposal) { current.current.props.onAreaProposal?.(null); setNotice('Proposal canceled. The previous target and confirmation are unchanged.'); }
  };
  useEffect(() => { if (!props.areaProposal) setNotice(previous => previous === 'Proposed area. The brief and its confirmation have not changed.' ? '' : previous); }, [props.areaProposal]);
  useEffect(() => { if (!enabled) { setMode('rotate'); setStroke({ active: false, circle: null }); } }, [enabled]);
  return { mode, changeMode, strokeActive: stroke.active, preview: stroke.active ? stroke.circle : props.areaProposal?.circle ?? null, notice, feedback, escape,
    earthNotice: () => setNotice('Choose Select area to draw, or edit coordinates.'),
    cancel: () => { setStroke({ active: false, circle: null }); props.onAreaProposal?.(null); setNotice('Proposal canceled. The previous target and confirmation are unchanged.'); },
    use: () => { if (props.areaProposal && validAreaCircle(props.areaProposal.circle)) { props.onUseAreaProposal?.(props.areaProposal); setNotice('Area applied. Confirm its size separately in the request brief.'); } },
  };
}
export type AreaProposalController = ReturnType<typeof useAreaProposal>;
export function AreaProposal({ controller, ready, ...props }: AreaProposalProps & { controller: AreaProposalController; ready: boolean }) {
  const proposal = props.areaProposal, proposed = proposal && validAreaCircle(proposal.circle) ? proposal.circle : null;
  const readouts = proposed ? circleReadouts(proposed.radiusKm) : null;
  const keyboardMode = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); const next = controller.mode === 'rotate' ? 'select' : 'rotate'; if (next === 'select' && !ready) return; controller.changeMode(next); const group = event.currentTarget.parentElement; (group?.querySelector(`[data-area-mode="${next}"]`) as HTMLButtonElement | null)?.focus(); }
  };
  return <section className="globe-area-panel" aria-label="Earth area controls" onKeyDown={event => { if (event.key === 'Escape' && !controller.strokeActive) { event.preventDefault(); controller.escape(); } }}>
    <div className="globe-area-modes" role="group" aria-label="Globe interaction mode"><button className="button" data-area-mode="rotate" aria-pressed={controller.mode === 'rotate'} onKeyDown={keyboardMode} onClick={() => controller.changeMode('rotate')}>Rotate</button><button className="button" data-area-mode="select" aria-pressed={controller.mode === 'select'} disabled={!ready} onKeyDown={keyboardMode} onClick={() => controller.changeMode('select')}>Select area</button></div>
    <p className="helper">{controller.mode === 'select' ? 'Drag from the circle center to its edge. Release to preview; then use and confirm the area separately.' : 'Drag rotates the camera. Earth clicks do not change the target.'}</p>
    <button className="text-button" onClick={() => props.onAdjustAreaProposal?.(null)}>Edit coordinates and radius</button>
    {controller.notice && <p className="globe-area-notice" role="status">{controller.notice}</p>}
    {controller.strokeActive && <p className="mono" aria-live="off">{controller.preview ? `Center ${controller.preview.latitude.toFixed(4)}°, ${controller.preview.longitude.toFixed(4)}° · Radius ${controller.preview.radiusKm.toFixed(3)} km` : 'Choosing circle edge…'}</p>}
    {proposed && <section className="globe-area-preview" aria-label="Proposed area"><h3>Proposed area</h3><p className="mono">Center {proposed.latitude.toFixed(4)}°, {proposed.longitude.toFixed(4)}°<br />Radius {proposed.radiusKm.toFixed(3)} km</p><p className="helper">Approximate area {readouts!.areaKm2.toLocaleString(undefined, { maximumFractionDigits: 2 })} km². Not applied or confirmed; this is not satellite coverage.</p><div className="globe-area-actions"><button className="button primary" disabled={controller.strokeActive} onClick={controller.use}>Use this circle</button><button className="button" disabled={controller.strokeActive} onClick={() => props.onAdjustAreaProposal?.(proposal ?? null)}>Adjust coordinates and radius</button><button className="button" disabled={controller.strokeActive} onClick={controller.cancel}>Cancel proposal</button></div></section>}
  </section>;
}
