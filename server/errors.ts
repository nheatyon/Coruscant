export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string,
    public fieldErrors?: Record<string, string>, public retryable = false) { super(message); }
}
export function unavailable(): never { throw new ApiError(404, 'UNAVAILABLE', 'This record is unavailable in the current context.'); }
export function invalid(message: string, fieldErrors?: Record<string, string>): never {
  throw new ApiError(422, 'VALIDATION', message, fieldErrors);
}
