import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/database.js';
import { transaction } from '../db/database.js';
import { bodyObject, guardContext, requireSession, type Clock } from '../security.js';
import { ApiError } from '../errors.js';
import type { OrbitalBrowseInput } from '../../shared/orbital-contracts.js';
import { createBrowseService } from './browse.js';

export function registerOrbitalBrowseRoutes(app: FastifyInstance, dependencies: { db: Database; clock: Clock }): void {
  const { db, clock } = dependencies, service = createBrowseService(db, clock);
  app.addHook('onClose', async () => service.close());
  app.post('/api/orbital-browse', async (request, reply) => {
    const raw = bodyObject(request), allowed = ['snapshotVersion', 'factVersion', 'representedAt', 'generation', 'criteria', 'exclusions', 'selectedId', 'shortlistedIds', 'visibility', 'cursor', 'contextGeneration', 'contextToken'];
    if (Object.keys(raw).some(key => !allowed.includes(key)) || raw.cursor !== undefined && (typeof raw.cursor !== 'string' || raw.cursor.length > 120)) throw new ApiError(422, 'BROWSE_INPUT_INVALID', 'Review the current globe inputs.');
    const { contextGeneration: _generation, contextToken: _token, ...value } = raw, input = value as unknown as OrbitalBrowseInput;
    const initial = transaction(db, () => { const session = requireSession(db, request, clock); guardContext(session, request); return session; });
    const reauthorize = () => transaction(db, () => { const current = requireSession(db, request, clock); guardContext(current, request); if (current.cookie_hash !== initial.cookie_hash || current.context_generation !== initial.context_generation) throw new ApiError(409, 'CONTEXT_CHANGED', 'Your context changed while the globe was being prepared.'); });
    const controller = new AbortController(), cancel = () => { if (!reply.raw.writableEnded) controller.abort(); };
    request.raw.once('aborted', cancel); reply.raw.once('close', cancel);
    try { return await service.run(input, `${initial.cookie_hash}:${initial.context_generation}`, controller.signal, reauthorize); }
    finally { request.raw.removeListener('aborted', cancel); reply.raw.removeListener('close', cancel); }
  });
}
