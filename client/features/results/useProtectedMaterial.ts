import { useLayoutEffect, useRef, useState } from 'react';
import type { ApiErrorBody } from '../../../shared/contracts.js';
import { contextKey } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';

type MaterialState = { key: string; status: 'loading' | 'ready' | 'missing' | 'error' | 'denied'; url?: string; message?: string };
export function materialRoute(assetId: string, version: number, variant: 'thumbnail' | 'preview'): string {
  return `/api/material/${encodeURIComponent(assetId)}/versions/${version}/${variant}`;
}
/** Private bytes become a short-lived Blob URL only after the current view/generation has checked them. */
export function useProtectedMaterial(route: string | null, scope: string, onDenied: () => void) {
  const { context, covered } = useCurrentContext(); const key = `${contextKey(context)}:${scope}:${route}`;
  const current = useRef({ key, covered }); current.current = { key, covered };
  const denied = useRef(onDenied); denied.current = onDenied;
  const [round, setRound] = useState(0); const [state, setState] = useState<MaterialState>({ key, status: 'loading' });
  useLayoutEffect(() => {
    const controller = new AbortController(); let objectUrl: string | null = null;
    setState({ key, status: 'loading' });
    if (!route || covered || !context || context.audience === 'PUBLIC') return () => controller.abort();
    void (async () => {
      try {
        const response = await fetch(route, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: { Accept: 'image/svg+xml,image/*' } });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as Partial<ApiErrorBody>;
          if (controller.signal.aborted || current.current.key !== key || current.current.covered) return;
          if (body.code === 'MATERIAL_UNAVAILABLE') setState({ key, status: 'missing', message: body.message ?? 'This exact supplied image file is unavailable. No replacement has been substituted.' });
          else if ([401, 403, 404].includes(response.status)) { setState({ key, status: 'denied' }); denied.current(); }
          else setState({ key, status: 'error', message: body.message ?? 'This image could not be loaded. Its permitted metadata remains available.' });
          return;
        }
        if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('image/')) throw new Error('Unexpected material response');
        const blob = await response.blob();
        if (controller.signal.aborted || current.current.key !== key || current.current.covered) return;
        objectUrl = URL.createObjectURL(blob); setState({ key, status: 'ready', url: objectUrl });
      } catch {
        if (!controller.signal.aborted && current.current.key === key && !current.current.covered) setState({ key, status: 'error', message: 'This image could not be loaded. Your permitted metadata and unsent input are retained.' });
      }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [route, scope, key, covered, round]);
  const visible = !covered && state.key === key ? state : { key, status: 'loading' as const };
  return { ...visible, retry: () => setRound(value => value + 1) };
}
