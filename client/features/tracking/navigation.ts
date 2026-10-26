import type { RequestStatus } from '../../../shared/contracts.js';

export const requestStatuses: RequestStatus[] = ['Planning', 'Submitted', 'In review', 'Needs information', 'Quote ready', 'Accepted', 'Scheduled', 'Delivered'];
export interface RequestFilters { search: string; status: string; page: number }
export function readRequestFilters(query: URLSearchParams): RequestFilters | null {
  if ([...query.keys()].some(key => !['search', 'status', 'page'].includes(key))) return null;
  if (['search', 'status', 'page'].some(key => query.getAll(key).length > 1)) return null;
  const search = query.get('search') ?? '', status = query.get('status') ?? '', rawPage = query.get('page') ?? '1';
  if (search.length > 200 || status && !requestStatuses.includes(status as RequestStatus) || !/^\d+$/.test(rawPage) || Number(rawPage) < 1 || Number(rawPage) > 100000) return null;
  return { search, status, page: Number(rawPage) };
}
export function requestFilterQuery(filters: RequestFilters): string {
  const query = new URLSearchParams();
  if (filters.search) query.set('search', filters.search);
  if (filters.status) query.set('status', filters.status);
  if (filters.page > 1) query.set('page', String(filters.page));
  return query.size ? `?${query}` : '';
}
/** Only an applied Requests list in this same organization is a permitted list return. */
export function requestListReturn(organizationId: string, search: string | URLSearchParams): string {
  const fallback = `/workspaces/${organizationId}/requests`, query = typeof search === 'string' ? new URLSearchParams(search) : search;
  const value = query.get('returnTo');
  if (!value || !value.startsWith(`${fallback}?`) && value !== fallback) return fallback;
  const boundary = value.indexOf('?'), path = boundary < 0 ? value : value.slice(0, boundary);
  if (path !== fallback || value.includes('#')) return fallback;
  const applied = new URLSearchParams(boundary < 0 ? '' : value.slice(boundary + 1));
  if ([...applied.keys()].some(key => !['search', 'status', 'page'].includes(key))) return fallback;
  const filters = readRequestFilters(applied);
  return filters ? fallback + requestFilterQuery(filters) : fallback;
}
/** Preserve an already validated same-workspace list return across this request's surfaces. */
export function withRequestListReturn(path: string, organizationId: string, search: string | URLSearchParams): string {
  const query = typeof search === 'string' ? new URLSearchParams(search) : search;
  if (!query.has('returnTo')) return path;
  const fragment = path.indexOf('#'), base = fragment < 0 ? path : path.slice(0, fragment), hash = fragment < 0 ? '' : path.slice(fragment);
  return `${base}${base.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(requestListReturn(organizationId, query))}${hash}`;
}
export function listDetailHref(path: string, organizationId: string, filters: RequestFilters): string {
  return `${path}?returnTo=${encodeURIComponent(`/workspaces/${organizationId}/requests${requestFilterQuery(filters)}`)}`;
}
