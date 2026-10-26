import type { BriefInput } from '../../../shared/contracts.js';
import { createEmptyBrief } from '../../../shared/validation.js';
import './planning.css';

export const observationIntent = (brief: Pick<BriefInput, 'observationIntent'>) => brief.observationIntent ?? 'comparison';
export const createPlanningBrief = (): BriefInput => ({ ...createEmptyBrief(), observationIntent: 'single-observation' });
export const planningSensor = (value: string) => value === 'Visible' ? 'VISIBLE' : value === 'Thermal' ? 'THERMAL' : value;
export const supportedPlanningSensor = (value: string) => ['OPEN', 'SAR', 'VISIBLE', 'SWIR', 'THERMAL'].includes(planningSensor(value));
export function EOIntent({ brief, change, disabled = false }: { brief: Pick<BriefInput, 'observationIntent'>; change: (patch: Partial<BriefInput>) => void; disabled?: boolean }) {
  const selected = observationIntent(brief);
  return <fieldset className="observation-intent" disabled={disabled}><legend>Observation</legend><div className="intent-options">{([['single-observation', 'Single observation'], ['comparison', 'Baseline–recent comparison']] as const).map(([value, label]) => <label className="check" key={value}><input type="radio" name="observation-intent" value={value} checked={selected === value} onChange={() => change({ observationIntent: value })} />{label}</label>)}</div><p className="helper">{selected === 'single-observation' ? 'Plan one observation without inventing a comparison pair. Supply a planning window when you are ready.' : 'Keep independently chosen comparison reference dates separate from the planning window and actual imagery dates.'}</p></fieldset>;
}
export function FulfillmentBoundary({ brief }: { brief: Pick<BriefInput, 'observationIntent' | 'sensor'> }) {
  return <p className="helper planning-boundary">{observationIntent(brief) !== 'comparison' || planningSensor(brief.sensor) !== 'SAR' ? 'Technical planning only. Actual single-observation/optical supply, processing and delivery are not implemented. No operator booking or collection is created.' : 'The supplied-result demonstration uses the separately reviewed synthetic SAR comparison. Planning does not create an acquisition or operator booking.'}</p>;
}
