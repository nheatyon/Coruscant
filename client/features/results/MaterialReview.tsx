import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RequestProjection } from '../../../shared/contracts.js';
import type { MaterialCommandName, MaterialExpected, MaterialPayloads, MaterialTarget, StaffResultProjection } from '../../../shared/material.js';
import type { ValidationResult, WorkflowConfirmation } from '../../../shared/workflow.js';
import { requestPrivateDeparture } from '../../lib/privateDrafts.js';
import { Panel } from '../../shell/Panel.js';
import { ActionNotice, Errors } from '../workflow/WorkflowUI.js';
import { materialStamp, useMaterialAction } from './useMaterialAction.js';

export function MaterialReview<T, K extends MaterialCommandName>({ request, result, slot, command, initial, payload, target, expected, title, label, visibleLabel, confirmLabel, retryLabel, validate, fields, summary, resetOnOpen, saved, reload, disabled = false }: {
  request: RequestProjection; result: StaffResultProjection; slot: string; command: K; initial: T;
  payload: (value: T) => MaterialPayloads[K]; target?: Omit<MaterialTarget, 'requestId'>; expected?: MaterialExpected;
  title: string; label: string; visibleLabel?: string; confirmLabel: string; retryLabel: string;
  validate: (value: T) => ValidationResult<unknown>; fields?: (value: T, change: (value: T | ((current: T) => T)) => void) => ReactNode;
  summary: (confirmation: WorkflowConfirmation | null) => ReactNode; resetOnOpen?: (value: T) => T;
  saved: (text: string) => void; reload: () => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false); const [round, setRound] = useState(0); const opener = useRef<HTMLElement | null>(null);
  const form = useMaterialAction(request, result, slot, initial, text => { form.saved(initial); setOpen(false); saved(text); });
  const stamp = `${request.requestVersion}:${request.briefRevision}:${materialStamp(result)}`;
  const openedBinding = useRef(''); const checked = useRef('');
  const serial = JSON.stringify(form.entry.value); const valid = validate(form.entry.value);
  const changed = openedBinding.current !== stamp;
  const start = (button?: HTMLButtonElement) => {
    button?.focus(); if (button) opener.current = button;
    if (!form.entry.uncertain) { form.change(resetOnOpen ? resetOnOpen(form.entry.value) : form.entry.value); form.clearPreview(); }
    openedBinding.current = stamp; checked.current = ''; setOpen(true);
  };
  useEffect(() => {
    const key = `${stamp}:${serial}:${round}`;
    if (!open || changed || !valid.value || form.busy || form.entry.uncertain || checked.current === key) return;
    const timer = setTimeout(() => { checked.current = key; void form.previewAction(command, payload(form.entry.value), target, expected); }, 100);
    return () => clearTimeout(timer);
  }, [open, changed, stamp, serial, form.busy, form.entry.uncertain, round]);
  const close = async () => { if (await requestPrivateDeparture()) { form.clearPreview(); setOpen(false); } };
  return <><button className="button" type="button" aria-label={label} disabled={disabled && !form.entry.uncertain} onClick={event => start(event.currentTarget)}>{form.entry.uncertain ? retryLabel : visibleLabel ?? label}</button>{open && <Panel title={title} opener={opener.current} busy={form.busy} close={() => void close()}><div className="sheet-body material-review"><p className="eyebrow">{request.reference} / EXPLICIT STAFF ACTION</p><h1>{title}</h1>{summary(form.preview?.confirmation ?? null)}{changed && !form.entry.uncertain && <div className="notice warning"><strong>The saved material changed.</strong><p>Your input is retained. Inspect its current exact versions and review again; the previous confirmation is invalid.</p><button className="button" onClick={() => start()}>Review updated material</button></div>}<Errors errors={form.entry.fieldErrors} /><ActionNotice error={form.entry.error} uncertain={form.entry.uncertain} refresh={reload} /><fieldset disabled={form.busy || form.entry.uncertain || changed}>{fields?.(form.entry.value, form.change)}</fieldset>{!valid.value && !form.entry.uncertain && <p className="helper">Complete the required reason and review confirmations before this action can be confirmed.</p>}{form.busy && !form.entry.uncertain && <p role="status" className="helper">Checking the exact action and current saved versions…</p>}{form.entry.error && !form.entry.uncertain && !changed && <button className="button" onClick={() => setRound(value => value + 1)}>Check current review again</button>}<div className="sheet-actions"><button className="button" disabled={form.busy || form.entry.uncertain} onClick={() => void close()}>Back</button><button className="button primary" disabled={form.busy || (!form.entry.uncertain && (!form.preview || changed))} onClick={() => void form.commitAction(command, payload(form.entry.value), target, expected)}>{form.busy ? 'Saving action…' : form.entry.uncertain ? retryLabel : confirmLabel}</button></div></div></Panel>}</>;
}
