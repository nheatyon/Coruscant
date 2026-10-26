import { useEffect, useRef, useState } from 'react';
import { ApiError, api, contextKey, message } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';

type ProtectedResponse<T> = T & { contextGeneration: number; serverNow: string };
export function usePrivateData<T>(path: string | null) {
  const { context, covered, refresh } = useCurrentContext();
  const key = `${contextKey(context)}:${path}`, current = useRef(key); current.current = key;
  const [state, setState] = useState<{ key: string; data?: ProtectedResponse<T>; error?: string; code?: string; denied?: boolean; loading?: boolean }>({ key });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (covered || !context || !path) return;
    const controller = new AbortController(), generation = context.contextGeneration;
    setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, loading: true }));
    void api<ProtectedResponse<T>>(path, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted || current.current !== key) return;
      if (data.contextGeneration !== generation) { setState({ key, denied: true }); void refresh(true); return; }
      setState({ key, data });
    }).catch(failure => {
      if (controller.signal.aborted || current.current !== key) return;
      const denied = failure instanceof ApiError && [401, 403, 404].includes(failure.status);
      setState(previous => ({ key, data: !denied && previous.key === key ? previous.data : undefined, error: message(failure), code: failure instanceof ApiError ? failure.body.code : undefined, denied, loading: false }));
    });
    return () => controller.abort();
  }, [key, covered, version, path]);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible') setVersion(value => value + 1); }, 15_000); return () => clearInterval(timer); }, [key]);
  const visible = !covered && state.key === key && path ? state : undefined;
  return { data: visible?.data, error: visible?.error, code: visible?.code, denied: !!visible?.denied, loading: !!visible?.loading, retry: () => setVersion(value => value + 1) };
}
