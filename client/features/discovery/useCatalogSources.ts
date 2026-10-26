import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogContext, Context, PublicCatalog } from '../../../shared/contracts.js';
import type { DiscoveryDictionary, DiscoveryEvidence, DiscoveryExclusion, DiscoveryValues } from '../../../shared/discovery-contracts.js';
import type { RealCatalogDetail, RealCatalogItem, RealCatalogPage, RefreshCatalogOutcome } from '../../../shared/orbital-contracts.js';
import { emptyDiscoveryValues, makeDiscoveryDictionary } from '../../../shared/discovery.js';
import { api, contextKey, message, post } from '../../lib/api.js';
import { useCurrentContext } from '../../lib/context.js';

export type CatalogMode = 'REAL' | 'DEMONSTRATION';
export type DiscoveryItem = DiscoveryEvidence;
export interface DiscoveryCatalog { items: DiscoveryItem[] }
export const EMPTY_REAL_DICTIONARY: DiscoveryDictionary = { operators: [], countries: [], places: [] };
const queryText = (criteria: DiscoveryValues, exclusions: readonly DiscoveryExclusion[]) => JSON.stringify({ criteria, exclusions });
function queryString(criteria: DiscoveryValues, exclusions: readonly DiscoveryExclusion[], extra: Record<string, string> = {}) {
  return new URLSearchParams({ criteria: JSON.stringify(criteria), exclusions: JSON.stringify(exclusions), ...extra }).toString();
}

/** Public source state is separate from sample access/D0 bootstrap definitions. */
export function useCatalogSources(bootstrap: PublicCatalog | null) {
  const access = useCurrentContext(), { ensure } = access;
  const accessRef = useRef(access); accessRef.current = access;
  const [mode, changeMode] = useState<CatalogMode>('REAL'), modeRef = useRef(mode); modeRef.current = mode;
  const [query, setQuery] = useState({ criteria: emptyDiscoveryValues(), exclusions: [] as DiscoveryExclusion[] });
  const queryKey = queryText(query.criteria, query.exclusions), queryRef = useRef(queryKey); queryRef.current = queryKey;
  const [page, setPage] = useState<RealCatalogPage | null>(null), [pageQuery, setPageQuery] = useState('');
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [round, setRound] = useState(0);
  const [refreshing, setRefreshing] = useState(false), [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [representedUtc, setRepresentedUtc] = useState<string | null>(null);
  const [known, setKnown] = useState<Record<string, RealCatalogItem>>({}), [details, setDetails] = useState<Record<string, RealCatalogDetail>>({});
  const [detailLoading, setDetailLoading] = useState<string | null>(null), [detailError, setDetailError] = useState<string | null>(null);
  const sequence = useRef(0), detailSequence = useRef(0), modeGeneration = useRef(0), timeSequence = useRef(0), refreshSequence = useRef(0), mounted = useRef(true), pageRef = useRef(page); pageRef.current = page;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++sequence.current; ++detailSequence.current; ++timeSequence.current; ++refreshSequence.current; }; }, []);
  const accessStamp = contextKey(access.context);
  useEffect(() => { ++timeSequence.current; }, [accessStamp, access.covered]);
  const remember = useCallback((items: RealCatalogItem[]) => setKnown(previous => Object.fromEntries([...Object.entries(previous), ...items.map(item => [item.id, item] as const)])), []);
  useEffect(() => {
    if (mode !== 'REAL') { ++sequence.current; setLoading(false); return; }
    const controller = new AbortController(), invocation = ++sequence.current;
    setLoading(true); setError(null); ++detailSequence.current; setDetails({}); setDetailLoading(null); setDetailError(null);
    void api<RealCatalogPage>(`/api/public/real-catalog?${queryString(query.criteria, query.exclusions)}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted || invocation !== sequence.current || modeRef.current !== 'REAL') return;
      setPage(value); setPageQuery(queryKey); remember(value.items.map(row => row.item));
      setRepresentedUtc(previous => previous ?? value.serverNow); setLoading(false);
    }).catch(failure => { if (!controller.signal.aborted && invocation === sequence.current) { setError(message(failure)); setLoading(false); } });
    return () => controller.abort();
  }, [mode, queryKey, round, remember]);
  const setSearch = useCallback((criteria: DiscoveryValues, exclusions: readonly DiscoveryExclusion[]) => {
    const next = queryText(criteria, exclusions); setQuery(previous => queryText(previous.criteria, previous.exclusions) === next ? previous : { criteria, exclusions: [...exclusions] });
  }, []);
  const setMode = (next: CatalogMode) => {
    if (next === modeRef.current) return;
    modeRef.current = next; ++modeGeneration.current; ++sequence.current; ++detailSequence.current; ++timeSequence.current; ++refreshSequence.current;
    setDetailLoading(null); setDetailError(null); setRefreshing(false); setRefreshMessage(null);
    if (next === 'REAL') setRepresentedUtc(null);
    changeMode(next);
  };
  const loadMore = async () => {
    if (loading || !page?.nextCursor || !page.snapshotVersion || pageQuery !== queryKey) return;
    const captured = queryKey, invocation = ++sequence.current; setLoading(true); setError(null);
    try {
      const value = await api<RealCatalogPage>(`/api/public/real-catalog?${queryString(query.criteria, query.exclusions, { snapshotVersion: page.snapshotVersion, cursor: page.nextCursor })}`);
      if (!mounted.current || invocation !== sequence.current || modeRef.current !== 'REAL' || queryRef.current !== captured) return;
      setPage(previous => previous && previous.snapshotVersion === value.snapshotVersion ? { ...value, items: [...previous.items, ...value.items] } : value);
      remember(value.items.map(row => row.item));
    } catch (failure) { if (mounted.current && invocation === sequence.current) setError(message(failure)); }
    finally { if (mounted.current && invocation === sequence.current) setLoading(false); }
  };
  const resolve = async (id: string) => {
    const snapshot = pageRef.current?.snapshotVersion; if (modeRef.current !== 'REAL' || !snapshot) return null;
    const invocation = ++detailSequence.current, capturedQuery = queryRef.current; setDetailLoading(id); setDetailError(null);
    try {
      const value = await api<RealCatalogDetail>(`/api/public/real-catalog/${encodeURIComponent(id)}?${queryString(query.criteria, query.exclusions, { snapshotVersion: snapshot })}`);
      if (!mounted.current || invocation !== detailSequence.current || modeRef.current !== 'REAL' || queryRef.current !== capturedQuery || pageRef.current?.snapshotVersion !== snapshot) return null;
      remember([value.item]); setDetails(previous => ({ ...previous, [id]: value })); return value;
    } catch (failure) { if (mounted.current && invocation === detailSequence.current) setDetailError(message(failure)); return null; }
    finally { if (mounted.current && invocation === detailSequence.current) setDetailLoading(null); }
  };
  const refresh = async () => {
    if (refreshing || modeRef.current !== 'REAL') return;
    const invocation = ++refreshSequence.current, entry = modeGeneration.current;
    const current = () => mounted.current && invocation === refreshSequence.current && entry === modeGeneration.current && modeRef.current === 'REAL';
    setRefreshing(true); setRefreshMessage(null);
    try {
      const context = await ensure(); if (!current()) return;
      const value = await post<RefreshCatalogOutcome>('/api/orbital-evidence/refresh', context, {});
      if (!current()) return;
      setRefreshMessage(value.sources.map(source => `${source.group}: ${source.message}`).join(' ')); setRound(value => value + 1);
    } catch (failure) { if (current()) setRefreshMessage(message(failure)); }
    finally { if (current()) setRefreshing(false); }
  };
  const updateTime = async () => {
    if (modeRef.current !== 'REAL' || accessRef.current.covered) return;
    const invocation = ++timeSequence.current, entry = modeGeneration.current, owner = contextKey(accessRef.current.context);
    const current = () => mounted.current && invocation === timeSequence.current && entry === modeGeneration.current && modeRef.current === 'REAL' && !accessRef.current.covered && contextKey(accessRef.current.context) === owner && document.visibilityState !== 'hidden';
    try {
      const value = await api<Context>('/api/context');
      if (current() && contextKey(value) === owner) setRepresentedUtc(value.serverNow);
    } catch (failure) { if (current()) setRefreshMessage(`Predicted time could not update. ${message(failure)}`); }
  };
  const dictionary = useMemo(() => mode === 'REAL' ? page?.dictionary ?? EMPTY_REAL_DICTIONARY : makeDiscoveryDictionary(bootstrap?.items ?? []), [mode, page?.dictionary, bootstrap]);
  const catalog: DiscoveryCatalog | null = useMemo(() => mode === 'REAL' ? Object.keys(known).length || page?.availability === 'READY' ? { items: Object.values(known) } : null : bootstrap, [mode, known, page?.availability, bootstrap]);
  const catalogContext: CatalogContext = mode === 'REAL' ? { sourceKind: 'PUBLIC_REAL', snapshotVersion: page?.snapshotVersion ?? null, factVersion: page?.snapshotVersion ? page.factVersion : null } : { sourceKind: 'DEMONSTRATION' };
  return { mode, setMode, page, catalog, dictionary, catalogContext, query, queryKey, current: pageQuery === queryKey, loading, error,
    representedUtc, setSearch, retry: () => setRound(value => value + 1), loadMore, resolve, details, detailLoading, detailError,
    refreshing, refresh, refreshMessage, updateTime };
}
export type CatalogSources = ReturnType<typeof useCatalogSources>;

/** A saved real brief may have no shortlist; its exact source version still owns recognition. */
export function useSavedCatalogDictionary(context?: CatalogContext, fallback?: DiscoveryDictionary) {
  const [state, setState] = useState({ dictionary: EMPTY_REAL_DICTIONARY, loading: false, error: null as string | null });
  const [round, setRound] = useState(0);
  const version = context?.sourceKind === 'PUBLIC_REAL' ? context.snapshotVersion : null;
  useEffect(() => {
    const controller = new AbortController(); setState({ dictionary: EMPTY_REAL_DICTIONARY, loading: !!version, error: null });
    if (context?.sourceKind === 'PUBLIC_REAL' && version) void api<RealCatalogPage>(`/api/public/real-catalog?${new URLSearchParams({ snapshotVersion: version })}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setState({ dictionary: value.dictionary, loading: false, error: value.availability === 'READY' ? null : 'The original real catalog context is unavailable. Your revision input is retained.' }); }).catch(failure => { if (!controller.signal.aborted) setState({ dictionary: EMPTY_REAL_DICTIONARY, loading: false, error: message(failure) }); });
    return () => controller.abort();
  }, [version, round]);
  return { ...(context?.sourceKind === 'PUBLIC_REAL' ? state : { dictionary: fallback ?? EMPTY_REAL_DICTIONARY, loading: false, error: null }), retry: () => setRound(value => value + 1) };
}
