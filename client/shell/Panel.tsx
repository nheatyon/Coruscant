import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const modalStack: HTMLElement[] = [];
let originalInert = false; let originalOverflow = '';

export function Panel({ children, title, close, modal = true, busy = false, detail = false, opener }: { children: ReactNode; title: string; close: () => void; modal?: boolean; busy?: boolean; detail?: boolean; opener?: HTMLElement | null }) {
  const panel = useRef<HTMLElement>(null); const returnFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(close); closeRef.current = close;
  const busyRef = useRef(busy); busyRef.current = busy;
  useLayoutEffect(() => { if (opener) returnFocus.current = opener; }, [opener]);
  useEffect(() => {
    if (!opener) returnFocus.current = document.activeElement as HTMLElement;
    const restoreFocus = () => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); };
    if (!modal) return restoreFocus;
    const root = document.getElementById('root')!; const node = panel.current!;
    if (!modalStack.length) { originalInert = root.inert; originalOverflow = document.body.style.overflow; }
    const previous = modalStack.at(-1); if (previous) previous.inert = true;
    modalStack.push(node);
    root.inert = true; document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== node) return;
      if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) closeRef.current(); }
      if (event.key !== 'Tab') return;
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') ?? [])].filter(node => !node.hidden && node.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      const index = modalStack.indexOf(node); if (index >= 0) modalStack.splice(index, 1);
      const top = modalStack.at(-1); if (top) top.inert = false;
      else { root.inert = originalInert; document.body.style.overflow = originalOverflow; }
      document.removeEventListener('keydown', keydown); restoreFocus();
    };
  }, [modal]);
  const content = <>{modal && <div className="panel-scrim" onClick={() => { if (!busyRef.current) closeRef.current(); }} aria-hidden="true" />}<aside ref={panel} role={modal ? 'dialog' : 'complementary'} aria-modal={modal || undefined} aria-label={title} className={`sheet ${detail ? 'details-sheet' : ''} ${modal ? 'modal-sheet' : 'nonmodal-sheet'}`}><div className="sheet-close"><span>{title}</span><button type="button" onClick={close} disabled={busy} aria-label={`Close ${title}`}><span aria-hidden="true">×</span> Close panel</button></div>{children}</aside></>;
  return modal ? createPortal(content, document.body) : content;
}
