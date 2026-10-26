import { useEffect, useRef, useState } from 'react';
import { useCurrentContext } from './context.js';

/** Display time advances from the latest server snapshot; it never changes a workflow record. */
export function useServerClock(serverNow?: string, intervalMs = 30_000): number {
  const { context } = useCurrentContext();
  const source = serverNow ?? context?.serverNow;
  const anchor = useRef({ source, server: Date.parse(source ?? ''), elapsed: performance.now() });
  if (anchor.current.source !== source) anchor.current = { source, server: Date.parse(source ?? ''), elapsed: performance.now() };
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick(value => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, source]);
  return anchor.current.server + performance.now() - anchor.current.elapsed;
}
