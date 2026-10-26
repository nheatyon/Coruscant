import type { Context } from '../../../shared/contracts.js';
import { contextKey } from '../../lib/api.js';

/** UI guidance only. Every operation still requires the server's current authority. */
export function planningCapability(context: Context | null) {
  const writable = context?.audience === 'CUSTOMER' && !!context.organization && ['OWNER', 'REQUESTER'].includes(context.role ?? '');
  const kind = !context ? 'CHECKING' : context.audience === 'PUBLIC' ? 'PUBLIC' : context.audience === 'STAFF' ? 'STAFF' : !context.organization ? 'NO_WORKSPACE' : writable ? 'WRITER' : 'VIEWER';
  return { kind, canCalculate: kind === 'PUBLIC' || writable, canSave: writable };
}
/** Opaque tokens are compared in memory only, never rendered or put in a URL. */
export function planningOwnershipStamp(context: Context | null): string {
  return JSON.stringify([contextKey(context), context?.role, context?.contextToken, context?.csrfToken]);
}
export function planningIdentity(context: Context | null): string {
  return JSON.stringify([context?.audience, context?.actor?.id, context?.organization?.id, context?.role]);
}
