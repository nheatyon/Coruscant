import { useEffect, useRef, useState } from 'react';
import type { CustomerResultProjection, PublishedImage } from '../../../shared/material.js';
import { validateObservation, type ObservationProjection } from '../../../shared/observations.js';
import type { Point } from '../../../shared/image-view.js';
import { useCurrentContext } from '../../lib/context.js';
import { Panel } from '../../shell/Panel.js';
import { ActionNotice, Errors, Field, formatTime } from '../workflow/WorkflowUI.js';
import { useWorkflow } from '../workflow/useWorkflow.js';
import { imageKey } from './presentation.js';

interface ObservationDraft { point: Point | null; text: string; xInput: string; yInput: string; xValue: number | null; yValue: number | null; editing: { id: string; version: number } | null }
const empty = (): ObservationDraft => ({ point: null, text: '', xInput: '', yInput: '', xValue: null, yValue: null, editing: null });
function coordinate(raw: string): number | null { if (!raw.trim()) return null; const value = Number(raw); return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null; }
function resolvedPoint(raw: ObservationDraft): Point | null {
  if (!raw.point) return null;
  const x = raw.xInput === raw.point.x.toFixed(4) ? raw.point.x : coordinate(raw.xInput);
  const y = raw.yInput === raw.point.y.toFixed(4) ? raw.point.y : coordinate(raw.yInput);
  return x === null || y === null ? null : { x, y };
}
export function useObservations(result: CustomerResultProjection, image: PublishedImage | undefined, saved: (text: string) => void) {
  const { context } = useCurrentContext();
  const writer = context?.audience === 'CUSTOMER' && ['OWNER', 'REQUESTER'].includes(context.role ?? '');
  const record = { id: result.requestId, organizationId: result.organizationId, requestVersion: result.requestVersion, briefRevision: result.briefRevision };
  const notes = result.observations.filter(note => image && note.assetId === image.assetId && note.contentVersion === image.contentVersion);
  const exact = image ? imageKey(image) : 'none';
  const form = useWorkflow(record, `observation:${exact}`, empty(), text => { form.saved(empty()); setNotice(null); saved(text); }, notes.map(note => `${note.id}:${note.version}`).join('|'));
  const [mode, setMode] = useState<'pan' | 'point'>('pan');
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setMode('pan'); setNotice(null); }, [exact]);
  const point = (value: Point | null) => { if (!writer || form.entry.uncertain) return; if (!value) { setNotice('Choose a point inside the actual image. Letterboxing is not image content.'); return; } form.change(current => ({ ...current, point: value, xInput: value.x.toFixed(4), yInput: value.y.toFixed(4), xValue: value.x, yValue: value.y })); setNotice(null); };
  const cancelPoint = () => { if (!writer || form.entry.uncertain) return; form.change(current => ({ ...current, point: null, xInput: '', yInput: '', xValue: null, yValue: null })); };
  const commitCoordinate = (axis: 'x' | 'y') => {
    const key = axis === 'x' ? 'xInput' : 'yInput';
    form.change(current => {
      const raw = current[key], previous = current[axis === 'x' ? 'xValue' : 'yValue'] ?? current.point?.[axis] ?? null;
      const value = previous !== null && raw === previous.toFixed(4) ? previous : coordinate(raw);
      if (value === null) return current;
      if (current.point && raw === current.point[axis].toFixed(4)) return current;
      const otherAxis = axis === 'x' ? 'y' : 'x'; const other = current[axis === 'x' ? 'yValue' : 'xValue'] ?? current.point?.[otherAxis] ?? null;
      const next = other === null ? null : axis === 'x' ? { x: value, y: other } : { x: other, y: value };
      return { ...current, [key]: value.toFixed(4), [axis === 'x' ? 'xValue' : 'yValue']: value, point: next };
    });
    const currentValue = coordinate(form.entry.value[key]);
    if (currentValue === null) form.errors({ [axis]: 'Enter an image coordinate from 0 to 1.' });
  };
  const save = () => {
    if (!image || !writer) return;
    const raw = form.entry.value, selected = resolvedPoint(raw);
    const checked = validateObservation({ x: selected?.x, y: selected?.y, text: raw.text });
    if (!form.entry.uncertain) { form.errors(checked.fieldErrors); if (!checked.value) return; }
    const editing = raw.editing;
    void form.execute(editing ? 'updateObservation' : 'createObservation', { observation: checked.value ?? { x: raw.point?.x ?? 0, y: raw.point?.y ?? 0, text: raw.text } }, { direct: true, target: { resultId: result.id, assetId: image.assetId, ...(editing ? { observationId: editing.id } : {}) }, expected: { imageContentVersion: image.contentVersion, ...(editing ? { observationVersion: editing.version } : {}) } });
  };
  const edit = (note: ObservationProjection) => {
    if (!writer || !note.canEdit || form.entry.uncertain) return;
    if (form.entry.dirty) { setNotice('Your current unsent preparation is retained. Save it or explicitly Cancel before editing another saved observation.'); return; }
    form.change({ point: { x: note.x, y: note.y }, xInput: note.x.toFixed(4), yInput: note.y.toFixed(4), xValue: note.x, yValue: note.y, text: note.text, editing: { id: note.id, version: note.version } });
    setMode('point'); setNotice(null);
  };
  const cancel = () => { if (!form.entry.uncertain) { form.saved(empty()); setNotice(null); } };
  return { form, record, writer, notes, mode, setMode, notice, point, cancelPoint, commitCoordinate, save, edit, cancel };
}
export type ObservationController = ReturnType<typeof useObservations>;

export function Observations({ result, image, state, reload, saved }: { result: CustomerResultProjection; image: PublishedImage | undefined; state: ObservationController; reload: () => void; saved: (text: string) => void }) {
  const { form, writer, notes } = state;
  const editing = form.entry.value.editing; const currentEditing = editing ? notes.find(note => note.id === editing.id) : undefined;
  const staleEditing = !!editing && (!currentEditing || currentEditing.version !== editing.version);
  const [deletionSelection, setDeletionSelection] = useState<ObservationProjection | null>(null);
  const remove = useWorkflow(state.record, `observation-delete:${image ? imageKey(image) : 'none'}`, { note: deletionSelection }, text => { setDeletionSelection(null); setDeleteOpen(false); remove.saved({ note: null }); saved(text); }, notes.map(note => `${note.id}:${note.version}`).join('|'));
  const [deleteOpen, setDeleteOpen] = useState(false); const opener = useRef<HTMLElement | null>(null);
  const selectedDelete = remove.entry.value.note;
  const deleteNote = () => { if (!image || !selectedDelete) return; void remove.execute('deleteObservation', {}, { direct: true, target: { resultId: result.id, assetId: image.assetId, observationId: selectedDelete.id }, expected: { imageContentVersion: image.contentVersion, observationVersion: selectedDelete.version } }); };
  const closeDelete = () => { setDeleteOpen(false); if (!remove.entry.uncertain) { setDeletionSelection(null); remove.saved({ note: null }); } };
  return <><p className="eyebrow">CUSTOMER OBSERVATIONS / EXACT IMAGE VERSION</p><h3>{image ? `${image.role === 'BASELINE' ? 'Baseline' : 'Recent'} · Version ${image.contentVersion}` : 'No selected image'}</h3><p className="helper">Your notes are separate from the staff finding. A point belongs only to this exact image version; it is not a measured ground coordinate.</p>{state.notice && <p className="notice warning" role="status">{state.notice}</p>}<ActionNotice error={form.entry.error} uncertain={form.entry.uncertain} refresh={reload} /><Errors errors={form.entry.fieldErrors} />{staleEditing && <div className="notice warning"><strong>The saved observation changed</strong><p>Your unsent point and text remain bound to the originally loaded version {editing!.version}. They have not been applied to the current record.</p><details><summary>Review current observation; retain my draft</summary>{currentEditing ? <><p className="preserve-lines">{currentEditing.text}</p><p className="helper">Current version {currentEditing.version} · {currentEditing.authorName} · X {currentEditing.x.toFixed(4)} · Y {currentEditing.y.toFixed(4)}</p></> : <p>This observation is no longer in the current list.</p>}<p className="helper">Your unsent input remains below. Cancel explicitly discards that preparation; then Edit can load the current saved point and text. No merge or automatic version upgrade is performed.</p></details></div>}{writer && image ? <form noValidate autoComplete="off" onSubmit={event => { event.preventDefault(); state.save(); }}><p className="annotation">{form.entry.value.editing ? 'EDITING YOUR SAVED OBSERVATION' : 'UNSAVED OBSERVATION'}</p><button type="button" className="button" disabled={form.busy || form.entry.uncertain} onClick={() => { state.point({ x: .5, y: .5 }); state.setMode('point'); }}>Start point at centre</button><div className="point-coordinate-fields">{(['x', 'y'] as const).map(axis => { const id = `observation-${axis}`; return <Field key={axis} id={id} label={`Point ${axis.toUpperCase()}`} error={form.entry.fieldErrors[axis]}><input id={id} type="text" inputMode="decimal" value={form.entry.value[axis === 'x' ? 'xInput' : 'yInput']} disabled={form.busy || form.entry.uncertain} placeholder="0.0000–1.0000" onChange={event => { const value = event.target.value; form.change(current => ({ ...current, [axis === 'x' ? 'xInput' : 'yInput']: value })); }} onBlur={() => state.commitCoordinate(axis)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); state.commitCoordinate(axis); } }} /></Field>; })}</div><p className="helper">Coordinates run from 0 to 1 across the oriented image. Display uses four decimals; a placed point retains its full precision. Commit keyboard coordinates with Enter or by leaving the field.</p><Field id="observation-note" label="Observation note" error={form.entry.fieldErrors.text}><textarea id="observation-note" rows={5} maxLength={2000} value={form.entry.value.text} disabled={form.busy || form.entry.uncertain} onChange={event => { const text = event.target.value; form.change(current => ({ ...current, text })); }} /></Field><div className="sheet-actions"><button className="button primary" disabled={form.busy || form.entry.uncertain || staleEditing}>{form.busy ? 'Saving observation…' : form.entry.value.editing ? 'Save changes' : 'Save observation'}</button><button type="button" className="button" disabled={form.busy || form.entry.uncertain} onClick={state.cancel}>Cancel</button></div>{form.entry.uncertain && <button type="button" className="button" disabled={form.busy} onClick={state.save}>Retry same observation save</button>}</form> : <p className="helper warning-text">Your workspace role is read-only. You can inspect saved observations; add, edit and delete controls are unavailable.</p>}<section className="saved-observations" aria-label="Saved observations"><h3>Saved observations <span className="annotation">{notes.length}</span></h3>{notes.length ? <ol>{notes.map((note, index) => <li key={note.id} data-note-id={note.id}><span className="observation-index mono">{String(index + 1).padStart(2, '0')}</span><p className="preserve-lines">{note.text}</p><p className="helper">{note.authorName} · Updated {formatTime(note.updatedAt)}<br /><span className="mono">X {note.x.toFixed(4)} · Y {note.y.toFixed(4)} · Version {note.version}</span></p>{writer && note.canEdit && <div className="sheet-actions"><button type="button" className="text-button" aria-label={`Edit observation by ${note.authorName}`} disabled={form.busy || form.entry.uncertain || remove.busy || remove.entry.uncertain} onClick={() => state.edit(note)}>Edit</button><button type="button" className="text-button danger-text" aria-label={`Delete observation by ${note.authorName}`} disabled={remove.busy || remove.entry.uncertain} onClick={event => { event.currentTarget.focus(); opener.current = event.currentTarget; setDeletionSelection(note); remove.saved({ note }); setDeleteOpen(true); }}>Delete</button></div>}</li>)}</ol> : <p className="helper">No saved observations on this exact image version. No customer point or note has been pre-filled.</p>}</section><ActionNotice error={remove.entry.error} uncertain={remove.entry.uncertain} refresh={reload} />{remove.entry.uncertain && !deleteOpen && <button className="button" onClick={deleteNote}>Retry same observation deletion</button>}{deleteOpen && selectedDelete && <Panel title="Delete observation" opener={opener.current} busy={remove.busy} close={() => void closeDelete()}><div className="sheet-body"><p className="eyebrow">YOUR OWN NOTE / EXACT SAVED VERSION</p><h1>Delete observation</h1><p className="preserve-lines">{selectedDelete.text}</p><p className="helper">{selectedDelete.authorName} · X {selectedDelete.x.toFixed(4)} · Y {selectedDelete.y.toFixed(4)} · Version {selectedDelete.version}</p><p>This removes your note from the current observation list. The image and staff finding are unchanged.</p><ActionNotice error={remove.entry.error} uncertain={remove.entry.uncertain} refresh={reload} /><Errors errors={remove.entry.fieldErrors} /><div className="sheet-actions"><button className="button primary" disabled={remove.busy} onClick={deleteNote}>{remove.busy ? 'Deleting…' : remove.entry.uncertain ? 'Retry same observation deletion' : 'Confirm delete'}</button><button className="button" disabled={remove.busy} onClick={() => void closeDelete()}>Cancel</button></div></div></Panel>}</>;
}
