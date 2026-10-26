import type { ApiErrorBody, Context } from '../../shared/contracts.js';

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) { super(body.message); }
}
export class ContextChangedError extends Error {}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options,
    headers: { Accept: 'application/json', ...options.headers } });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const supplied = body && typeof body === 'object' ? body as Partial<ApiErrorBody> : {};
    throw new ApiError(response.status, { code: supplied.code ?? 'UNAVAILABLE', message: supplied.message ?? 'This action is temporarily unavailable. Your input is retained.', fieldErrors: supplied.fieldErrors, retryable: supplied.retryable ?? response.status >= 500, correlationId: supplied.correlationId ?? '' });
  }
  return body as T;
}
export function post<T>(path: string, context: Context, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return api<T>(path, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Coruscant-CSRF': context.csrfToken ?? '' }, body: JSON.stringify({ ...body, contextGeneration: context.contextGeneration, contextToken: context.contextToken }) });
}
export function contextKey(context: Context | null): string {
  return context ? [context.audience, context.actor?.id, context.organization?.id, context.contextGeneration].join(':') : 'unknown';
}
export function message(error: unknown): string {
  return error instanceof ApiError || error instanceof ContextChangedError ? error.message : 'The connection was interrupted. Your input is retained; the outcome may be uncertain.';
}
