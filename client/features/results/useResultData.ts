import { useEffect, useRef, useState } from 'react';
import { ApiError, api, contextKey, message } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';

export function useResultData<T extends { contextGeneration: number }>(path: string) {
  const { context, covered, refresh } = useCurrentContext(); const key = `${contextKey(context)}:${path}`;
  const current = useRef(key); current.current = key; const [round, setRound] = useState(0);
  const [state, setState] = useState<{ key: string; data?: T; loading: boolean; error?: string; denied?: boolean }>({ key, loading: true });
  useEffect(() => {
    if (covered || !context) return;
    const controller = new AbortController(); setState(previous => ({ key, data: previous.key === key ? previous.data : undefined, loading: true, error: previous.key === key ? previous.error : undefined, denied: previous.key === key ? previous.denied : undefined }));
    void api<T>(path, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted || current.current !== key) return;
      if (data.contextGeneration !== context.contextGeneration) { setState({ key, loading: false, denied: true }); void refresh(true); return; }
      setState({ key, data, loading: false });
    }).catch(error => {
      if (controller.signal.aborted || current.current !== key) return;
      const denied = error instanceof ApiError && [401, 403, 404].includes(error.status);
      setState(previous => ({ key, data: denied ? undefined : previous.key === key ? previous.data : undefined, loading: false, denied, error: message(error) }));
    });
    return () => controller.abort();
  }, [key, covered, round, path]);
  useEffect(() => { const timer = setInterval(() => { if (document.visibilityState === 'visible') setRound(value => value + 1); }, 15_000); return () => clearInterval(timer); }, [key]);
  const visible = !covered && state.key === key ? state : { key, loading: true };
  return { data: visible.error || visible.denied ? undefined : visible.data, error: visible.error, denied: visible.denied, loading: visible.loading,
    retry: () => setRound(value => value + 1),
    invalidate: () => { setState({ key, loading: true }); setRound(value => value + 1); },
  };
}
